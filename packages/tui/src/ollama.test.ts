import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { ensureOllama, safeOllamaBase } from "./ollama.js";

test("Ollama probe only accepts credential-free loopback endpoints", () => {
  assert.equal(safeOllamaBase("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434");
  assert.equal(safeOllamaBase("https://localhost:11434/"), "https://localhost:11434");
  assert.equal(safeOllamaBase("http://[::1]:11434"), "http://[::1]:11434");
  assert.equal(safeOllamaBase("https://example.com"), undefined);
  assert.equal(safeOllamaBase("http://localhost.evil.test"), undefined);
  assert.equal(safeOllamaBase("http://user:secret@localhost:11434"), undefined);
  assert.equal(safeOllamaBase("file:///tmp/ollama.sock"), undefined);
});

test("Ollama auto-start is opt-in and never resolves an executable from PATH", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(503);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const previousAutoStart = process.env["ANICODE_OLLAMA_AUTO_START"];
  const previousExecutable = process.env["ANICODE_OLLAMA_EXECUTABLE"];
  try {
    delete process.env["ANICODE_OLLAMA_AUTO_START"];
    process.env["ANICODE_OLLAMA_EXECUTABLE"] = "/untrusted/path/that-must-not-run";
    assert.equal(await ensureOllama(base, 1), "manual");

    process.env["ANICODE_OLLAMA_AUTO_START"] = "1";
    process.env["ANICODE_OLLAMA_EXECUTABLE"] = "ollama";
    assert.equal(await ensureOllama(base, 1), "missing");
  } finally {
    if (previousAutoStart === undefined) delete process.env["ANICODE_OLLAMA_AUTO_START"];
    else process.env["ANICODE_OLLAMA_AUTO_START"] = previousAutoStart;
    if (previousExecutable === undefined) delete process.env["ANICODE_OLLAMA_EXECUTABLE"];
    else process.env["ANICODE_OLLAMA_EXECUTABLE"] = previousExecutable;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Ollama probe rejects a remote configured endpoint before network access", async () => {
  assert.equal(await ensureOllama("https://example.com", 1), "unsafe");
});
