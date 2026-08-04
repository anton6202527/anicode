import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DebugProvider } from "./provider/debug.js";
import {
  createProductionSessionManager,
  productionSessionManagerOptions,
} from "./production-session-manager.js";
import { SessionManager } from "./session-manager.js";
import { createLocalRuntimeStack } from "./runtime/local-stack.js";
import { noTelemetry } from "./runtime/telemetry.js";
import { DisabledExecutionRuntime } from "./runtime/isolated-runtime.js";
import type { Tool, ToolCapability } from "./tools/tool.js";
import type { Provider, StreamEvent, StreamRequest } from "./types.js";
import { BrowserRegistry } from "./browser/cdp.js";

function fixtureTool(name: string, capabilities?: readonly ToolCapability[]): Tool {
  return {
    def: {
      name,
      description: `${name} fixture`,
      parameters: { type: "object", properties: {} },
    },
    ...(capabilities ? { capabilities } : {}),
    readOnly: true,
    ruleKey: () => name,
    run: async () => "ok",
  };
}

test("production composition keeps every local host on the same capability contract", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-production-host-"));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  const env: NodeJS.ProcessEnv = {
    ANICODE_CREDENTIAL_BACKEND: "memory",
    ANICODE_NETWORK_PROXY_URL: "http://127.0.0.1:9317",
  };
  const stack = createLocalRuntimeStack(root, env);
  const disabledSkills: string[] = ["disabled-fixture"];
  try {
    const options = productionSessionManagerOptions(
      {
        cwd,
        sessionsDir: path.join(root, "sessions"),
        env,
        resolveProvider: () => ({ provider: new DebugProvider(), model: "demo" }),
        permissionMode: "acceptEdits",
        allowRestrictedWorkspaceDevelopment: true,
        runBudget: {
          maxWallTimeMs: 60_000,
          maxTotalTokens: 50_000,
          maxCostUSD: 2,
          maxToolCalls: 20,
          maxConcurrentTools: 3,
          toolTimeoutMs: 10_000,
        },
        config: {
          smallModel: "debug/demo",
          fallbackModels: ["debug/fallback"],
          permissions: {
            allow: ["Read(*)"],
            deny: ["Bash(rm *)"],
            ask: ["Bash(*)"],
          },
          permissionProfile: "workspace",
          permissionProfiles: {
            custom: { mode: "default", allowRules: ["Glob(*)"] },
          },
          agents: {
            reviewer: { description: "review changes", prompt: "Review carefully." },
          },
          hooks: [{ event: "Stop", command: "true" }],
        },
        extraTools: [fixtureTool("extra_fixture")],
        deferredTools: [fixtureTool("deferred_fixture")],
        skillDirs: [path.join(root, "skills")],
        subagentDirs: [path.join(root, "agents")],
        disabledSkills,
      },
      stack,
      noTelemetry,
    );

    assert.equal(options.compaction, true);
    assert.equal(options.persistPermissions, true);
    assert.equal(options.checkpoints, true);
    assert.equal(options.repoMap, true);
    assert.equal(options.autoTitle, true);
    assert.equal(options.workspaceScope, cwd);
    assert.deepEqual(options.runBudget, {
      maxWallTimeMs: 60_000,
      maxTotalTokens: 50_000,
      maxCostUSD: 2,
      maxToolCalls: 20,
      maxConcurrentTools: 3,
      toolTimeoutMs: 10_000,
    });
    assert.equal(options.smallModel, "debug/demo");
    assert.deepEqual(options.fallbackModels, ["debug/fallback"]);
    assert.deepEqual(options.permission, {
      mode: "acceptEdits",
      allowRules: ["Read(*)"],
      denyRules: ["Bash(rm *)"],
      askRules: ["Bash(*)"],
    });
    assert.equal(options.allowRestrictedWorkspaceDevelopment, true);
    assert.equal(options.permissionProfile, "workspace");
    assert.ok(options.permissionProfiles?.["custom"]);
    assert.equal(options.hooks?.length, 1);

    assert.notEqual(options.browser, false);
    assert.equal(typeof options.browser, "object");
    if (options.browser && typeof options.browser === "object") {
      assert.equal(options.browser.requireProxy, true);
      assert.equal(options.browser.proxyUrl, env.ANICODE_NETWORK_PROXY_URL);
    }

    assert.equal(typeof options.skills, "object");
    if (options.skills && typeof options.skills === "object") {
      assert.deepEqual(options.skills.dirs, [path.join(root, "skills")]);
      assert.equal(options.skills.disabled, disabledSkills);
    }
    assert.equal(typeof options.subagents, "object");
    if (typeof options.subagents === "object" && !Array.isArray(options.subagents)) {
      assert.equal(options.subagents.discover, true);
      assert.equal(options.subagents.definitions?.[0]?.name, "reviewer");
      assert.deepEqual(options.subagents.dirs, [path.join(root, "agents")]);
    }

    const tools = options.tools?.();
    assert.ok(tools?.names().includes("read"));
    assert.ok(tools?.names().includes("extra_fixture"));
    assert.equal(tools?.isDeferred("deferred_fixture"), true);

    let capturedWindowsRequest: StreamRequest | undefined;
    const windowsProvider: Provider = {
      name: "capture-windows-tools",
      async *stream(request): AsyncIterable<StreamEvent> {
        capturedWindowsRequest = request;
        yield {
          type: "done",
          stopReason: "end_turn",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    const windowsRestricted = productionSessionManagerOptions(
      {
        cwd,
        sessionsDir: path.join(root, "sessions"),
        env,
        resolveProvider: () => ({ provider: windowsProvider, model: "demo" }),
        workspaceTrust: async () => ({
          trusted: false,
          reason: "not-trusted",
          executionSources: [],
          storeFile: path.join(root, "trust.json"),
          assessedAt: new Date().toISOString(),
        }),
        config: {
          hooks: [{ event: "Stop", command: "node project-hook.js" }],
          agents: { reviewer: { description: "review", prompt: "review" } },
        },
        extraTools: [
          fixtureTool("diagnostics"),
          fixtureTool("definition"),
          fixtureTool("browser"),
          fixtureTool("build_native", ["process"]),
          fixtureTool("undeclared_plugin"),
          fixtureTool("audited_safe", ["memory"]),
        ],
        deferredTools: [fixtureTool("kill_shell")],
      },
      {
        ...stack,
        executionMode: "restricted",
        isolatedRuntime: new DisabledExecutionRuntime("native Windows execution disabled"),
      },
      noTelemetry,
    );

    assert.equal(windowsRestricted.browser, false);
    assert.equal(windowsRestricted.hooks, undefined);
    assert.equal(windowsRestricted.verifier, undefined);
    assert.equal(windowsRestricted.checkpoints, undefined);
    assert.equal(windowsRestricted.subagents, undefined);
    const windowsTools = windowsRestricted.tools?.();
    assert.ok(windowsTools);
    const windowsSchema = [
      ...windowsTools.definitions(),
      ...windowsTools.deferredDefinitions(),
    ].map((definition) => definition.name);
    for (const processTool of [
      "bash",
      "bash_output",
      "write_stdin",
      "list_shells",
      "kill_shell",
      "diagnostics",
      "definition",
      "references",
      "symbols",
      "browser",
      "build_native",
      "undeclared_plugin",
    ]) {
      assert.equal(
        windowsSchema.includes(processTool),
        false,
        `${processTool} must not be exposed`,
      );
    }
    assert.equal(windowsSchema.includes("audited_safe"), true);
    const trustRestrictedSchema =
      windowsRestricted
        .restrictedDevelopmentTools?.()
        .definitions()
        .map((definition) => definition.name) ?? [];
    assert.equal(trustRestrictedSchema.includes("bash"), false);
    assert.equal(trustRestrictedSchema.includes("bash_output"), false);
    assert.equal(trustRestrictedSchema.includes("kill_shell"), false);

    const windowsManager = new SessionManager(windowsRestricted);
    try {
      const session = await windowsManager.createSession({ cwd, model: "demo" });
      await windowsManager.send(session.id, "inspect safely");
      const actualSchema = (capturedWindowsRequest?.tools ?? []).map(
        (definition) => definition.name,
      );
      assert.equal(actualSchema.includes("bash"), false);
      assert.equal(actualSchema.includes("bash_output"), false);
      assert.equal(actualSchema.includes("kill_shell"), false);
    } finally {
      await windowsManager.shutdown();
    }

    const container = productionSessionManagerOptions(
      {
        cwd,
        sessionsDir: path.join(root, "sessions"),
        env,
        resolveProvider: () => ({ provider: new DebugProvider(), model: "demo" }),
      },
      { ...stack, executionMode: "container" },
      noTelemetry,
    );
    const containerTools = container.tools?.();
    assert.ok(container.verifier, "pinned OCI mode keeps discard-only deterministic verification");
    const containerBash = containerTools?.get("bash");
    assert.ok(containerBash, "pinned OCI mode keeps foreground command execution");
    const containerBashProperties = containerBash.def.parameters["properties"] as Record<
      string,
      unknown
    >;
    assert.equal("run_in_background" in containerBashProperties, false);
    assert.equal(containerTools?.names().includes("bash_output"), false);
    assert.equal(containerTools?.names().includes("kill_shell"), false);
    const untrustedContainerBash = container.restrictedDevelopmentTools?.().get("bash");
    assert.ok(untrustedContainerBash);
    const untrustedContainerProperties = untrustedContainerBash.def.parameters[
      "properties"
    ] as Record<string, unknown>;
    assert.equal("run_in_background" in untrustedContainerProperties, false);
    assert.equal("network" in untrustedContainerProperties, false);
  } finally {
    await stack.artifacts.close?.();
    await stack.networkProxy.close();
    await stack.database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("production compositions close only their own browser ownership scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-browser-owner-"));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  const firstRegistry = new BrowserRegistry();
  const secondRegistry = new BrowserRegistry();
  let firstClosed = 0;
  let secondClosed = 0;
  await firstRegistry.add({ close: async () => void firstClosed++ });
  await secondRegistry.add({ close: async () => void secondClosed++ });
  const common = {
    cwd,
    env: {
      ANICODE_CREDENTIAL_BACKEND: "memory",
      ANICODE_NETWORK_PROXY_URL: "http://127.0.0.1:9317",
    },
    resolveProvider: () => ({ provider: new DebugProvider(), model: "demo" }),
  };
  const first = createProductionSessionManager({
    ...common,
    sessionsDir: path.join(root, "first-sessions"),
    browserRegistry: firstRegistry,
  });
  const second = createProductionSessionManager({
    ...common,
    sessionsDir: path.join(root, "second-sessions"),
    browserRegistry: secondRegistry,
  });
  try {
    await first.dispose();
    assert.equal(firstClosed, 1);
    assert.equal(secondClosed, 0, "disposing first manager must not close second browser owner");
    await second.dispose();
    assert.equal(secondClosed, 1);
  } finally {
    await Promise.allSettled([first.dispose(), second.dispose()]);
    await fs.rm(root, { recursive: true, force: true });
  }
});
