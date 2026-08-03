import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { configuredS3ArtifactStoreFromEnv, S3ArtifactStore } from "./artifacts.js";

async function readBody(body: unknown): Promise<Buffer> {
  if (typeof body === "string" || body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

class FakeS3Client {
  readonly objects = new Map<string, Buffer>();
  puts = 0;
  readonly deleteBatchSizes: number[] = [];
  readonly listedPrefixes: string[] = [];

  constructor(private readonly pageSize = 1) {}

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      if (command.input.IfNoneMatch === "*" && this.objects.has(command.input.Key!)) {
        throw Object.assign(new Error("precondition failed"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        });
      }
      this.puts++;
      this.objects.set(command.input.Key!, await readBody(command.input.Body));
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const body = this.objects.get(command.input.Key!);
      if (!body) {
        throw Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
      }
      return { Body: new Uint8Array(body) };
    }
    if (command instanceof GetBucketVersioningCommand) return {};
    if (command instanceof ListObjectsV2Command) {
      this.listedPrefixes.push(command.input.Prefix ?? "");
      const keys = [...this.objects.keys()]
        .filter((key) => key.startsWith(command.input.Prefix ?? ""))
        .sort();
      const offset = Number(command.input.ContinuationToken ?? "0");
      const pageSize = Math.min(command.input.MaxKeys ?? 1_000, this.pageSize);
      const selected = keys.slice(offset, offset + pageSize);
      return {
        Contents: selected.map((Key) => ({ Key })),
        ...(offset + selected.length < keys.length
          ? { NextContinuationToken: String(offset + selected.length) }
          : {}),
      };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(command.input.Key!);
      return {};
    }
    if (command instanceof DeleteObjectsCommand) {
      const keys = (command.input.Delete?.Objects ?? []).flatMap((object) =>
        object.Key ? [object.Key] : [],
      );
      this.deleteBatchSizes.push(keys.length);
      for (const key of keys) this.objects.delete(key);
      return {};
    }
    throw new Error(`Unsupported fake S3 command: ${String(command)}`);
  }
}

class StuckDeleteS3Client extends FakeS3Client {
  override async send(command: unknown): Promise<unknown> {
    if (command instanceof DeleteObjectsCommand) return {};
    return super.send(command);
  }
}

class StreamingBodyS3Client extends FakeS3Client {
  body: unknown;

  override async send(command: unknown): Promise<unknown> {
    if (
      command instanceof GetObjectCommand &&
      command.input.Key?.includes("/blobs/") &&
      this.body
    ) {
      return { Body: this.body };
    }
    return super.send(command);
  }
}

class AbortAwareHangingS3Client {
  send(_command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    return new Promise((_, reject) => {
      const signal = options?.abortSignal;
      if (!signal) return;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}

class VersionedFakeS3Client extends FakeS3Client {
  readonly versions: Array<{ Key: string; VersionId: string; marker?: boolean }> = [];
  readonly deletedVersions: Array<{ Key: string; VersionId: string }> = [];

  override async send(command: unknown): Promise<unknown> {
    if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
    if (command instanceof PutObjectCommand) {
      const result = await super.send(command);
      this.versions.push({
        Key: command.input.Key!,
        VersionId: `auto-${this.versions.length}`,
      });
      return result;
    }
    if (command instanceof ListObjectVersionsCommand) {
      const matching = this.versions
        .filter((value) => value.Key.startsWith(command.input.Prefix ?? ""))
        .slice(0, command.input.MaxKeys ?? 1_000);
      return {
        Versions: matching
          .filter((value) => !value.marker)
          .map(({ Key, VersionId }) => ({ Key, VersionId })),
        DeleteMarkers: matching
          .filter((value) => value.marker)
          .map(({ Key, VersionId }) => ({ Key, VersionId })),
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      const identifiers = (command.input.Delete?.Objects ?? []).flatMap((value) =>
        value.Key && value.VersionId ? [{ Key: value.Key, VersionId: value.VersionId }] : [],
      );
      this.deletedVersions.push(...identifiers);
      for (const identifier of identifiers) {
        const index = this.versions.findIndex(
          (value) => value.Key === identifier.Key && value.VersionId === identifier.VersionId,
        );
        if (index >= 0) this.versions.splice(index, 1);
        if (!this.versions.some((value) => value.Key === identifier.Key)) {
          this.objects.delete(identifier.Key);
        }
      }
      return {};
    }
    return super.send(command);
  }
}

test("S3 artifacts: streaming、session payload isolation、pagination、integrity 与 full delete", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-s3-artifact-test-"));
  try {
    const client = new FakeS3Client();
    const store = new S3ArtifactStore({
      client,
      bucket: "test-artifacts",
      kmsKeyId: "alias/anicode-test",
      tempDir,
      maxArtifactBytes: 1024,
    });
    const artifact = await store.putStream({
      sessionId: "session_one",
      kind: "report",
      name: "result.txt",
      mediaType: "text/plain",
      data: (async function* () {
        yield Buffer.from("hel");
        yield Buffer.from("lo");
      })(),
    });
    assert.equal(artifact.sizeBytes, 5);
    assert.equal(client.puts, 2);
    assert.equal(
      Buffer.from((await store.get("session_one", artifact.id))!.data).toString(),
      "hello",
    );

    const duplicate = await store.put({
      sessionId: "session_one",
      kind: "report",
      name: "ignored-name.txt",
      data: "hello",
    });
    assert.equal(duplicate.id, artifact.id);
    assert.equal(client.puts, 2);

    await store.put({ sessionId: "session_one", kind: "log", name: "second", data: "world" });
    assert.equal((await store.list("session_one")).length, 2);
    assert.equal((await store.list("other_session")).length, 0);

    const other = await store.put({
      sessionId: "session_two",
      kind: "report",
      name: "same-content.txt",
      data: "hello",
    });

    const blobKey = [...client.objects.keys()].find(
      (key) => key.includes("/sessions/session_one/blobs/") && key.endsWith(artifact.sha256),
    )!;
    const otherBlobKey = [...client.objects.keys()].find(
      (key) => key.includes("/sessions/session_two/blobs/") && key.endsWith(other.sha256),
    )!;
    const original = client.objects.get(blobKey)!;
    client.objects.set(blobKey, Buffer.from("HELLO"));
    await assert.rejects(() => store.get("session_one", artifact.id), /integrity check failed/);
    client.objects.set(blobKey, original);

    assert.equal(await store.delete("session_one", artifact.id), true);
    assert.equal(await store.delete("session_one", artifact.id), false);
    assert.equal(client.objects.has(blobKey), false, "session payload is physically deleted");
    assert.equal(client.objects.has(otherBlobKey), true, "another session's payload is untouched");
    assert.equal(Buffer.from((await store.get("session_two", other.id))!.data).toString(), "hello");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("S3 artifacts: closing an iterator cancels the upstream WebStream", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-s3-artifact-cancel-"));
  try {
    const client = new StreamingBodyS3Client();
    const store = new S3ArtifactStore({
      client,
      bucket: "test-artifacts",
      tempDir,
      maxArtifactBytes: 1024,
    });
    const artifact = await store.put({
      sessionId: "stream_cancel",
      kind: "report",
      name: "stream.txt",
      data: "firstSECRET_AFTER_CLOSE",
    });
    let resolveCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    client.body = {
      transformToByteArray(): Promise<Uint8Array> {
        throw new Error("streaming response must not use transformToByteArray");
      },
      transformToWebStream(): ReadableStream<Uint8Array> {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from("first"));
          },
          cancel() {
            resolveCancelled();
          },
        });
      },
    };

    const opened = await store.open("stream_cancel", artifact.id);
    assert.ok(opened);
    const reader = opened.data[Symbol.asyncIterator]();
    const first = await reader.next();
    assert.equal(Buffer.from(first.value!).toString("utf8"), "first");
    await reader.return?.();
    await cancelled;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("S3 artifacts: legacy global blobs remain readable and are never deleted by one session", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-s3-artifact-legacy-"));
  try {
    const client = new FakeS3Client();
    const store = new S3ArtifactStore({
      client,
      bucket: "test-artifacts",
      tempDir,
      maxArtifactBytes: 1024,
    });
    const artifact = await store.put({
      sessionId: "legacy_session",
      kind: "report",
      name: "legacy.txt",
      data: "legacy payload",
    });
    const scopedKey = [...client.objects.keys()].find(
      (key) => key.includes("/sessions/legacy_session/blobs/") && key.endsWith(artifact.sha256),
    )!;
    const legacyKey = scopedKey.replace(
      `/sessions/legacy_session/blobs/${artifact.sha256.slice(0, 2)}/`,
      `/blobs/${artifact.sha256.slice(0, 2)}/`,
    );
    client.objects.set(legacyKey, client.objects.get(scopedKey)!);
    client.objects.delete(scopedKey);

    assert.equal(
      Buffer.from((await store.get("legacy_session", artifact.id))!.data).toString(),
      "legacy payload",
    );
    assert.equal(await store.delete("legacy_session", artifact.id), true);
    assert.equal(client.objects.has(legacyKey), true, "legacy shared payload must be retained");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("S3 artifacts: deleteSession paginates past 10k and removes corrupt metadata and orphan blobs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-s3-artifact-purge-"));
  try {
    const client = new FakeS3Client(257);
    const store = new S3ArtifactStore({
      client,
      bucket: "test-artifacts",
      tempDir,
      // The interactive list limit must not cap destructive prefix enumeration.
      maxListItems: 3,
    });
    const prefix = "anicode/artifacts/v1/sessions/bulk_session/";
    for (let index = 0; index < 10_005; index++) {
      client.objects.set(`${prefix}orphans/${String(index).padStart(5, "0")}`, Buffer.from("x"));
    }
    client.objects.set(`${prefix}corrupt.json`, Buffer.from("{not-json"));
    client.objects.set(`${prefix}blobs/ff/orphan-after-interrupted-put`, Buffer.from("secret"));
    client.objects.set("anicode/artifacts/v1/sessions/other_session/keep", Buffer.from("other"));

    await store.deleteSession("bulk_session");

    assert.equal(
      [...client.objects.keys()].some((key) => key.startsWith(prefix)),
      false,
      "the entire session namespace must be physically removed",
    );
    assert.equal(client.objects.has("anicode/artifacts/v1/sessions/other_session/keep"), true);
    assert.ok(client.deleteBatchSizes.length > 10);
    assert.ok(client.deleteBatchSizes.every((size) => size > 0 && size <= 1_000));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("S3 artifacts: deleteSession never scans globally or deletes shared legacy blobs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-s3-artifact-gc-"));
  try {
    const client = new FakeS3Client(50);
    const store = new S3ArtifactStore({ client, bucket: "test-artifacts", tempDir });
    const first = await store.put({
      sessionId: "legacy_first",
      kind: "report",
      name: "shared.txt",
      data: "shared legacy secret",
    });
    await store.put({
      sessionId: "legacy_second",
      kind: "report",
      name: "shared.txt",
      data: "shared legacy secret",
    });
    const firstScoped = [...client.objects.keys()].find(
      (key) => key.includes("/sessions/legacy_first/blobs/") && key.endsWith(first.sha256),
    )!;
    const secondScoped = [...client.objects.keys()].find(
      (key) => key.includes("/sessions/legacy_second/blobs/") && key.endsWith(first.sha256),
    )!;
    const global = firstScoped.replace(
      `/sessions/legacy_first/blobs/${first.sha256.slice(0, 2)}/`,
      `/blobs/${first.sha256.slice(0, 2)}/`,
    );
    client.objects.set(global, client.objects.get(firstScoped)!);
    client.objects.delete(firstScoped);
    client.objects.delete(secondScoped);

    await store.deleteSession("legacy_first");
    assert.equal(
      client.objects.has(global),
      true,
      "a remaining metadata reference retains v1 data",
    );
    await store.deleteSession("legacy_second");
    assert.equal(
      client.objects.has(global),
      true,
      "online deletion leaves global v1 data for an offline inventory GC",
    );
    assert.equal(
      client.listedPrefixes.some((prefix) => prefix === "anicode/artifacts/v1/sessions/"),
      false,
      "a session deletion must never enumerate every tenant/session object",
    );

    const uncertain = await store.put({
      sessionId: "legacy_uncertain",
      kind: "report",
      name: "uncertain.txt",
      data: "uncertain legacy secret",
    });
    const uncertainScoped = [...client.objects.keys()].find(
      (key) => key.includes("/sessions/legacy_uncertain/blobs/") && key.endsWith(uncertain.sha256),
    )!;
    const uncertainGlobal = uncertainScoped.replace(
      `/sessions/legacy_uncertain/blobs/${uncertain.sha256.slice(0, 2)}/`,
      `/blobs/${uncertain.sha256.slice(0, 2)}/`,
    );
    client.objects.set(uncertainGlobal, client.objects.get(uncertainScoped)!);
    client.objects.delete(uncertainScoped);
    client.objects.set(
      "anicode/artifacts/v1/sessions/corrupt_other/unknown.json",
      Buffer.from("{broken"),
    );
    await store.deleteSession("legacy_uncertain");
    assert.equal(
      client.objects.has(uncertainGlobal),
      true,
      "legacy shared payloads are always retained by online deletion",
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("S3 artifacts: deleteSession fails instead of looping when deletion makes no progress", async () => {
  const client = new StuckDeleteS3Client();
  client.objects.set("anicode/artifacts/v1/sessions/stuck_session/orphan", Buffer.from("secret"));
  const store = new S3ArtifactStore({ client, bucket: "test-artifacts" });

  await assert.rejects(() => store.deleteSession("stuck_session"), /made no progress/);
});

test("S3 artifacts: persistent deletion marker blocks reuse and repairs a post-crash late object", async () => {
  const client = new FakeS3Client(50);
  const store = new S3ArtifactStore({ client, bucket: "test-artifacts" });
  const sessionPrefix = "anicode/artifacts/v1/sessions/crashed_writer/";
  const markerKey = "anicode/artifacts/v1/deletions/crashed_writer.json";

  await store.put({
    sessionId: "crashed_writer",
    kind: "report",
    name: "before-delete.txt",
    data: "sensitive content",
  });
  await store.deleteSession("crashed_writer");
  assert.equal(client.objects.has(markerKey), true, "the content-free fence survives prefix purge");

  // Model an S3 Put accepted after its producer process died and after the first purge completed.
  const lateKey = `${sessionPrefix}blobs/ff/late-after-process-crash`;
  client.objects.set(lateKey, Buffer.from("late sensitive bytes"));
  assert.deepEqual(await store.list("crashed_writer"), []);
  await assert.rejects(
    () =>
      store.put({
        sessionId: "crashed_writer",
        kind: "report",
        name: "must-not-reopen.txt",
        data: "new bytes",
      }),
    /permanently deleted/,
  );

  assert.equal(await store.reconcileDeletedSessions(), 1);
  assert.equal(
    client.objects.has(lateKey),
    false,
    "restart-safe reconciliation removes the orphan",
  );
  assert.equal(client.objects.has(markerKey), true, "reconciliation never removes the fence");
});

test("S3 artifacts: versioned session deletion permanently removes versions and delete markers", async () => {
  const client = new VersionedFakeS3Client(137);
  const prefix = "anicode/artifacts/v1/sessions/versioned_session/";
  for (let index = 0; index < 1_205; index++) {
    client.versions.push({
      Key: `${prefix}objects/${String(index).padStart(4, "0")}`,
      VersionId: `v-${index}`,
      ...(index % 7 === 0 ? { marker: true } : {}),
    });
  }
  client.versions.push({
    Key: "anicode/artifacts/v1/sessions/other_session/keep",
    VersionId: "other-v1",
  });
  client.versions.push({
    Key: "anicode/artifacts/v1/blobs/aa/shared",
    VersionId: "legacy-v1",
  });
  const store = new S3ArtifactStore({ client, bucket: "test-artifacts" });

  await store.deleteSession("versioned_session");
  await store.deleteSession("versioned_session");

  assert.equal(
    client.versions.some((value) => value.Key.startsWith(prefix)),
    false,
  );
  assert.equal(client.deletedVersions.length, 1_205);
  assert.equal(
    client.versions.filter(
      (value) => value.Key === "anicode/artifacts/v1/deletions/versioned_session.json",
    ).length,
    1,
    "repeated reconciliation must not create unbounded deletion-marker versions",
  );
  assert.equal(
    client.versions.some((value) => value.Key.includes("other_session/keep")),
    true,
  );
  assert.equal(
    client.versions.some((value) => value.Key.includes("/blobs/aa/shared")),
    true,
  );
});

test("S3 artifacts: versioned single-artifact deletion removes every owned version only", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-s3-versioned-single-"));
  try {
    const client = new VersionedFakeS3Client();
    const store = new S3ArtifactStore({
      client,
      bucket: "test-artifacts",
      tempDir,
    });
    const artifact = await store.put({
      sessionId: "versioned_single",
      kind: "report",
      name: "secret.txt",
      data: "versioned secret",
    });
    const ownedKeys = [...client.objects.keys()].filter((key) =>
      key.includes("/sessions/versioned_single/"),
    );
    for (const key of ownedKeys) {
      client.versions.push({ Key: key, VersionId: `old-${key}`, marker: true });
      client.versions.push({ Key: key, VersionId: `older-${key}` });
    }
    const metadataKey = ownedKeys.find((key) => key.endsWith(".json"))!;
    client.versions.push({ Key: `${metadataKey}.foreign-suffix`, VersionId: "keep-suffix" });

    assert.equal(await store.delete("versioned_single", artifact.id), true);
    assert.equal(
      client.versions.some((value) => ownedKeys.includes(value.Key)),
      false,
    );
    assert.equal(
      client.versions.some((value) => value.VersionId === "keep-suffix"),
      true,
      "exact-key deletion must not consume an adjacent key sharing the prefix",
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("S3 artifacts: size failure cleans staging and production env rejects static AWS keys", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-s3-artifact-limit-"));
  try {
    const store = new S3ArtifactStore({
      client: new FakeS3Client(),
      bucket: "test-artifacts",
      tempDir,
      maxArtifactBytes: 3,
    });
    await assert.rejects(
      () => store.put({ sessionId: "session_one", kind: "log", name: "too-big", data: "four" }),
      /exceeds 3 bytes/,
    );
    assert.deepEqual(await fs.readdir(tempDir), []);
    assert.throws(
      () =>
        configuredS3ArtifactStoreFromEnv({
          AWS_ACCESS_KEY_ID: "forbidden",
          ANICODE_ARTIFACT_S3_BUCKET: "test-artifacts",
          ANICODE_ARTIFACT_KMS_KEY_ID: "alias/test",
        }),
      /AWS_ACCESS_KEY_ID is forbidden/,
    );
    assert.throws(
      () => new S3ArtifactStore({ bucket: "test-artifacts", maxArtifactBytes: Number.NaN }),
      /Invalid S3 artifact size limit/,
    );
    assert.throws(
      () => new S3ArtifactStore({ bucket: "test-artifacts", requestTimeoutMs: 999 }),
      /request timeout must be from 1000/,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("S3 artifacts: every backend request has a bounded abort deadline", async () => {
  const store = new S3ArtifactStore({
    client: new AbortAwareHangingS3Client(),
    bucket: "test-artifacts",
    requestTimeoutMs: 1_000,
  });
  const started = Date.now();
  await assert.rejects(() => store.list("bounded_session"), /timed out|timeout/i);
  assert.ok(Date.now() - started < 2_000, "a stalled S3 request must not wedge reconciliation");
});
