/**
 * Credential Broker：密钥只在受信执行边界注入，不进入 prompt、事件、Artifact 或日志。
 */

import { randomUUID } from "node:crypto";
import type { SecretBackend, SyncSecretBackend } from "./secret-backends.js";

export interface CredentialScope {
  audiences: string[];
  hosts?: string[];
  tools?: string[];
  env?: string;
  header?: string;
}

export interface CredentialRegistration {
  id: string;
  /** 仅兼容一次性/测试凭据；生产长期凭据使用 backend reference。 */
  value?: string;
  backend?: SyncSecretBackend;
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

export class CredentialBroker {
  private readonly credentials = new Map<string, CredentialRegistration>();
  private readonly leases = new Map<string, Lease>();
  private readonly recentSecrets = new Map<string, { value: string; expiresAt: number }>();
  private readonly onAudit?: CredentialBrokerOptions["onAudit"];
  private readonly redactionTtlMs: number;

  constructor(options: CredentialBrokerOptions = {}) {
    if (options.onAudit) this.onAudit = options.onAudit;
    this.redactionTtlMs = Math.max(1_000, options.redactionTtlMs ?? 5 * 60_000);
  }

  private audit(
    event: Omit<CredentialAuditEvent, "timestamp" | "success"> & { success?: boolean },
  ): void {
    void Promise.resolve(
      this.onAudit?.({
        timestamp: new Date().toISOString(),
        success: event.success ?? true,
        ...event,
      }),
    ).catch(() => undefined);
  }

  private resolveValue(credential: CredentialRegistration): string {
    const value = credential.backend
      ? credential.backend.getSync(credential.backendKey ?? credential.id)
      : credential.value;
    if (!value) throw new Error("Credential value is unavailable");
    this.recentSecrets.set(credential.id, {
      value,
      expiresAt: Date.now() + this.redactionTtlMs,
    });
    return value;
  }

  register(registration: CredentialRegistration): void {
    if (
      !registration.id ||
      (!registration.value && !registration.backend) ||
      (registration.value !== undefined && registration.backend !== undefined) ||
      registration.scopes.length === 0
    ) {
      throw new Error("Credential id, exactly one value source, and scopes are required");
    }
    this.credentials.set(registration.id, {
      ...registration,
      version: Math.max(1, registration.version ?? 1),
      scopes: [...registration.scopes],
    });
    this.audit({
      action: "register",
      credentialId: registration.id,
      version: Math.max(1, registration.version ?? 1),
    });
  }

  registerReference(
    registration: Omit<CredentialRegistration, "value" | "backend" | "backendKey"> & {
      backend: SyncSecretBackend;
      backendKey?: string;
    },
  ): void {
    this.register(registration);
  }

  /** Vault/KMS 等异步后端在宿主启动时水合；明文不落盘，只保留到进程退出/轮换。 */
  async registerFromBackend(
    registration: Omit<CredentialRegistration, "value" | "backend" | "backendKey"> & {
      backend: SecretBackend;
      backendKey?: string;
    },
  ): Promise<void> {
    const key = registration.backendKey ?? registration.id;
    const value = await registration.backend.get(key);
    if (!value)
      throw new Error(`Credential ${registration.id} is missing from ${registration.backend.kind}`);
    this.register({
      id: registration.id,
      value,
      scopes: registration.scopes,
      ...(registration.expiresAt ? { expiresAt: registration.expiresAt } : {}),
      ...(registration.version ? { version: registration.version } : {}),
    });
  }

  revoke(credentialId: string): boolean {
    for (const [id, lease] of this.leases)
      if (lease.credentialId === credentialId) this.leases.delete(id);
    this.recentSecrets.delete(credentialId);
    const deleted = this.credentials.delete(credentialId);
    this.audit({ action: "revoke", credentialId, success: deleted });
    return deleted;
  }

  has(credentialId: string): boolean {
    const credential = this.credentials.get(credentialId);
    if (!credential || (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now())) {
      return false;
    }
    if (!credential.backend) return Boolean(credential.value);
    try {
      return Boolean(credential.backend.getSync(credential.backendKey ?? credential.id));
    } catch {
      return false;
    }
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
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) {
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
    this.audit({
      action: "read",
      credentialId,
      ...request,
      version: credential.version ?? 1,
    });
    return value;
  }

  lease(request: CredentialLeaseRequest): string {
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
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) {
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
      scope,
      expiresAt: Date.now() + Math.max(1_000, request.ttlMs ?? 60_000),
      usesLeft: Math.max(1, Math.floor(request.maxUses ?? 1)),
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

  private consume(leaseId: string): { credential: CredentialRegistration; scope: CredentialScope } {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.expiresAt <= Date.now() || lease.usesLeft <= 0) {
      this.leases.delete(leaseId);
      throw new Error("Credential lease expired or exhausted");
    }
    const credential = this.credentials.get(lease.credentialId);
    if (!credential) throw new Error("Credential revoked");
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
    return { ...env, [scope.env]: this.resolveValue(credential) };
  }

  injectHeaders(leaseId: string, headers: HeadersInit = {}): Headers {
    const { credential, scope } = this.consume(leaseId);
    if (!scope.header) throw new Error("Credential lease does not permit header injection");
    const result = new Headers(headers);
    result.set(scope.header, this.resolveValue(credential));
    return result;
  }

  rotate(credentialId: string, value: string): number {
    const credential = this.credentials.get(credentialId);
    if (!credential) throw new Error("Unknown credential");
    if (!value) throw new Error("Credential value cannot be empty");
    if (credential.backend)
      credential.backend.putSync(credential.backendKey ?? credential.id, value);
    else credential.value = value;
    credential.version = (credential.version ?? 1) + 1;
    for (const [id, lease] of this.leases)
      if (lease.credentialId === credentialId) this.leases.delete(id);
    this.recentSecrets.delete(credentialId);
    this.audit({ action: "rotate", credentialId, version: credential.version });
    return credential.version;
  }

  async rotateBackend(
    credentialId: string,
    backend: SecretBackend,
    value: string,
    key?: string,
  ): Promise<number> {
    await backend.put(key ?? credentialId, value);
    const credential = this.credentials.get(credentialId);
    if (credential) {
      credential.value = value;
      credential.version = (credential.version ?? 1) + 1;
      for (const [id, lease] of this.leases)
        if (lease.credentialId === credentialId) this.leases.delete(id);
      this.recentSecrets.delete(credentialId);
      this.audit({ action: "rotate", credentialId, version: credential.version });
      return credential.version;
    }
    return 1;
  }

  /** 在写日志/事件前调用；长密钥优先替换，避免短串先替换造成残留。 */
  redact(value: string): string {
    let redacted = value;
    const now = Date.now();
    for (const [id, secret] of this.recentSecrets)
      if (secret.expiresAt <= now) this.recentSecrets.delete(id);
    const secrets = [
      ...[...this.credentials.values()].map((credential) => credential.value),
      ...[...this.recentSecrets.values()].map((secret) => secret.value),
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
const CREDENTIAL_CONTROL_NAME =
  /(?:_TOKEN_FILE|_TOKEN_REQUEST_URL|_CREDENTIAL_BACKEND|_CREDENTIAL_KEYS)$/i;

export function isCredentialEnvironmentName(name: string): boolean {
  return !CREDENTIAL_CONTROL_NAME.test(name) && SENSITIVE_NAME.test(name);
}

export function credentialScopesForEnvironment(name: string): CredentialScope[] {
  return [
    { audiences: ["provider:*", "network:*"], hosts: ["*"] },
    { audiences: ["telemetry:*"], hosts: ["*"] },
    { audiences: ["tool:*"], tools: ["*"], env: name },
    { audiences: ["mcp:*"], tools: ["stdio"], env: name },
    { audiences: ["mcp:*"], hosts: ["*"], tools: ["http"], header: "authorization" },
  ];
}

/** Vault/KMS 等异步后端：按需水合指定凭据，后端仍是唯一长期存储。 */
export async function credentialBrokerFromBackend(
  backend: SecretBackend,
  environmentNames: string[],
  options: { onAudit?: CredentialBrokerOptions["onAudit"]; ignoreMissing?: boolean } = {},
): Promise<CredentialBroker> {
  const broker = new CredentialBroker({ ...(options.onAudit ? { onAudit: options.onAudit } : {}) });
  for (const name of [...new Set(environmentNames)]) {
    if (!isCredentialEnvironmentName(name))
      throw new Error(`Refusing non-credential backend key: ${name}`);
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

/** 把环境密钥登记进 Broker；宿主可随后清理原环境，工具进程默认也会剥离这些变量。 */
export function credentialBrokerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    remove?: boolean;
    backend?: SyncSecretBackend;
    onAudit?: CredentialBrokerOptions["onAudit"];
  } = {},
): CredentialBroker {
  const broker = new CredentialBroker({ ...(options.onAudit ? { onAudit: options.onAudit } : {}) });
  if (options.backend?.listSync) {
    for (const id of options.backend.listSync()) {
      if (!id.startsWith("env:")) continue;
      const name = id.slice(4);
      if (!isCredentialEnvironmentName(name)) continue;
      broker.registerReference({
        id,
        backend: options.backend,
        scopes: credentialScopesForEnvironment(name),
      });
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (!value || !isCredentialEnvironmentName(name)) continue;
    const id = `env:${name}`;
    if (options.backend) {
      options.backend.putSync(id, value);
      broker.registerReference({
        id,
        backend: options.backend,
        scopes: credentialScopesForEnvironment(name),
      });
    } else {
      broker.register({ id, value, scopes: credentialScopesForEnvironment(name) });
    }
    if (options.remove) delete env[name];
  }
  return broker;
}
