import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  DeleteObjectCommand,
  GetObjectCommand,
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

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
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
    if (command instanceof ListObjectsV2Command) {
      const keys = [...this.objects.keys()]
        .filter((key) => key.startsWith(command.input.Prefix ?? ""))
        .sort();
      const offset = Number(command.input.ContinuationToken ?? "0");
      // One key per page exercises continuation without coupling the test to AWS paging defaults.
      const selected = keys.slice(offset, offset + 1);
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
    throw new Error(`Unsupported fake S3 command: ${String(command)}`);
  }
}

test("S3 artifacts: streaming、content addressing、pagination、integrity 与 metadata delete", async () => {
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

    const blobKey = [...client.objects.keys()].find((key) => key.endsWith(artifact.sha256))!;
    const original = client.objects.get(blobKey)!;
    client.objects.set(blobKey, Buffer.from("HELLO"));
    await assert.rejects(() => store.get("session_one", artifact.id), /integrity check failed/);
    client.objects.set(blobKey, original);

    assert.equal(await store.delete("session_one", artifact.id), true);
    assert.equal(await store.delete("session_one", artifact.id), false);
    assert.equal(
      client.objects.has(blobKey),
      true,
      "shared content-addressed blobs remain for lifecycle GC",
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
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
