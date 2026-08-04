import { promises as fs } from "node:fs";
import * as path from "node:path";
import { evaluateQualityGate, formatQualityGate } from "./quality-gate.js";
import { assertComparableSummaries, formatReport, mergeSummaries, type Summary } from "./report.js";
import { verifyReviewedBaseline, type BaselineManifest } from "./baseline.js";
import { catalogDigest } from "./catalog.js";
import { REAL_REPO_TASKS } from "./tasks/real-repo.generated.js";

interface Args {
  input?: string;
  output?: string;
  baseline?: string;
  baselineManifest?: string;
  bootstrapBaseline?: boolean;
  expectRealLimit?: number;
  expectTrials?: number;
}

function parse(argv: string[]): Args {
  const args: Args = {};
  const required = (index: number, flag: string): string => {
    const value = argv[index];
    if (!value) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--input") args.input = required(++index, value);
    else if (value === "--output") args.output = required(++index, value);
    else if (value === "--baseline") args.baseline = required(++index, value);
    else if (value === "--baseline-manifest") args.baselineManifest = required(++index, value);
    else if (value === "--bootstrap-baseline") args.bootstrapBaseline = true;
    else if (value === "--expect-real-limit")
      args.expectRealLimit = Number(required(++index, value));
    else if (value === "--expect-trials") args.expectTrials = Number(required(++index, value));
    else throw new Error(`Unknown merge argument: ${value}`);
  }
  return args;
}

async function jsonFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (/real-eval-\d+\.json$/.test(entry.name)) files.push(target);
    }
  };
  await walk(root);
  return files.sort();
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (!args.input || !args.output) throw new Error("--input and --output are required");
  if (args.bootstrapBaseline) {
    throw new Error(
      "--bootstrap-baseline no longer writes a trusted baseline. Use eval:baseline create and eval:baseline approve",
    );
  }
  if (args.baseline && !args.baselineManifest) {
    throw new Error("--baseline-manifest is required with --baseline");
  }
  if (args.expectRealLimit !== undefined) {
    if (
      !Number.isInteger(args.expectRealLimit) ||
      args.expectRealLimit < 1 ||
      args.expectRealLimit > REAL_REPO_TASKS.length
    ) {
      throw new Error(`--expect-real-limit must be an integer in [1, ${REAL_REPO_TASKS.length}]`);
    }
  }
  if (
    args.expectTrials !== undefined &&
    (!Number.isInteger(args.expectTrials) || args.expectTrials < 1)
  ) {
    throw new Error("--expect-trials must be a positive integer");
  }
  const files = await jsonFiles(path.resolve(args.input));
  const summaries = await Promise.all(
    files.map(async (file) => JSON.parse(await fs.readFile(file, "utf8")) as Summary),
  );
  const merged = mergeSummaries(summaries);
  if (args.expectRealLimit !== undefined) {
    const expectedTasks = REAL_REPO_TASKS.slice(0, args.expectRealLimit);
    const expectedIds = expectedTasks.map((task) => task.id);
    const actualIds = merged.settings?.expectedTaskIds ?? [];
    const missing = expectedIds.filter((id) => !actualIds.includes(id));
    const unexpected = actualIds.filter((id) => !expectedIds.includes(id));
    if (
      missing.length ||
      unexpected.length ||
      actualIds.length !== expectedIds.length ||
      merged.settings?.catalogDigest !== catalogDigest(expectedTasks)
    ) {
      throw new Error("Merged eval result does not match the trusted real-eval task catalog");
    }
  }
  if (args.expectTrials !== undefined && merged.settings?.trials !== args.expectTrials) {
    throw new Error(
      `Merged eval trial count mismatch: ${merged.settings?.trials} != ${args.expectTrials}`,
    );
  }
  await fs.writeFile(args.output, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(formatReport(merged));

  if (args.baseline) {
    const baselineText = await fs.readFile(args.baseline, "utf8");
    const baseline = JSON.parse(baselineText) as Summary;
    const manifest = JSON.parse(
      await fs.readFile(args.baselineManifest!, "utf8"),
    ) as BaselineManifest;
    verifyReviewedBaseline(baselineText, baseline, manifest, trustedBaselineKeys());
    assertComparableSummaries(merged, baseline);
    const gate = evaluateQualityGate(merged, baseline);
    if (!gate.passed) {
      console.error(formatQualityGate(gate));
      process.exitCode = 1;
    }
  }
}

function trustedBaselineKeys(): Record<string, string> {
  const raw = process.env.ANICODE_EVAL_BASELINE_TRUSTED_KEYS;
  if (!raw)
    throw new Error("ANICODE_EVAL_BASELINE_TRUSTED_KEYS is required to verify a reviewed baseline");
  let keys: unknown;
  try {
    keys = JSON.parse(raw);
  } catch {
    throw new Error(
      "ANICODE_EVAL_BASELINE_TRUSTED_KEYS must be a JSON key-id to Ed25519 public-key map",
    );
  }
  if (!keys || typeof keys !== "object" || Array.isArray(keys) || Object.keys(keys).length === 0) {
    throw new Error("ANICODE_EVAL_BASELINE_TRUSTED_KEYS must contain at least one trusted key");
  }
  if (Object.values(keys as Record<string, unknown>).some((value) => typeof value !== "string")) {
    throw new Error("ANICODE_EVAL_BASELINE_TRUSTED_KEYS values must be PEM or base64 SPKI strings");
  }
  return keys as Record<string, string>;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
