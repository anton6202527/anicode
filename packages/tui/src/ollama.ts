/**
 * 本地 Ollama 就绪检查。默认绝不从 PATH 自动执行二进制；需要自启动时，用户必须
 * 同时显式启用开关并提供一个绝对、可信的可执行文件路径。
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { terminateProcessTree } from "@anicode/core/tui-runtime";

const DEFAULT_BASE = "http://127.0.0.1:11434";

function rootOf(base: string): string {
  return base.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

export function safeOllamaBase(base: string): string | undefined {
  try {
    const url = new URL(rootOf(base));
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/** 探测 Ollama 是否在跑（GET /api/tags，短超时）。 */
export async function ollamaLive(base = DEFAULT_BASE): Promise<boolean> {
  const safeBase = safeOllamaBase(base);
  if (!safeBase) return false;
  try {
    const res = await fetch(`${safeBase}/api/tags`, {
      signal: AbortSignal.timeout(800),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 确保 Ollama 在跑：默认只检查，不执行 PATH。显式配置可信绝对路径后才允许自启动。
 */
export async function ensureOllama(
  base = process.env["OLLAMA_BASE_URL"] || DEFAULT_BASE,
  timeoutMs = 15000,
): Promise<"running" | "started" | "manual" | "unsafe" | "missing" | "timeout"> {
  if (!safeOllamaBase(base)) return "unsafe";
  if (await ollamaLive(base)) return "running";

  if (process.env["ANICODE_OLLAMA_AUTO_START"] !== "1") return "manual";
  const configuredExecutable = process.env["ANICODE_OLLAMA_EXECUTABLE"];
  if (!configuredExecutable || !path.isAbsolute(configuredExecutable)) return "missing";
  let executable: string;
  try {
    executable = await fs.realpath(configuredExecutable);
    const stat = await fs.stat(executable);
    if (!stat.isFile()) return "missing";
    if (process.platform !== "win32") {
      const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (
        (currentUid !== undefined && stat.uid !== currentUid && stat.uid !== 0) ||
        stat.mode & 0o022
      ) {
        return "missing";
      }
    }
  } catch {
    return "missing";
  }

  let child: ReturnType<typeof spawn> | undefined;
  const spawned = await new Promise<boolean>((resolve) => {
    try {
      child = spawn(executable, ["serve"], {
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
        env: ollamaEnvironment(),
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok || !child) {
        resolve(ok);
      } else {
        void terminateProcessTree(child).then(
          () => resolve(false),
          () => resolve(false),
        );
      }
    };
    const timer = setTimeout(() => done(false), 5_000);
    child.once("error", () => done(false));
    child.once("spawn", () => {
      child!.unref();
      done(true);
    });
  });
  if (!spawned) return "missing";

  const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 60_000));
  while (Date.now() < deadline) {
    await delay(300);
    if (await ollamaLive(base)) return "started";
  }
  if (child) await terminateProcessTree(child);
  return "timeout";
}

function ollamaEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "OLLAMA_HOST",
    "OLLAMA_MODELS",
    "OLLAMA_KEEP_ALIVE",
    "OLLAMA_NUM_PARALLEL",
    "OLLAMA_MAX_LOADED_MODELS",
  ];
  return Object.fromEntries(
    allowed.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}
