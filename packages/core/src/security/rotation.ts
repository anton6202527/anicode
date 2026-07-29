/** 密钥轮换调度：新版本先写后端，再原子撤销旧 leases；不记录明文。 */

import type { CredentialBroker } from "./credentials.js";
import type { SecretBackend } from "./secret-backends.js";

export interface CredentialRotationPolicy {
  credentialId: string;
  backend: SecretBackend;
  backendKey?: string;
  intervalMs: number;
  issue: () => Promise<string>;
}

export interface CredentialRotationEvent {
  timestamp: string;
  credentialId: string;
  success: boolean;
  version?: number;
  error?: string;
}

export class CredentialRotationManager {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly policies = new Map<string, CredentialRotationPolicy>();
  constructor(
    private readonly broker: CredentialBroker,
    private readonly onAudit?: (event: CredentialRotationEvent) => void | Promise<void>,
  ) {}

  register(policy: CredentialRotationPolicy): void {
    if (policy.intervalMs < 60_000)
      throw new Error("Credential rotation interval must be at least 60s");
    if (this.policies.has(policy.credentialId)) {
      throw new Error(`Credential rotation is already registered: ${policy.credentialId}`);
    }
    this.policies.set(policy.credentialId, policy);
  }

  async rotateNow(credentialId: string): Promise<number> {
    const policy = this.policies.get(credentialId);
    if (!policy) throw new Error(`Unknown credential rotation policy: ${credentialId}`);
    try {
      const value = await policy.issue();
      if (!value) throw new Error("Credential issuer returned an empty value");
      const version = await this.broker.rotateBackend(
        policy.credentialId,
        policy.backend,
        value,
        policy.backendKey,
      );
      await this.onAudit?.({
        timestamp: new Date().toISOString(),
        credentialId,
        success: true,
        version,
      });
      return version;
    } catch (error) {
      await this.onAudit?.({
        timestamp: new Date().toISOString(),
        credentialId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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
