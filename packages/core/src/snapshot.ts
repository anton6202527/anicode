/**
 * 工作区快照 / 撤销（checkpoint / undo）—— 让用户敢放手让 agent 改代码。
 *
 * 用 git plumbing 把「当前工作树的全部改动」记成一个游离的 commit 对象，但**绝不触碰**
 * 用户的 HEAD、index 或分支：全程用一个临时 index 文件（GIT_INDEX_FILE）操作，
 *   seed HEAD → add -A（含未跟踪/删除，尊重 .gitignore，不吞 node_modules）
 *   → write-tree → commit-tree
 * 得到 commit sha 作为快照 id。撤销时把该 tree 铺回工作树，并删掉快照之后新增的文件。
 *
 * 不是 git 仓库、或 git 不可用时，take() 返回 null（调用方据此禁用 undo，不报错）。
 * 对齐 opencode 的 git-based snapshot / revert。
 */

import { spawn } from "node:child_process";
import { t } from "./i18n.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface Snapshot {
  /** 游离 commit 的 sha —— 快照 id。 */
  id: string;
  /** 对应的 tree sha（restore 用）。 */
  tree: string;
  /** 人类可读标签（如触发它的用户输入摘要）。 */
  label: string;
  createdAt: string;
}

export interface RestoreResult {
  /** 从快照铺回/覆盖的文件数（checkout-index 写出的条目）。 */
  restored: number;
  /** 删除的「快照之后新增」文件数。 */
  deleted: number;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class SnapshotStore {
  private readonly cwd: string;
  private availability: Promise<boolean> | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** 是否可用：git 存在且 cwd 位于工作树内（结果缓存）。 */
  isAvailable(): Promise<boolean> {
    if (!this.availability) {
      this.availability = (async () => {
        const r = await this.git(["rev-parse", "--is-inside-work-tree"]).catch(() => null);
        return r !== null && r.code === 0 && r.stdout.trim() === "true";
      })();
    }
    return this.availability;
  }

  /**
   * 记一个快照。不可用时返回 null。label 只用于展示，不参与任何路径。
   */
  async take(label: string): Promise<Snapshot | null> {
    if (!(await this.isAvailable())) return null;
    const indexFile = this.tempIndexPath();
    try {
      // 空仓库（无 HEAD）也能工作：read-tree 失败就用空 index 起步。
      const head = await this.git(["rev-parse", "--verify", "-q", "HEAD"]).catch(() => null);
      const hasHead = head !== null && head.code === 0;
      const env = { GIT_INDEX_FILE: indexFile };
      if (hasHead) await this.git(["read-tree", "HEAD"], env);
      // add -A：暂存改动/新增/删除；尊重 .gitignore，不会纳入被忽略的大目录。
      await this.git(["add", "-A"], env);
      const tree = (await this.git(["write-tree"], env)).stdout.trim();
      if (!tree) return null;
      const commitArgs = ["commit-tree", tree, "-m", `anicode checkpoint: ${label}`.slice(0, 200)];
      if (hasHead) commitArgs.push("-p", head!.stdout.trim());
      const id = (await this.git(commitArgs)).stdout.trim();
      return { id, tree, label, createdAt: new Date().toISOString() };
    } catch {
      return null; // 快照是尽力而为，绝不因它中断主流程
    } finally {
      await fs.rm(indexFile, { force: true }).catch(() => {});
    }
  }

  /**
   * 把工作树恢复到某快照：
   *   1. 用临时 index 载入快照 tree，checkout-index 覆盖/重建所有文件；
   *   2. 计算「快照之后新增」的文件并删除（checkout-index 不会删多余文件）。
   * 只影响 git 视野内（未被 .gitignore 忽略）的文件，node_modules 等不受牵连。
   */
  async restore(snapshot: Pick<Snapshot, "tree">): Promise<RestoreResult> {
    if (!(await this.isAvailable()))
      throw new Error(
        t(
          "Current directory is not a git repository; cannot undo",
          "当前目录不是 git 仓库，无法撤销",
        ),
      );
    const restoreIndex = this.tempIndexPath();
    const currentIndex = this.tempIndexPath();
    try {
      const env = { GIT_INDEX_FILE: restoreIndex };
      await this.git(["read-tree", snapshot.tree], env);
      // -a 全部、-f 覆盖已存在文件、-u 顺带更新 index（无害）。
      const checkout = await this.git(["checkout-index", "-a", "-f"], env);
      if (checkout.code !== 0)
        throw new Error(
          t(
            `checkout-index failed: ${checkout.stderr.trim()}`,
            `checkout-index 失败: ${checkout.stderr.trim()}`,
          ),
        );
      const restored = countLines(
        (await this.git(["ls-tree", "-r", "--name-only", snapshot.tree]).catch(() => emptyGit()))
          .stdout,
      );

      // 当前工作树快照 tree（复用同一套 seed→add→write-tree），对比出「新增」文件删掉。
      const cEnv = { GIT_INDEX_FILE: currentIndex };
      const head = await this.git(["rev-parse", "--verify", "-q", "HEAD"]).catch(() => null);
      if (head && head.code === 0) await this.git(["read-tree", "HEAD"], cEnv);
      await this.git(["add", "-A"], cEnv);
      const currentTree = (await this.git(["write-tree"], cEnv)).stdout.trim();
      let deleted = 0;
      if (currentTree && currentTree !== snapshot.tree) {
        // diff-filter=A：从快照到现状「新增」的路径 = 现在有、快照没有 → 撤销即删除。
        const added = (
          await this.git([
            "diff",
            "--name-only",
            "--diff-filter=A",
            "-z",
            snapshot.tree,
            currentTree,
          ])
        ).stdout;
        for (const rel of added.split("\0")) {
          const name = rel.trim();
          if (!name) continue;
          await fs.rm(path.join(this.cwd, name), { force: true }).catch(() => {});
          deleted++;
        }
      }
      return { restored, deleted };
    } finally {
      await fs.rm(restoreIndex, { force: true }).catch(() => {});
      await fs.rm(currentIndex, { force: true }).catch(() => {});
    }
  }

  private tempIndexPath(): string {
    return path.join(os.tmpdir(), `anicode-index-${process.pid}-${randomUUID()}`);
  }

  private git(args: string[], extraEnv?: Record<string, string>): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        cwd: this.cwd,
        env: { ...process.env, ...extraEnv },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
      child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }
}

function emptyGit(): GitResult {
  return { code: 0, stdout: "", stderr: "" };
}

function countLines(text: string): number {
  const t = text.replace(/\n+$/, "");
  return t ? t.split("\n").length : 0;
}
