import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolExecutor } from "./tool-executor.js";
import { ToolRegistry, type Tool } from "./tools/tool.js";
import { PermissionEngine } from "./permission.js";
import { HookRunner } from "./hooks.js";
import type { AgentEvent } from "./agent.js";
import { SecurityPolicyEngine } from "./security/policy.js";

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

function makeExecutor(tools: ToolRegistry, parallelInputsStable = true): ToolExecutor {
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

test("ToolExecutor: 未知工具合成配对的错误 tool_result（不抛、不缺配对）", async () => {
  const exec = makeExecutor(new ToolRegistry());
  const results = await drain(
    exec.run([{ id: "9", name: "nope", args: {} }], new AbortController().signal),
  );
  assert.equal(results.length, 1);
  assert.equal(results[0]!.isError, true);
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
