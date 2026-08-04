import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { EVAL_REPORT_SCHEMA_VERSION, summarize, type Summary } from "./report.js";

export const BASELINE_MANIFEST_SCHEMA_VERSION = 2 as const;

export interface BaselineProfile {
  model: string;
  suite: "offline" | "real";
  catalog: string;
  catalogDigest: string;
  runtimeImage: string;
  repomap: boolean;
  trials: number;
  taskCount: number;
  trialCount: number;
}

interface BaselineManifestCommon {
  schemaVersion: typeof BASELINE_MANIFEST_SCHEMA_VERSION;
  reportSchemaVersion: typeof EVAL_REPORT_SCHEMA_VERSION;
  status: "candidate" | "reviewed";
  baselineSha256: string;
  profile: BaselineProfile;
  sourceRevision: string;
  sourceRunUrl?: string;
  generatedAt: string;
}

export interface BaselineCandidateManifest extends BaselineManifestCommon {
  status: "candidate";
}

export interface ReviewedBaselineManifest extends BaselineManifestCommon {
  status: "reviewed";
  sourceRunUrl: string;
  reviewedBy: string;
  reviewedAt: string;
  approval: BaselineApproval;
}

export type BaselineManifest = BaselineCandidateManifest | ReviewedBaselineManifest;

export interface BaselineApproval {
  algorithm: "ed25519";
  keyId: string;
  /** Base64 Ed25519 signature over the canonical reviewed manifest excluding this field. */
  signature: string;
}

export type TrustedBaselineKeys = Readonly<Record<string, string>>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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

function stableJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

function reviewedPayload(manifest: Omit<ReviewedBaselineManifest, "approval">): Buffer {
  return Buffer.from(stableJson(manifest));
}

function trustedPublicKey(value: string) {
  try {
    const key = value.includes("BEGIN PUBLIC KEY")
      ? createPublicKey(value)
      : createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("unexpected key type");
    return key;
  } catch {
    throw new Error("Trusted baseline key is not a valid Ed25519 public key");
  }
}

export function serializeBaseline(summary: Summary): string {
  validateBaselineSummary(summary);
  return `${JSON.stringify(summary, null, 2)}\n`;
}

export function baselineProfile(summary: Summary): BaselineProfile {
  const settings = summary.settings;
  if (
    !settings?.suite ||
    !settings.catalog ||
    !settings.catalogDigest ||
    !settings.runtimeImage ||
    !settings.trials
  ) {
    throw new Error(
      "Baseline report must record suite, catalog digest, runtimeImage and trials in settings",
    );
  }
  return {
    model: summary.model,
    suite: settings.suite,
    catalog: settings.catalog,
    catalogDigest: settings.catalogDigest,
    runtimeImage: settings.runtimeImage,
    repomap: settings.repomap === true,
    trials: settings.trials,
    taskCount: summary.taskCount,
    trialCount: summary.total,
  };
}

export function validateBaselineSummary(summary: Summary): void {
  if (summary.schemaVersion !== EVAL_REPORT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported eval report schema ${String(summary.schemaVersion)}; expected ${EVAL_REPORT_SCHEMA_VERSION}`,
    );
  }
  if (!summary.model.trim()) throw new Error("Baseline model is required");
  if (summary.total < 1 || summary.taskCount < 1) {
    throw new Error("Baseline must contain at least one executed task");
  }
  const expectedTaskIds = summary.settings?.expectedTaskIds;
  if (!expectedTaskIds?.length || new Set(expectedTaskIds).size !== expectedTaskIds.length) {
    throw new Error("Baseline must record a unique, non-empty expected task set");
  }
  if (summary.taskCount !== expectedTaskIds.length) {
    throw new Error("Baseline task count does not match its expected task set");
  }
  if (summary.skipped !== 0 || summary.results.some((result) => result.skipped)) {
    throw new Error("Reviewed baselines cannot contain skipped trials");
  }
  if (
    summary.results.some(
      (result) =>
        !result.outcome ||
        (result.passed && (!result.outcome.verified || result.outcome.status !== "passed")) ||
        (!result.passed && result.outcome.status === "passed"),
    )
  ) {
    throw new Error("Baseline pass/fail values must agree with deterministic outcome evidence");
  }
  const revision = summary.settings?.revision?.trim();
  if (!revision || !/^[0-9a-f]{40,64}$/i.test(revision)) {
    throw new Error("Baseline source revision must be an immutable 40–64 digit commit hash");
  }
  baselineProfile(summary);
  const recomputed = summarize(summary.model, summary.results, summary.settings);
  if (stableJson(recomputed) !== stableJson(summary)) {
    throw new Error("Baseline summary metrics do not match its trial results");
  }
}

export function createCandidateManifest(
  baselineText: string,
  summary: Summary,
  sourceRunUrl?: string,
): BaselineCandidateManifest {
  validateBaselineSummary(summary);
  return {
    schemaVersion: BASELINE_MANIFEST_SCHEMA_VERSION,
    reportSchemaVersion: EVAL_REPORT_SCHEMA_VERSION,
    status: "candidate",
    baselineSha256: sha256(baselineText),
    profile: baselineProfile(summary),
    sourceRevision: summary.settings!.revision!,
    ...(sourceRunUrl ? { sourceRunUrl } : {}),
    generatedAt: new Date().toISOString(),
  };
}

function assertManifestMatches(
  baselineText: string,
  summary: Summary,
  manifest: BaselineManifest,
): void {
  validateBaselineSummary(summary);
  if (manifest.schemaVersion !== BASELINE_MANIFEST_SCHEMA_VERSION) {
    throw new Error("Unsupported baseline manifest schema");
  }
  if (manifest.reportSchemaVersion !== EVAL_REPORT_SCHEMA_VERSION) {
    throw new Error("Baseline manifest report schema mismatch");
  }
  if (!Number.isFinite(Date.parse(manifest.generatedAt))) {
    throw new Error("Baseline manifest has an invalid generation timestamp");
  }
  if (manifest.baselineSha256 !== sha256(baselineText)) {
    throw new Error("Baseline SHA-256 does not match its manifest");
  }
  if (stableJson(manifest.profile) !== stableJson(baselineProfile(summary))) {
    throw new Error("Baseline profile does not match its manifest");
  }
  if (manifest.sourceRevision !== summary.settings?.revision) {
    throw new Error("Baseline source revision does not match its manifest");
  }
}

export function approveCandidateManifest(
  baselineText: string,
  summary: Summary,
  candidate: BaselineCandidateManifest,
  reviewer: string,
  sourceRunUrl?: string,
  signingKey?: string | Buffer,
  keyId?: string,
): ReviewedBaselineManifest {
  assertManifestMatches(baselineText, summary, candidate);
  if (candidate.status !== "candidate")
    throw new Error("Only a candidate manifest can be approved");
  const reviewedBy = reviewer.trim();
  if (!reviewedBy) throw new Error("A reviewer identity is required");
  const runUrl = (sourceRunUrl ?? candidate.sourceRunUrl ?? "").trim();
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+(?:\/.*)?$/.test(runUrl)) {
    throw new Error("A GitHub Actions source run URL is required for a reviewed baseline");
  }
  const id = keyId?.trim();
  if (!id) throw new Error("An Ed25519 signing key ID is required");
  if (!signingKey) throw new Error("An Ed25519 signing key is required");
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(signingKey);
  } catch {
    throw new Error("Baseline signing key is not a valid private key");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Baseline signing key must be Ed25519");
  }
  const unsigned: Omit<ReviewedBaselineManifest, "approval"> = {
    ...candidate,
    status: "reviewed",
    sourceRunUrl: runUrl,
    reviewedBy,
    reviewedAt: new Date().toISOString(),
  };
  return {
    ...unsigned,
    approval: {
      algorithm: "ed25519",
      keyId: id,
      signature: sign(null, reviewedPayload(unsigned), privateKey).toString("base64"),
    },
  };
}

export function verifyReviewedBaseline(
  baselineText: string,
  summary: Summary,
  manifest: BaselineManifest,
  trustedKeys?: TrustedBaselineKeys,
): asserts manifest is ReviewedBaselineManifest {
  assertManifestMatches(baselineText, summary, manifest);
  if (manifest.status !== "reviewed") throw new Error("Baseline manifest is not reviewed");
  if (!manifest.reviewedBy.trim() || !Number.isFinite(Date.parse(manifest.reviewedAt))) {
    throw new Error("Reviewed baseline is missing reviewer audit metadata");
  }
  if (
    !/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+(?:\/.*)?$/.test(
      manifest.sourceRunUrl,
    )
  ) {
    throw new Error("Reviewed baseline is missing a GitHub Actions source run URL");
  }
  if (!trustedKeys || Object.keys(trustedKeys).length === 0) {
    throw new Error("Reviewed baseline has no configured Ed25519 trust root");
  }
  const approval = manifest.approval;
  if (!approval || approval.algorithm !== "ed25519" || !approval.keyId || !approval.signature) {
    throw new Error("Reviewed baseline is missing an Ed25519 approval signature");
  }
  const trusted = trustedKeys[approval.keyId];
  if (!trusted) throw new Error(`Reviewed baseline signer is not trusted: ${approval.keyId}`);
  const signature = Buffer.from(approval.signature, "base64");
  const { approval: _approval, ...unsigned } = manifest;
  if (
    !signature.length ||
    !verify(null, reviewedPayload(unsigned), trustedPublicKey(trusted), signature)
  ) {
    throw new Error("Reviewed baseline approval signature is invalid");
  }
}
