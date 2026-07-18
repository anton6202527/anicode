/**
 * 文件系统 agents（.claude/agents/*.md）：解析、发现优先级、Agent 装配。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSubagentFile, discoverSubagents } from "./agents-fs.js";
import { Agent } from "./agent.js";
import type { Provider, StreamEvent, StreamRequest, ToolDefinition } from "./types.js";

test("parseSubagentFile: 完整 frontmatter + 正文为 system", () => {
  const def = parseSubagentFile(
    "reviewer.md",
    [
      "---",
      "name: code-reviewer",
      "description: 审查代码质量",
      "tools: read, grep",
      "model: openai/gpt-5",
      "maxTurns: 12",
      "readonly: true",
      "---",
      "You review code.",
    ].join("\n"),
  );
  assert.ok(def);
  assert.equal(def.name, "code-reviewer");
  assert.equal(def.description, "审查代码质量");
  assert.deepEqual(def.tools, ["read", "grep"]);
  assert.equal(def.model, "openai/gpt-5");
  assert.equal(def.maxTurns, 12);
  assert.equal(def.readOnly, true);
  assert.equal(def.system, "You review code.");
});

test("parseSubagentFile: 文件名兜底 name；缺 description 无效", () => {
  const ok = parseSubagentFile("helper.md", "---\ndescription: 帮忙\n---\nbody");
  assert.equal(ok?.name, "helper");
  assert.equal(parseSubagentFile("x.md", "---\nname: x\n---\nbody"), null);
});

test("discoverSubagents: .anicode/agents 同名覆盖 .claude/agents", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-agents-"));
  try {
    const claudeDir = path.join(tmp, ".claude", "agents");
    const anicodeDir = path.join(tmp, ".anicode", "agents");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.mkdir(anicodeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, "helper.md"),
      "---\ndescription: 项目级\n---\nA",
      "utf8",
    );
    await fs.writeFile(
      path.join(claudeDir, "other.md"),
      "---\ndescription: 另一个\n---\nB",
      "utf8",
    );
    await fs.writeFile(
      path.join(anicodeDir, "helper.md"),
      "---\ndescription: 原生覆盖\n---\nC",
      "utf8",
    );
    const defs = await discoverSubagents(tmp);
    const helper = defs.find((d) => d.name === "helper");
    assert.equal(helper?.description, "原生覆盖");
    assert.ok(defs.some((d) => d.name === "other"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/** 捕获首次请求的工具定义后即结束。 */
function capturingProvider(sink: { tools: ToolDefinition[] }): Provider {
  return {
    name: "capture",
    async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
      sink.tools = req.tools ?? [];
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

test("Agent(subagents.discover): 首次 send 前注册 task 工具并含发现的类型", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-agents-wire-"));
  try {
    await fs.writeFile(
      path.join(tmp, "planner.md"),
      "---\ndescription: 规划任务\n---\nPlan things.",
      "utf8",
    );
    const sink = { tools: [] as ToolDefinition[] };
    const agent = new Agent({
      provider: capturingProvider(sink),
      model: "m",
      cwd: await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cwd-")),
      retry: false,
      projectMemory: false,
      injectEnv: false,
      subagents: { discover: true, dirs: [tmp] },
    });
    for await (const _ of agent.send("hi")) {
      /* drain */
    }
    const task = sink.tools.find((t) => t.name === "task");
    assert.ok(task, `task 工具未注册；实际: ${sink.tools.map((t) => t.name).join(",")}`);
    assert.match(task.description, /planner/);
    assert.match(task.description, /general/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Agent(subagents 数组): 构造期注册（行为不回退）", async () => {
  const sink = { tools: [] as ToolDefinition[] };
  const agent = new Agent({
    provider: capturingProvider(sink),
    model: "m",
    cwd: process.cwd(),
    retry: false,
    projectMemory: false,
    injectEnv: false,
    subagents: [{ name: "custom", description: "自定义类型" }],
  });
  for await (const _ of agent.send("hi")) {
    /* drain */
  }
  const task = sink.tools.find((t) => t.name === "task");
  assert.ok(task);
  assert.match(task.description, /custom/);
});
