import { createHash } from "node:crypto";

/**
 * The task payload (rather than a human-readable catalog label) identifies what was evaluated.
 * This is deliberately stable across object-key ordering so a baseline cannot be reused after a
 * task prompt, commit, or verifier definition changes under the same catalog name.
 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

export function catalogDigest(tasks: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(tasks)))
    .digest("hex");
}
