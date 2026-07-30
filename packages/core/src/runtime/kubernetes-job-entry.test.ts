import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "node:test";

const runFile = promisify(execFile);
const entry = fileURLToPath(new URL("./kubernetes-job-entry.ts", import.meta.url));

test(
  "Kubernetes job entry: 成功命令经 PatchSet 提交，失败命令不污染 PVC workspace",
  { skip: process.platform === "win32" ? "Kubernetes runner uses a POSIX shell" : false },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-entry-"));
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-staging-"));
    try {
      await fs.writeFile(path.join(root, "value.txt"), "before\n");
      const env = {
        ...process.env,
        ANICODE_JOB_SOURCE: root,
        ANICODE_JOB_RELATIVE_CWD: ".",
        ANICODE_JOB_COMMAND: "printf 'after\\n' > value.txt",
        ANICODE_JOB_TIMEOUT_MS: "10000",
        TMPDIR: staging,
      };
      const success = await runFile(process.execPath, ["--import", "tsx", entry], {
        env,
        maxBuffer: 2 * 1024 * 1024,
      });
      assert.match(success.stdout, /\[PatchSet .* committed\]/);
      assert.equal(await fs.readFile(path.join(root, "value.txt"), "utf8"), "after\n");

      env.ANICODE_JOB_COMMAND = "printf 'leaked\\n' > value.txt; exit 7";
      await assert.rejects(
        () => runFile(process.execPath, ["--import", "tsx", entry], { env }),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: number }).code === 7,
      );
      assert.equal(await fs.readFile(path.join(root, "value.txt"), "utf8"), "after\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(staging, { recursive: true, force: true });
    }
  },
);
