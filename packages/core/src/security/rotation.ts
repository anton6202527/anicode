/** 密钥轮换调度：发行、后端写入和 Broker 激活按 credential 单飞；不记录明文。 */

import { performance } from "node:perf_hooks";
import { CredentialRotationError, type CredentialBroker } from "./credentials.js";
import type { SecretBackend } from "./secret-backends.js";

export interface IssuedCredentialRotation {
  value: string;
  expiresAt?: string;
}

export interface CredentialRotationPolicy {
  credentialId: string;
  backend: SecretBackend;
  backendKey?: string;
  intervalMs: number;
  /** Monotonic elapsed-time budget shared by issue and backend write; default 30s, maximum 5m. */
  timeoutMs?: number;
  issue: (signal?: AbortSignal) => Promise<string | IssuedCredentialRotation>;
  /**
   * Optional, idempotent issuer cleanup used when an operator explicitly discards a pending
   * candidate. Each attempt receives the policy timeout and a cooperative cancellation signal.
   */
  revokeIssued?: (issued: IssuedCredentialRotation, signal?: AbortSignal) => Promise<void>;
}

export interface CredentialRotationEvent {
  timestamp: string;
  credentialId: string;
  success: boolean;
  version?: number;
  error?: string;
}

interface RegisteredCredentialRotationPolicy {
  readonly credentialId: string;
  readonly backend: SecretBackend;
  readonly backendKey?: string;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly issue: CredentialRotationPolicy["issue"];
  readonly revokeIssued?: CredentialRotationPolicy["revokeIssued"];
}

interface PendingIssuedCredential {
  readonly generation: symbol;
  readonly issued: Readonly<IssuedCredentialRotation>;
}

interface PendingCredentialIssue {
  readonly generation: symbol;
  readonly controller: AbortController;
  readonly promise: Promise<Readonly<IssuedCredentialRotation>>;
  readonly policy: RegisteredCredentialRotationPolicy;
}

const MAX_ROTATION_INTERVAL_MS = 2_147_483_647;
const DEFAULT_ROTATION_TIMEOUT_MS = 30_000;
const MAX_ROTATION_TIMEOUT_MS = 5 * 60_000;

function boundedIdentifier(value: string, label: string, maximumBytes = 4_096): string {
  if (
    !value ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} must be a bounded non-empty string without controls`);
  }
  return value;
}

function rotationTimeout(value: number | undefined): number {
  const resolved = value ?? DEFAULT_ROTATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_ROTATION_TIMEOUT_MS) {
    throw new Error(
      `Credential rotation timeout must be a safe integer from 1 to ${MAX_ROTATION_TIMEOUT_MS}ms`,
    );
  }
  return resolved;
}

function remainingBudget(deadline: number): number {
  return Math.floor(deadline - performance.now());
}

function issuedCredential(
  value: string | IssuedCredentialRotation,
): Readonly<IssuedCredentialRotation> {
  const candidate = typeof value === "string" ? { value } : value;
  if (typeof candidate.value !== "string" || !candidate.value) {
    throw new Error("Credential issuer returned an invalid candidate");
  }
  let expiresAt: string | undefined;
  if (candidate.expiresAt !== undefined) {
    const deadline = Date.parse(candidate.expiresAt);
    if (!Number.isFinite(deadline)) {
      throw new Error("Credential issuer returned invalid expiry metadata");
    }
    expiresAt = new Date(deadline).toISOString();
  }
  return Object.freeze({
    value: candidate.value,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
}

function safeRotationFailure(error: unknown): string {
  if (error instanceof CredentialRotationError) {
    switch (error.reason) {
      case "in-progress":
      case "quarantined":
      case "target-in-progress":
      case "target-registered":
      case "write-indeterminate":
      case "superseded-during-write":
      case "superseded-after-write":
        return `credential rotation ${error.reason}`;
    }
  }
  return "credential rotation failed";
}

function waitWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  label: string,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    onTimeout();
    return Promise.reject(new Error(`${label} exceeded its deadline`));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(() => {
      finish(() => {
        onTimeout();
        reject(new Error(`${label} exceeded its deadline`));
      });
    }, timeoutMs);
    void promise.then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(new Error(`${label} failed`))),
    );
  });
}

export class CredentialRotationManager {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly policies = new Map<string, RegisteredCredentialRotationPolicy>();
  private readonly inFlight = new Map<string, Promise<number>>();
  private readonly cleanupInFlight = new Map<string, Promise<boolean>>();
  private readonly cleanupRequired = new WeakSet<PendingIssuedCredential>();
  private readonly pendingIssues = new Map<string, PendingCredentialIssue>();
  private readonly pendingIssued = new Map<string, PendingIssuedCredential>();

  constructor(
    private readonly broker: CredentialBroker,
    private readonly onAudit?: (event: CredentialRotationEvent) => void | Promise<void>,
  ) {}

  register(policy: CredentialRotationPolicy): void {
    const credentialId = boundedIdentifier(policy.credentialId, "Credential rotation id");
    if (
      !Number.isSafeInteger(policy.intervalMs) ||
      policy.intervalMs < 60_000 ||
      policy.intervalMs > MAX_ROTATION_INTERVAL_MS
    ) {
      throw new Error(
        `Credential rotation interval must be a safe integer from 60000 to ${MAX_ROTATION_INTERVAL_MS}ms`,
      );
    }
    if (!policy.backend || typeof policy.backend.put !== "function") {
      throw new Error("Credential rotation backend must implement put");
    }
    if (typeof policy.issue !== "function") {
      throw new Error("Credential rotation policy requires an issuer");
    }
    if (policy.revokeIssued !== undefined && typeof policy.revokeIssued !== "function") {
      throw new Error("Credential rotation revokeIssued must be a function");
    }
    const backendKey =
      policy.backendKey === undefined
        ? undefined
        : boundedIdentifier(policy.backendKey, "Credential rotation backend key");
    const registered: RegisteredCredentialRotationPolicy = Object.freeze({
      credentialId,
      backend: policy.backend,
      ...(backendKey !== undefined ? { backendKey } : {}),
      intervalMs: policy.intervalMs,
      timeoutMs: rotationTimeout(policy.timeoutMs),
      issue: policy.issue,
      ...(policy.revokeIssued ? { revokeIssued: policy.revokeIssued } : {}),
    });
    if (this.policies.has(credentialId)) {
      throw new Error(`Credential rotation is already registered: ${credentialId}`);
    }
    this.policies.set(credentialId, registered);
  }

  private audit(event: CredentialRotationEvent): void {
    const onAudit = this.onAudit;
    if (!onAudit) return;
    const snapshot = Object.freeze({ ...event });
    queueMicrotask(() => {
      queueMicrotask(() => {
        try {
          void Promise.resolve(onAudit(snapshot)).catch(() => undefined);
        } catch {
          // Audit is observational and must never change a completed rotation outcome.
        }
      });
    });
  }

  private revokeIssuedWithin(
    policy: RegisteredCredentialRotationPolicy,
    issued: Readonly<IssuedCredentialRotation>,
  ): Promise<void> {
    const revokeIssued = policy.revokeIssued;
    if (!revokeIssued) {
      return Promise.reject(
        new Error("Credential rotation policy cannot revoke an issued candidate"),
      );
    }
    const controller = new AbortController();
    const running = Promise.resolve().then(() => revokeIssued({ ...issued }, controller.signal));
    return waitWithin(
      running,
      policy.timeoutMs,
      () => controller.abort(),
      "Credential issuer cleanup",
    );
  }

  private adoptIssued(
    credentialId: string,
    pending: PendingCredentialIssue,
    issued: Readonly<IssuedCredentialRotation>,
  ): PendingIssuedCredential | undefined {
    const adopted = this.pendingIssued.get(credentialId);
    if (adopted?.generation === pending.generation && adopted.issued === issued) return adopted;
    if (this.pendingIssues.get(credentialId) !== pending) {
      // An operator may only remove an unresolved issuance after an issuer cleanup contract exists.
      // If it nevertheless completed late, invoke that cleanup without exposing the candidate.
      const revokeIssued = pending.policy.revokeIssued;
      if (revokeIssued) {
        // The bounded wrapper observes late rejection and never retains this attempt in manager
        // state. Abort remains cooperative; process isolation is required to force termination.
        void this.revokeIssuedWithin(pending.policy, issued).catch(() => undefined);
      }
      return undefined;
    }
    this.pendingIssues.delete(credentialId);
    const existing = this.pendingIssued.get(credentialId);
    if (existing) return existing;
    const candidate: PendingIssuedCredential = Object.freeze({
      generation: pending.generation,
      issued,
    });
    this.pendingIssued.set(credentialId, candidate);
    return candidate;
  }

  private pendingIssue(
    policy: RegisteredCredentialRotationPolicy,
    generation: symbol,
  ): PendingCredentialIssue {
    const existing = this.pendingIssues.get(policy.credentialId);
    if (existing) {
      if (existing.generation !== generation) {
        throw new Error("Credential issuance requires explicit reconciliation");
      }
      return existing;
    }
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => policy.issue(controller.signal))
      .then(issuedCredential);
    const pending: PendingCredentialIssue = Object.freeze({
      generation,
      controller,
      promise,
      policy,
    });
    this.pendingIssues.set(policy.credentialId, pending);
    void promise.then(
      (issued) => void this.adoptIssued(policy.credentialId, pending, issued),
      () => {
        if (this.pendingIssues.get(policy.credentialId) === pending) {
          this.pendingIssues.delete(policy.credentialId);
        }
      },
    );
    return pending;
  }

  private async rotateOnce(credentialId: string): Promise<number> {
    const policy = this.policies.get(credentialId);
    if (!policy) throw new Error(`Unknown credential rotation policy: ${credentialId}`);
    const deadline = performance.now() + policy.timeoutMs;
    try {
      let pending = this.pendingIssued.get(credentialId);
      if (!pending) {
        if (this.broker.rotationStatus(credentialId) !== "idle") {
          throw new Error("Credential rotation requires explicit reconciliation");
        }
        const generation = this.broker.credentialGeneration(credentialId);
        if (!generation) {
          throw new Error("Credential rotation target is unknown or expired");
        }
        const issuance = this.pendingIssue(policy, generation);
        const issued = await waitWithin(
          issuance.promise,
          remainingBudget(deadline),
          () => issuance.controller.abort(),
          "Credential issuance",
        );
        pending = this.adoptIssued(credentialId, issuance, issued);
        if (!pending) throw new Error("Credential issuance requires explicit reconciliation");
      }

      if (this.cleanupRequired.has(pending)) {
        throw new Error("Credential issuer cleanup requires explicit retry");
      }
      if (this.broker.credentialGeneration(credentialId) !== pending.generation) {
        throw new Error("Credential rotation generation changed; explicit reconciliation required");
      }
      if (this.broker.rotationStatus(credentialId) === "pending") {
        throw new Error("Credential rotation is already pending");
      }
      const remaining = remainingBudget(deadline);
      if (remaining < 1) throw new Error("Credential rotation exceeded its deadline before write");
      const version = await this.broker.rotateBackend(
        policy.credentialId,
        policy.backend,
        pending.issued.value,
        policy.backendKey,
        {
          ...(pending.issued.expiresAt !== undefined
            ? { expiresAt: pending.issued.expiresAt }
            : {}),
          timeoutMs: remaining,
        },
      );
      if (this.pendingIssued.get(credentialId) === pending) {
        this.pendingIssued.delete(credentialId);
      }
      this.audit({
        timestamp: new Date().toISOString(),
        credentialId,
        success: true,
        version,
      });
      return version;
    } catch (error) {
      this.audit({
        timestamp: new Date().toISOString(),
        credentialId,
        success: false,
        error: safeRotationFailure(error),
      });
      throw error;
    }
  }

  rotateNow(credentialId: string): Promise<number> {
    const existing = this.inFlight.get(credentialId);
    if (existing) return existing;
    const running = this.rotateOnce(credentialId);
    this.inFlight.set(credentialId, running);
    void running
      .finally(() => {
        if (this.inFlight.get(credentialId) === running) this.inFlight.delete(credentialId);
      })
      .catch(() => undefined);
    return running;
  }

  private async discardPendingOnce(credentialId: string): Promise<boolean> {
    if (this.inFlight.has(credentialId)) {
      throw new Error("Credential rotation is in progress");
    }
    if (this.pendingIssues.has(credentialId)) {
      throw new Error("Credential issuance outcome is still unknown");
    }
    const pending = this.pendingIssued.get(credentialId);
    if (!pending) return false;
    const policy = this.policies.get(credentialId);
    if (!policy?.revokeIssued) {
      throw new Error("Credential rotation policy cannot revoke an issued candidate");
    }
    // Once revocation starts its outcome can become unknown. Never activate this candidate again:
    // retries may only repeat the same idempotent cleanup operation.
    this.cleanupRequired.add(pending);
    await this.revokeIssuedWithin(policy, pending.issued);
    if (this.pendingIssued.get(credentialId) === pending) {
      this.pendingIssued.delete(credentialId);
    }
    return true;
  }

  /** Explicitly revoke and forget an issued candidate which has not been activated. */
  discardPending(credentialId: string): Promise<boolean> {
    const existing = this.cleanupInFlight.get(credentialId);
    if (existing) return existing;
    const attempt = this.discardPendingOnce(credentialId);
    const running = attempt.finally(() => {
      if (this.cleanupInFlight.get(credentialId) === running) {
        this.cleanupInFlight.delete(credentialId);
      }
    });
    this.cleanupInFlight.set(credentialId, running);
    // Observe fire-and-forget callers without converting the returned promise into a success.
    void running.catch(() => undefined);
    return running;
  }

  start(): void {
    for (const policy of this.policies.values()) {
      if (this.timers.has(policy.credentialId)) continue;
      const timer = setInterval(
        () => void this.rotateNow(policy.credentialId).catch(() => undefined),
        policy.intervalMs,
      );
      timer.unref?.();
      this.timers.set(policy.credentialId, timer);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}
