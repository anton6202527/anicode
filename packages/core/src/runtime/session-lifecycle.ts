/**
 * Durable session lifecycle fencing.
 *
 * A producer must hold an operation lease before it performs a session-scoped side effect. A
 * deleter atomically moves the lifecycle to `deleting`, which rejects new leases, then waits for
 * every previously-issued lease to be released (or to expire after its owner crashed). The
 * `deleted` tombstone is intentionally permanent: reusing a session id could otherwise let a
 * delayed producer from an older generation recreate purged content.
 */

import { randomUUID } from "node:crypto";

export type SessionLifecycleState = "active" | "deleting" | "deleted";

export interface SessionOperationLease {
  sessionId: string;
  leaseId: string;
  owner: string;
  /** Generation observed when the lease was granted. Useful for backend fencing/audit. */
  epoch: number;
  expiresAt: string;
}

export interface SessionLifecycleRecord {
  sessionId: string;
  state: SessionLifecycleState;
  epoch: number;
  /** Retained on the permanent tombstone so a restarted process can safely repair late writes. */
  workspace?: string;
  workspaceIdentity?: { device: string; inode: string };
  activeLeases: number;
  deleteOwner?: string;
  deleteToken?: string;
  deleteLeaseExpiresAt?: string;
}

export interface SessionDeletionClaim extends SessionLifecycleRecord {
  claimed: boolean;
}

export interface AcquireSessionOperationInput {
  sessionId: string;
  owner: string;
  ttlMs: number;
  workspace?: string;
  workspaceIdentity?: { device: string; inode: string };
}

export interface ClaimSessionDeletionInput {
  sessionId: string;
  owner: string;
  ttlMs: number;
  workspace?: string;
  workspaceIdentity?: { device: string; inode: string };
}

/** Shared backend contract. Every mutating method must be atomic in its implementation. */
export interface SessionLifecycleStore {
  get(sessionId: string): Promise<SessionLifecycleRecord | undefined>;
  /**
   * Bounded, stable pagination over permanent tombstones. Hosts use this as an orphan collector:
   * a producer which lost its lease may still finish a non-transactional S3/backend commit after
   * the first purge, including immediately before its process crashes.
   */
  listDeleted(input: {
    limit: number;
    afterSessionId?: string;
    workspace?: string;
  }): Promise<SessionLifecycleRecord[]>;
  acquireOperation(input: AcquireSessionOperationInput): Promise<SessionOperationLease>;
  renewOperation(lease: SessionOperationLease, ttlMs: number): Promise<boolean>;
  releaseOperation(lease: SessionOperationLease): Promise<void>;
  claimDeletion(input: ClaimSessionDeletionInput): Promise<SessionDeletionClaim>;
  renewDeletion(claim: SessionDeletionClaim, ttlMs: number): Promise<boolean>;
  completeDeletion(claim: SessionDeletionClaim): Promise<boolean>;
}

export class SessionLifecycleUnavailableError extends Error {
  readonly code = "SESSION_LIFECYCLE_UNAVAILABLE";

  constructor(
    readonly sessionId: string,
    readonly state: "deleting" | "deleted",
  ) {
    super(`Session ${sessionId} is being or has been deleted`);
    this.name = "SessionLifecycleUnavailableError";
  }
}

export class SessionLifecycleLeaseLostError extends Error {
  readonly code = "SESSION_LIFECYCLE_LEASE_LOST";

  constructor(readonly sessionId: string) {
    super(`Durable lifecycle lease for session ${sessionId} was lost`);
    this.name = "SessionLifecycleLeaseLostError";
  }
}

export function assertLifecycleId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

export function assertLifecycleTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs < 100 || ttlMs > 24 * 60 * 60 * 1_000) {
    throw new Error(`Session lifecycle lease TTL must be an integer from 100 to 86400000 ms`);
  }
}

interface MemoryLifecycleRow {
  sessionId: string;
  state: SessionLifecycleState;
  epoch: number;
  workspace?: string;
  workspaceIdentity?: { device: string; inode: string };
  deleteOwner?: string;
  deleteToken?: string;
  deleteLeaseExpiresAt?: number;
}

interface MemoryOperationRow extends SessionOperationLease {
  expiresAtMs: number;
}

/** In-memory implementation used by tests/embedded hosts; one instance is a shared backend. */
export class MemorySessionLifecycleStore implements SessionLifecycleStore {
  private readonly rows = new Map<string, MemoryLifecycleRow>();
  private readonly operations = new Map<string, MemoryOperationRow>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(sessionId: string): Promise<SessionLifecycleRecord | undefined> {
    this.validateSessionId(sessionId);
    const now = this.now();
    this.expireOperations(sessionId, now);
    const row = this.rows.get(sessionId);
    return row ? this.record(row, now) : undefined;
  }

  async listDeleted(input: {
    limit: number;
    afterSessionId?: string;
    workspace?: string;
  }): Promise<SessionLifecycleRecord[]> {
    this.validateListInput(input);
    const now = this.now();
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.state === "deleted" &&
          (input.afterSessionId === undefined || row.sessionId > input.afterSessionId) &&
          (input.workspace === undefined || row.workspace === input.workspace),
      )
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      .slice(0, input.limit)
      .map((row) => this.record(row, now));
  }

  async acquireOperation(input: AcquireSessionOperationInput): Promise<SessionOperationLease> {
    this.validateInput(input);
    const now = this.now();
    this.expireOperations(input.sessionId, now);
    let row = this.rows.get(input.sessionId);
    if (!row) {
      row = {
        sessionId: input.sessionId,
        state: "active",
        epoch: 0,
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.workspaceIdentity ? { workspaceIdentity: { ...input.workspaceIdentity } } : {}),
      };
      this.rows.set(input.sessionId, row);
    }
    if (row.state !== "active") {
      throw new SessionLifecycleUnavailableError(input.sessionId, row.state);
    }
    if (!row.workspace && input.workspace) row.workspace = input.workspace;
    this.assertWorkspace(row, input.workspace, input.workspaceIdentity);
    if (!row.workspaceIdentity && input.workspaceIdentity) {
      row.workspaceIdentity = { ...input.workspaceIdentity };
    }
    const expiresAtMs = now + input.ttlMs;
    const lease: MemoryOperationRow = {
      sessionId: input.sessionId,
      leaseId: `sop_${randomUUID()}`,
      owner: input.owner,
      epoch: row.epoch,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
    };
    this.operations.set(lease.leaseId, lease);
    return this.publicLease(lease);
  }

  async renewOperation(lease: SessionOperationLease, ttlMs: number): Promise<boolean> {
    this.validateLease(lease);
    assertLifecycleTtl(ttlMs);
    const now = this.now();
    this.expireOperations(lease.sessionId, now);
    const stored = this.operations.get(lease.leaseId);
    if (!this.sameLease(stored, lease)) return false;
    stored.expiresAtMs = now + ttlMs;
    stored.expiresAt = new Date(stored.expiresAtMs).toISOString();
    return true;
  }

  async releaseOperation(lease: SessionOperationLease): Promise<void> {
    this.validateLease(lease);
    const stored = this.operations.get(lease.leaseId);
    if (this.sameLease(stored, lease)) this.operations.delete(lease.leaseId);
  }

  async claimDeletion(input: ClaimSessionDeletionInput): Promise<SessionDeletionClaim> {
    this.validateInput(input);
    const now = this.now();
    this.expireOperations(input.sessionId, now);
    let row = this.rows.get(input.sessionId);
    if (!row) {
      row = {
        sessionId: input.sessionId,
        state: "active",
        epoch: 0,
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.workspaceIdentity ? { workspaceIdentity: { ...input.workspaceIdentity } } : {}),
      };
      this.rows.set(input.sessionId, row);
    }
    this.assertWorkspace(row, input.workspace, input.workspaceIdentity);
    if (!row.workspace && input.workspace) row.workspace = input.workspace;
    if (!row.workspaceIdentity && input.workspaceIdentity) {
      row.workspaceIdentity = { ...input.workspaceIdentity };
    }
    if (row.state === "deleted") return { ...this.record(row, now), claimed: false };
    if (row.state === "active") {
      row.state = "deleting";
      row.epoch++;
      delete row.deleteOwner;
      delete row.deleteToken;
      delete row.deleteLeaseExpiresAt;
    }
    const claimExpired = (row.deleteLeaseExpiresAt ?? 0) <= now;
    const reentrant = row.deleteOwner === input.owner && !claimExpired;
    if (claimExpired || reentrant) {
      row.deleteOwner = input.owner;
      row.deleteToken = reentrant ? row.deleteToken! : `sdel_${randomUUID()}`;
      row.deleteLeaseExpiresAt = now + input.ttlMs;
      return { ...this.record(row, now), claimed: true };
    }
    return { ...this.record(row, now), claimed: false };
  }

  async renewDeletion(claim: SessionDeletionClaim, ttlMs: number): Promise<boolean> {
    this.validateClaim(claim);
    assertLifecycleTtl(ttlMs);
    const row = this.rows.get(claim.sessionId);
    const now = this.now();
    if (
      !row ||
      row.state !== "deleting" ||
      row.deleteOwner !== claim.deleteOwner ||
      row.deleteToken !== claim.deleteToken ||
      (row.deleteLeaseExpiresAt ?? 0) <= now
    ) {
      return false;
    }
    row.deleteLeaseExpiresAt = now + ttlMs;
    return true;
  }

  async completeDeletion(claim: SessionDeletionClaim): Promise<boolean> {
    this.validateClaim(claim);
    const now = this.now();
    this.expireOperations(claim.sessionId, now);
    const row = this.rows.get(claim.sessionId);
    if (
      !row ||
      row.state !== "deleting" ||
      row.deleteOwner !== claim.deleteOwner ||
      row.deleteToken !== claim.deleteToken ||
      (row.deleteLeaseExpiresAt ?? 0) <= now ||
      this.activeLeaseCount(claim.sessionId, now) !== 0
    ) {
      return false;
    }
    row.state = "deleted";
    delete row.deleteOwner;
    delete row.deleteToken;
    delete row.deleteLeaseExpiresAt;
    return true;
  }

  private validateSessionId(sessionId: string): void {
    assertLifecycleId(sessionId, "session lifecycle id");
  }

  private validateListInput(input: {
    limit: number;
    afterSessionId?: string;
    workspace?: string;
  }): void {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new Error("Session lifecycle list limit must be an integer from 1 to 1000");
    }
    if (input.afterSessionId !== undefined) this.validateSessionId(input.afterSessionId);
    if (input.workspace !== undefined && input.workspace.length === 0) {
      throw new Error("Session lifecycle workspace must not be empty");
    }
  }

  private validateInput(input: AcquireSessionOperationInput | ClaimSessionDeletionInput): void {
    this.validateSessionId(input.sessionId);
    assertLifecycleId(input.owner, "session lifecycle owner");
    assertLifecycleTtl(input.ttlMs);
    if (input.workspace !== undefined && input.workspace.length === 0) {
      throw new Error("Session lifecycle workspace must not be empty");
    }
    if (
      input.workspaceIdentity &&
      (!input.workspaceIdentity.device || !input.workspaceIdentity.inode)
    ) {
      throw new Error("Session lifecycle workspace identity must include device and inode");
    }
  }

  private validateLease(lease: SessionOperationLease): void {
    this.validateSessionId(lease.sessionId);
    assertLifecycleId(lease.leaseId, "session operation lease id");
    assertLifecycleId(lease.owner, "session lifecycle owner");
  }

  private validateClaim(claim: SessionDeletionClaim): void {
    this.validateSessionId(claim.sessionId);
    if (!claim.deleteOwner || !claim.deleteToken) {
      throw new Error("Session deletion claim is missing its owner or token");
    }
    assertLifecycleId(claim.deleteOwner, "session lifecycle owner");
    assertLifecycleId(claim.deleteToken, "session deletion token");
  }

  private expireOperations(sessionId: string, now: number): void {
    for (const [id, lease] of this.operations) {
      if (lease.sessionId === sessionId && lease.expiresAtMs <= now) this.operations.delete(id);
    }
  }

  private activeLeaseCount(sessionId: string, now: number): number {
    let count = 0;
    for (const lease of this.operations.values()) {
      if (lease.sessionId === sessionId && lease.expiresAtMs > now) count++;
    }
    return count;
  }

  private record(row: MemoryLifecycleRow, now: number): SessionLifecycleRecord {
    return {
      sessionId: row.sessionId,
      state: row.state,
      epoch: row.epoch,
      activeLeases: this.activeLeaseCount(row.sessionId, now),
      ...(row.workspace ? { workspace: row.workspace } : {}),
      ...(row.workspaceIdentity ? { workspaceIdentity: { ...row.workspaceIdentity } } : {}),
      ...(row.deleteOwner ? { deleteOwner: row.deleteOwner } : {}),
      ...(row.deleteToken ? { deleteToken: row.deleteToken } : {}),
      ...(row.deleteLeaseExpiresAt
        ? { deleteLeaseExpiresAt: new Date(row.deleteLeaseExpiresAt).toISOString() }
        : {}),
    };
  }

  private publicLease(lease: MemoryOperationRow): SessionOperationLease {
    return {
      sessionId: lease.sessionId,
      leaseId: lease.leaseId,
      owner: lease.owner,
      epoch: lease.epoch,
      expiresAt: lease.expiresAt,
    };
  }

  private sameLease(
    stored: MemoryOperationRow | undefined,
    lease: SessionOperationLease,
  ): stored is MemoryOperationRow {
    return (
      stored !== undefined &&
      stored.sessionId === lease.sessionId &&
      stored.owner === lease.owner &&
      stored.epoch === lease.epoch
    );
  }

  private assertWorkspace(
    row: MemoryLifecycleRow,
    workspace: string | undefined,
    identity: { device: string; inode: string } | undefined,
  ): void {
    if (row.workspace && row.workspace !== workspace) {
      throw new Error(`Session ${row.sessionId} workspace lifecycle mismatch`);
    }
    if (
      row.workspaceIdentity &&
      (!identity ||
        row.workspaceIdentity.device !== identity.device ||
        row.workspaceIdentity.inode !== identity.inode)
    ) {
      throw new Error(`Session ${row.sessionId} workspace identity lifecycle mismatch`);
    }
  }
}
