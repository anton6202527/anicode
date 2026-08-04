import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LspClient, LspPool, pickLspServer } from "./lsp.js";
import { createDiagnosticsTool } from "./tools/diagnostics.js";
import type { ExecutionRuntime } from "./runtime/isolated-runtime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "testutil", "fake-lsp-server.mjs");
const cfg = {
  command: process.execPath,
  args: [serverPath], // 纯 JS，任意 cwd 可跑（不依赖 tsx 解析）
  extensions: [".ts", ".tsx"],
};

test("LSP: 握手 → didOpen → 收到 publishDiagnostics", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-lsp-"));
  const file = path.join(dir, "a.ts");
  await fs.writeFile(file, "const x: number = 1;\nconst y = x;\nbad code here\n");
  const client = LspClient.start(dir, cfg);
  const diags = await client.diagnose(file, 3000);
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.severity, "error");
  assert.equal(diags[0]!.line, 3); // 0-based 2 → 1-based 3
  assert.equal(diags[0]!.column, 5);
  assert.match(diags[0]!.message, /类型不匹配/);
  await client.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("LSP: diagnostics 工具格式化输出；未配置扩展名给出提示", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-lsp-"));
  await fs.writeFile(path.join(dir, "a.ts"), "x\n");
  const pool = new LspPool(dir, [cfg]);
  const tool = createDiagnosticsTool(pool);
  const ctx = { cwd: dir, signal: new AbortController().signal } as any;
  const out = await tool.run({ path: "a.ts" }, ctx);
  assert.match(out, /a\.ts:3:5 \[error\] 类型不匹配/);
  const none = await tool.run({ path: "readme.md" }, ctx);
  assert.match(none, /没有为 .md 配置语言服务器/);
  await pool.closeAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("LSP: pickLspServer 按扩展名匹配（大小写不敏感）", () => {
  const s = pickLspServer([cfg], ".TS");
  assert.ok(s);
  assert.equal(pickLspServer([cfg], ".go"), undefined);
});

test("LSP: production runtime 以只读、断网策略 prepare 持久进程", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-lsp-isolated-"));
  const file = path.join(dir, "a.ts");
  await fs.writeFile(file, "bad code here\n");
  const requests: string[] = [];
  const runtime: ExecutionRuntime = {
    async run() {
      throw new Error("persistent LSP must use prepare");
    },
    prepare(request) {
      requests.push(`${request.policy}:${request.network}:${request.cwd}`);
      return {
        file: process.execPath,
        args: [serverPath],
        cwd: request.cwd,
        env: { PATH: process.env.PATH },
        sandboxed: true,
      };
    },
  };
  const pool = new LspPool(dir, [cfg], runtime);
  const diagnostics = await pool.clientFor(".ts")!.diagnose(file, 3000);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(requests, [`read-only:false:${await fs.realpath(dir)}`]);
  await pool.closeAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("LSP: 无响应 server 在请求超时后失败，不得挂住 agent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-lsp-timeout-"));
  const file = path.join(dir, "a.ts");
  await fs.writeFile(file, "const x = 1\n");
  const client = LspClient.start(dir, {
    command: process.execPath,
    args: ["-e", "setInterval(()=>{}, 1000)"],
    extensions: [".ts"],
    timeoutMs: 100,
  });
  await assert.rejects(client.diagnose(file), /LSP request timed out: initialize/);
  await client.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("LSP: 拒绝输入 symlink 逃逸，并过滤 server 返回的 workspace 外 URI", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-lsp-boundary-"));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-lsp-host-"));
  const file = path.join(dir, "a.ts");
  const outside = path.join(outsideDir, "secret.ts");
  await fs.writeFile(file, "const x = 1\n");
  await fs.writeFile(outside, "HOST_CANARY\n");
  await fs.symlink(outside, path.join(dir, "escape.ts"));
  const oversized = path.join(dir, "oversized.ts");
  await fs.writeFile(oversized, "x");
  await fs.truncate(oversized, 8 * 1024 * 1024 + 1);
  const client = LspClient.start(dir, cfg);
  await assert.rejects(() => client.diagnose(path.join(dir, "escape.ts")), /escapes the workspace/);
  await assert.rejects(() => client.diagnose(oversized), /exceeds the 8 MiB limit/);
  const definitions = await client.definition(file, { line: 0, character: 0 });
  assert.deepEqual(definitions, [{ path: await fs.realpath(file), line: 1, column: 1 }]);
  assert.deepEqual(await client.workspaceSymbols("outside"), []);
  await client.close();
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(outsideDir, { recursive: true, force: true });
});

test("LSP: 工具声明真实的持久进程与文件读取 capabilities", async () => {
  const pool = new LspPool(process.cwd(), []);
  assert.deepEqual(createDiagnosticsTool(pool).capabilities, [
    "filesystem-read",
    "process",
    "persistent-process",
  ]);
});
