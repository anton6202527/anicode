import { test } from "node:test";
import assert from "node:assert/strict";
import type { LocalRuntimeStack } from "@anicode/core";
import { resolveEvalProvider } from "./cli.js";

test("eval CLI resolves providers through its bound runtime stack", () => {
  const expected = { marker: "bound-eval-provider" } as unknown as ReturnType<
    LocalRuntimeStack["resolveProvider"]
  >;
  const seen: string[] = [];
  const stack: Pick<LocalRuntimeStack, "resolveProvider"> = {
    resolveProvider(spec) {
      seen.push(spec);
      return expected;
    },
  };

  assert.strictEqual(resolveEvalProvider(stack, "fixture/model"), expected);
  assert.deepEqual(seen, ["fixture/model"]);
});
