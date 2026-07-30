import test from "node:test";
import assert from "node:assert/strict";
import { trustedExternalUrl, trustedRendererDevUrl } from "./security.js";

test("Electron security: renderer development URL is loopback-only", () => {
  assert.equal(trustedRendererDevUrl("http://localhost:5173"), "http://localhost:5173/");
  assert.equal(trustedRendererDevUrl("https://127.0.0.1:5173/app"), "https://127.0.0.1:5173/app");
  assert.equal(trustedRendererDevUrl("https://example.com"), undefined);
  assert.equal(trustedRendererDevUrl("http://user:secret@localhost:5173"), undefined);
});

test("Electron security: external links are credential-free HTTPS only", () => {
  assert.equal(trustedExternalUrl("https://example.com/docs"), "https://example.com/docs");
  assert.equal(trustedExternalUrl("http://example.com"), undefined);
  assert.equal(trustedExternalUrl("file:///etc/passwd"), undefined);
  assert.equal(trustedExternalUrl("javascript:alert(1)"), undefined);
  assert.equal(trustedExternalUrl("https://user:secret@example.com"), undefined);
});
