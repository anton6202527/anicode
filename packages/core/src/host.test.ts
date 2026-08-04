import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalSessionHost } from "./host.js";
import type { SessionManager } from "./session-manager.js";

test("LocalSessionHost: live model discovery stays on the host and sanitizes results", async () => {
  const calls: string[] = [];
  const manager = { async shutdown() {} } as unknown as SessionManager;
  const host = new LocalSessionHost(manager, async (providerId) => {
    calls.push(providerId);
    return ["live-model", "live-model", "\u001b[31munsafe"];
  });

  assert.deepEqual(await host.discoverModels("cliproxy"), ["live-model"]);
  assert.deepEqual(calls, ["cliproxy"]);
  await assert.rejects(() => host.discoverModels("../cliproxy"), /Invalid provider id/);
  await host.dispose();
});

test("LocalSessionHost: discovery errors hide the provider", async () => {
  const manager = { async shutdown() {} } as unknown as SessionManager;
  const host = new LocalSessionHost(manager, async () => {
    throw new Error("secret upstream detail");
  });
  assert.equal(await host.discoverModels("cliproxy"), undefined);
  await host.dispose();
});
