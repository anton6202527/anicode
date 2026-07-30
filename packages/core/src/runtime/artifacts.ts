/**
 * Artifact 是 Agent 产出的可寻址结果，而不是聊天文本的别名。
 * 计划、补丁、验证报告、截图与日志都通过同一资源模型暴露给 TUI/IDE/SDK。
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

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

export interface ArtifactStreamInput extends Omit<ArtifactInput, "data"> {
  data: AsyncIterable<Uint8Array>;
}

export interface ArtifactRecord {
  artifact: Artifact;
  data: Uint8Array;
}

export interface ArtifactStreamRecord {
  artifact: Artifact;
  data: AsyncIterable<Uint8Array>;
}

export interface ArtifactStore {
  put(input: ArtifactInput): Promise<Artifact>;
  list(sessionId: string): Promise<Artifact[]>;
  get(sessionId: string, artifactId: string): Promise<ArtifactRecord | undefined>;
  delete(sessionId: string, artifactId: string): Promise<boolean>;
  putStream?(input: ArtifactStreamInput): Promise<Artifact>;
  open?(sessionId: string, artifactId: string): Promise<ArtifactStreamRecord | undefined>;
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

function makeArtifactFromDigest(
  input: Omit<ArtifactInput, "data">,
  sha256: string,
  sizeBytes: number,
): Artifact {
  assertSegment(input.sessionId, "session id");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid artifact sha256");
  const id = artifactId(sha256);
  return {
    id,
    sessionId: input.sessionId,
    kind: input.kind,
    name: input.name.trim() || id,
    mediaType: input.mediaType ?? "application/octet-stream",
    sizeBytes,
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

interface S3LikeClient {
  send(command: unknown): Promise<unknown>;
}

export interface S3ArtifactStoreOptions {
  client?: S3LikeClient;
  clientConfig?: S3ClientConfig;
  bucket: string;
  prefix?: string;
  kmsKeyId?: string;
  tempDir?: string;
  maxArtifactBytes?: number;
  maxListItems?: number;
}

function validBucket(value: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) || value.includes("..")) {
    throw new Error("Invalid S3 artifact bucket");
  }
  return value;
}

function validPrefix(value: string): string {
  const normalized = value.replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid S3 artifact prefix");
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label}`);
  return value;
}

async function bodyBytes(body: unknown, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of bodyIterable(body)) {
    size += chunk.byteLength;
    if (size > limit) throw new Error(`Artifact object exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  );
}

async function* bodyIterable(body: unknown): AsyncGenerator<Uint8Array> {
  if (!body) return;
  if (typeof body === "string") {
    yield Buffer.from(body, "utf8");
    return;
  }
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  if (body instanceof ArrayBuffer) {
    yield new Uint8Array(body);
    return;
  }
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    yield new Uint8Array(
      await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray(),
    );
    return;
  }
  if (typeof (body as { transformToWebStream?: unknown }).transformToWebStream === "function") {
    const stream = (
      body as { transformToWebStream(): ReadableStream<Uint8Array> }
    ).transformToWebStream();
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function") {
    for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
      yield typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
    }
    return;
  }
  throw new Error("S3 response body is not streamable");
}

const ARTIFACT_KINDS = new Set<ArtifactKind>([
  "plan",
  "patch",
  "diff",
  "verification",
  "log",
  "report",
  "screenshot",
  "file",
  "other",
]);

function validateStoredArtifact(value: unknown): Artifact {
  if (!value || typeof value !== "object") throw new Error("Invalid artifact metadata");
  const artifact = value as Artifact;
  assertSegment(artifact.sessionId, "session id");
  assertSegment(artifact.id, "artifact id");
  if (!ARTIFACT_KINDS.has(artifact.kind)) throw new Error("Invalid artifact kind");
  if (typeof artifact.name !== "string" || !artifact.name.trim()) {
    throw new Error("Invalid artifact name");
  }
  if (typeof artifact.mediaType !== "string" || artifact.mediaType.length > 255) {
    throw new Error("Invalid artifact media type");
  }
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
    throw new Error("Invalid artifact size");
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || artifactId(artifact.sha256) !== artifact.id) {
    throw new Error("Invalid artifact digest");
  }
  if (Number.isNaN(Date.parse(artifact.createdAt))) throw new Error("Invalid artifact timestamp");
  const expectedUri = `anicode://sessions/${encodeURIComponent(artifact.sessionId)}/artifacts/${artifact.id}`;
  if (artifact.uri !== expectedUri) throw new Error("Invalid artifact URI");
  if (
    artifact.metadata !== undefined &&
    (!artifact.metadata || typeof artifact.metadata !== "object")
  ) {
    throw new Error("Invalid artifact metadata attributes");
  }
  return artifact;
}

/**
 * Production Artifact store: small metadata objects are session-scoped; immutable blobs are
 * content-addressed and streamed through a private temp file, so large logs never occupy heap or
 * PostgreSQL bytea. S3 lifecycle rules may garbage-collect unreferenced blobs after retention.
 */
export class S3ArtifactStore implements ArtifactStore {
  private readonly client: S3LikeClient;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly maxArtifactBytes: number;
  private readonly maxListItems: number;

  constructor(private readonly options: S3ArtifactStoreOptions) {
    this.client = options.client ?? new S3Client(options.clientConfig ?? {});
    this.bucket = validBucket(options.bucket);
    this.prefix = validPrefix(options.prefix ?? "anicode/artifacts/v1");
    this.maxArtifactBytes = positiveInteger(
      options.maxArtifactBytes ?? 2 * 1024 * 1024 * 1024,
      "S3 artifact size limit",
    );
    this.maxListItems = positiveInteger(options.maxListItems ?? 10_000, "S3 artifact list limit");
  }

  private metadataKey(sessionId: string, artifactIdValue: string): string {
    assertSegment(sessionId, "session id");
    assertSegment(artifactIdValue, "artifact id");
    return `${this.prefix}/sessions/${sessionId}/${artifactIdValue}.json`;
  }

  private blobKey(sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid artifact sha256");
    return `${this.prefix}/blobs/${sha256.slice(0, 2)}/${sha256}`;
  }

  private encryption(): Record<string, string> {
    return this.options.kmsKeyId
      ? { ServerSideEncryption: "aws:kms", SSEKMSKeyId: this.options.kmsKeyId }
      : { ServerSideEncryption: "AES256" };
  }

  put(input: ArtifactInput): Promise<Artifact> {
    const data = bytesOf(input.data);
    return this.putStream({
      sessionId: input.sessionId,
      kind: input.kind,
      name: input.name,
      ...(input.mediaType ? { mediaType: input.mediaType } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      data: (async function* () {
        yield data;
      })(),
    });
  }

  async putStream(input: ArtifactStreamInput): Promise<Artifact> {
    assertSegment(input.sessionId, "session id");
    const tempRoot = path.resolve(this.options.tempDir ?? os.tmpdir());
    await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const directory = await fs.mkdtemp(path.join(tempRoot, "anicode-artifact-"));
    await fs.chmod(directory, 0o700);
    const temporary = path.join(directory, "payload");
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      const digest = createHash("sha256");
      let size = 0;
      try {
        for await (const chunk of input.data) {
          const bytes = Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > this.maxArtifactBytes) {
            throw new Error(`Artifact exceeds ${this.maxArtifactBytes} bytes`);
          }
          digest.update(bytes);
          let offset = 0;
          while (offset < bytes.byteLength) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
            if (bytesWritten <= 0) throw new Error("Artifact temporary write made no progress");
            offset += bytesWritten;
          }
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      const sha256 = digest.digest("hex");
      const artifact = makeArtifactFromDigest(
        {
          sessionId: input.sessionId,
          kind: input.kind,
          name: input.name,
          ...(input.mediaType ? { mediaType: input.mediaType } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        sha256,
        size,
      );
      const existing = await this.readMetadata(input.sessionId, artifact.id);
      if (existing) return existing;
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.blobKey(sha256),
          Body: createReadStream(temporary),
          ContentLength: size,
          ContentType: artifact.mediaType,
          ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
          ...this.encryption(),
        }),
      );
      const metadata = Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8");
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.metadataKey(input.sessionId, artifact.id),
          Body: metadata,
          ContentLength: metadata.byteLength,
          ContentType: "application/json",
          ChecksumSHA256: createHash("sha256").update(metadata).digest("base64"),
          ...this.encryption(),
        }),
      );
      return artifact;
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async list(sessionId: string): Promise<Artifact[]> {
    assertSegment(sessionId, "session id");
    const prefix = `${this.prefix}/sessions/${sessionId}/`;
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const response = (await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: Math.min(1_000, this.maxListItems - keys.length),
          ...(token ? { ContinuationToken: token } : {}),
        }),
      )) as { Contents?: Array<{ Key?: string }>; NextContinuationToken?: string };
      for (const value of response.Contents ?? []) {
        if (value.Key?.endsWith(".json")) keys.push(value.Key);
        if (keys.length >= this.maxListItems) break;
      }
      token = response.NextContinuationToken;
    } while (token && keys.length < this.maxListItems);
    const artifacts: Artifact[] = [];
    for (let index = 0; index < keys.length; index += 20) {
      const batch = await Promise.all(
        keys
          .slice(index, index + 20)
          .map((key) => this.readMetadataKey(key).catch(() => undefined)),
      );
      artifacts.push(...batch.filter((value): value is Artifact => Boolean(value)));
    }
    return artifacts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(sessionId: string, artifactIdValue: string): Promise<ArtifactRecord | undefined> {
    const opened = await this.open(sessionId, artifactIdValue);
    if (!opened) return undefined;
    const data = await bodyBytes(opened.data, this.maxArtifactBytes);
    return { artifact: opened.artifact, data };
  }

  async open(
    sessionId: string,
    artifactIdValue: string,
  ): Promise<ArtifactStreamRecord | undefined> {
    const artifact = await this.readMetadata(sessionId, artifactIdValue);
    if (!artifact) return undefined;
    let response: { Body?: unknown };
    try {
      response = (await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.blobKey(artifact.sha256) }),
      )) as { Body?: unknown };
    } catch (error) {
      if (s3NotFound(error)) return undefined;
      throw error;
    }
    const source = bodyIterable(response.Body);
    const verified = async function* (): AsyncGenerator<Uint8Array> {
      const digest = createHash("sha256");
      let size = 0;
      for await (const chunk of source) {
        size += chunk.byteLength;
        digest.update(chunk);
        yield chunk;
      }
      if (size !== artifact.sizeBytes || digest.digest("hex") !== artifact.sha256) {
        throw new Error(`Artifact integrity check failed: ${artifact.id}`);
      }
    };
    return { artifact, data: verified() };
  }

  async delete(sessionId: string, artifactIdValue: string): Promise<boolean> {
    const existing = await this.readMetadata(sessionId, artifactIdValue);
    if (!existing) return false;
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.metadataKey(sessionId, artifactIdValue),
      }),
    );
    return true;
  }

  private async readMetadata(
    sessionId: string,
    artifactIdValue: string,
  ): Promise<Artifact | undefined> {
    return this.readMetadataKey(this.metadataKey(sessionId, artifactIdValue));
  }

  private async readMetadataKey(key: string): Promise<Artifact | undefined> {
    try {
      const response = (await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      )) as { Body?: unknown };
      const parsed = validateStoredArtifact(
        JSON.parse(Buffer.from(await bodyBytes(response.Body, 1024 * 1024)).toString("utf8")),
      );
      if (this.metadataKey(parsed.sessionId, parsed.id) !== key) {
        throw new Error("S3 artifact metadata key mismatch");
      }
      return parsed;
    } catch (error) {
      if (s3NotFound(error)) return undefined;
      throw error;
    }
  }
}

function s3NotFound(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value.name === "NoSuchKey" || value.$metadata?.httpStatusCode === 404;
}

/** Workload identity/default provider chain only; static AWS keys are rejected. */
export function configuredS3ArtifactStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): S3ArtifactStore {
  const staticCredential = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"].find(
    (name) => env[name],
  );
  if (staticCredential) {
    throw new Error(`${staticCredential} is forbidden for Artifact storage; use workload identity`);
  }
  const bucket = env.ANICODE_ARTIFACT_S3_BUCKET;
  const kmsKeyId = env.ANICODE_ARTIFACT_KMS_KEY_ID;
  if (!bucket || !kmsKeyId) {
    throw new Error("ANICODE_ARTIFACT_S3_BUCKET and ANICODE_ARTIFACT_KMS_KEY_ID are required");
  }
  return new S3ArtifactStore({
    bucket,
    kmsKeyId,
    prefix: env.ANICODE_ARTIFACT_S3_PREFIX ?? "anicode/artifacts/v1",
    maxArtifactBytes: Number(env.ANICODE_ARTIFACT_MAX_BYTES ?? 2 * 1024 * 1024 * 1024),
    clientConfig: {
      ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
      ...(env.ANICODE_ARTIFACT_S3_ENDPOINT ? { endpoint: env.ANICODE_ARTIFACT_S3_ENDPOINT } : {}),
      forcePathStyle: env.ANICODE_ARTIFACT_S3_FORCE_PATH_STYLE === "1",
    },
  });
}
