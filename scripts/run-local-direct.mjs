#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_ENV_BYTES = 4 * 1024 * 1024;
export const LOCAL_DIRECT_MODEL = "deepseek/deepseek-v4-flash";
export const LOCAL_DIRECT_CREDENTIAL = "DEEPSEEK_API_KEY";
export const LOCAL_DIRECT_BASE_URL = "https://api.deepseek.com/v1";
export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseLocalDeepSeekKey(raw) {
  const matches = [];
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const equals = normalized.indexOf("=");
    if (equals <= 0 || normalized.slice(0, equals).trim() !== LOCAL_DIRECT_CREDENTIAL) continue;
    let value = normalized.slice(equals + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trimEnd();
    }
    if (!value) throw new Error(`${LOCAL_DIRECT_CREDENTIAL} in .env is empty`);
    matches.push(value);
  }
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `${LOCAL_DIRECT_CREDENTIAL} is missing from the repository .env`
        : `${LOCAL_DIRECT_CREDENTIAL} must appear exactly once in the repository .env`,
    );
  }
  return matches[0];
}

export async function readLocalDeepSeekKey(file = path.join(REPOSITORY_ROOT, ".env")) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(file, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ENV_BYTES) {
      throw new Error("repository .env must be a bounded regular file");
    }
    return parseLocalDeepSeekKey(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

export function localDirectEnvironment(source, key, repositoryRoot = REPOSITORY_ROOT) {
  return {
    ...source,
    [LOCAL_DIRECT_CREDENTIAL]: key,
    DEEPSEEK_BASE_URL: LOCAL_DIRECT_BASE_URL,
    ANICODE_CREDENTIAL_BACKEND: "memory",
    ANICODE_DISABLE_OS_KEYCHAIN: "1",
    ANICODE_DEV_DIRECT: "1",
    ANICODE_DEV_WORKSPACE: repositoryRoot,
    ANICODE_DEV_DEFAULT_MODEL: LOCAL_DIRECT_MODEL,
  };
}

export function localDirectCommand(mode, repositoryRoot = REPOSITORY_ROOT) {
  if (mode === "tui") {
    return {
      cwd: repositoryRoot,
      args: [
        "--import",
        "tsx",
        path.join(repositoryRoot, "packages/tui/src/cli.tsx"),
        "--model",
        LOCAL_DIRECT_MODEL,
        "--cwd",
        repositoryRoot,
        "--sessions",
        path.join(repositoryRoot, ".anicode-dev/sessions"),
        "--debug-log",
        path.join(repositoryRoot, ".anicode-dev/tui.jsonl"),
      ],
    };
  }
  if (mode === "app") {
    const resolveFromApp = createRequire(path.join(repositoryRoot, "packages/app/package.json"));
    const electronVitePackage = resolveFromApp.resolve("electron-vite/package.json");
    return {
      cwd: path.join(repositoryRoot, "packages/app"),
      args: [path.join(path.dirname(electronVitePackage), "bin/electron-vite.js"), "."],
    };
  }
  throw new Error("Usage: node scripts/run-local-direct.mjs <tui|app>");
}

export async function runLocalDirect(mode) {
  const command = localDirectCommand(mode);
  const key = await readLocalDeepSeekKey();
  const child = spawn(process.execPath, command.args, {
    cwd: command.cwd,
    env: localDirectEnvironment(process.env, key),
    stdio: "inherit",
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code ?? 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const mode = process.argv.length === 3 ? process.argv[2] : undefined;
  runLocalDirect(mode).catch((error) => {
    const message = error instanceof Error ? error.message : "unknown startup error";
    console.error(`Local direct DeepSeek startup failed: ${message}`);
    process.exitCode = 1;
  });
}
