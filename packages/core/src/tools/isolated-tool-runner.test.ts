import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "../agent.js";
import { HookRunner } from "../hooks.js";
import { PermissionEngine } from "../permission.js";
import type { ExecutionRuntime, IsolatedRunRequest } from "../runtime/isolated-runtime.js";
import { IsolatedRuntime, RuntimeTerminationError } from "../runtime/isolated-runtime.js";
import { ToolExecutor } from "../tool-executor.js";
import type { ImagePart, ToolResultPart } from "../types.js";
import {
  isolatedModuleTool,
  managedExternalTool,
  ToolRegistry,
  type IsolatedModuleToolManifest,
  type Tool,
  type ToolCapability,
} from "./tool.js";

const POSIX_NATIVE_RUNTIME_ONLY = {
  skip:
    process.platform === "win32" ? "the test-native module adapter requires a POSIX shell" : false,
};

/**
 * Test-only adapter that exercises IsolatedRuntime's real process-group termination. Production
 * deliberately does not advertise the native runtime as an untrusted-module security boundary;
 * declarative extensions are composed only with the pinned OCI runtime.
 */
class NativeFaultTestRuntime implements ExecutionRuntime {
  // Test-only: exercise the OCI command adapter through the real native process-group lifecycle.
  // Production composition accepts this declaration only from ContainerIsolatedRuntime.
  readonly toolModuleEnvironment = "container" as const;
  private readonly delegate = new IsolatedRuntime({
    // The test seam exercises process termination and Node permissions even on Linux CI images
    // without bwrap. Production never advertises this permissive native runtime for modules.
    failClosed: false,
    requireProxy: false,
    terminationGraceMs: 50,
  });

  run(request: IsolatedRunRequest) {
    return this.delegate.run(request);
  }
}

interface FixtureOptions {
  capabilities?: readonly ToolCapability[];
  readOnly?: boolean;
  mutatesFiles?: boolean;
  name?: string;
  ruleKeyFields?: readonly string[];
}

async function moduleFixture(
  root: string,
  source: string,
  options: FixtureOptions = {},
): Promise<Tool> {
  const file = `tool-${Math.random().toString(16).slice(2)}.mjs`;
  await fs.writeFile(path.join(root, file), source, "utf8");
  const capabilities = options.capabilities ?? [];
  const manifest: IsolatedModuleToolManifest = {
    version: 1,
    namespace: "fixture",
    name: options.name ?? "run",
    description: "isolated fixture",
    parameters: { type: "object", properties: {} },
    module: `./${file}`,
    sha256: createHash("sha256").update(source).digest("hex"),
    capabilities,
    readOnly: options.readOnly ?? true,
    ...(options.mutatesFiles !== undefined ? { mutatesFiles: options.mutatesFiles } : {}),
    ...(options.ruleKeyFields ? { ruleKeyFields: options.ruleKeyFields } : {}),
  };
  return isolatedModuleTool(manifest);
}

function executor(
  root: string,
  tool: Tool,
  timeoutMs = 3_000,
  runtime: ExecutionRuntime = new NativeFaultTestRuntime(),
): ToolExecutor {
  const tools = new ToolRegistry().registerExtension(tool);
  return new ToolExecutor({
    tools,
    perm: new PermissionEngine({
      mode: "auto",
      readOnlyTools: tools.readOnlyNames(),
      editTools: tools.editNames(),
    }),
    hooks: new HookRunner([]),
    cwd: root,
    maxToolResultChars: 4_096,
    maxConcurrentTools: 2,
    toolTimeoutMs: timeoutMs,
    maxProgressEvents: 4,
    maxProgressBytes: 1_024,
    parallelInputsStable: true,
    supportsImages: () => false,
    addUsage: () => undefined,
    isolatedRuntime: runtime,
  });
}

async function collect(run: ReturnType<ToolExecutor["run"]>): Promise<{
  events: AgentEvent[];
  results: ToolResultPart[];
  images: ImagePart[];
}> {
  const events: AgentEvent[] = [];
  let next = await run.next();
  while (!next.done) {
    events.push(next.value);
    next = await run.next();
  }
  return { events, ...next.value };
}

test("isolated manifests are data-only, branded, frozen and namespace collision-safe", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-isolated-manifest-"));
  try {
    const tool = await moduleFixture(root, 'export async function run() { return "ok"; }');
    assert.equal(tool.def.name, "fixture__run");
    assert.ok(Object.isFrozen(tool));
    assert.ok(Object.isFrozen(tool.def));
    assert.ok(Object.isFrozen(tool.def.parameters));
    assert.ok(Object.isFrozen(tool.execution));
    assert.ok(Object.isFrozen(tool.capabilities));
    const registry = new ToolRegistry().registerExtension(tool);
    assert.throws(() => registry.registerExtension(tool), /collision/i);
    const caseVariant = new ToolRegistry().register({
      def: {
        name: tool.def.name.toUpperCase(),
        description: "case collision",
        parameters: { type: "object" },
      },
      readOnly: true,
      ruleKey: () => "case",
      run: async () => "case",
    });
    assert.throws(() => caseVariant.registerExtension(tool), /canonicalization|collision/i);

    const forgedIsolated: Tool = {
      ...tool,
      def: { ...tool.def, name: "evil__fake" },
      execution: {
        kind: "isolated-module",
        protocolVersion: 1,
        namespace: "evil",
        module: "./fake.mjs",
        sha256: "0".repeat(64),
        exportName: "run",
      },
    };
    assert.throws(
      () => new ToolRegistry().registerExtension(forgedIsolated),
      /data-only manifest/i,
    );

    const forgedManaged: Tool = {
      def: { name: "evil__remote", description: "fake", parameters: { type: "object" } },
      execution: {
        kind: "managed-external",
        protocol: "mcp-stdio",
        namespace: "evil",
        cancellation: "close-confirmed",
      },
      readOnly: false,
      ruleKey: () => "evil",
      run: async () => "unsafe",
    };
    assert.throws(
      () => new ToolRegistry().registerExtension(forgedManaged),
      /core-owned proxy adapter/i,
    );

    const managed = (name: string) =>
      managedExternalTool(
        {
          def: { name, description: "managed", parameters: { type: "object" } },
          readOnly: false,
          ruleKey: () => name,
          run: async () => "managed",
        },
        {
          kind: "managed-external",
          protocol: "mcp-http",
          namespace: "x",
          cancellation: "outcome-indeterminate",
        },
      );
    for (const name of ["x__deploy)", "x__部署", "x__deploy\n"]) {
      assert.throws(() => managed(name), /name suffix is invalid/i);
    }
    const managedRegistry = new ToolRegistry().registerExtension(managed("x__Deploy"));
    assert.throws(() => managedRegistry.registerExtension(managed("x__deploy")), /collision/i);
    assert.throws(
      () =>
        new ToolRegistry().registerExtension({
          def: {
            name: "trusted)ambiguous",
            description: "invalid permission identifier",
            parameters: { type: "object" },
          },
          execution: { kind: "trusted-in-process" },
          readOnly: true,
          ruleKey: () => "trusted)ambiguous",
          run: async () => "unsafe",
        }),
      /trusted extension tool name is invalid/i,
    );

    const base = {
      version: 1,
      namespace: "fixture",
      name: "bad",
      description: "bad",
      parameters: { type: "object" },
      module: "./bad.mjs",
      sha256: "0".repeat(64),
      capabilities: [],
      readOnly: true,
    } as const;
    assert.throws(
      () => isolatedModuleTool({ ...base, parameters: [] } as never),
      /parameters must be a JSON object/i,
    );
    assert.throws(
      () =>
        isolatedModuleTool({
          ...base,
          capabilities: ["filesystem-read", "filesystem-read"],
        } as never),
      /duplicates/i,
    );
    const processOnly = isolatedModuleTool({
      ...base,
      name: "process",
      capabilities: ["process"],
      readOnly: false,
    } as never);
    assert.deepEqual(processOnly.capabilities, ["process"]);
    assert.throws(
      () => isolatedModuleTool({ ...base, capabilities: ["persistent-process"] } as never),
      /cannot declare persistent-process/i,
    );
    assert.deepEqual(
      new ToolRegistry().registerExtension(tool).permissionReadOnlyNames(),
      [],
      "readOnly must not auto-approve an untrusted isolated boundary",
    );
    assert.throws(
      () =>
        isolatedModuleTool({
          ...base,
          namespace: "a".repeat(40),
          name: "b".repeat(30),
        } as never),
      /full name exceeds 64/i,
    );
    assert.throws(
      () => isolatedModuleTool({ ...base, module: "./tool*.mjs" } as never),
      /literal traversal-free/i,
    );
    const cyclic: Record<string, unknown> = { ...base };
    cyclic["cycle"] = cyclic;
    assert.throws(() => isolatedModuleTool(cyclic as never), /cycle/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isolated tool rejects hostile input before callbacks or child execution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-isolated-input-"));
  try {
    const marker = path.join(root, "executed");
    const tool = await moduleFixture(
      root,
      `import { writeFile } from "node:fs/promises";
       export async function run() { await writeFile(${JSON.stringify(marker)}, "bad"); return "bad"; }`,
      {
        capabilities: ["filesystem-read", "filesystem-write"],
        readOnly: false,
        mutatesFiles: true,
      },
    );
    const args: Record<string, unknown> = {};
    Object.defineProperty(args, "secret", {
      enumerable: true,
      get() {
        throw new Error("accessor must never run");
      },
    });
    const result = await collect(
      executor(root, tool).run(
        [{ id: "1", name: tool.def.name, args }],
        new AbortController().signal,
      ),
    );
    assert.equal(result.results[0]?.isError, true);
    assert.match(result.results[0]?.content ?? "", /accessor/i);
    await assert.rejects(fs.access(marker));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isolated bundle integrity and file identity are proven before runtime dispatch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-isolated-integrity-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-isolated-outside-"));
  try {
    const source = 'export async function run() { return "ok"; }';
    await fs.writeFile(path.join(root, "bundle.mjs"), source, "utf8");
    await fs.writeFile(path.join(outside, "outside.mjs"), source, "utf8");
    await fs.symlink(path.join(outside, "outside.mjs"), path.join(root, "linked.mjs"));
    let calls = 0;
    const runtime: ExecutionRuntime = {
      toolModuleEnvironment: "container",
      async run() {
        calls++;
        throw new Error("must not dispatch");
      },
    };
    const manifest = (module: string, sha256: string, name: string) =>
      isolatedModuleTool({
        version: 1,
        namespace: "integrity",
        name,
        description: "integrity fixture",
        parameters: { type: "object" },
        module,
        sha256,
        capabilities: [],
        readOnly: true,
      });
    const wrongDigest = manifest("./bundle.mjs", "0".repeat(64), "digest");
    const digestResult = await collect(
      executor(root, wrongDigest, 3_000, runtime).run(
        [{ id: "digest", name: wrongDigest.def.name, args: {} }],
        new AbortController().signal,
      ),
    );
    assert.match(digestResult.results[0]?.content ?? "", /integrity check failed/i);

    const linked = manifest(
      "./linked.mjs",
      createHash("sha256").update(source).digest("hex"),
      "linked",
    );
    const linkedResult = await collect(
      executor(root, linked, 3_000, runtime).run(
        [{ id: "linked", name: linked.def.name, args: {} }],
        new AbortController().signal,
      ),
    );
    assert.match(linkedResult.results[0]?.content ?? "", /module is unavailable/i);
    assert.equal(calls, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test(
  "isolated modules are self-contained data-url bundles with no relative imports",
  POSIX_NATIVE_RUNTIME_ONLY,
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-isolated-self-contained-"));
    try {
      await fs.writeFile(
        path.join(root, "dependency.mjs"),
        'export const value = "dependency";',
        "utf8",
      );
      const tool = await moduleFixture(
        root,
        'import { value } from "./dependency.mjs"; export async function run() { return value; }',
        { name: "relative" },
      );
      const result = await collect(
        executor(root, tool).run(
          [{ id: "relative", name: tool.def.name, args: {} }],
          new AbortController().signal,
        ),
      );
      assert.equal(result.results[0]?.isError, true);
      assert.match(result.results[0]?.content ?? "", /isolated tool execution failed/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "isolated module process starts with a minimal image-independent environment",
  POSIX_NATIVE_RUNTIME_ONLY,
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-isolated-env-"));
    try {
      const tool = await moduleFixture(
        root,
        "export async function run() { return JSON.stringify(process.env); }",
        { name: "environment" },
      );
      const result = await collect(
        executor(root, tool).run(
          [{ id: "environment", name: tool.def.name, args: {} }],
          new AbortController().signal,
        ),
      );
      assert.equal(result.results[0]?.isError, undefined);
      const environment = JSON.parse(result.results[0]?.content ?? "{}") as Record<string, string>;
      assert.equal(environment["HOME"], "/tmp");
      assert.equal(environment["NODE_OPTIONS"], "");
      assert.equal(environment["NODE_PATH"], "");
      assert.equal(environment["PATH"], undefined);
      assert.deepEqual(
        Object.keys(environment).filter((key) => !key.startsWith("__CF_")),
        ["HOME", "NODE_OPTIONS", "NODE_PATH"],
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "isolated busy loop times out only after the real process tree is closed",
  POSIX_NATIVE_RUNTIME_ONLY,
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-isolated-loop-"));
    try {
      const tool = await moduleFixture(root, "export function run() { while (true) {} }", {
        name: "loop",
      });
      const started = Date.now();
      const result = await collect(
        executor(root, tool, 1_000).run(
          [{ id: "1", name: tool.def.name, args: {} }],
          new AbortController().signal,
        ),
      );
      assert.equal(result.results[0]?.isError, true);
      assert.match(result.results[0]?.content ?? "", /超时|timed out/i);
      assert.ok(Date.now() - started < 4_000, "busy loop must be force-killed within the deadline");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("isolated runner rejects workspace/network projections before runtime dispatch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-isolated-permission-"));
  try {
    let calls = 0;
    const runtime: ExecutionRuntime = {
      toolModuleEnvironment: "container",
      async run() {
        calls++;
        throw new Error("must not dispatch");
      },
    };
    const cases: Array<{ capabilities: readonly ToolCapability[]; mutatesFiles?: boolean }> = [
      { capabilities: ["filesystem-read"] },
      { capabilities: ["filesystem-read", "filesystem-write"], mutatesFiles: true },
      { capabilities: ["network"] },
    ];
    for (const [index, fixture] of cases.entries()) {
      const tool = await moduleFixture(root, 'export async function run() { return "bad"; }', {
        name: `denied${index}`,
        capabilities: fixture.capabilities,
        readOnly: false,
        ...(fixture.mutatesFiles ? { mutatesFiles: true } : {}),
      });
      const result = await collect(
        executor(root, tool, 3_000, runtime).run(
          [{ id: String(index), name: tool.def.name, args: {} }],
          new AbortController().signal,
        ),
      );
      assert.equal(result.results[0]?.isError, true);
      assert.match(result.results[0]?.content ?? "", /capability is unsupported/i);
    }
    assert.equal(calls, 0);

    const pure = await moduleFixture(root, 'export async function run() { return "bad"; }', {
      name: "wrongruntime",
    });
    const unsupportedRuntime: ExecutionRuntime = {
      toolModuleEnvironment: "unsupported",
      async run() {
        calls++;
        throw new Error("must not dispatch");
      },
    };
    const result = await collect(
      executor(root, pure, 3_000, unsupportedRuntime).run(
        [{ id: "runtime", name: pure.def.name, args: {} }],
        new AbortController().signal,
      ),
    );
    assert.match(result.results[0]?.content ?? "", /requires a container module boundary/i);
    assert.equal(calls, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  "isolated success force-exits late timers, and close is stable while SIGTERM is ignored",
  POSIX_NATIVE_RUNTIME_ONLY,
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-isolated-close-"));
    try {
      const late = path.join(root, "late-success");
      const success = await moduleFixture(
        root,
        `import { writeFileSync } from "node:fs";
       export async function run(_input, { cwd, emit }) {
         console.log("attacker stdout is not the protocol");
         emit({ step: 1 });
         setTimeout(() => writeFileSync(cwd + "/${path.basename(late)}", "late"), 200);
         return "ok";
       }`,
        {
          name: "success",
          capabilities: [],
          readOnly: false,
        },
      );
      const successResult = await collect(
        executor(root, success).run(
          [{ id: "1", name: success.def.name, args: {} }],
          new AbortController().signal,
        ),
      );
      assert.equal(successResult.results[0]?.content, "ok");
      assert.equal(successResult.results[0]?.isError, undefined);
      assert.equal(
        successResult.events.filter((event) => event.type === "tool_progress").length,
        1,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await assert.rejects(fs.access(late));

      const ignoredLateMarker = path.join(root, "ignored-late");
      const hanging = await moduleFixture(
        root,
        `export async function run() {
         try { process.on("SIGTERM", () => {}); }
         catch (error) { return "SIGNAL_" + String(error?.code ?? "FAILED"); }
         return await new Promise((resolve) => setTimeout(() => resolve("unexpected"), 5_000));
       }`,
        {
          name: "ignore",
          capabilities: [],
          readOnly: false,
        },
      );
      const exec = executor(root, hanging, 10_000);
      const running = collect(
        exec.run([{ id: "2", name: hanging.def.name, args: {} }], new AbortController().signal),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      const firstClose = exec.close();
      const secondClose = exec.close();
      assert.equal(firstClose, secondClose, "close must return one stable promise");
      await firstClose;
      const closedResult = await running;
      assert.equal(closedResult.results[0]?.isError, true);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await assert.rejects(fs.access(ignoredLateMarker));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("native IsolatedRuntime never advertises an untrusted module boundary", () => {
  assert.equal(new IsolatedRuntime({ failClosed: true }).toolModuleEnvironment, "unsupported");
  assert.equal(new IsolatedRuntime({ failClosed: false }).toolModuleEnvironment, "unsupported");
});

test("executor close rejects when the runtime cannot prove isolated workload cleanup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-isolated-proof-failure-"));
  try {
    const tool = await moduleFixture(root, 'export async function run() { return "unused"; }', {
      name: "proof",
    });
    let calls = 0;
    const runtime: ExecutionRuntime = {
      toolModuleEnvironment: "container",
      async run() {
        calls++;
        throw new RuntimeTerminationError();
      },
    };
    const exec = executor(root, tool, 10_000, runtime);
    const result = await collect(
      exec.run([{ id: "1", name: tool.def.name, args: {} }], new AbortController().signal),
    );
    assert.equal(result.results[0]?.isError, true);
    assert.match(result.results[0]?.content ?? "", /termination proof failed/i);
    const rejectedAfterPoison = await collect(
      exec.run([{ id: "2", name: tool.def.name, args: {} }], new AbortController().signal),
    );
    assert.match(rejectedAfterPoison.results[0]?.content ?? "", /failed termination proof/i);
    assert.equal(calls, 1, "a poisoned runner must never dispatch another workload");
    const close = exec.close();
    await assert.rejects(close, /termination proof failed/i);
    await assert.rejects(exec.close(), /termination proof failed/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("container adapter sends exact bundle bytes into a private workspace with a minimal environment", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-isolated-container-command-"));
  try {
    const source = 'export async function run() { return "unused"; }';
    const secret = "must-never-cross-the-container-boundary";
    await fs.writeFile(path.join(root, ".env"), secret, "utf8");
    const tool = await moduleFixture(root, source, {
      name: "process",
      capabilities: ["process"],
      readOnly: false,
    });
    let captured: IsolatedRunRequest | undefined;
    let invocationValue: Record<string, unknown> | undefined;
    const runtime: ExecutionRuntime = {
      toolModuleEnvironment: "container",
      async run(request) {
        captured = request;
        assert.notEqual(request.cwd, root);
        assert.deepEqual(await fs.readdir(request.cwd), []);
        const modulePath = tool.execution?.kind === "isolated-module" ? tool.execution.module : "";
        await fs.writeFile(path.join(root, modulePath.slice(2)), "malicious replacement", "utf8");
        const match = request.stdin?.match(/await runIsolatedTool\(("[^"]+")\);/);
        assert.ok(match);
        const encoded = JSON.parse(match[1]!) as string;
        const invocation = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<
          string,
          unknown
        > & { nonce: string; sourceBase64: string };
        invocationValue = invocation;
        assert.equal(Buffer.from(invocation.sourceBase64, "base64").toString("utf8"), source);
        assert.equal(request.stdin?.includes(secret), false);
        const payload = JSON.stringify({
          version: 1,
          status: "ok",
          content: "ok",
          progress: [],
          progressTruncated: false,
        });
        return {
          exitCode: 0,
          output: `ANICODE_ISOLATED_TOOL_V1_${invocation.nonce}:${payload}\n`,
          controlOutput: `ANICODE_ISOLATED_TOOL_V1_${invocation.nonce}:${payload}\n`,
          timedOut: false,
          sandboxed: true,
          durationMs: 1,
        };
      },
    };
    const result = await collect(
      executor(root, tool, 3_000, runtime).run(
        [{ id: "1", name: tool.def.name, args: {} }],
        new AbortController().signal,
      ),
    );
    assert.equal(result.results[0]?.content, "ok");
    assert.equal(captured?.network, false);
    assert.equal(captured?.workspaceExposure, "none");
    assert.equal(captured?.policy, "read-only");
    assert.ok(captured?.cwd);
    await assert.rejects(fs.access(captured!.cwd));
    assert.equal(Object.hasOwn(invocationValue ?? {}, "module"), false);
    assert.match(captured?.command ?? "", /NODE_MAJOR=.*NODE_MINOR=/);
    assert.match(captured?.command ?? "", /NODE_MAJOR.*-lt 22/);
    assert.match(captured?.command ?? "", /NODE_MINOR.*-lt 15/);
    assert.match(captured?.command ?? "", /--allow-child-process/);
    assert.match(captured?.command ?? "", /env[^;]*-i HOME=\/tmp NODE_OPTIONS= NODE_PATH=/i);
    assert.doesNotMatch(captured?.command ?? "", /--allow-fs-(?:read|write)=/);
    assert.doesNotMatch(captured?.command ?? "", /\/workspace\/tool-/);
    assert.match(captured?.workload?.tenantId ?? "", /^workspace:[a-f0-9]{32}$/);
    assert.match(captured?.workload?.executionId ?? "", /^tool:[a-f0-9]{32}$/);
    assert.equal(captured?.workload?.actor, `isolated-tool:${tool.def.name}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
