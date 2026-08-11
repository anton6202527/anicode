import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentEvent } from "./agent.js";
import { commandHook } from "./hooks-exec.js";
import { ToolRegistry, type Tool } from "./tools/tool.js";
import type { ExecutionRuntime, IsolatedRunRequest } from "./runtime/isolated-runtime.js";
import type { Verifier } from "./runtime/verifier.js";
import type { Provider, StreamEvent, Usage } from "./types.js";

const usage: Usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function done(message: StreamEvent & { type: "done" }): StreamEvent {
  return message;
}

function scriptedToolProvider(toolName: string, args: Record<string, unknown>): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream() {
      turn++;
      if (turn === 1) {
        const call = { type: "tool_call" as const, id: "call-1", name: toolName, args };
        yield done({
          type: "done",
          stopReason: "tool_use",
          message: { role: "assistant", content: [call] },
          usage,
        });
        return;
      }
      yield done({
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        usage,
      });
    },
  };
}

function passingVerifier(observed: string[][]): Verifier {
  return {
    async verify(request: { changedFiles?: string[] }) {
      observed.push([...(request.changedFiles ?? [])]);
      const now = new Date().toISOString();
      return {
        id: "verification-test",
        status: "passed" as const,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        checks: [],
        summary: "passed",
      };
    },
  } as unknown as Verifier;
}

async function collect(agent: Agent): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.send("go")) events.push(event);
  return events;
}

test("Verifier dirty: bash 重定向使用 cwd sentinel 并在 done 前验证", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-verify-bash-"));
  const observed: string[][] = [];
  let request: IsolatedRunRequest | undefined;
  const runtime: ExecutionRuntime = {
    async run(input) {
      request = input;
      await fs.writeFile(path.join(input.cwd, "generated.txt"), "verified");
      return { exitCode: 0, output: "", timedOut: false, sandboxed: true, durationMs: 1 };
    },
  };
  try {
    const agent = new Agent({
      provider: scriptedToolProvider("bash", { command: "printf verified > generated.txt" }),
      model: "m",
      modelInfo: {
        providerId: "test",
        model: "m",
        capabilities: { tools: true },
        limits: { maxOutputTokens: 64 },
      },
      cwd,
      system: "",
      projectMemory: false,
      injectEnv: false,
      permission: { mode: "auto" },
      isolatedRuntime: runtime,
      verifier: passingVerifier(observed),
      retry: false,
    });
    const events = await collect(agent);
    assert.equal(request?.command, "printf verified > generated.txt");
    assert.equal(request?.cwd, cwd);
    assert.equal(await fs.readFile(path.join(cwd, "generated.txt"), "utf8"), "verified");
    assert.deepEqual(observed, [[cwd]]);
    assert.ok(events.findIndex((event) => event.type === "verification") >= 0);
    assert.ok(
      events.findIndex((event) => event.type === "verification") <
        events.findIndex((event) => event.type === "done"),
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("Verifier dirty: mutation-capable Stop command hook 在最终验证之前运行", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-verify-stop-"));
  const observed: string[][] = [];
  try {
    const provider: Provider = {
      name: "one-turn",
      async *stream() {
        yield done({
          type: "done",
          stopReason: "end_turn",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
          usage,
        });
      },
    };
    const agent = new Agent({
      provider,
      model: "m",
      modelInfo: {
        providerId: "test",
        model: "m",
        capabilities: { tools: false },
        limits: { maxOutputTokens: 64 },
      },
      cwd,
      system: "",
      projectMemory: false,
      injectEnv: false,
      hooks: [commandHook({ event: "Stop", command: "printf stop > stop-hook.txt" })],
      verifier: passingVerifier(observed),
      retry: false,
    });
    const events = await collect(agent);
    assert.equal(await fs.readFile(path.join(cwd, "stop-hook.txt"), "utf8"), "stop");
    assert.deepEqual(observed, [[cwd]]);
    assert.ok(events.some((event) => event.type === "done"));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("Verifier dirty: mutation-capable Pre/PostToolUse hooks 都不能绕过验证", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-verify-tool-hooks-"));
  const observed: string[][] = [];
  const noop: Tool = {
    def: { name: "noop", description: "noop", parameters: { type: "object" } },
    readOnly: true,
    ruleKey: () => "noop",
    async run() {
      return "ok";
    },
  };
  try {
    const agent = new Agent({
      provider: scriptedToolProvider("noop", {}),
      model: "m",
      modelInfo: {
        providerId: "test",
        model: "m",
        capabilities: { tools: true },
        limits: { maxOutputTokens: 64 },
      },
      cwd,
      system: "",
      projectMemory: false,
      injectEnv: false,
      tools: new ToolRegistry().register(noop),
      permission: { mode: "auto" },
      hooks: [
        commandHook({ event: "PreToolUse", command: "printf pre > hook.txt" }),
        commandHook({ event: "PostToolUse", command: "printf post >> hook.txt" }),
      ],
      verifier: passingVerifier(observed),
      retry: false,
    });
    const events = await collect(agent);
    assert.equal(await fs.readFile(path.join(cwd, "hook.txt"), "utf8"), "prepost");
    assert.deepEqual(observed, [[cwd]]);
    assert.ok(events.some((event) => event.type === "verification"));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
