import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  approveCandidateManifest,
  createCandidateManifest,
  serializeBaseline,
  verifyReviewedBaseline,
  type BaselineCandidateManifest,
  type BaselineManifest,
} from "./baseline.js";
import type { Summary } from "./report.js";

interface Args {
  command?: "create" | "approve" | "verify";
  result?: string;
  candidate?: string;
  candidateManifest?: string;
  baseline?: string;
  manifest?: string;
  reviewer?: string;
  sourceRunUrl?: string;
  expectModel?: string;
  expectTrials?: number;
  expectSuite?: "offline" | "real";
  expectRuntimeImage?: string;
  signingKeyFile?: string;
  signingKeyId?: string;
}

function parse(argv: string[]): Args {
  const command = argv.shift();
  if (command !== "create" && command !== "approve" && command !== "verify") {
    throw new Error("Usage: eval:baseline create|approve|verify [options]");
  }
  const args: Args = { command };
  const required = (flag: string): string => {
    const value = argv.shift();
    if (!value) throw new Error(`${flag} requires a value`);
    return value;
  };
  while (argv.length) {
    const flag = argv.shift()!;
    if (flag === "--result") args.result = required(flag);
    else if (flag === "--candidate") args.candidate = required(flag);
    else if (flag === "--candidate-manifest") args.candidateManifest = required(flag);
    else if (flag === "--baseline") args.baseline = required(flag);
    else if (flag === "--manifest") args.manifest = required(flag);
    else if (flag === "--reviewer") args.reviewer = required(flag);
    else if (flag === "--source-run-url") args.sourceRunUrl = required(flag);
    else if (flag === "--expect-model") args.expectModel = required(flag);
    else if (flag === "--expect-trials") args.expectTrials = Number(required(flag));
    else if (flag === "--expect-suite") {
      const suite = required(flag);
      if (suite !== "offline" && suite !== "real") throw new Error("Invalid --expect-suite");
      args.expectSuite = suite;
    } else if (flag === "--expect-runtime-image") args.expectRuntimeImage = required(flag);
    else if (flag === "--signing-key-file") args.signingKeyFile = required(flag);
    else if (flag === "--signing-key-id") args.signingKeyId = required(flag);
    else throw new Error(`Unknown baseline argument: ${flag}`);
  }
  return args;
}

function need(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

async function readSummary(
  file: string,
): Promise<{ raw: string; canonical: string; summary: Summary }> {
  const raw = await fs.readFile(file, "utf8");
  const summary = JSON.parse(raw) as Summary;
  return { raw, canonical: serializeBaseline(summary), summary };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (
    args.expectTrials !== undefined &&
    (!Number.isFinite(args.expectTrials) ||
      !Number.isInteger(args.expectTrials) ||
      args.expectTrials < 1 ||
      args.expectTrials > 20)
  ) {
    throw new Error("--expect-trials must be an integer in [1, 20]");
  }
  if (args.command === "create") {
    const result = need(args.result, "--result");
    const candidateFile = need(args.candidate, "--candidate");
    const manifestFile = need(args.manifest, "--manifest");
    const { canonical, summary } = await readSummary(result);
    const manifest = createCandidateManifest(canonical, summary, args.sourceRunUrl);
    await fs.mkdir(path.dirname(path.resolve(candidateFile)), { recursive: true });
    await fs.writeFile(candidateFile, canonical, "utf8");
    await writeJson(manifestFile, manifest);
    console.log(`Created unreviewed baseline candidate ${candidateFile}`);
    return;
  }

  if (args.command === "approve") {
    const candidateFile = need(args.candidate, "--candidate");
    const candidateManifestFile = need(args.candidateManifest, "--candidate-manifest");
    const baselineFile = need(args.baseline, "--baseline");
    const manifestFile = need(args.manifest, "--manifest");
    const reviewer = need(args.reviewer, "--reviewer");
    const signingKeyFile = need(args.signingKeyFile, "--signing-key-file");
    const signingKeyId = need(args.signingKeyId, "--signing-key-id");
    const { raw, summary } = await readSummary(candidateFile);
    const candidate = JSON.parse(
      await fs.readFile(candidateManifestFile, "utf8"),
    ) as BaselineCandidateManifest;
    const signingKey = await fs.readFile(signingKeyFile);
    const reviewed = approveCandidateManifest(
      raw,
      summary,
      candidate,
      reviewer,
      args.sourceRunUrl,
      signingKey,
      signingKeyId,
    );
    await fs.mkdir(path.dirname(path.resolve(baselineFile)), { recursive: true });
    await fs.writeFile(baselineFile, raw, "utf8");
    await writeJson(manifestFile, reviewed);
    console.log(`Approved reviewed baseline ${baselineFile}`);
    return;
  }

  const baselineFile = need(args.baseline, "--baseline");
  const manifestFile = need(args.manifest, "--manifest");
  const { raw, summary } = await readSummary(baselineFile);
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8")) as BaselineManifest;
  verifyReviewedBaseline(raw, summary, manifest, trustedBaselineKeys());
  if (args.expectModel && manifest.profile.model !== args.expectModel) {
    throw new Error(
      `Reviewed baseline model mismatch: ${manifest.profile.model} != ${args.expectModel}`,
    );
  }
  if (args.expectTrials !== undefined && manifest.profile.trials !== args.expectTrials) {
    throw new Error(
      `Reviewed baseline trials mismatch: ${manifest.profile.trials} != ${args.expectTrials}`,
    );
  }
  if (args.expectSuite && manifest.profile.suite !== args.expectSuite) {
    throw new Error(
      `Reviewed baseline suite mismatch: ${manifest.profile.suite} != ${args.expectSuite}`,
    );
  }
  if (args.expectRuntimeImage && manifest.profile.runtimeImage !== args.expectRuntimeImage) {
    throw new Error(
      `Reviewed baseline runtime image mismatch: ${manifest.profile.runtimeImage} != ${args.expectRuntimeImage}`,
    );
  }
  console.log(
    `Verified reviewed baseline ${baselineFile} (${manifest.reviewedBy}, ${manifest.reviewedAt})`,
  );
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
