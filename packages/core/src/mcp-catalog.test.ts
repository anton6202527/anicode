import { test } from "node:test";
import assert from "node:assert/strict";
import { DEVELOPMENT_MCP_CATALOG, findDevelopmentMcp } from "./mcp-catalog.js";

test("MCP catalog: contains the curated development set with stable ids", () => {
  assert.deepEqual(
    DEVELOPMENT_MCP_CATALOG.map((entry) => entry.id),
    ["context7", "github", "playwright", "chrome-devtools", "sentry", "firebase"],
  );
  assert.equal(findDevelopmentMcp("Chrome-DevTools")?.server.name, "chrome-devtools");
  assert.equal(findDevelopmentMcp("missing"), undefined);
});

test("MCP catalog: local packages are pinned and deprecated servers are absent", () => {
  const commands = DEVELOPMENT_MCP_CATALOG.flatMap((entry) =>
    "command" in entry.server ? (entry.server.args ?? []) : [],
  );
  assert.ok(commands.includes("@playwright/mcp@0.0.78"));
  assert.ok(commands.includes("chrome-devtools-mcp@1.6.0"));
  assert.ok(commands.includes("firebase-tools@15.25.1"));
  assert.ok(!commands.some((arg) => arg.includes("@latest")));
  assert.ok(!commands.some((arg) => arg.includes("server-github")));
  assert.ok(!commands.some((arg) => arg.includes("server-web-search")));
});

test("MCP catalog: hosted credentials are broker references, never token values", () => {
  const github = findDevelopmentMcp("github")!;
  assert.ok("url" in github.server);
  if (!("url" in github.server)) return;
  assert.deepEqual(github.server.credential, {
    id: "env:GITHUB_TOKEN",
    header: "Authorization",
    scheme: "Bearer",
  });
  assert.equal(github.server.headers?.["X-MCP-Lockdown"], "true");

  const serialized = JSON.stringify(DEVELOPMENT_MCP_CATALOG);
  assert.doesNotMatch(serialized, /ghp_|github_pat_|sntrys_/);
});
