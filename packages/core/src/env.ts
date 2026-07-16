/**
 * 环境接地（environment grounding）——对齐 Claude Code / Codex 在会话开始时注入的
 * `<env>` 块。模型据此知道"我在哪、今天几号、是不是 git 仓库、当前分支和改动"，
 * 极大减少盲目探路和错误假设。
 *
 * 设计：
 * - 纯函数 formatEnv(info) 负责渲染，离线可测；
 * - 异步 gatherEnv(cwd) 负责采集（含短超时的 git 探测），失败静默降级；
 * - 在会话开始时采集一次并拼进 system（快照语义，缓存友好——与 Claude Code 一致）。
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { t } from "./i18n.js";

export interface EnvInfo {
  cwd: string;
  platform: string;
  osVersion: string;
  /** ISO 日期（YYYY-MM-DD），只到天，避免频繁失效 */
  date: string;
  isGitRepo: boolean;
  gitBranch?: string;
  /** git status --porcelain 的精简摘要（截断后的若干行） */
  gitStatus?: string;
  /** 最近若干条提交（oneline） */
  recentCommits?: string;
}

/** 把 EnvInfo 渲染成注入 system 的 `<env>` 块。纯函数，离线可测。 */
export function formatEnv(info: EnvInfo): string {
  const lines: string[] = [
    "<env>",
    `${t("Working directory", "工作目录")}: ${info.cwd}`,
    `${t("Platform", "平台")}: ${info.platform}`,
    `${t("OS version", "系统版本")}: ${info.osVersion}`,
    `${t("Today's date", "今天日期")}: ${info.date}`,
    `${t("Is a git repo", "是否 git 仓库")}: ${info.isGitRepo ? t("yes", "是") : t("no", "否")}`,
  ];
  if (info.isGitRepo && info.gitBranch)
    lines.push(`${t("Current branch", "当前分支")}: ${info.gitBranch}`);
  lines.push("</env>");

  if (info.isGitRepo && (info.gitStatus || info.recentCommits)) {
    lines.push("", "<git-status>");
    if (info.gitStatus) lines.push(`${t("Working tree changes", "工作区改动")}:`, info.gitStatus);
    else lines.push(t("Working tree clean", "工作区干净"));
    if (info.recentCommits) lines.push(`${t("Recent commits", "最近提交")}:`, info.recentCommits);
    lines.push("</git-status>");
  }
  return lines.join("\n");
}

/** 采集当前环境上下文并渲染为可注入 system 的文本。任何一步失败都静默降级。 */
export async function gatherEnv(cwd: string, now: Date = new Date()): Promise<string> {
  const info: EnvInfo = {
    cwd,
    platform: process.platform,
    osVersion: safeOsVersion(),
    date: isoDate(now),
    isGitRepo: false,
  };

  if (await isGitRepo(cwd)) {
    info.isGitRepo = true;
    const [branch, status, commits] = await Promise.all([
      git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
      git(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"]),
      git(cwd, ["log", "--oneline", "-5"]),
    ]);
    if (branch) info.gitBranch = branch.trim();
    if (status !== null) {
      const trimmed = clampLines(status.trim(), 20);
      if (trimmed) info.gitStatus = trimmed;
    }
    if (commits) info.recentCommits = commits.trim();
  }

  return formatEnv(info);
}

function isoDate(d: Date): string {
  // 只到天；避免用 toISOString 受时区影响到不确定的"昨天/明天"
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function safeOsVersion(): string {
  try {
    return `${os.type()} ${os.release()}`;
  } catch {
    return process.platform;
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  // 直接查 .git（比 spawn 快、无副作用）；worktree 场景 .git 是文件也算。
  try {
    await fs.access(path.join(cwd, ".git"));
    return true;
  } catch {
    /* 继续向上探测：cwd 可能在仓库子目录 */
  }
  const out = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return out?.trim() === "true";
}

/** 保留前 n 行，超出用省略提示，避免 git status 在大改动时撑爆上下文。 */
function clampLines(text: string, n: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  const more = lines.length - n;
  return [...lines.slice(0, n), t(`…(${more} more changes)`, `…（另有 ${more} 处改动）`)].join(
    "\n",
  );
}

/** 跑一条 git 子命令，带 3s 超时；任何失败返回 null（不抛）。 */
function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }
    let out = "";
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, 3000);
    child.stdout?.on("data", (b: Buffer) => {
      if (out.length < 8192) out += b.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0 ? out : null);
    });
  });
}
