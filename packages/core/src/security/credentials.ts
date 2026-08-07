/**
 * Credential Broker：密钥只在受信执行边界注入，不进入 prompt、事件、Artifact 或日志。
 */

import { randomUUID } from "node:crypto";
import { isSafeCredentialError, safeCredentialError } from "./credential-io.js";
import type { SecretBackend, SyncSecretBackend } from "./secret-backends.js";

export interface CredentialScope {
  audiences: string[];
  hosts?: string[];
  tools?: string[];
  env?: string;
  header?: string;
  /** 例如 Authorization 的 `Bearer `；前缀由可信 broker 注入。 */
  headerPrefix?: string;
}

export interface CredentialRegistration {
  id: string;
  /** 仅兼容一次性/测试凭据；生产长期凭据使用 backend reference。 */
  value?: string;
  /** Async backend which supplied an in-memory value and remains its rotation target. */
  backingBackend?: SecretBackend;
  backend?: SyncSecretBackend;
  /** Async Vault/KMS reference. Use trustedValueAsync; the plaintext is never retained as source. */
  asyncBackend?: SecretBackend;
  backendKey?: string;
  scopes: CredentialScope[];
  expiresAt?: string;
  version?: number;
}

export interface CredentialLeaseRequest {
  credentialId: string;
  audience: string;
  host?: string;
  tool?: string;
  ttlMs?: number;
  maxUses?: number;
}

interface Lease {
  id: string;
  credentialId: string;
  credential: CredentialRegistration;
  credentialVersion: number;
  scope: CredentialScope;
  expiresAt: number;
  usesLeft: number;
}

export interface CredentialAuditEvent {
  timestamp: string;
  action: "register" | "read" | "lease" | "consume" | "rotate" | "revoke" | "deny";
  credentialId: string;
  audience?: string;
  host?: string;
  tool?: string;
  leaseId?: string;
  version?: number;
  success: boolean;
  reason?: string;
}

export interface CredentialBrokerOptions {
  onAudit?: (event: CredentialAuditEvent) => void | Promise<void>;
  /** 仅用于日志脱敏的短期缓存时长，不是长期密钥存储。 */
  redactionTtlMs?: number;
  /** 同步/异步后端引用按需读取后的有界进程内缓存；默认一小时，最长二十四小时。 */
  referenceCacheTtlMs?: number;
  /** 后端缺失/拒绝时的短期负缓存，避免 provider 探测循环反复触发 Keychain 授权。 */
  unavailableCacheTtlMs?: number;
}

export interface CredentialRotationMetadata {
  /** New expiry metadata installed atomically with the rotated value. */
  expiresAt?: string;
}

export interface CredentialRotationOptions extends CredentialRotationMetadata {
  /** Async backend mutation deadline; defaults to 30 seconds and is capped at five minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type CredentialAvailability = "unavailable" | "configured" | "available";

export type CredentialRotationOutcome = "not-written" | "indeterminate" | "written-not-activated";

/**
 * Structured rotation failure. Callers must not blindly retry an indeterminate mutation against
 * a different target: the external backend may already contain the new value.
 */
export class CredentialRotationError extends Error {
  constructor(
    readonly credentialId: string,
    readonly outcome: CredentialRotationOutcome,
    readonly reason:
      | "in-progress"
      | "quarantined"
      | "target-in-progress"
      | "target-registered"
      | "write-indeterminate"
      | "superseded-during-write"
      | "superseded-after-write",
  ) {
    const messages: Record<typeof reason, string> = {
      "in-progress": "Credential rotation is already in progress",
      quarantined: "Credential is quarantined after an indeterminate rotation",
      "target-in-progress": "Credential backend target is already being rotated",
      "target-registered": "Credential backend target belongs to another credential",
      "write-indeterminate": "Credential backend write outcome is indeterminate",
      "superseded-during-write":
        "Credential was revoked while the backend write outcome became indeterminate",
      "superseded-after-write": "Credential was revoked while the backend write was in progress",
    };
    super(messages[reason]);
    this.name = "CredentialRotationError";
  }
}

type ReferenceCacheEntry =
  | {
      state: "available";
      value: string;
      credential: CredentialRegistration;
      version: number;
      expiresAt: number;
    }
  | {
      state: "unavailable";
      error: Error;
      credential: CredentialRegistration;
      version: number;
      expiresAt: number;
    };

interface ActiveCredentialRotation {
  token: symbol;
  credential: CredentialRegistration;
  targetBackend?: SecretBackend;
  /** Canonical physical target used only by the in-memory coordination registry. */
  targetCoordinationKey?: string;
  /** Original logical key passed unchanged to backend I/O. */
  targetKey?: string;
  nextVersion: number;
  cancelled: boolean;
  attemptedValue: string;
  expiresAt?: string;
}

interface QuarantinedCredentialRotation {
  credential: CredentialRegistration;
  targetBackend?: SecretBackend;
  targetCoordinationKey?: string;
  targetKey?: string;
  attemptedValue: string;
  expiresAt?: string;
}

interface BackendTargetState {
  ownerCredentialId?: string;
  activeRotationToken?: symbol;
}

const DEFAULT_REFERENCE_CACHE_TTL_MS = 60 * 60_000;
const DEFAULT_UNAVAILABLE_CACHE_TTL_MS = 30_000;
const MAX_REFERENCE_CACHE_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_CREDENTIAL_LEASE_TTL_MS = 60_000;
const MAX_CREDENTIAL_LEASE_TTL_MS = 60 * 60_000;
const MAX_CREDENTIAL_LEASE_USES = 1_000;
const MAX_RETIRED_REDACTION_SECRETS = 1_024;
const DEFAULT_CREDENTIAL_ROTATION_TIMEOUT_MS = 30_000;
const MAX_CREDENTIAL_ROTATION_TIMEOUT_MS = 5 * 60_000;

function boundedCacheTtl(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return Math.min(Math.floor(resolved), MAX_REFERENCE_CACHE_TTL_MS);
}

function boundedRedactionTtl(value: number | undefined): number {
  const resolved = value ?? 5 * 60_000;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1_000 ||
    resolved > MAX_REFERENCE_CACHE_TTL_MS
  ) {
    throw new Error(
      `Credential redaction TTL must be an integer from 1000 to ${MAX_REFERENCE_CACHE_TTL_MS}`,
    );
  }
  return resolved;
}

function matches(patterns: readonly string[] | undefined, value: string | undefined): boolean {
  if (!patterns?.length) return true;
  if (!value) return false;
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith("*") && !pattern.startsWith("*.")) {
      return value.startsWith(pattern.slice(0, -1));
    }
    if (pattern.startsWith("*."))
      return value === pattern.slice(2) || value.endsWith(pattern.slice(1));
    return pattern === value;
  });
}

function cloneScope(scope: CredentialScope): CredentialScope {
  if (
    !Array.isArray(scope.audiences) ||
    scope.audiences.length === 0 ||
    scope.audiences.some((audience) => typeof audience !== "string" || audience.length === 0)
  ) {
    throw new Error("Credential scope requires at least one non-empty audience");
  }
  for (const [label, values] of [
    ["hosts", scope.hosts],
    ["tools", scope.tools],
  ] as const) {
    if (
      values !== undefined &&
      (!Array.isArray(values) ||
        values.length === 0 ||
        values.some((value) => typeof value !== "string" || value.length === 0))
    ) {
      throw new Error(`Credential scope ${label} must contain non-empty values`);
    }
  }
  const cloned: CredentialScope = {
    audiences: [...scope.audiences],
    ...(scope.hosts ? { hosts: [...scope.hosts] } : {}),
    ...(scope.tools ? { tools: [...scope.tools] } : {}),
    ...(scope.env !== undefined ? { env: scope.env } : {}),
    ...(scope.header !== undefined ? { header: scope.header } : {}),
    ...(scope.headerPrefix !== undefined ? { headerPrefix: scope.headerPrefix } : {}),
  };
  Object.freeze(cloned.audiences);
  if (cloned.hosts) Object.freeze(cloned.hosts);
  if (cloned.tools) Object.freeze(cloned.tools);
  return Object.freeze(cloned);
}

function credentialExpiry(credential: CredentialRegistration): number {
  return credential.expiresAt === undefined ? Infinity : Date.parse(credential.expiresAt);
}

function positiveSafeInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${label} must be a safe integer between 1 and ${maximum}`);
  }
  return resolved;
}

function isSyncSecretBackend(backend: SecretBackend): backend is SyncSecretBackend {
  const candidate = backend as Partial<SyncSecretBackend>;
  return (
    typeof candidate.getSync === "function" &&
    typeof candidate.putSync === "function" &&
    typeof candidate.deleteSync === "function"
  );
}

function validRotationBackendKey(key: string): string {
  if (!key || Buffer.byteLength(key, "utf8") > 4_096 || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new Error("Credential backend key must be a bounded non-empty string without controls");
  }
  return key;
}

function normalizedRotationExpiry(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const deadline = Date.parse(value);
  if (!Number.isFinite(deadline)) throw new Error("Credential expiry must be a valid date");
  return new Date(deadline).toISOString();
}

function credentialRotationTimeout(value: number | undefined): number {
  const resolved = value ?? DEFAULT_CREDENTIAL_ROTATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_CREDENTIAL_ROTATION_TIMEOUT_MS
  ) {
    throw new Error(
      `Credential rotation timeoutMs must be an integer from 1 to ${MAX_CREDENTIAL_ROTATION_TIMEOUT_MS}`,
    );
  }
  return resolved;
}

function credentialBackendNamespace(backend: SecretBackend): string | undefined {
  const namespace = backend.credentialNamespace;
  if (namespace === undefined) return undefined;
  if (
    !namespace ||
    Buffer.byteLength(namespace, "utf8") > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(namespace)
  ) {
    throw new Error("Credential backend namespace must be bounded and contain no controls");
  }
  return namespace;
}

function credentialBackendTargetKey(backend: SecretBackend, key: string): string {
  const logicalKey = validRotationBackendKey(key);
  return validRotationBackendKey(backend.credentialTargetKey?.(logicalKey) ?? logicalKey);
}

function sanitizedCredentialBackendReadError(error: unknown): Error {
  return isSafeCredentialError(error)
    ? error
    : safeCredentialError("Credential backend read failed");
}

export class CredentialBroker {
  private readonly credentials = new Map<string, CredentialRegistration>();
  private readonly leases = new Map<string, Lease>();
  private readonly recentSecrets = new Map<string, { value: string; expiresAt: number }>();
  private readonly retiredSecrets = new Map<number, { value: string; expiresAt: number }>();
  private readonly referenceCache = new Map<string, ReferenceCacheEntry>();
  private readonly pendingReferenceReads = new Map<
    string,
    { credential: CredentialRegistration; promise: Promise<string> }
  >();
  private readonly pendingBackendHydrations = new Map<string, symbol>();
  private readonly activeRotations = new Map<string, ActiveCredentialRotation>();
  private readonly quarantinedRotations = new Map<string, QuarantinedCredentialRotation>();
  private readonly credentialGenerations = new WeakMap<CredentialRegistration, symbol>();
  private readonly objectBackendTargets = new WeakMap<
    SecretBackend,
    Map<string, BackendTargetState>
  >();
  private readonly namespacedBackendTargets = new Map<string, Map<string, BackendTargetState>>();
  private nextRetiredSecretId = 1;
  private readonly onAudit?: CredentialBrokerOptions["onAudit"];
  private readonly redactionTtlMs: number;
  private readonly referenceCacheTtlMs: number;
  private readonly unavailableCacheTtlMs: number;

  constructor(options: CredentialBrokerOptions = {}) {
    if (options.onAudit) this.onAudit = options.onAudit;
    this.redactionTtlMs = boundedRedactionTtl(options.redactionTtlMs);
    this.referenceCacheTtlMs = boundedCacheTtl(
      options.referenceCacheTtlMs,
      DEFAULT_REFERENCE_CACHE_TTL_MS,
      "Credential reference cache TTL",
    );
    this.unavailableCacheTtlMs = boundedCacheTtl(
      options.unavailableCacheTtlMs,
      DEFAULT_UNAVAILABLE_CACHE_TTL_MS,
      "Credential unavailable cache TTL",
    );
  }

  private audit(
    event: Omit<CredentialAuditEvent, "timestamp" | "success"> & { success?: boolean },
  ): void {
    const onAudit = this.onAudit;
    if (!onAudit) return;
    const snapshot: CredentialAuditEvent = Object.freeze({
      timestamp: new Date().toISOString(),
      success: event.success ?? true,
      ...event,
    });
    // Two microtask hops keep an untrusted sink outside both the broker's current call stack and
    // the immediate continuation of async trusted access. This makes audit strictly observational:
    // a sink which synchronously revokes/replaces a credential cannot change the outcome being
    // returned to the caller. Invocation order is still FIFO for events emitted in the same turn.
    queueMicrotask(() => {
      queueMicrotask(() => {
        try {
          void Promise.resolve(onAudit(snapshot)).catch(() => undefined);
        } catch {
          // Audit sinks are observational and must never change credential mutation outcomes.
        }
      });
    });
  }

  private rememberSecret(credentialId: string, value: string): void {
    this.recentSecrets.set(credentialId, {
      value,
      expiresAt: Date.now() + this.redactionTtlMs,
    });
  }

  private rememberRetiredSecret(value: string | undefined): void {
    if (!value) return;
    for (const [id, existing] of this.retiredSecrets) {
      if (existing.value !== value) continue;
      this.retiredSecrets.delete(id);
      break;
    }
    while (this.retiredSecrets.size >= MAX_RETIRED_REDACTION_SECRETS) {
      const oldest = this.retiredSecrets.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.retiredSecrets.delete(oldest);
    }
    this.retiredSecrets.set(this.nextRetiredSecretId++, {
      value,
      expiresAt: Date.now() + this.redactionTtlMs,
    });
  }

  private retireCredentialSecrets(
    credentialId: string,
    credential = this.credentials.get(credentialId),
  ): void {
    this.rememberRetiredSecret(credential?.value);
    this.rememberRetiredSecret(this.recentSecrets.get(credentialId)?.value);
    const cached = this.referenceCache.get(credentialId);
    if (cached?.state === "available") this.rememberRetiredSecret(cached.value);
  }

  private invalidateCredentialUse(
    credentialId: string,
    credential = this.credentials.get(credentialId),
  ): void {
    this.retireCredentialSecrets(credentialId, credential);
    for (const [id, lease] of this.leases) {
      if (lease.credentialId === credentialId) this.leases.delete(id);
    }
    this.recentSecrets.delete(credentialId);
    this.referenceCache.delete(credentialId);
    this.pendingReferenceReads.delete(credentialId);
    this.pendingBackendHydrations.delete(credentialId);
  }

  private rotationBlocked(credentialId: string): boolean {
    return this.activeRotations.has(credentialId) || this.quarantinedRotations.has(credentialId);
  }

  private backendTargetMap(
    backend: SecretBackend,
    create: boolean,
  ): Map<string, BackendTargetState> | undefined {
    const namespace = credentialBackendNamespace(backend);
    if (namespace !== undefined) {
      let targets = this.namespacedBackendTargets.get(namespace);
      if (!targets && create) {
        targets = new Map();
        this.namespacedBackendTargets.set(namespace, targets);
      }
      return targets;
    }
    let targets = this.objectBackendTargets.get(backend);
    if (!targets && create) {
      targets = new Map();
      this.objectBackendTargets.set(backend, targets);
    }
    return targets;
  }

  private cleanupBackendTarget(
    backend: SecretBackend,
    key: string,
    state: BackendTargetState,
  ): void {
    if (state.ownerCredentialId || state.activeRotationToken) return;
    const targets = this.backendTargetMap(backend, false);
    if (targets?.get(key) === state) targets.delete(key);
    const namespace = credentialBackendNamespace(backend);
    if (namespace !== undefined && targets?.size === 0) {
      this.namespacedBackendTargets.delete(namespace);
    }
  }

  private registrationBackendTarget(
    credential: CredentialRegistration | undefined,
  ): { backend: SecretBackend; key: string } | undefined {
    if (!credential) return undefined;
    const backend = credential.backend ?? credential.asyncBackend ?? credential.backingBackend;
    if (!backend) return undefined;
    return {
      backend,
      key: credentialBackendTargetKey(backend, credential.backendKey ?? credential.id),
    };
  }

  private assertBackendTargetAvailable(
    credentialId: string,
    backend: SecretBackend,
    key: string,
  ): void {
    const state = this.backendTargetMap(backend, false)?.get(key);
    if (state?.ownerCredentialId && state.ownerCredentialId !== credentialId) {
      throw new Error("Credential backend target is already registered");
    }
    if (state?.activeRotationToken) {
      throw new Error("Credential backend target is being rotated");
    }
  }

  private trackRegistrationTarget(
    credentialId: string,
    credential: CredentialRegistration | undefined,
  ): void {
    const target = this.registrationBackendTarget(credential);
    if (!target) return;
    this.trackBackendTarget(credentialId, target.backend, target.key);
  }

  private trackBackendTarget(credentialId: string, backend: SecretBackend, key: string): void {
    const targets = this.backendTargetMap(backend, true)!;
    const state = targets.get(key) ?? {};
    if (state.ownerCredentialId && state.ownerCredentialId !== credentialId) {
      throw new Error("Credential backend target is already registered");
    }
    state.ownerCredentialId = credentialId;
    targets.set(key, state);
  }

  private untrackBackendTarget(
    credentialId: string,
    backend: SecretBackend | undefined,
    key: string | undefined,
  ): void {
    if (!backend || !key) return;
    const state = this.backendTargetMap(backend, false)?.get(key);
    if (!state || state.ownerCredentialId !== credentialId) return;
    delete state.ownerCredentialId;
    this.cleanupBackendTarget(backend, key, state);
  }

  private untrackRegistrationTarget(
    credentialId: string,
    credential: CredentialRegistration | undefined,
  ): void {
    const target = this.registrationBackendTarget(credential);
    if (target) this.untrackBackendTarget(credentialId, target.backend, target.key);
  }

  private referenceCacheDeadline(credential: CredentialRegistration, ttlMs: number): number {
    const now = Date.now();
    const credentialDeadline = credentialExpiry(credential);
    return Math.min(
      now + ttlMs,
      Number.isFinite(credentialDeadline) ? credentialDeadline : Infinity,
    );
  }

  private cachedReference(credential: CredentialRegistration): ReferenceCacheEntry | undefined {
    const cached = this.referenceCache.get(credential.id);
    if (
      !cached ||
      cached.credential !== credential ||
      cached.version !== (credential.version ?? 1) ||
      cached.expiresAt <= Date.now()
    ) {
      if (cached) this.referenceCache.delete(credential.id);
      return undefined;
    }
    return cached;
  }

  private cacheReferenceValue(credential: CredentialRegistration, value: string): void {
    // Both sync and async references must observe external rotation/deletion within a bounded time.
    const expiresAt = this.referenceCacheDeadline(credential, this.referenceCacheTtlMs);
    if (expiresAt <= Date.now()) return;
    this.referenceCache.set(credential.id, {
      state: "available",
      value,
      credential,
      version: credential.version ?? 1,
      expiresAt,
    });
  }

  private cacheReferenceUnavailable(credential: CredentialRegistration, error: Error): void {
    const expiresAt = this.referenceCacheDeadline(credential, this.unavailableCacheTtlMs);
    if (expiresAt <= Date.now()) return;
    this.referenceCache.set(credential.id, {
      state: "unavailable",
      error,
      credential,
      version: credential.version ?? 1,
      expiresAt,
    });
  }

  private isCurrentReference(
    credential: CredentialRegistration,
    backend: SecretBackend,
    backendKey: string,
  ): boolean {
    const current = this.credentials.get(credential.id);
    return (
      current === credential &&
      !this.rotationBlocked(credential.id) &&
      (current.version ?? 1) === (credential.version ?? 1) &&
      (current.backend ?? current.asyncBackend) === backend &&
      (current.backendKey ?? current.id) === backendKey
    );
  }

  private resolvedCachedReference(credential: CredentialRegistration): string | undefined {
    const cached = this.cachedReference(credential);
    if (!cached) return undefined;
    if (cached.state === "unavailable") throw cached.error;
    this.rememberSecret(credential.id, cached.value);
    return cached.value;
  }

  private resolveValue(credential: CredentialRegistration): string {
    // An async backend may have been hydrated immediately before entering a legacy synchronous
    // adapter (provider SDK construction, MCP lease injection, and similar trusted boundaries).
    // Honor that identity-bound cache before rejecting synchronous access; an unhydrated async
    // reference still fails closed below.
    const cached = this.resolvedCachedReference(credential);
    if (cached !== undefined) return cached;
    if (credential.asyncBackend) throw new Error("Credential requires async trusted access");
    if (!credential.backend) {
      if (!credential.value) throw new Error("Credential value is unavailable");
      this.rememberSecret(credential.id, credential.value);
      return credential.value;
    }
    const expectedVersion = credential.version ?? 1;
    const expectedBackend = credential.backend;
    const expectedBackendKey = credential.backendKey ?? credential.id;
    const isCurrentReference = () =>
      (credential.version ?? 1) === expectedVersion &&
      credential.backend === expectedBackend &&
      this.isCurrentReference(credential, expectedBackend, expectedBackendKey);
    let value: string | undefined;
    try {
      value = expectedBackend.getSync(expectedBackendKey);
    } catch (error) {
      const cachedError = sanitizedCredentialBackendReadError(error);
      if (isCurrentReference()) this.cacheReferenceUnavailable(credential, cachedError);
      throw cachedError;
    }
    if (!isCurrentReference()) {
      throw new Error("Credential changed during backend resolution");
    }
    if (credentialExpiry(credential) <= Date.now()) {
      throw new Error("Credential expired during backend resolution");
    }
    if (!value) {
      const error = new Error("Credential value is unavailable");
      this.cacheReferenceUnavailable(credential, error);
      throw error;
    }
    this.cacheReferenceValue(credential, value);
    this.rememberSecret(credential.id, value);
    return value;
  }

  private async resolveValueAsync(credential: CredentialRegistration): Promise<string> {
    if (!credential.asyncBackend) return this.resolveValue(credential);
    const cached = this.resolvedCachedReference(credential);
    if (cached !== undefined) return cached;
    const pending = this.pendingReferenceReads.get(credential.id);
    if (pending?.credential === credential) return pending.promise;
    const expectedVersion = credential.version ?? 1;
    const expectedBackend = credential.asyncBackend;
    const expectedBackendKey = credential.backendKey ?? credential.id;
    const isCurrentReference = () =>
      (credential.version ?? 1) === expectedVersion &&
      credential.asyncBackend === expectedBackend &&
      this.isCurrentReference(credential, expectedBackend, expectedBackendKey);
    const promise = (async () => {
      let value: string | undefined;
      try {
        value = await expectedBackend.get(expectedBackendKey);
      } catch (error) {
        const cachedError = sanitizedCredentialBackendReadError(error);
        if (isCurrentReference()) {
          this.cacheReferenceUnavailable(credential, cachedError);
        }
        throw cachedError;
      }
      if (!isCurrentReference()) {
        throw new Error("Credential changed during backend resolution");
      }
      if (credentialExpiry(credential) <= Date.now()) {
        throw new Error("Credential expired during backend resolution");
      }
      if (!value) {
        const error = new Error("Credential value is unavailable");
        this.cacheReferenceUnavailable(credential, error);
        throw error;
      }
      this.cacheReferenceValue(credential, value);
      this.rememberSecret(credential.id, value);
      return value;
    })();
    this.pendingReferenceReads.set(credential.id, { credential, promise });
    try {
      return await promise;
    } finally {
      const current = this.pendingReferenceReads.get(credential.id);
      if (current?.promise === promise) this.pendingReferenceReads.delete(credential.id);
    }
  }

  register(registration: CredentialRegistration): void {
    if (this.activeRotations.has(registration.id)) {
      this.audit({
        action: "register",
        credentialId: registration.id,
        success: false,
        reason: "rotation-in-progress",
      });
      throw new CredentialRotationError(registration.id, "not-written", "in-progress");
    }
    if (this.quarantinedRotations.has(registration.id)) {
      this.audit({
        action: "register",
        credentialId: registration.id,
        success: false,
        reason: "rotation-quarantined",
      });
      throw new CredentialRotationError(registration.id, "not-written", "quarantined");
    }
    const sources = [registration.value, registration.backend, registration.asyncBackend].filter(
      (source) => source !== undefined,
    ).length;
    if (!registration.id || sources !== 1 || registration.scopes.length === 0) {
      throw new Error("Credential id, exactly one value source, and scopes are required");
    }
    if (registration.value !== undefined && registration.value.length === 0) {
      throw new Error("Credential value cannot be empty");
    }
    if (registration.backingBackend && registration.value === undefined) {
      throw new Error("A backing backend is valid only for an in-memory credential value");
    }
    if (
      registration.backendKey !== undefined &&
      !registration.backend &&
      !registration.asyncBackend &&
      !registration.backingBackend
    ) {
      throw new Error("Credential backendKey requires a backend reference");
    }
    const version = positiveSafeInteger(
      registration.version,
      1,
      Number.MAX_SAFE_INTEGER,
      "Credential version",
    );
    let expiresAt: string | undefined;
    if (registration.expiresAt !== undefined) {
      const deadline = Date.parse(registration.expiresAt);
      if (!Number.isFinite(deadline)) throw new Error("Credential expiry must be a valid date");
      expiresAt = new Date(deadline).toISOString();
    }
    const scopes = registration.scopes.map(cloneScope);
    Object.freeze(scopes);
    const previous = this.credentials.get(registration.id);
    const next: CredentialRegistration = Object.freeze({
      ...registration,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      version,
      scopes,
    });
    const target = this.registrationBackendTarget(next);
    if (target) this.assertBackendTargetAvailable(registration.id, target.backend, target.key);
    this.invalidateCredentialUse(registration.id);
    this.untrackRegistrationTarget(registration.id, previous);
    this.credentials.set(registration.id, next);
    this.trackRegistrationTarget(registration.id, next);
    this.audit({
      action: "register",
      credentialId: registration.id,
      version,
    });
  }

  registerReference(
    registration: Omit<
      CredentialRegistration,
      "value" | "backingBackend" | "backend" | "asyncBackend" | "backendKey"
    > & {
      backend: SyncSecretBackend;
      backendKey?: string;
    },
  ): void {
    this.register(registration);
  }

  registerAsyncReference(
    registration: Omit<
      CredentialRegistration,
      "value" | "backingBackend" | "backend" | "asyncBackend" | "backendKey"
    > & {
      backend: SecretBackend;
      backendKey?: string;
    },
  ): void {
    this.register({
      id: registration.id,
      asyncBackend: registration.backend,
      ...(registration.backendKey ? { backendKey: registration.backendKey } : {}),
      scopes: registration.scopes,
      ...(registration.expiresAt !== undefined ? { expiresAt: registration.expiresAt } : {}),
      ...(registration.version !== undefined ? { version: registration.version } : {}),
    });
  }

  /** Vault/KMS 等异步后端在宿主启动时水合；明文不落盘，只保留到进程退出/轮换。 */
  async registerFromBackend(
    registration: Omit<
      CredentialRegistration,
      "value" | "backingBackend" | "backend" | "asyncBackend" | "backendKey"
    > & {
      backend: SecretBackend;
      backendKey?: string;
    },
  ): Promise<void> {
    // Snapshot every caller-owned field before the first await so a concurrent mutation cannot
    // widen the eventual registration.
    const id = registration.id;
    const key = registration.backendKey ?? id;
    const scopes = registration.scopes.map(cloneScope);
    const expiresAt = registration.expiresAt;
    const version = registration.version;
    const backend = registration.backend;
    if (this.activeRotations.has(id)) {
      throw new CredentialRotationError(id, "not-written", "in-progress");
    }
    if (this.quarantinedRotations.has(id)) {
      throw new CredentialRotationError(id, "not-written", "quarantined");
    }
    if (this.pendingBackendHydrations.has(id)) {
      throw new Error("Credential backend hydration is already in progress");
    }
    const validatedKey = validRotationBackendKey(key);
    this.assertBackendTargetAvailable(
      id,
      backend,
      credentialBackendTargetKey(backend, validatedKey),
    );
    const token = Symbol(id);
    this.pendingBackendHydrations.set(id, token);
    try {
      const value = await backend.get(validatedKey);
      if (this.pendingBackendHydrations.get(id) !== token) {
        throw new Error("Credential changed during backend hydration");
      }
      if (!value) throw new Error(`Credential ${id} is missing from ${backend.kind}`);
      this.register({
        id,
        value,
        backingBackend: backend,
        backendKey: validatedKey,
        scopes,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(version !== undefined ? { version } : {}),
      });
    } finally {
      if (this.pendingBackendHydrations.get(id) === token) {
        this.pendingBackendHydrations.delete(id);
      }
    }
  }

  revoke(credentialId: string): boolean {
    const credential = this.credentials.get(credentialId);
    const rotation = this.activeRotations.get(credentialId);
    if (rotation) {
      rotation.cancelled = true;
      this.rememberRetiredSecret(rotation.attemptedValue);
    }
    const quarantine = this.quarantinedRotations.get(credentialId);
    this.rememberRetiredSecret(quarantine?.attemptedValue);
    this.invalidateCredentialUse(credentialId, credential);
    this.untrackRegistrationTarget(credentialId, credential);
    this.untrackBackendTarget(
      credentialId,
      quarantine?.targetBackend,
      quarantine?.targetCoordinationKey,
    );
    this.quarantinedRotations.delete(credentialId);
    const deleted = this.credentials.delete(credentialId);
    this.audit({ action: "revoke", credentialId, success: deleted });
    return deleted;
  }

  /**
   * Pure in-memory availability. `configured` means an explicit backend reference exists but has
   * not been read yet; this method deliberately never opens Keychain/Vault/KMS.
   */
  availability(credentialId: string): CredentialAvailability {
    const credential = this.credentials.get(credentialId);
    if (
      !credential ||
      this.rotationBlocked(credentialId) ||
      credentialExpiry(credential) <= Date.now()
    ) {
      return "unavailable";
    }
    if (credential.value) return "available";
    const cached = this.cachedReference(credential);
    if (cached?.state === "available") return "available";
    if (cached?.state === "unavailable") return "unavailable";
    return credential.backend || credential.asyncBackend ? "configured" : "unavailable";
  }

  /** Whether a usable value is present or explicitly configured, without performing backend I/O. */
  has(credentialId: string): boolean {
    return this.availability(credentialId) !== "unavailable";
  }

  /** Pure in-memory mutation state for schedulers; never reads a secret backend. */
  rotationStatus(credentialId: string): "idle" | "pending" | "quarantined" {
    if (this.activeRotations.has(credentialId)) return "pending";
    if (this.quarantinedRotations.has(credentialId)) return "quarantined";
    return "idle";
  }

  private generationForCredential(credential: CredentialRegistration): symbol {
    let generation = this.credentialGenerations.get(credential);
    if (!generation) {
      generation = Symbol();
      this.credentialGenerations.set(credential, generation);
    }
    return generation;
  }

  /**
   * Opaque identity for the current registration. This is a pure, secret-free preflight and CAS
   * token: explicit replacement/revocation changes it even when the id and numeric version are
   * reused, while internal rotation fencing and quarantine preserve it. Callers inspect
   * `rotationStatus` separately; backend references are never resolved here.
   */
  credentialGeneration(credentialId: string): symbol | undefined {
    const credential = this.credentials.get(credentialId);
    if (!credential || credentialExpiry(credential) <= Date.now()) {
      return undefined;
    }
    return this.generationForCredential(credential);
  }

  /**
   * 受信 provider/proxy adapter 专用读取：仍执行 audience/host/tool scope，
   * 但不把值放进普通工具输入。调用方不得记录返回值。
   */
  trustedValue(
    credentialId: string,
    request: { audience: string; host?: string; tool?: string },
  ): string {
    const credential = this.credentials.get(credentialId);
    if (!credential) {
      this.audit({ action: "deny", credentialId, ...request, success: false, reason: "unknown" });
      throw new Error("Unknown credential");
    }
    if (this.rotationBlocked(credentialId)) {
      this.audit({ action: "deny", credentialId, ...request, success: false, reason: "rotation" });
      throw new Error("Credential is unavailable during rotation reconciliation");
    }
    if (credentialExpiry(credential) <= Date.now()) {
      this.audit({ action: "deny", credentialId, ...request, success: false, reason: "expired" });
      throw new Error("Credential expired");
    }
    const allowed = credential.scopes.some(
      (scope) =>
        matches(scope.audiences, request.audience) &&
        matches(scope.hosts, request.host) &&
        matches(scope.tools, request.tool),
    );
    if (!allowed) {
      this.audit({ action: "deny", credentialId, ...request, success: false, reason: "scope" });
      throw new Error("Credential scope denied");
    }
    const value = this.resolveValue(credential);
    if (this.credentials.get(credentialId) !== credential) {
      throw new Error("Credential changed during trusted access");
    }
    if (credentialExpiry(credential) <= Date.now()) throw new Error("Credential expired");
    this.audit({
      action: "read",
      credentialId,
      ...request,
      version: credential.version ?? 1,
    });
    return value;
  }

  async trustedValueAsync(
    credentialId: string,
    request: { audience: string; host?: string; tool?: string },
  ): Promise<string> {
    const credential = this.credentials.get(credentialId);
    if (!credential) {
      this.audit({ action: "deny", credentialId, ...request, success: false, reason: "unknown" });
      throw new Error("Unknown credential");
    }
    if (this.rotationBlocked(credentialId)) {
      this.audit({ action: "deny", credentialId, ...request, success: false, reason: "rotation" });
      throw new Error("Credential is unavailable during rotation reconciliation");
    }
    if (credentialExpiry(credential) <= Date.now()) {
      this.audit({ action: "deny", credentialId, ...request, success: false, reason: "expired" });
      throw new Error("Credential expired");
    }
    const allowed = credential.scopes.some(
      (scope) =>
        matches(scope.audiences, request.audience) &&
        matches(scope.hosts, request.host) &&
        matches(scope.tools, request.tool),
    );
    if (!allowed) {
      this.audit({ action: "deny", credentialId, ...request, success: false, reason: "scope" });
      throw new Error("Credential scope denied");
    }
    const value = await this.resolveValueAsync(credential);
    if (this.credentials.get(credentialId) !== credential) {
      throw new Error("Credential changed during trusted access");
    }
    if (credentialExpiry(credential) <= Date.now()) throw new Error("Credential expired");
    this.audit({
      action: "read",
      credentialId,
      ...request,
      version: credential.version ?? 1,
    });
    return value;
  }

  lease(request: CredentialLeaseRequest): string {
    const ttlMs = positiveSafeInteger(
      request.ttlMs,
      DEFAULT_CREDENTIAL_LEASE_TTL_MS,
      MAX_CREDENTIAL_LEASE_TTL_MS,
      "Credential lease ttlMs",
    );
    const maxUses = positiveSafeInteger(
      request.maxUses,
      1,
      MAX_CREDENTIAL_LEASE_USES,
      "Credential lease maxUses",
    );
    const credential = this.credentials.get(request.credentialId);
    if (!credential) {
      this.audit({
        action: "deny",
        credentialId: request.credentialId,
        audience: request.audience,
        ...(request.host ? { host: request.host } : {}),
        ...(request.tool ? { tool: request.tool } : {}),
        success: false,
        reason: "unknown",
      });
      throw new Error("Unknown credential");
    }
    if (this.rotationBlocked(request.credentialId)) {
      this.audit({
        action: "deny",
        credentialId: request.credentialId,
        audience: request.audience,
        ...(request.host ? { host: request.host } : {}),
        ...(request.tool ? { tool: request.tool } : {}),
        success: false,
        reason: "rotation",
      });
      throw new Error("Credential is unavailable during rotation reconciliation");
    }
    const now = Date.now();
    const credentialDeadline = credentialExpiry(credential);
    if (credentialDeadline <= now) {
      this.audit({
        action: "deny",
        credentialId: request.credentialId,
        audience: request.audience,
        ...(request.host ? { host: request.host } : {}),
        ...(request.tool ? { tool: request.tool } : {}),
        success: false,
        reason: "expired",
      });
      throw new Error("Credential expired");
    }
    const scope = credential.scopes.find(
      (candidate) =>
        matches(candidate.audiences, request.audience) &&
        matches(candidate.hosts, request.host) &&
        matches(candidate.tools, request.tool),
    );
    if (!scope) {
      this.audit({
        action: "deny",
        credentialId: request.credentialId,
        audience: request.audience,
        ...(request.host ? { host: request.host } : {}),
        ...(request.tool ? { tool: request.tool } : {}),
        success: false,
        reason: "scope",
      });
      throw new Error("Credential scope denied");
    }
    const id = `lease_${randomUUID()}`;
    this.leases.set(id, {
      id,
      credentialId: credential.id,
      credential,
      credentialVersion: credential.version ?? 1,
      scope: cloneScope(scope),
      expiresAt: Math.min(now + ttlMs, credentialDeadline),
      usesLeft: maxUses,
    });
    this.audit({
      action: "lease",
      credentialId: credential.id,
      audience: request.audience,
      ...(request.host ? { host: request.host } : {}),
      ...(request.tool ? { tool: request.tool } : {}),
      leaseId: id,
      version: credential.version ?? 1,
    });
    return id;
  }

  /** Inspect only the authorized destination name; does not expose or consume the secret value. */
  leaseEnvironmentName(leaseId: string): string | undefined {
    const lease = this.activeLease(leaseId);
    return lease.scope.env;
  }

  private activeLease(leaseId: string): Lease {
    const lease = this.leases.get(leaseId);
    const credential = lease ? this.credentials.get(lease.credentialId) : undefined;
    if (
      !lease ||
      lease.expiresAt <= Date.now() ||
      lease.usesLeft <= 0 ||
      credential !== lease.credential ||
      (credential?.version ?? 0) !== lease.credentialVersion ||
      this.rotationBlocked(lease.credentialId) ||
      credentialExpiry(lease.credential) <= Date.now()
    ) {
      this.leases.delete(leaseId);
      throw new Error("Credential lease expired, exhausted, revoked, or replaced");
    }
    return lease;
  }

  private consume(leaseId: string): { credential: CredentialRegistration; scope: CredentialScope } {
    const lease = this.activeLease(leaseId);
    const credential = lease.credential;
    lease.usesLeft--;
    if (lease.usesLeft === 0) this.leases.delete(leaseId);
    this.audit({
      action: "consume",
      credentialId: credential.id,
      leaseId,
      version: credential.version ?? 1,
    });
    return { credential, scope: lease.scope };
  }

  injectEnv(leaseId: string, env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const { credential, scope } = this.consume(leaseId);
    if (!scope.env) throw new Error("Credential lease does not permit env injection");
    const value = this.resolveValue(credential);
    if (
      this.credentials.get(credential.id) !== credential ||
      credentialExpiry(credential) <= Date.now()
    ) {
      throw new Error("Credential expired, revoked, or replaced during lease consumption");
    }
    return { ...env, [scope.env]: value };
  }

  async injectEnvAsync(leaseId: string, env: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
    const { credential, scope } = this.consume(leaseId);
    if (!scope.env) throw new Error("Credential lease does not permit env injection");
    const value = await this.resolveValueAsync(credential);
    if (
      this.credentials.get(credential.id) !== credential ||
      credentialExpiry(credential) <= Date.now()
    ) {
      throw new Error("Credential expired, revoked, or replaced during lease consumption");
    }
    return { ...env, [scope.env]: value };
  }

  injectHeaders(leaseId: string, headers: HeadersInit = {}): Headers {
    const { credential, scope } = this.consume(leaseId);
    if (!scope.header) throw new Error("Credential lease does not permit header injection");
    const result = new Headers(headers);
    const value = this.resolveValue(credential);
    if (
      this.credentials.get(credential.id) !== credential ||
      credentialExpiry(credential) <= Date.now()
    ) {
      throw new Error("Credential expired, revoked, or replaced during lease consumption");
    }
    result.set(scope.header, `${scope.headerPrefix ?? ""}${value}`);
    return result;
  }

  async injectHeadersAsync(leaseId: string, headers: HeadersInit = {}): Promise<Headers> {
    const { credential, scope } = this.consume(leaseId);
    if (!scope.header) throw new Error("Credential lease does not permit header injection");
    const result = new Headers(headers);
    const value = await this.resolveValueAsync(credential);
    if (
      this.credentials.get(credential.id) !== credential ||
      credentialExpiry(credential) <= Date.now()
    ) {
      throw new Error("Credential expired, revoked, or replaced during lease consumption");
    }
    result.set(scope.header, `${scope.headerPrefix ?? ""}${value}`);
    return result;
  }

  private rotationPreconditionFailure(
    credentialId: string,
    reason: "in-progress" | "quarantined" | "target-in-progress" | "target-registered",
  ): never {
    this.audit({ action: "rotate", credentialId, success: false, reason });
    throw new CredentialRotationError(credentialId, "not-written", reason);
  }

  private acquireRotationTarget(
    credentialId: string,
    backend: SecretBackend,
    key: string,
    token: symbol,
  ): void {
    const targets = this.backendTargetMap(backend, true)!;
    const state = targets.get(key) ?? {};
    if (state.ownerCredentialId && state.ownerCredentialId !== credentialId) {
      this.rotationPreconditionFailure(credentialId, "target-registered");
    }
    if (state.activeRotationToken) {
      this.rotationPreconditionFailure(credentialId, "target-in-progress");
    }
    state.activeRotationToken = token;
    targets.set(key, state);
  }

  private releaseRotationTarget(rotation: ActiveCredentialRotation): void {
    if (!rotation.targetBackend || !rotation.targetCoordinationKey) return;
    const state = this.backendTargetMap(rotation.targetBackend, false)?.get(
      rotation.targetCoordinationKey,
    );
    if (state?.activeRotationToken === rotation.token) {
      delete state.activeRotationToken;
      this.cleanupBackendTarget(rotation.targetBackend, rotation.targetCoordinationKey, state);
    }
  }

  private beginRotation(
    credentialId: string,
    value: string,
    targetBackend?: SecretBackend,
    targetKey?: string,
    expiresAt?: string,
  ): ActiveCredentialRotation {
    if (this.activeRotations.has(credentialId)) {
      this.rotationPreconditionFailure(credentialId, "in-progress");
    }
    const credential = this.credentials.get(credentialId);
    if (!credential) throw new Error("Unknown credential");
    if (!value) throw new Error("Credential value cannot be empty");
    const currentVersion = credential.version ?? 1;
    if (!Number.isSafeInteger(currentVersion) || currentVersion >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Credential version cannot be rotated further");
    }
    const resolvedTargetKey = targetBackend
      ? validRotationBackendKey(targetKey ?? credentialId)
      : undefined;
    const targetCoordinationKey =
      targetBackend && resolvedTargetKey
        ? credentialBackendTargetKey(targetBackend, resolvedTargetKey)
        : undefined;
    const quarantine = this.quarantinedRotations.get(credentialId);
    if (
      quarantine &&
      (quarantine.credential !== credential ||
        quarantine.targetBackend !== targetBackend ||
        quarantine.targetKey !== resolvedTargetKey ||
        quarantine.targetCoordinationKey !== targetCoordinationKey ||
        quarantine.attemptedValue !== value ||
        quarantine.expiresAt !== expiresAt)
    ) {
      this.rotationPreconditionFailure(credentialId, "quarantined");
    }

    const token = Symbol(credentialId);
    if (targetBackend && targetCoordinationKey) {
      this.acquireRotationTarget(credentialId, targetBackend, targetCoordinationKey, token);
    }
    const generation = this.generationForCredential(credential);
    const fencedCredential = Object.freeze({ ...credential });
    this.credentialGenerations.set(fencedCredential, generation);
    const rotation: ActiveCredentialRotation = {
      token,
      credential: fencedCredential,
      ...(targetBackend ? { targetBackend } : {}),
      ...(targetCoordinationKey ? { targetCoordinationKey } : {}),
      ...(resolvedTargetKey ? { targetKey: resolvedTargetKey } : {}),
      nextVersion: currentVersion + 1,
      cancelled: false,
      attemptedValue: value,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    this.rememberRetiredSecret(value);
    this.invalidateCredentialUse(credentialId, credential);
    this.credentials.set(credentialId, fencedCredential);
    this.activeRotations.set(credentialId, rotation);
    return rotation;
  }

  private completeRotation(
    rotation: ActiveCredentialRotation,
    replacement: CredentialRegistration,
    value: string,
    backendWasWritten: boolean,
  ): number {
    const credentialId = rotation.credential.id;
    if (
      this.activeRotations.get(credentialId) !== rotation ||
      rotation.cancelled ||
      this.credentials.get(credentialId) !== rotation.credential
    ) {
      if (this.activeRotations.get(credentialId) === rotation) {
        this.activeRotations.delete(credentialId);
      }
      this.rememberRetiredSecret(rotation.attemptedValue);
      this.releaseRotationTarget(rotation);
      this.audit({
        action: "rotate",
        credentialId,
        version: rotation.nextVersion,
        success: false,
        reason: "superseded-after-write",
      });
      throw new CredentialRotationError(
        credentialId,
        backendWasWritten ? "written-not-activated" : "not-written",
        "superseded-after-write",
      );
    }
    this.untrackRegistrationTarget(credentialId, rotation.credential);
    const frozenReplacement = Object.freeze(replacement);
    this.credentialGenerations.set(
      frozenReplacement,
      this.generationForCredential(rotation.credential),
    );
    this.credentials.set(credentialId, frozenReplacement);
    this.trackRegistrationTarget(credentialId, frozenReplacement);
    this.activeRotations.delete(credentialId);
    this.quarantinedRotations.delete(credentialId);
    this.releaseRotationTarget(rotation);
    this.rememberSecret(credentialId, value);
    if (frozenReplacement.backend || frozenReplacement.asyncBackend) {
      this.cacheReferenceValue(frozenReplacement, value);
    }
    this.audit({ action: "rotate", credentialId, version: rotation.nextVersion });
    return rotation.nextVersion;
  }

  private failRotation(rotation: ActiveCredentialRotation): never {
    const credentialId = rotation.credential.id;
    const isCurrent =
      this.activeRotations.get(credentialId) === rotation &&
      !rotation.cancelled &&
      this.credentials.get(credentialId) === rotation.credential;
    if (this.activeRotations.get(credentialId) === rotation) {
      this.activeRotations.delete(credentialId);
    }
    if (isCurrent) {
      this.quarantinedRotations.set(credentialId, {
        credential: rotation.credential,
        ...(rotation.targetBackend ? { targetBackend: rotation.targetBackend } : {}),
        ...(rotation.targetCoordinationKey
          ? { targetCoordinationKey: rotation.targetCoordinationKey }
          : {}),
        ...(rotation.targetKey ? { targetKey: rotation.targetKey } : {}),
        attemptedValue: rotation.attemptedValue,
        ...(rotation.expiresAt !== undefined ? { expiresAt: rotation.expiresAt } : {}),
      });
      if (rotation.targetBackend && rotation.targetCoordinationKey) {
        this.trackBackendTarget(
          credentialId,
          rotation.targetBackend,
          rotation.targetCoordinationKey,
        );
      }
    } else {
      this.rememberRetiredSecret(rotation.attemptedValue);
    }
    this.releaseRotationTarget(rotation);
    const reason = isCurrent ? "write-indeterminate" : "superseded-during-write";
    this.audit({
      action: "rotate",
      credentialId,
      version: rotation.nextVersion,
      success: false,
      reason,
    });
    throw new CredentialRotationError(credentialId, "indeterminate", reason);
  }

  private async putRotationBackend(
    backend: SecretBackend,
    key: string,
    value: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const controller = new AbortController();
    type Outcome = "success" | "failed" | "timed-out" | "cancelled";
    const running: Promise<Outcome> = Promise.resolve()
      .then(() => backend.put(key, value, controller.signal))
      .then(
        () => "success" as const,
        () => "failed" as const,
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => resolve("timed-out"), timeoutMs);
    });
    let cancel: (() => void) | undefined;
    const cancelled = signal
      ? signal.aborted
        ? Promise.resolve<Outcome>("cancelled")
        : new Promise<Outcome>((resolve) => {
            cancel = () => resolve("cancelled");
            signal.addEventListener("abort", cancel, { once: true });
          })
      : undefined;
    const outcome = await Promise.race(
      cancelled ? [running, timedOut, cancelled] : [running, timedOut],
    );
    if (timer) clearTimeout(timer);
    if (cancel && signal) signal.removeEventListener("abort", cancel);
    if (outcome === "success") return;
    controller.abort();
    throw new Error(`Credential backend write ${outcome}`);
  }

  rotate(credentialId: string, value: string, options: CredentialRotationMetadata = {}): number {
    const credential = this.credentials.get(credentialId);
    if (!credential) throw new Error("Unknown credential");
    if (!value) throw new Error("Credential value cannot be empty");
    if (credential.asyncBackend) {
      throw new Error("Async credential must be rotated with rotateBackend");
    }
    if (credential.backingBackend && !isSyncSecretBackend(credential.backingBackend)) {
      throw new Error("Async-backed credential must be rotated with rotateBackend");
    }
    const targetBackend = credential.backend ?? credential.backingBackend;
    const targetKey = targetBackend ? (credential.backendKey ?? credential.id) : undefined;
    const expiresAt =
      options.expiresAt !== undefined
        ? normalizedRotationExpiry(options.expiresAt)
        : credential.expiresAt;
    const rotation = this.beginRotation(credentialId, value, targetBackend, targetKey, expiresAt);
    try {
      targetBackend?.putSync(rotation.targetKey ?? credentialId, value);
    } catch {
      return this.failRotation(rotation);
    }
    const replacement: CredentialRegistration = rotation.credential.backend
      ? {
          id: credentialId,
          backend: targetBackend as SyncSecretBackend,
          ...(rotation.targetKey ? { backendKey: rotation.targetKey } : {}),
          scopes: rotation.credential.scopes,
          ...(rotation.expiresAt ? { expiresAt: rotation.expiresAt } : {}),
          version: rotation.nextVersion,
        }
      : {
          id: credentialId,
          value,
          ...(targetBackend ? { backingBackend: targetBackend } : {}),
          ...(rotation.targetKey ? { backendKey: rotation.targetKey } : {}),
          scopes: rotation.credential.scopes,
          ...(rotation.expiresAt ? { expiresAt: rotation.expiresAt } : {}),
          version: rotation.nextVersion,
        };
    return this.completeRotation(rotation, replacement, value, Boolean(targetBackend));
  }

  async rotateBackend(
    credentialId: string,
    backend: SecretBackend,
    value: string,
    key?: string,
    options: CredentialRotationOptions = {},
  ): Promise<number> {
    const credential = this.credentials.get(credentialId);
    if (!credential) throw new Error("Unknown credential");
    if (!value) throw new Error("Credential value cannot be empty");
    if (credential.backend && !isSyncSecretBackend(backend)) {
      throw new Error("Synchronous credential rotation requires a synchronous backend");
    }
    if (options.signal?.aborted) {
      throw new Error("Credential rotation was cancelled before the backend write");
    }
    const timeoutMs = credentialRotationTimeout(options.timeoutMs);
    const expiresAt =
      options.expiresAt !== undefined
        ? normalizedRotationExpiry(options.expiresAt)
        : credential.expiresAt;
    const targetKey = validRotationBackendKey(key ?? credentialId);
    const rotation = this.beginRotation(credentialId, value, backend, targetKey, expiresAt);
    try {
      await this.putRotationBackend(backend, targetKey, value, timeoutMs, options.signal);
    } catch {
      return this.failRotation(rotation);
    }
    const replacement: CredentialRegistration = rotation.credential.asyncBackend
      ? {
          id: credentialId,
          asyncBackend: backend,
          backendKey: targetKey,
          scopes: rotation.credential.scopes,
          ...(rotation.expiresAt ? { expiresAt: rotation.expiresAt } : {}),
          version: rotation.nextVersion,
        }
      : rotation.credential.backend
        ? {
            id: credentialId,
            backend: backend as SyncSecretBackend,
            backendKey: targetKey,
            scopes: rotation.credential.scopes,
            ...(rotation.expiresAt ? { expiresAt: rotation.expiresAt } : {}),
            version: rotation.nextVersion,
          }
        : {
            id: credentialId,
            value,
            backingBackend: backend,
            backendKey: targetKey,
            scopes: rotation.credential.scopes,
            ...(rotation.expiresAt ? { expiresAt: rotation.expiresAt } : {}),
            version: rotation.nextVersion,
          };
    return this.completeRotation(rotation, replacement, value, true);
  }

  /** 在写日志/事件前调用；长密钥优先替换，避免短串先替换造成残留。 */
  redact(value: string): string {
    let redacted = value;
    const now = Date.now();
    for (const [id, secret] of this.recentSecrets)
      if (secret.expiresAt <= now) this.recentSecrets.delete(id);
    for (const [id, secret] of this.retiredSecrets)
      if (secret.expiresAt <= now) this.retiredSecrets.delete(id);
    for (const [id, cached] of this.referenceCache)
      if (cached.expiresAt <= now) this.referenceCache.delete(id);
    const secrets = [
      ...[...this.credentials.values()].map((credential) => credential.value),
      ...[...this.recentSecrets.values()].map((secret) => secret.value),
      ...[...this.retiredSecrets.values()].map((secret) => secret.value),
      ...[...this.activeRotations.values()].map((rotation) => rotation.attemptedValue),
      ...[...this.quarantinedRotations.values()].map((rotation) => rotation.attemptedValue),
      ...[...this.referenceCache.values()].map((cached) =>
        cached.state === "available" ? cached.value : undefined,
      ),
    ]
      .filter((secret): secret is string => Boolean(secret && secret.length >= 4))
      .sort((a, b) => b.length - a.length);
    for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED]");
    return redacted
      .replace(/\b(?:sk|api|token|secret)[-_][A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]")
      .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, "$1[REDACTED]");
  }
}

const SENSITIVE_NAME =
  /(?:^|_)(?:API_?KEY|ADMIN_?KEY|ACCESS_?KEY(?:_ID)?|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY)$/i;
const MAX_CREDENTIAL_ENVIRONMENT_NAME_LENGTH = 128;
const MAX_CREDENTIAL_ENVIRONMENT_VALUE_BYTES = 64 * 1024;

/** Sensitive material that must not be inherited by runtime children, including control-plane data. */
export function isSensitiveEnvironmentName(name: string): boolean {
  return SENSITIVE_NAME.test(name);
}

const ENVIRONMENT_CREDENTIAL_SCOPES: Readonly<Record<string, readonly CredentialScope[]>> = {
  OPENAI_API_KEY: [{ audiences: ["provider:openai"], hosts: ["api.openai.com"] }],
  OPENAI_ADMIN_KEY: [{ audiences: ["provider:openai"], hosts: ["api.openai.com"] }],
  ANTHROPIC_API_KEY: [{ audiences: ["provider:anthropic"], hosts: ["api.anthropic.com"] }],
  DEEPSEEK_API_KEY: [{ audiences: ["provider:deepseek"], hosts: ["api.deepseek.com"] }],
  GEMINI_API_KEY: [
    {
      audiences: ["provider:gemini"],
      hosts: ["generativelanguage.googleapis.com"],
    },
  ],
  GOOGLE_API_KEY: [
    {
      audiences: ["provider:gemini"],
      hosts: ["generativelanguage.googleapis.com"],
    },
  ],
  OPENROUTER_API_KEY: [
    { audiences: ["provider:openrouter"], hosts: ["openrouter.ai", "api.openrouter.ai"] },
  ],
  GITHUB_TOKEN: [
    {
      audiences: ["mcp:github"],
      hosts: ["api.githubcopilot.com"],
      tools: ["http"],
      header: "authorization",
    },
  ],
  SENTRY_ACCESS_TOKEN: [
    {
      audiences: ["mcp:sentry"],
      hosts: ["mcp.sentry.dev"],
      tools: ["http"],
      header: "authorization",
    },
  ],
  CLIPROXY_API_KEY: [{ audiences: ["provider:cliproxy"], hosts: ["127.0.0.1", "localhost"] }],
  // This explicit name is the escape hatch for arbitrary OpenAI-compatible endpoints. Unknown
  // *_API_KEY names never inherit its wildcard authority.
  CUSTOM_OPENAI_API_KEY: [{ audiences: ["provider:*"], hosts: ["*"] }],
  TAVILY_API_KEY: [
    {
      audiences: ["network:web-search"],
      hosts: ["api.tavily.com"],
      tools: ["web_search"],
      header: "authorization",
      headerPrefix: "Bearer ",
    },
  ],
  BRAVE_SEARCH_API_KEY: [
    {
      audiences: ["network:web-search"],
      hosts: ["api.search.brave.com"],
      tools: ["web_search"],
      header: "x-subscription-token",
    },
  ],
};

/** Provider credentials are a positive allowlist; control-plane and unknown secrets default deny. */
export function isCredentialEnvironmentName(name: string): boolean {
  return (
    name === name.toUpperCase() &&
    isSensitiveEnvironmentName(name) &&
    Object.hasOwn(ENVIRONMENT_CREDENTIAL_SCOPES, name)
  );
}

function assertBoundedEnvironmentCredential(name: string, value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_ENVIRONMENT_VALUE_BYTES) {
    throw new Error(
      `Environment credential ${name} exceeds ${MAX_CREDENTIAL_ENVIRONMENT_VALUE_BYTES} bytes`,
    );
  }
}

export function credentialEnvironmentAllowlist(env: NodeJS.ProcessEnv): string[] {
  const configured = env.ANICODE_CREDENTIAL_KEYS;
  if (!configured?.trim()) return [];
  if (Buffer.byteLength(configured, "utf8") > 256 * 129) {
    throw new Error("ANICODE_CREDENTIAL_KEYS is too large");
  }
  const names = configured
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (names.length > 256) throw new Error("ANICODE_CREDENTIAL_KEYS exceeds 256 entries");
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (
      name.length > MAX_CREDENTIAL_ENVIRONMENT_NAME_LENGTH ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      !isCredentialEnvironmentName(name)
    ) {
      throw new Error(`ANICODE_CREDENTIAL_KEYS contains an invalid credential name: ${name}`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      unique.push(name);
    }
  }
  return unique;
}

export function credentialScopesForEnvironment(name: string): CredentialScope[] {
  if (!isCredentialEnvironmentName(name)) return [];
  return (ENVIRONMENT_CREDENTIAL_SCOPES[name] ?? []).map(cloneScope);
}

/** Vault/KMS 等异步后端：按需水合指定凭据，后端仍是唯一长期存储。 */
export async function credentialBrokerFromBackend(
  backend: SecretBackend,
  environmentNames: string[],
  options: {
    onAudit?: CredentialBrokerOptions["onAudit"];
    ignoreMissing?: boolean;
    /** Explicit host environment values take precedence and remain process-local. */
    environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<CredentialBroker> {
  const broker = new CredentialBroker({ ...(options.onAudit ? { onAudit: options.onAudit } : {}) });
  const inlineNames = new Set<string>();
  if (options.environment) {
    for (const [name, value] of Object.entries(options.environment)) {
      if (!value || !isSensitiveEnvironmentName(name)) continue;
      assertBoundedEnvironmentCredential(name, value);
      if (!isCredentialEnvironmentName(name)) continue;
      broker.register({ id: `env:${name}`, value, scopes: credentialScopesForEnvironment(name) });
      inlineNames.add(name);
    }
  }
  for (const name of [...new Set(environmentNames)]) {
    if (!isCredentialEnvironmentName(name))
      throw new Error(`Refusing non-credential backend key: ${name}`);
    if (inlineNames.has(name)) continue;
    try {
      await broker.registerFromBackend({
        id: `env:${name}`,
        backend,
        backendKey: `env:${name}`,
        scopes: credentialScopesForEnvironment(name),
      });
    } catch (error) {
      if (!options.ignoreMissing) throw error;
    }
  }
  return broker;
}

/**
 * Register exact, lazy references for an asynchronous process-isolated backend.
 *
 * Unlike `credentialBrokerFromBackend`, this function performs no backend I/O during host
 * assembly. Trusted async call sites hydrate one selected reference immediately before the first
 * real provider/MCP/tool operation; synchronous adapters may then consume the broker's bounded,
 * identity-bound cache without opening the backend again.
 */
export function credentialBrokerFromLazyBackend(
  backend: SecretBackend,
  environmentNames: string[],
  options: {
    onAudit?: CredentialBrokerOptions["onAudit"];
    /** Explicit host environment values take precedence and remain process-local. */
    environment?: NodeJS.ProcessEnv;
  } = {},
): CredentialBroker {
  if (!backend || typeof backend.get !== "function") {
    throw new Error("Lazy credential backend must implement get");
  }
  const broker = new CredentialBroker({ ...(options.onAudit ? { onAudit: options.onAudit } : {}) });
  const inlineNames = new Set<string>();
  if (options.environment) {
    for (const [name, value] of Object.entries(options.environment)) {
      if (!value || !isSensitiveEnvironmentName(name)) continue;
      assertBoundedEnvironmentCredential(name, value);
      if (!isCredentialEnvironmentName(name)) continue;
      broker.register({ id: `env:${name}`, value, scopes: credentialScopesForEnvironment(name) });
      inlineNames.add(name);
    }
  }
  for (const name of [...new Set(environmentNames)]) {
    if (!isCredentialEnvironmentName(name)) {
      throw new Error(`Refusing non-credential backend key: ${name}`);
    }
    if (inlineNames.has(name)) continue;
    broker.registerAsyncReference({
      id: `env:${name}`,
      backend,
      backendKey: `env:${name}`,
      scopes: credentialScopesForEnvironment(name),
    });
  }
  return broker;
}

/**
 * 把环境密钥登记进当前进程 Broker，从不隐式写入持久后端。后端引用只能由
 * `ANICODE_CREDENTIAL_KEYS` 中的精确环境变量名显式注册，且仅在同名环境值不存在时使用。
 */
export function credentialBrokerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    remove?: boolean;
    backend?: SyncSecretBackend;
    onAudit?: CredentialBrokerOptions["onAudit"];
  } = {},
): CredentialBroker {
  const broker = new CredentialBroker({ ...(options.onAudit ? { onAudit: options.onAudit } : {}) });
  const explicitReferences = credentialEnvironmentAllowlist(env);
  const sensitiveValues: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || !isSensitiveEnvironmentName(name)) continue;
    assertBoundedEnvironmentCredential(name, value);
    sensitiveValues.push({ name, value });
  }
  const inlineNames = new Set<string>();
  for (const { name, value } of sensitiveValues) {
    if (!isCredentialEnvironmentName(name)) continue;
    const id = `env:${name}`;
    broker.register({ id, value, scopes: credentialScopesForEnvironment(name) });
    inlineNames.add(name);
  }
  if (options.backend) {
    for (const name of explicitReferences) {
      if (inlineNames.has(name)) continue;
      broker.registerReference({
        id: `env:${name}`,
        backend: options.backend,
        backendKey: `env:${name}`,
        scopes: credentialScopesForEnvironment(name),
      });
    }
  }
  if (options.remove) {
    for (const { name, value } of sensitiveValues) {
      if (env[name] === value) delete env[name];
    }
  }
  return broker;
}
