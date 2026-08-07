import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { productionSessionManagerOptions } from "./production-session-manager.js";
import { ContainerIsolatedRuntime } from "./runtime/container-runtime.js";
import type { ExecutionRuntime } from "./runtime/isolated-runtime.js";
import { createLocalRuntimeStack } from "./runtime/local-stack.js";
import { noTelemetry } from "./runtime/telemetry.js";
import { TransactionalExecutionRuntime } from "./runtime/transactional-runtime.js";
import { isolatedModuleTool, ToolRegistry, type IsolatedModuleToolManifest } from "./tools/tool.js";

test("production advertises declarative modules only with matching OCI capabilities", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-production-isolated-"));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  const source = 'export async function run() { return "ok"; }';
  await fs.writeFile(path.join(cwd, "tool.mjs"), source, "utf8");
  const digest = createHash("sha256").update(source).digest("hex");
  const pure: IsolatedModuleToolManifest = {
    version: 1,
    namespace: "extension",
    name: "pure",
    description: "pure isolated fixture",
    parameters: { type: "object" },
    module: "./tool.mjs",
    sha256: digest,
    capabilities: [],
    readOnly: true,
  };
  const processTool: IsolatedModuleToolManifest = {
    ...pure,
    name: "process",
    capabilities: ["process"],
    readOnly: false,
  };
  const memoryTool: IsolatedModuleToolManifest = {
    ...pure,
    name: "memory",
    capabilities: ["memory"],
  };
  const networkTool: IsolatedModuleToolManifest = {
    ...pure,
    name: "network",
    capabilities: ["network"],
    readOnly: false,
  };
  const readTool: IsolatedModuleToolManifest = {
    ...pure,
    name: "read",
    capabilities: ["filesystem-read"],
  };
  const writeTool: IsolatedModuleToolManifest = {
    ...pure,
    name: "write",
    capabilities: ["filesystem-read", "filesystem-write"],
    readOnly: false,
    mutatesFiles: true,
  };
  const env: NodeJS.ProcessEnv = { ANICODE_CREDENTIAL_BACKEND: "memory" };
  const stack = createLocalRuntimeStack(root, env);
  const input = {
    cwd,
    sessionsDir: path.join(root, "sessions"),
    isolatedTools: [pure, processTool, memoryTool],
  };
  const fakeContainerRuntime: ExecutionRuntime = {
    toolModuleEnvironment: "container",
    toolModuleNetworkBoundary: "unsupported",
    run: (request) => stack.isolatedRuntime.run(request),
  };
  const containerDelegate = new ContainerIsolatedRuntime({
    image: `runtime@sha256:${"a".repeat(64)}`,
    processRunner: async () => ({ exitCode: 0, output: "", timedOut: false }),
  });
  const containerRuntime = new TransactionalExecutionRuntime(containerDelegate);
  try {
    assert.throws(
      () =>
        productionSessionManagerOptions(
          input,
          { ...stack, executionMode: "native-isolated" },
          noTelemetry,
        ),
      /require container execution mode/i,
    );
    assert.throws(
      () =>
        productionSessionManagerOptions(
          input,
          { ...stack, executionMode: "restricted" },
          noTelemetry,
        ),
      /require container execution mode/i,
    );
    assert.throws(
      () =>
        productionSessionManagerOptions(
          input,
          { ...stack, executionMode: "container" },
          noTelemetry,
        ),
      /capability mismatch/i,
    );
    assert.throws(
      () =>
        productionSessionManagerOptions(
          input,
          {
            ...stack,
            executionMode: "container",
            isolatedRuntime: fakeContainerRuntime,
          },
          noTelemetry,
        ),
      /capability mismatch/i,
    );

    const container = productionSessionManagerOptions(
      input,
      {
        ...stack,
        executionMode: "container",
        isolatedRuntime: containerRuntime,
      },
      noTelemetry,
    );
    const names = container.tools?.().names() ?? [];
    assert.ok(names.includes("extension__pure"));
    assert.ok(names.includes("extension__process"));
    assert.ok(names.includes("extension__memory"));
    const containerHooks = productionSessionManagerOptions(
      {
        cwd,
        sessionsDir: path.join(root, "sessions"),
        config: { hooks: [{ event: "Stop", command: "true" }] },
      },
      {
        ...stack,
        executionMode: "container",
        isolatedRuntime: containerRuntime,
      },
      noTelemetry,
    );
    assert.equal(containerHooks.hooks?.length, 1);
    const fakeContainerHooks = productionSessionManagerOptions(
      {
        cwd,
        sessionsDir: path.join(root, "sessions"),
        config: { hooks: [{ event: "Stop", command: "true" }] },
      },
      {
        ...stack,
        executionMode: "container",
        isolatedRuntime: fakeContainerRuntime,
      },
      noTelemetry,
    );
    assert.equal(fakeContainerHooks.hooks, undefined);

    assert.throws(
      () =>
        productionSessionManagerOptions(
          { ...input, isolatedTools: [networkTool] },
          {
            ...stack,
            executionMode: "container",
            isolatedRuntime: containerRuntime,
          },
          noTelemetry,
        ),
      /network capability is unsupported/i,
    );
    assert.throws(
      () =>
        productionSessionManagerOptions(
          { ...input, isolatedTools: [networkTool] },
          {
            ...stack,
            executionMode: "container",
            isolatedRuntime: {
              ...fakeContainerRuntime,
              toolModuleNetworkBoundary: "scoped-proxy",
            },
          },
          noTelemetry,
        ),
      /capability mismatch/i,
    );
    for (const unsupported of [readTool, writeTool]) {
      assert.throws(
        () =>
          productionSessionManagerOptions(
            { ...input, isolatedTools: [unsupported] },
            {
              ...stack,
              executionMode: "container",
              isolatedRuntime: containerRuntime,
            },
            noTelemetry,
          ),
        /filesystem-(?:read|write) capability is unsupported/i,
      );
    }

    const dynamic = productionSessionManagerOptions(
      {
        cwd,
        sessionsDir: path.join(root, "sessions"),
        tools: () => new ToolRegistry().registerExtension(isolatedModuleTool(pure)),
      },
      { ...stack, executionMode: "native-isolated" },
      noTelemetry,
    );
    assert.throws(() => dynamic.tools?.(), /require container execution mode/i);

    const dynamicUnsupported = productionSessionManagerOptions(
      {
        cwd,
        sessionsDir: path.join(root, "sessions"),
        tools: () => new ToolRegistry().registerExtension(isolatedModuleTool(readTool)),
      },
      {
        ...stack,
        executionMode: "container",
        isolatedRuntime: containerRuntime,
      },
      noTelemetry,
    );
    assert.throws(() => dynamicUnsupported.tools?.(), /filesystem-read capability is unsupported/i);
  } finally {
    await containerRuntime.shutdown();
    await stack.artifacts.close?.();
    await stack.networkProxy.close();
    await stack.database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
