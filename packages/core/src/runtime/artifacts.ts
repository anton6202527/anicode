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
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
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
  /** Physically remove every payload and metadata object owned by one session. */
  deleteSession(sessionId: string): Promise<void>;
  putStream?(input: ArtifactStreamInput): Promise<Artifact>;
  open?(
    sessionId: string,
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<ArtifactStreamRecord | undefined>;
  close?(): void | Promise<void>;
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

  async deleteSession(sessionId: string): Promise<void> {
    assertSegment(sessionId, "session id");
    const prefix = `${sessionId}/`;
    for (const key of this.records.keys()) {
      if (key.startsWith(prefix)) this.records.delete(key);
    }
  }
}

/**
 * 文件实现：新内容与元数据都按 session 隔离；临时文件 + rename 原子发布。
 * session-scoped payload 让删除会话时能真正清除用户内容，同时保留对旧版全局
 * content-addressed blob 的只读兼容。目录/文件权限固定为 0700/0600。
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

  /** v2 payload: 不与其他 session 共享，因而可安全删除。 */
  private sessionBlobFile(sessionId: string, sha256: string): string {
    assertSegment(sessionId, "session id");
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid artifact sha256");
    return path.join(this.root, "sessions", sessionId, "blobs", sha256.slice(0, 2), sha256);
  }

  /** v1 payload: 仅用于读旧数据；不能删除，因为可能被其他 session 引用。 */
  private legacyBlobFile(sha256: string): string {
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

    const blobFile = this.sessionBlobFile(input.sessionId, artifact.sha256);
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
      let data: Uint8Array;
      try {
        data = await fs.readFile(this.sessionBlobFile(sessionId, artifact.sha256));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        data = await fs.readFile(this.legacyBlobFile(artifact.sha256));
      }
      return { artifact, data };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async delete(sessionId: string, artifactIdValue: string): Promise<boolean> {
    const file = this.metadataFile(sessionId, artifactIdValue);
    let artifact: Artifact;
    try {
      artifact = JSON.parse(await fs.readFile(file, "utf8")) as Artifact;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    // 只删除 v2 session-scoped payload。v1 全局 blob 可能被其他 session 共享。
    await fs.rm(this.sessionBlobFile(sessionId, artifact.sha256), { force: true });
    await fs.unlink(file);
    return true;
  }

  async deleteSession(sessionId: string): Promise<void> {
    assertSegment(sessionId, "session id");
    // Only the v2 session namespace has single-session ownership. Legacy v1 blobs are global and
    // may be referenced by metadata outside this process' inventory, so online deletion never
    // scans every session or guesses reference ownership. Operators may reclaim them with an
    // offline, version-aware inventory after migration.
    await this.removeSessionDirectory(sessionId);
  }

  private async removeSessionDirectory(sessionId: string): Promise<void> {
    const sessionsRoot = path.resolve(this.root, "sessions");
    const directory = path.resolve(sessionsRoot, sessionId);
    if (path.dirname(directory) !== sessionsRoot) throw new Error("Unsafe artifact session path");

    try {
      const rootStat = await fs.lstat(sessionsRoot);
      if (rootStat.isSymbolicLink()) throw new Error("Unsafe artifact sessions symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      await fs.rm(directory, { force: true });
      return;
    }
    const [canonicalRoot, canonicalDirectory] = await Promise.all([
      fs.realpath(sessionsRoot),
      fs.realpath(directory),
    ]);
    if (path.dirname(canonicalDirectory) !== canonicalRoot) {
      throw new Error("Unsafe artifact session path");
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

interface S3LikeClient {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
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
  requestTimeoutMs?: number;
  /**
   * Periodically repair session prefixes protected by persistent deletion markers. This closes the
   * crash window where S3 accepts a request after the producer process and its lease disappeared.
   * Direct/test construction is opt-in; production env assembly enables it by default.
   */
  deletionReconcileIntervalMs?: number;
  onDeletionReconcileError?: (error: unknown) => void;
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

async function bodyBytes(body: unknown, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of bodyIterable(body, signal)) {
    size += chunk.byteLength;
    if (size > limit) throw new Error(`Artifact object exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Artifact stream aborted");
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Normalize an AWS response body without losing cancellation. This is deliberately a normal
 * function (rather than an async generator): WebStream ownership and its abort listener are
 * installed as soon as S3 returns the body, even if the caller has not requested the first chunk.
 */
function bodyIterable(body: unknown, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const fixed = (value?: Uint8Array): AsyncGenerator<Uint8Array> =>
    (async function* () {
      if (signal?.aborted) throw abortReason(signal);
      if (value) yield value;
    })();
  if (!body) return fixed();
  if (typeof body === "string") return fixed(Buffer.from(body, "utf8"));
  if (body instanceof Uint8Array) return fixed(body);
  if (body instanceof ArrayBuffer) return fixed(new Uint8Array(body));

  // SDK streaming bodies also expose transformToByteArray(). Prefer the streaming API so a large
  // artifact is never buffered in heap and DELETE can cancel a blocked upstream read.
  if (typeof (body as { transformToWebStream?: unknown }).transformToWebStream === "function") {
    const stream = (
      body as { transformToWebStream(): ReadableStream<Uint8Array> }
    ).transformToWebStream();
    const reader = stream.getReader();
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= Promise.resolve(reader.cancel(signal?.reason)).catch(() => undefined);
      return cancellation;
    };
    const onAbort = () => void cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    return (async function* () {
      try {
        for (;;) {
          const { done, value } = await abortable(reader.read(), signal);
          if (signal?.aborted) throw abortReason(signal);
          if (done) return;
          if (value) yield value;
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        // reader.cancel(), unlike releaseLock(), actually terminates a pending HTTP response.
        await cancel();
        reader.releaseLock();
      }
    })();
  }

  if (typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function") {
    const source = body as AsyncIterable<Uint8Array | Buffer | string> & {
      destroy?: (error?: Error) => void;
    };
    const iterator = source[Symbol.asyncIterator]();
    const onAbort = () => {
      const reason = abortReason(signal!);
      source.destroy?.(reason instanceof Error ? reason : new Error(String(reason)));
      void iterator.return?.().catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    return (async function* () {
      let completed = false;
      try {
        for (;;) {
          const next = await abortable(Promise.resolve(iterator.next()), signal);
          if (signal?.aborted) throw abortReason(signal);
          if (next.done) {
            completed = true;
            return;
          }
          const chunk = next.value;
          yield typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (!completed) {
          source.destroy?.();
          await iterator.return?.().catch(() => undefined);
        }
      }
    })();
  }

  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    return (async function* () {
      const value = await abortable(
        (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray(),
        signal,
      );
      if (signal?.aborted) throw abortReason(signal);
      yield new Uint8Array(value);
    })();
  }
  return (async function* () {
    yield* fixed();
    throw new Error("S3 response body is not streamable");
  })();
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
 * Production Artifact store: metadata and newly-written immutable payloads are session-scoped and
 * streamed through a private temp file, so large logs never occupy heap or PostgreSQL bytea.
 * Reads retain a fallback for legacy globally content-addressed blobs.
 */
export class S3ArtifactStore implements ArtifactStore {
  private readonly client: S3LikeClient;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly maxArtifactBytes: number;
  private readonly maxListItems: number;
  private readonly requestTimeoutMs: number;
  private readonly deletionReconcileIntervalMs: number;
  private deletionReconcileTimer: ReturnType<typeof setInterval> | undefined;
  private deletionReconcileRunning: Promise<number> | undefined;

  constructor(private readonly options: S3ArtifactStoreOptions) {
    this.client = options.client ?? new S3Client(options.clientConfig ?? {});
    this.bucket = validBucket(options.bucket);
    this.prefix = validPrefix(options.prefix ?? "anicode/artifacts/v1");
    this.maxArtifactBytes = positiveInteger(
      options.maxArtifactBytes ?? 2 * 1024 * 1024 * 1024,
      "S3 artifact size limit",
    );
    this.maxListItems = positiveInteger(options.maxListItems ?? 10_000, "S3 artifact list limit");
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? 120_000,
      "S3 artifact request timeout",
    );
    if (this.requestTimeoutMs < 1_000 || this.requestTimeoutMs > 15 * 60_000) {
      throw new Error("S3 artifact request timeout must be from 1000 to 900000 ms");
    }
    const reconcileInterval = options.deletionReconcileIntervalMs ?? 0;
    if (
      !Number.isSafeInteger(reconcileInterval) ||
      reconcileInterval < 0 ||
      (reconcileInterval > 0 && reconcileInterval < 1_000)
    ) {
      throw new Error("Invalid S3 deletion reconcile interval");
    }
    this.deletionReconcileIntervalMs = reconcileInterval;
    if (reconcileInterval > 0) this.startDeletionReconciler();
  }

  private metadataKey(sessionId: string, artifactIdValue: string): string {
    assertSegment(sessionId, "session id");
    assertSegment(artifactIdValue, "artifact id");
    return `${this.prefix}/sessions/${sessionId}/${artifactIdValue}.json`;
  }

  private sessionBlobKey(sessionId: string, sha256: string): string {
    assertSegment(sessionId, "session id");
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid artifact sha256");
    return `${this.prefix}/sessions/${sessionId}/blobs/${sha256.slice(0, 2)}/${sha256}`;
  }

  private legacyBlobKey(sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid artifact sha256");
    return `${this.prefix}/blobs/${sha256.slice(0, 2)}/${sha256}`;
  }

  /** Stored outside the mutable session prefix and intentionally retained forever. */
  private deletionMarkerKey(sessionId: string): string {
    assertSegment(sessionId, "session id");
    return `${this.prefix}/deletions/${sessionId}.json`;
  }

  private encryption(): Record<string, string> {
    return this.options.kmsKeyId
      ? { ServerSideEncryption: "aws:kms", SSEKMSKeyId: this.options.kmsKeyId }
      : { ServerSideEncryption: "AES256" };
  }

  private async send(command: unknown, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason ?? new Error("S3 request cancelled"));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(`S3 artifact request timed out after ${this.requestTimeoutMs}ms`),
        ),
      this.requestTimeoutMs,
    );
    try {
      controller.signal.throwIfAborted();
      return await abortable(
        this.client.send(command, { abortSignal: controller.signal }),
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async sessionIsDeleted(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const response = (await this.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.deletionMarkerKey(sessionId) }),
        signal,
      )) as { Body?: unknown };
      // Drain the tiny response so the AWS HTTP connection is reusable. Marker contents carry no
      // user data and are not interpreted; existence is the permanent fence.
      await bodyBytes(response.Body, 1_024, signal);
      return true;
    } catch (error) {
      if (s3NotFound(error)) return false;
      throw error;
    }
  }

  private async assertSessionWritable(sessionId: string): Promise<void> {
    if (await this.sessionIsDeleted(sessionId)) {
      throw new Error(`Artifact session ${sessionId} has been permanently deleted`);
    }
  }

  private async removeLateSessionWrite(sessionId: string): Promise<never> {
    await this.deleteSessionPrefix(sessionId);
    throw new Error(`Artifact session ${sessionId} was deleted during upload`);
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
    await this.assertSessionWritable(input.sessionId);
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
      await this.assertSessionWritable(input.sessionId);
      const existing = await this.readMetadata(input.sessionId, artifact.id);
      if (existing) {
        await this.assertSessionWritable(input.sessionId);
        return existing;
      }
      await this.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.sessionBlobKey(input.sessionId, sha256),
          Body: createReadStream(temporary),
          ContentLength: size,
          ContentType: artifact.mediaType,
          ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
          ...this.encryption(),
        }),
      );
      if (await this.sessionIsDeleted(input.sessionId)) {
        return await this.removeLateSessionWrite(input.sessionId);
      }
      const metadata = Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8");
      await this.send(
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
      if (await this.sessionIsDeleted(input.sessionId)) {
        return await this.removeLateSessionWrite(input.sessionId);
      }
      return artifact;
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async list(sessionId: string): Promise<Artifact[]> {
    assertSegment(sessionId, "session id");
    if (await this.sessionIsDeleted(sessionId)) return [];
    const prefix = `${this.prefix}/sessions/${sessionId}/`;
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const response = (await this.send(
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
    if (await this.sessionIsDeleted(sessionId)) return [];
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
    signal?: AbortSignal,
  ): Promise<ArtifactStreamRecord | undefined> {
    if (await this.sessionIsDeleted(sessionId, signal)) return undefined;
    const artifact = await this.readMetadata(sessionId, artifactIdValue, signal);
    if (!artifact) return undefined;
    let response: { Body?: unknown };
    try {
      response = (await this.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.sessionBlobKey(sessionId, artifact.sha256),
        }),
        signal,
      )) as { Body?: unknown };
    } catch (error) {
      if (!s3NotFound(error)) throw error;
      try {
        response = (await this.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: this.legacyBlobKey(artifact.sha256) }),
          signal,
        )) as { Body?: unknown };
      } catch (legacyError) {
        if (s3NotFound(legacyError)) return undefined;
        throw legacyError;
      }
    }
    const source = bodyIterable(response.Body, signal);
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
    if (await this.sessionIsDeleted(sessionId)) return false;
    const existing = await this.readMetadata(sessionId, artifactIdValue);
    if (!existing) return false;
    // Delete only the v2 session-scoped payload. A legacy global blob may still serve another
    // session with the same digest and is therefore deliberately retained.
    const keys = [
      this.sessionBlobKey(sessionId, existing.sha256),
      this.metadataKey(sessionId, artifactIdValue),
    ];
    if (await this.bucketIsVersioned()) {
      for (const key of keys) await this.deleteVersionedPrefix(key, key);
    } else {
      for (const key of keys) {
        await this.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      }
    }
    return true;
  }

  async deleteSession(sessionId: string): Promise<void> {
    assertSegment(sessionId, "session id");

    // The marker is the object-store commit fence. It lives outside the purged prefix, so a Put
    // accepted by S3 after its producer crashed remains unreachable and a later reconciler can
    // deterministically remove it. Session ids are never reusable at the durable lifecycle layer.
    const marker = Buffer.from("{}\n", "utf8");
    try {
      await this.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.deletionMarkerKey(sessionId),
          Body: marker,
          ContentLength: marker.byteLength,
          ContentType: "application/json",
          ChecksumSHA256: createHash("sha256").update(marker).digest("base64"),
          IfNoneMatch: "*",
          ...this.encryption(),
        }),
      );
    } catch (error) {
      // Reconciliation repeatedly calls deleteSession. A conditional create keeps a versioned
      // bucket from accumulating a fresh marker version on every repair pass.
      if (!s3PreconditionFailed(error)) throw error;
    }

    await this.deleteSessionPrefix(sessionId);
  }

  private async deleteSessionPrefix(sessionId: string): Promise<void> {
    const sessionPrefix = `${this.prefix}/sessions/${sessionId}/`;

    // Delete the complete namespace rather than relying on metadata. This removes corrupt records
    // and payloads orphaned when a process died between the blob and metadata PutObject calls. v1
    // global blobs are deliberately left to an offline inventory GC: scanning the whole bucket on
    // an interactive delete is unbounded, and metadata outside this prefix may still reference it.
    if (await this.bucketIsVersioned()) await this.deleteVersionedPrefix(sessionPrefix);
    else await this.deletePrefix(sessionPrefix);
  }

  /**
   * Repair every namespace named by a persistent deletion marker. The marker scan is paginated and
   * each session purge is itself bounded to 1,000-key batches. It is safe to run concurrently or
   * after a process restart; markers are intentionally never removed.
   */
  reconcileDeletedSessions(): Promise<number> {
    if (this.deletionReconcileRunning) return this.deletionReconcileRunning;
    const operation = this.reconcileDeletedSessionsInternal();
    this.deletionReconcileRunning = operation;
    const cleanup = () => {
      if (this.deletionReconcileRunning === operation) this.deletionReconcileRunning = undefined;
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  close(): void {
    if (this.deletionReconcileTimer) clearInterval(this.deletionReconcileTimer);
    this.deletionReconcileTimer = undefined;
  }

  private startDeletionReconciler(): void {
    const run = () => {
      void this.reconcileDeletedSessions().catch((error) => {
        try {
          this.options.onDeletionReconcileError?.(error);
        } catch {
          // An observability callback must never disable the durable repair loop.
        }
      });
    };
    queueMicrotask(run);
    this.deletionReconcileTimer = setInterval(run, this.deletionReconcileIntervalMs);
    this.deletionReconcileTimer.unref?.();
  }

  private async reconcileDeletedSessionsInternal(): Promise<number> {
    const markerPrefix = `${this.prefix}/deletions/`;
    let continuationToken: string | undefined;
    let repaired = 0;
    const seenTokens = new Set<string>();
    do {
      const response = (await this.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: markerPrefix,
          MaxKeys: 1_000,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      )) as { Contents?: Array<{ Key?: string }>; NextContinuationToken?: string };
      for (const value of response.Contents ?? []) {
        if (!value.Key?.startsWith(markerPrefix) || !value.Key.endsWith(".json")) {
          throw new Error("S3 returned an invalid artifact deletion marker");
        }
        const sessionId = value.Key.slice(markerPrefix.length, -".json".length);
        assertSegment(sessionId, "session id");
        if (this.deletionMarkerKey(sessionId) !== value.Key) {
          throw new Error("S3 returned a non-canonical artifact deletion marker");
        }
        await this.deleteSessionPrefix(sessionId);
        repaired++;
      }
      const next = response.NextContinuationToken;
      if (next) {
        if (seenTokens.has(next)) throw new Error("S3 deletion marker scan made no progress");
        seenTokens.add(next);
      }
      continuationToken = next;
    } while (continuationToken);
    return repaired;
  }

  private async bucketIsVersioned(): Promise<boolean> {
    const response = (await this.send(new GetBucketVersioningCommand({ Bucket: this.bucket }))) as {
      Status?: string;
    };
    if (response.Status === undefined) return false;
    if (response.Status === "Enabled" || response.Status === "Suspended") return true;
    throw new Error(`Unsupported S3 bucket versioning status: ${String(response.Status)}`);
  }

  /** Re-list the first page after every batch so deletion uses bounded memory and cannot skip keys. */
  private async deletePrefix(prefix: string): Promise<void> {
    let previousPage: string | undefined;
    for (;;) {
      const response = (await this.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: 1_000,
        }),
      )) as { Contents?: Array<{ Key?: string }> };
      const keys: string[] = [];
      for (const value of response.Contents ?? []) {
        if (!value.Key) continue;
        if (!value.Key.startsWith(prefix)) throw new Error("S3 returned a key outside its prefix");
        keys.push(value.Key);
      }
      if (keys.length === 0) return;
      const page = keys.join("\0");
      if (page === previousPage) {
        throw new Error("S3 artifact deletion made no progress");
      }
      previousPage = page;
      await this.deleteKeys(keys);
    }
  }

  /** Permanently remove versions and delete markers in bounded batches. */
  private async deleteVersionedPrefix(prefix: string, exactKey?: string): Promise<void> {
    let previousPage: string | undefined;
    for (;;) {
      const response = (await this.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: 1_000,
        }),
      )) as {
        Versions?: Array<{ Key?: string; VersionId?: string }>;
        DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>;
      };
      const versions: Array<{ Key: string; VersionId: string }> = [];
      for (const value of [...(response.Versions ?? []), ...(response.DeleteMarkers ?? [])]) {
        if (!value.Key || !value.Key.startsWith(prefix)) {
          if (value.Key) throw new Error("S3 returned an object version outside its prefix");
          continue;
        }
        if (exactKey !== undefined && value.Key !== exactKey) continue;
        if (!value.VersionId) throw new Error("S3 returned an object version without VersionId");
        versions.push({ Key: value.Key, VersionId: value.VersionId });
      }
      if (versions.length === 0) return;
      const page = versions.map((value) => `${value.Key}\0${value.VersionId}`).join("\0");
      if (page === previousPage) {
        throw new Error("S3 versioned artifact deletion made no progress");
      }
      previousPage = page;
      await this.deleteKeys(versions);
    }
  }

  private async deleteKeys(
    keys: ReadonlyArray<string | { Key: string; VersionId: string }>,
  ): Promise<void> {
    for (let index = 0; index < keys.length; index += 1_000) {
      const batch = keys.slice(index, index + 1_000);
      const response = (await this.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: batch.map((value) => (typeof value === "string" ? { Key: value } : value)),
            Quiet: true,
          },
        }),
      )) as { Errors?: Array<{ Key?: string; Code?: string; Message?: string }> };
      if (response.Errors?.length) {
        const first = response.Errors[0]!;
        throw new Error(
          `S3 artifact deletion failed for ${first.Key ?? "unknown key"}: ${first.Code ?? first.Message ?? "unknown error"}`,
        );
      }
    }
  }

  private async readMetadata(
    sessionId: string,
    artifactIdValue: string,
    signal?: AbortSignal,
  ): Promise<Artifact | undefined> {
    return this.readMetadataKey(this.metadataKey(sessionId, artifactIdValue), signal);
  }

  private async readMetadataKey(key: string, signal?: AbortSignal): Promise<Artifact | undefined> {
    try {
      const response = (await this.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        signal,
      )) as { Body?: unknown };
      const parsed = validateStoredArtifact(
        JSON.parse(
          Buffer.from(await bodyBytes(response.Body, 1024 * 1024, signal)).toString("utf8"),
        ),
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

function s3PreconditionFailed(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value.name === "PreconditionFailed" || value.$metadata?.httpStatusCode === 412;
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
    requestTimeoutMs: Number(env.ANICODE_ARTIFACT_S3_REQUEST_TIMEOUT_MS ?? 120_000),
    deletionReconcileIntervalMs: Number(env.ANICODE_ARTIFACT_DELETE_RECONCILE_MS ?? 60_000),
    onDeletionReconcileError: (error) =>
      console.error(
        "AniCode S3 artifact deletion reconciliation failed:",
        error instanceof Error ? error.message : String(error),
      ),
    clientConfig: {
      ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
      ...(env.ANICODE_ARTIFACT_S3_ENDPOINT ? { endpoint: env.ANICODE_ARTIFACT_S3_ENDPOINT } : {}),
      forcePathStyle: env.ANICODE_ARTIFACT_S3_FORCE_PATH_STYLE === "1",
    },
  });
}
