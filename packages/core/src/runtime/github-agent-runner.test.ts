import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGitHubAgentProvider } from "./github-agent-runner.js";
import type { LocalRuntimeStack } from "./local-stack.js";

test("GitHub agent resolves providers through its bound runtime stack", () => {
  const expected = { marker: "bound-github-provider" } as unknown as ReturnType<
    LocalRuntimeStack["resolveProvider"]
  >;
  const seen: string[] = [];
  const stack: Pick<LocalRuntimeStack, "resolveProvider"> = {
    resolveProvider(spec) {
      seen.push(spec);
      return expected;
    },
  };

  assert.strictEqual(resolveGitHubAgentProvider(stack, "fixture/model"), expected);
  assert.deepEqual(seen, ["fixture/model"]);
});
