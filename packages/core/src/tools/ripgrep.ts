/**
 * ripgrep 后端 —— grep/glob 的高速实现。检测到 `rg` 时优先用它：
 * 天然尊重 .gitignore、跳过二进制、支持上下文行/大小写/多种输出模式，
 * 远快于逐文件 JS 扫描。检测不到（或执行失败）时调用方回退纯 JS 实现，
 * 保证离线/无 rg 环境仍可用。
 */

import { spawn } from "node:child_process";

let cachedAvailable: boolean | null = null;

/** 探测本机是否有可用的 ripgrep（结果缓存，避免每次调用都 spawn）。 */
export async function ripgrepAvailable(): Promise<boolean> {
  if (cachedAvailable !== null) return cachedAvailable;
  cachedAvailable = await new Promise<boolean>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("rg", ["--version"], { stdio: "ignore" });
    } catch {
      return resolve(false);
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  return cachedAvailable;
}

/** 仅供测试：重置探测缓存。 */
export function _resetRipgrepCache(): void {
  cachedAvailable = null;
}

export interface RgRunResult {
  /** stdout 按行拆分（已去掉尾空行） */
  lines: string[];
  /** 命中软上限被截断 */
  truncated: boolean;
  /** exit code（1 = 无匹配，非错误） */
  code: number | null;
}

/**
 * 跑一次 rg。maxLines 命中即杀进程（--max-count 无法跨文件封顶，故在读侧封顶）。
 * 返回 null 表示无法启动（调用方回退 JS）。
 */
export function runRipgrep(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  maxLines = 200,
): Promise<RgRunResult | null> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve({ lines: [], truncated: false, code: null });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }
    let buf = "";
    let truncated = false;
    let settled = false;
    const finish = (r: RgRunResult | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish({ lines: splitLines(buf), truncated, code: null });
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (b: Buffer) => {
      if (truncated) return;
      buf += b.toString();
      // 粗略封顶：行数超限就停，避免超大仓库把内存打满。
      if (countLines(buf) > maxLines) {
        truncated = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      const lines = splitLines(buf);
      if (lines.length > maxLines) {
        finish({ lines: lines.slice(0, maxLines), truncated: true, code });
      } else {
        finish({ lines, truncated, code });
      }
    });
  });
}

function splitLines(s: string): string[] {
  const lines = s.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function countLines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++;
  return n;
}
