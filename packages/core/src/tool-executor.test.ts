import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolExecutor } from "./tool-executor.js";
import { managedExternalTool, ToolError, ToolRegistry, type Tool } from "./tools/tool.js";
import { PermissionEngine } from "./permission.js";
import { HookRunner } from "./hooks.js";
import type { AgentEvent } from "./agent.js";
import type { ImagePart, ToolResultPart } from "./types.js";
import { SecurityPolicyEngine } from "./security/policy.js";
import { RuntimeTerminationError } from "./runtime/isolated-runtime.js";

function makeTool(
  name: string,
  opts: { readOnly: boolean; delayMs?: number; log: string[] },
): Tool {
  return {
    def: { name, description: name, parameters: { type: "object", properties: {} } },
    readOnly: opts.readOnly,
    ruleKey: () => name,
    run: async () => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      opts.log.push(name);
      return `out:${name}`;
    },
  };
}

function makeExecutor(
  tools: ToolRegistry,
  parallelInputsStable = true,
  limits: { maxConcurrentTools?: number; toolTimeoutMs?: number } = {},
): ToolExecutor {
  const perm = new PermissionEngine({
    mode: "auto",
    readOnlyTools: tools.readOnlyNames(),
    editTools: [],
  });
  return new ToolExecutor({
    tools,
    perm,
    hooks: new HookRunner([]),
    cwd: "/tmp",
    maxToolResultChars: 1000,
    ...limits,
    parallelInputsStable,
    supportsImages: () => false,
    addUsage: () => {},
  });
}

async function drain(
  gen: AsyncGenerator<AgentEvent, { results: { toolName: string; isError?: boolean }[] }>,
): Promise<{ toolName: string; isError?: boolean }[]> {
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  return r.value.results;
}

async function collectRun(gen: ReturnType<ToolExecutor["run"]>): Promise<{
  events: AgentEvent[];
  outcome: { results: ToolResultPart[]; images: ImagePart[] };
}> {
  const events: AgentEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, outcome: next.value };
}

function quotaWarnings(
  events: AgentEvent[],
  code: string,
): Extract<AgentEvent, { type: "tool_progress" }>[] {
  return events.filter((event): event is Extract<AgentEvent, { type: "tool_progress" }> => {
    if (event.type !== "tool_progress" || !event.event || typeof event.event !== "object") {
      return false;
    }
    return (event.event as { code?: unknown }).code === code;
  });
}

test("ToolExecutor.close drains raw executions even when isolated cleanup proof fails", async () => {
  const exec = makeExecutor(new ToolRegistry());
  let idleAwaited = false;
  const internals = exec as unknown as {
    isolatedRunner: { close(): Promise<void> };
    awaitIdle(): Promise<void>;
  };
  internals.isolatedRunner = {
    close: async () => {
      throw new RuntimeTerminationError();
    },
  };
  internals.awaitIdle = async () => {
    idleAwaited = true;
  };
  const first = exec.close();
  assert.equal(exec.close(), first);
  await assert.rejects(first, (error: unknown) => error instanceof RuntimeTerminationError);
  assert.equal(idleAwaited, true);
});

test("ToolExecutor preserves outcome-unknown semantics for managed HTTP timeout", async () => {
  const remote = managedExternalTool(
    {
      def: { name: "remote__write", description: "remote", parameters: { type: "object" } },
      capabilities: ["network"],
      readOnly: false,
      ruleKey: () => "remote-write",
      run: async (_input, context) =>
        await new Promise<string>((_resolve, reject) => {
          const abort = () => reject(context.signal.reason ?? new Error("cancelled"));
          if (context.signal.aborted) abort();
          else context.signal.addEventListener("abort", abort, { once: true });
        }),
    },
    {
      kind: "managed-external",
      protocol: "mcp-http",
      namespace: "remote",
      cancellation: "outcome-indeterminate",
    },
  );
  const tools = new ToolRegistry().registerExtension(remote);
  const result = await collectRun(
    makeExecutor(tools, true, { toolTimeoutMs: 1_000 }).run(
      [{ id: "http-timeout", name: remote.def.name, args: {} }],
      new AbortController().signal,
    ),
  );
  assert.equal(result.outcome.results[0]?.isError, true);
  assert.match(result.outcome.results[0]?.content ?? "", /超时.*远端操作结果未知/);
});

test("ToolExecutor: 连续只读并行执行，结果仍按调用顺序落位", async () => {
  const log: string[] = [];
  const tools = new ToolRegistry();
  tools.register(makeTool("slow", { readOnly: true, delayMs: 60, log }));
  tools.register(makeTool("fast", { readOnly: true, log }));
  const exec = makeExecutor(tools);
  const results = await drain(
    exec.run(
      [
        { id: "1", name: "slow", args: {} },
        { id: "2", name: "fast", args: {} },
      ],
      new AbortController().signal,
    ),
  );
  assert.deepEqual(
    results.map((x) => x.toolName),
    ["slow", "fast"],
  ); // 结果按调用顺序
  assert.deepEqual(log, ["fast", "slow"]); // 但确实并行：fast 先完成
});

test("ToolExecutor: 副作用调用打断并行批，严格按序串行", async () => {
  const log: string[] = [];
  const tools = new ToolRegistry();
  tools.register(makeTool("a", { readOnly: true, delayMs: 30, log }));
  tools.register(makeTool("w", { readOnly: false, log }));
  tools.register(makeTool("b", { readOnly: true, log }));
  const exec = makeExecutor(tools);
  await drain(
    exec.run(
      [
        { id: "1", name: "a", args: {} },
        { id: "2", name: "w", args: {} },
        { id: "3", name: "b", args: {} },
      ],
      new AbortController().signal,
    ),
  );
  assert.deepEqual(log, ["a", "w", "b"]);
});

test("ToolExecutor: parallelInputsStable=false 时只读调用也保守串行", async () => {
  const log: string[] = [];
  const tools = new ToolRegistry();
  tools.register(makeTool("s1", { readOnly: true, delayMs: 30, log }));
  tools.register(makeTool("s2", { readOnly: true, log }));
  const exec = makeExecutor(tools, false);
  await drain(
    exec.run(
      [
        { id: "1", name: "s1", args: {} },
        { id: "2", name: "s2", args: {} },
      ],
      new AbortController().signal,
    ),
  );
  assert.deepEqual(log, ["s1", "s2"]);
});

test("ToolExecutor: 并行安全工具仍受全局并发上限和背压约束", async () => {
  let active = 0;
  let peak = 0;
  const tools = new ToolRegistry();
  for (const name of ["a", "b", "c", "d", "e"]) {
    tools.register({
      def: { name, description: name, parameters: { type: "object" } },
      readOnly: true,
      ruleKey: () => name,
      async run() {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return name;
      },
    });
  }
  const exec = makeExecutor(tools, true, { maxConcurrentTools: 2 });
  const results = await drain(
    exec.run(
      ["a", "b", "c", "d", "e"].map((name, index) => ({
        id: String(index),
        name,
        args: {},
      })),
      new AbortController().signal,
    ),
  );
  assert.equal(peak, 2);
  assert.deepEqual(
    results.map((result) => result.toolName),
    ["a", "b", "c", "d", "e"],
  );
});

test("ToolExecutor: progress flood 按条数和 JSON 字节限流，每次工具仅告警一次", async () => {
  const tools = new ToolRegistry()
    .register({
      def: { name: "event-flood", description: "event-flood", parameters: { type: "object" } },
      readOnly: true,
      ruleKey: () => "event-flood",
      async run(_input, ctx) {
        for (let i = 0; i < 10_000; i++) ctx.emit?.({ i });
        return "count bounded";
      },
    })
    .register({
      def: { name: "byte-flood", description: "byte-flood", parameters: { type: "object" } },
      readOnly: true,
      ruleKey: () => "byte-flood",
      async run(_input, ctx) {
        for (let i = 0; i < 10_000; i++) ctx.emit?.("x".repeat(40));
        return "bytes bounded";
      },
    });
  const exec = new ToolExecutor({
    tools,
    perm: new PermissionEngine({ mode: "auto", readOnlyTools: tools.readOnlyNames() }),
    hooks: new HookRunner([]),
    cwd: "/tmp",
    maxToolResultChars: 1_000,
    maxProgressEvents: 2,
    maxProgressBytes: 64,
    parallelInputsStable: true,
    supportsImages: () => false,
    addUsage: () => undefined,
  });

  const { events, outcome } = await collectRun(
    exec.run(
      [
        { id: "event-id", name: "event-flood", args: {} },
        { id: "byte-id", name: "byte-flood", args: {} },
      ],
      new AbortController().signal,
    ),
  );
  const progress = events.filter(
    (event): event is Extract<AgentEvent, { type: "tool_progress" }> =>
      event.type === "tool_progress",
  );
  const warnings = quotaWarnings(events, "TOOL_PROGRESS_QUOTA_EXCEEDED");

  assert.equal(progress.filter((event) => event.id === "event-id").length, 3); // 2 payloads + warning
  assert.equal(progress.filter((event) => event.id === "byte-id").length, 2); // 1 payload + warning
  assert.deepEqual(warnings.map((event) => event.id).sort(), ["byte-id", "event-id"]);
  assert.equal(
    outcome.results.every((result) => !result.isError),
    true,
  );
});

test("ToolExecutor: attachImage flood 按张数和 base64 字节限流，每次工具仅告警一次", async () => {
  const image = (data: string): ImagePart => ({ type: "image", mediaType: "image/png", data });
  const tools = new ToolRegistry()
    .register({
      def: { name: "image-count", description: "image-count", parameters: { type: "object" } },
      readOnly: true,
      ruleKey: () => "image-count",
      async run(_input, ctx) {
        for (let i = 0; i < 10_000; i++) ctx.attachImage?.(image("a"));
        return "count bounded";
      },
    })
    .register({
      def: { name: "image-bytes", description: "image-bytes", parameters: { type: "object" } },
      readOnly: true,
      ruleKey: () => "image-bytes",
      async run(_input, ctx) {
        for (let i = 0; i < 10_000; i++) ctx.attachImage?.(image("123456"));
        return "bytes bounded";
      },
    });
  const exec = new ToolExecutor({
    tools,
    perm: new PermissionEngine({ mode: "auto", readOnlyTools: tools.readOnlyNames() }),
    hooks: new HookRunner([]),
    cwd: "/tmp",
    maxToolResultChars: 1_000,
    maxAttachedImages: 2,
    maxAttachedImageBytes: 10,
    parallelInputsStable: true,
    supportsImages: () => true,
    addUsage: () => undefined,
  });

  const { events, outcome } = await collectRun(
    exec.run(
      [
        { id: "image-count-id", name: "image-count", args: {} },
        { id: "image-bytes-id", name: "image-bytes", args: {} },
      ],
      new AbortController().signal,
    ),
  );
  const warnings = quotaWarnings(events, "TOOL_IMAGE_QUOTA_EXCEEDED");

  assert.deepEqual(
    outcome.images.map((part) => part.data),
    ["a", "a", "123456"],
  );
  assert.deepEqual(warnings.map((event) => event.id).sort(), ["image-bytes-id", "image-count-id"]);
});

test("ToolExecutor: 不合作的工具也会在统一超时后返回配对错误结果", async () => {
  const tools = new ToolRegistry().register({
    def: { name: "hung", description: "hung", parameters: { type: "object" } },
    readOnly: true,
    ruleKey: () => "hung",
    run: () => new Promise<string>(() => {}),
  });
  const exec = new ToolExecutor({
    tools,
    perm: new PermissionEngine({ mode: "auto", readOnlyTools: ["hung"] }),
    hooks: new HookRunner([]),
    cwd: "/tmp",
    maxToolResultChars: 1000,
    maxConcurrentTools: 1,
    toolTimeoutMs: 1_000,
    parallelInputsStable: true,
    supportsImages: () => false,
    addUsage: () => {},
  });
  const started = Date.now();
  const results = await drain(
    exec.run([{ id: "hung-1", name: "hung", args: {} }], new AbortController().signal),
  );
  assert.equal(results[0]?.isError, true);
  assert.ok(Date.now() - started < 2_000);
});

test("ToolExecutor: 未知工具合成配对的错误 tool_result（不抛、不缺配对）", async () => {
  const exec = makeExecutor(new ToolRegistry());
  const results = await drain(
    exec.run([{ id: "9", name: "nope", args: {} }], new AbortController().signal),
  );
  assert.equal(results.length, 1);
  assert.equal(results[0]!.isError, true);
});

test("ToolExecutor: provider 无法解析的工具参数在授权与执行链之前被脱敏拦截", async () => {
  const touched: string[] = [];
  const tools = new ToolRegistry().register({
    def: { name: "bash", description: "bash", parameters: { type: "object" } },
    readOnly: false,
    isConcurrencySafe: () => {
      touched.push("isConcurrencySafe");
      return false;
    },
    ruleKey: () => {
      touched.push("ruleKey");
      return "bash";
    },
    async run() {
      touched.push("run");
      return "unexpected";
    },
  });
  const hooks = new HookRunner([
    {
      event: "PreToolUse",
      handler() {
        touched.push("PreToolUse");
      },
    },
    {
      event: "PostToolUse",
      handler() {
        touched.push("PostToolUse");
      },
    },
  ]);
  const perm = new PermissionEngine({
    mode: "default",
    confirm: async () => {
      touched.push("permission");
      return { behavior: "allow" };
    },
  });
  const exec = new ToolExecutor({
    tools,
    perm,
    hooks,
    cwd: "/tmp",
    maxToolResultChars: 1_000,
    parallelInputsStable: true,
    supportsImages: () => false,
    addUsage: () => undefined,
  });
  const rawArguments = '{"command":"echo secret"';
  const events: AgentEvent[] = [];
  const generator = exec.run(
    [{ id: "invalid-json", name: "bash", args: { __unparsed: rawArguments } }],
    new AbortController().signal,
  );
  let next = await generator.next();
  while (!next.done) {
    events.push(next.value);
    next = await generator.next();
  }

  assert.deepEqual(touched, []);
  assert.deepEqual(
    events.map((event) => event.type),
    ["tool_result"],
  );
  assert.equal(next.value.results[0]?.isError, true);
  assert.match(next.value.results[0]?.content ?? "", /INVALID_TOOL_ARGUMENTS/);
  assert.equal(next.value.results[0]?.content.includes(rawArguments), false);
});

test("ToolExecutor: Pre/Post hook context 合并后仍受最终字符硬上限约束", async () => {
  const maxToolResultChars = 256;
  let postToolResult = "";
  const tools = new ToolRegistry().register({
    def: {
      name: "fail-large-hooks",
      description: "fail-large-hooks",
      parameters: { type: "object" },
    },
    readOnly: true,
    ruleKey: () => "fail-large-hooks",
    async run() {
      throw new ToolError("PRIMARY_TOOL_ERROR");
    },
  });
  const hooks = new HookRunner([
    {
      event: "PreToolUse",
      handler: () => ({ additionalContext: `PRE-BEGIN-${"p".repeat(10_000)}-PRE-END` }),
    },
    {
      event: "PostToolUse",
      handler: ({ toolResult }) => {
        postToolResult = toolResult ?? "";
        return { additionalContext: `POST-BEGIN-${"q".repeat(10_000)}-POST-END` };
      },
    },
  ]);
  const exec = new ToolExecutor({
    tools,
    perm: new PermissionEngine({ mode: "auto", readOnlyTools: tools.readOnlyNames() }),
    hooks,
    cwd: "/tmp",
    maxToolResultChars,
    parallelInputsStable: false,
    supportsImages: () => false,
    addUsage: () => undefined,
  });

  const { events, outcome } = await collectRun(
    exec.run(
      [{ id: "large-hooks", name: "fail-large-hooks", args: {} }],
      new AbortController().signal,
    ),
  );
  const result = outcome.results[0]!;
  const visible = events.find(
    (event): event is Extract<AgentEvent, { type: "tool_result" }> => event.type === "tool_result",
  )!;

  assert.ok(postToolResult.length <= maxToolResultChars);
  assert.equal(result.content.length <= maxToolResultChars, true);
  assert.equal(visible.content.length <= maxToolResultChars, true);
  assert.equal(result.isError, true);
  assert.match(result.content, /PRIMARY_TOOL_ERROR/);
  assert.match(result.content, /截断/);
  assert.match(result.content, /POST-END/);
});

test("ToolExecutor: 用户确认改写参数后仍重新经过硬安全策略", async () => {
  const log: string[] = [];
  const tool: Tool = {
    def: { name: "change", description: "change", parameters: { type: "object" } },
    readOnly: false,
    mutatesFiles: true,
    ruleKey: (input) => String(input["path"] ?? ""),
    async run(input) {
      log.push(String(input["path"]));
      return "changed";
    },
  };
  const tools = new ToolRegistry().register(tool);
  const exec = new ToolExecutor({
    tools,
    perm: new PermissionEngine({
      mode: "default",
      confirm: async () => ({ behavior: "allow", updatedInput: { path: ".env" } }),
    }),
    hooks: new HookRunner([]),
    cwd: "/tmp",
    maxToolResultChars: 1000,
    parallelInputsStable: false,
    supportsImages: () => false,
    addUsage: () => {},
    securityPolicy: new SecurityPolicyEngine({
      rules: [
        {
          id: "deny-env",
          effect: "deny",
          actions: ["tool:change"],
          resources: [".env"],
          reason: "credential files are protected",
        },
      ],
    }),
  });
  const results = await drain(
    exec.run(
      [{ id: "10", name: "change", args: { path: "safe.txt" } }],
      new AbortController().signal,
    ),
  );
  assert.deepEqual(log, []);
  assert.equal(results[0]?.isError, true);
});

test("ToolExecutor: durable execution fence 失败时副作用 tool body 不会 dispatch", async () => {
  let ran = false;
  const tools = new ToolRegistry().register({
    def: { name: "writeish", description: "writeish", parameters: { type: "object" } },
    readOnly: false,
    capabilities: ["filesystem-write"],
    ruleKey: () => "writeish",
    async run() {
      ran = true;
      return "unexpected";
    },
  });
  const exec = new ToolExecutor({
    tools,
    perm: new PermissionEngine({ mode: "auto" }),
    hooks: new HookRunner([]),
    cwd: "/tmp",
    maxToolResultChars: 1_000,
    parallelInputsStable: true,
    supportsImages: () => false,
    addUsage: () => undefined,
    beforeToolExecution: async () => {
      throw new Error("command lease lost");
    },
  });
  const results = await drain(
    exec.run([{ id: "fenced", name: "writeish", args: {} }], new AbortController().signal),
  );
  assert.equal(ran, false);
  assert.equal(results[0]?.isError, true);
});

test("ToolExecutor: filesystem-write 在 body dispatch 前即标 dirty，abort 不能清掉", async () => {
  const order: string[] = [];
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => (started = resolve));
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  const tools = new ToolRegistry().register({
    def: { name: "late-write", description: "late-write", parameters: { type: "object" } },
    readOnly: false,
    capabilities: ["filesystem-write"],
    ruleKey: () => "late-write",
    async run() {
      order.push("body");
      started();
      await gate;
      return "done";
    },
  });
  const controller = new AbortController();
  const exec = new ToolExecutor({
    tools,
    perm: new PermissionEngine({ mode: "auto" }),
    hooks: new HookRunner([]),
    cwd: "/tmp",
    maxToolResultChars: 1_000,
    parallelInputsStable: true,
    supportsImages: () => false,
    addUsage: () => undefined,
    onFilesChanged: () => order.push("dirty"),
  });
  const run = drain(exec.run([{ id: "late", name: "late-write", args: {} }], controller.signal));
  await didStart;
  assert.deepEqual(order, ["dirty", "body"]);
  controller.abort(new Error("lost command lease"));
  const results = await run;
  assert.equal(results[0]?.isError, true);
  assert.equal(order[0], "dirty");
  finish();
});

test("ToolExecutor: network-capable readOnly 工具默认要确认，plan 直接拒绝", async () => {
  for (const mode of ["default", "plan"] as const) {
    let ran = false;
    let asked = 0;
    let observedNetwork = false;
    const tools = new ToolRegistry().register({
      def: { name: "lookup", description: "lookup", parameters: { type: "object" } },
      readOnly: true,
      capabilities: ["network"],
      ruleKey: () => "example.test",
      async run() {
        ran = true;
        return "unexpected";
      },
    });
    assert.deepEqual(tools.permissionReadOnlyNames(), []);
    const exec = new ToolExecutor({
      tools,
      perm: new PermissionEngine({
        mode,
        readOnlyTools: tools.permissionReadOnlyNames(),
        confirm: async (request) => {
          asked++;
          observedNetwork = request.network === true;
          return { behavior: "deny" };
        },
      }),
      hooks: new HookRunner([]),
      cwd: "/tmp",
      maxToolResultChars: 1_000,
      parallelInputsStable: true,
      supportsImages: () => false,
      addUsage: () => undefined,
    });
    const result = await drain(
      exec.run([{ id: `net-${mode}`, name: "lookup", args: {} }], new AbortController().signal),
    );
    assert.equal(result[0]?.isError, true);
    assert.equal(ran, false);
    assert.equal(asked, mode === "default" ? 1 : 0);
    if (mode === "default") assert.equal(observedNetwork, true);
  }
});

test("ToolExecutor: raw tool body settles before awaitIdle releases late-side-effect fence", async () => {
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => (started = resolve));
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  let lateEffect = false;
  const tools = new ToolRegistry().register({
    def: { name: "noncooperative", description: "noncooperative", parameters: { type: "object" } },
    readOnly: false,
    capabilities: ["filesystem-write"],
    ruleKey: () => "noncooperative",
    async run() {
      started();
      await gate;
      lateEffect = true;
      return "done";
    },
  });
  const controller = new AbortController();
  const exec = new ToolExecutor({
    tools,
    perm: new PermissionEngine({ mode: "auto" }),
    hooks: new HookRunner([]),
    cwd: "/tmp",
    maxToolResultChars: 1_000,
    parallelInputsStable: true,
    supportsImages: () => false,
    addUsage: () => undefined,
  });
  const visible = drain(
    exec.run([{ id: "raw", name: "noncooperative", args: {} }], controller.signal),
  );
  await didStart;
  controller.abort(new Error("lease lost"));
  assert.equal((await visible)[0]?.isError, true);
  let idle = false;
  const idlePromise = exec.awaitIdle().then(() => (idle = true));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(idle, false);
  finish();
  await idlePromise;
  assert.equal(lateEffect, true);
});
