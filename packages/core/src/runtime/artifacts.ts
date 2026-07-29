/**
 * Artifact 是 Agent 产出的可寻址结果，而不是聊天文本的别名。
 * 计划、补丁、验证报告、截图与日志都通过同一资源模型暴露给 TUI/IDE/SDK。
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export type ArtifactKind =
  "plan" | "patch" | "diff" | "verification" | "log" | "report" | "screenshot" | "file" | "other";

export interface Artifact {
  id: string;
  sessionId: string;
  kind: ArtifactKind;
  name: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  /** 跨传输稳定的资源 URI；实际内容仍由 ArtifactStore/API 读取。 */
  uri: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactInput {
  sessionId: string;
  kind: ArtifactKind;
  name: string;
  mediaType?: string;
  data: string | Uint8Array;
  metadata?: Record<string, unknown>;
}

export interface ArtifactRecord {
  artifact: Artifact;
  data: Uint8Array;
}

export interface ArtifactStore {
  put(input: ArtifactInput): Promise<Artifact>;
  list(sessionId: string): Promise<Artifact[]>;
  get(sessionId: string, artifactId: string): Promise<ArtifactRecord | undefined>;
  delete(sessionId: string, artifactId: string): Promise<boolean>;
}

function bytesOf(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? Buffer.from(data, "utf8") : data;
}

function artifactId(sha256: string): string {
  return `art_${sha256.slice(0, 24)}`;
}

function assertSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

function makeArtifact(input: ArtifactInput, data: Uint8Array): Artifact {
  assertSegment(input.sessionId, "session id");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const id = artifactId(sha256);
  return {
    id,
    sessionId: input.sessionId,
    kind: input.kind,
    name: input.name.trim() || id,
    mediaType: input.mediaType ?? "application/octet-stream",
    sizeBytes: data.byteLength,
    sha256,
    createdAt: new Date().toISOString(),
    uri: `anicode://sessions/${encodeURIComponent(input.sessionId)}/artifacts/${id}`,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

/** 测试与嵌入式宿主使用的内存实现。 */
export class MemoryArtifactStore implements ArtifactStore {
  private records = new Map<string, ArtifactRecord>();

  async put(input: ArtifactInput): Promise<Artifact> {
    const data = bytesOf(input.data);
    const artifact = makeArtifact(input, data);
    const key = `${artifact.sessionId}/${artifact.id}`;
    const existing = this.records.get(key);
    if (existing) return existing.artifact;
    this.records.set(key, { artifact, data: new Uint8Array(data) });
    return artifact;
  }

  async list(sessionId: string): Promise<Artifact[]> {
    assertSegment(sessionId, "session id");
    return [...this.records.values()]
      .map((r) => r.artifact)
      .filter((a) => a.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(sessionId: string, artifactIdValue: string): Promise<ArtifactRecord | undefined> {
    assertSegment(sessionId, "session id");
    assertSegment(artifactIdValue, "artifact id");
    const found = this.records.get(`${sessionId}/${artifactIdValue}`);
    return found ? { artifact: found.artifact, data: new Uint8Array(found.data) } : undefined;
  }

  async delete(sessionId: string, artifactIdValue: string): Promise<boolean> {
    assertSegment(sessionId, "session id");
    assertSegment(artifactIdValue, "artifact id");
    return this.records.delete(`${sessionId}/${artifactIdValue}`);
  }
}

/**
 * 文件实现：内容按 sha256 去重，元数据按 session 隔离；临时文件 + rename 原子发布。
 * 目录/文件权限固定为 0700/0600，避免验证日志或补丁意外对同机其他用户可读。
 */
export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  private metadataDir(sessionId: string): string {
    assertSegment(sessionId, "session id");
    return path.join(this.root, "sessions", sessionId);
  }

  private metadataFile(sessionId: string, artifactIdValue: string): string {
    assertSegment(artifactIdValue, "artifact id");
    return path.join(this.metadataDir(sessionId), `${artifactIdValue}.json`);
  }

  private blobFile(sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid artifact sha256");
    return path.join(this.root, "blobs", sha256.slice(0, 2), sha256);
  }

  private async privateDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
  }

  private async atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, data, { mode: 0o600, flag: "wx" });
      await fs.rename(tmp, file);
      await fs.chmod(file, 0o600);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  async put(input: ArtifactInput): Promise<Artifact> {
    const data = bytesOf(input.data);
    const artifact = makeArtifact(input, data);
    const metadataFile = this.metadataFile(input.sessionId, artifact.id);
    try {
      const existing = JSON.parse(await fs.readFile(metadataFile, "utf8")) as Artifact;
      return existing;
    } catch {
      /* 继续创建 */
    }

    const blobFile = this.blobFile(artifact.sha256);
    await this.privateDir(path.dirname(blobFile));
    try {
      await fs.writeFile(blobFile, data, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await this.privateDir(path.dirname(metadataFile));
    await this.atomicWrite(metadataFile, JSON.stringify(artifact, null, 2) + "\n");
    return artifact;
  }

  async list(sessionId: string): Promise<Artifact[]> {
    const dir = this.metadataDir(sessionId);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const artifacts: Artifact[] = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      try {
        artifacts.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as Artifact);
      } catch {
        /* 损坏的单条元数据不拖垮整个列表 */
      }
    }
    return artifacts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(sessionId: string, artifactIdValue: string): Promise<ArtifactRecord | undefined> {
    try {
      const artifact = JSON.parse(
        await fs.readFile(this.metadataFile(sessionId, artifactIdValue), "utf8"),
      ) as Artifact;
      const data = await fs.readFile(this.blobFile(artifact.sha256));
      return { artifact, data };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async delete(sessionId: string, artifactIdValue: string): Promise<boolean> {
    const file = this.metadataFile(sessionId, artifactIdValue);
    try {
      await fs.unlink(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
