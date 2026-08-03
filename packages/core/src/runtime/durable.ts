/** Durable Runtime v2：append-only 事件是恢复与审计的事实源。 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { MemorySessionLifecycleStore, type SessionLifecycleStore } from "./session-lifecycle.js";

export interface RuntimeEvent<T = unknown> {
  id: string;
  version: 2;
  streamId: string;
  sequence: number;
  timestamp: string;
  type: string;
  data: T;
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
  traceId?: string;
  spanId?: string;
}

export interface AppendRuntimeEvent<T = unknown> {
  streamId: string;
  type: string;
  data: T;
  expectedSequence?: number;
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
  traceId?: string;
  spanId?: string;
}

export interface RuntimeEventStore {
  /** Shared lifecycle backend colocated with event persistence when available. */
  readonly lifecycle?: SessionLifecycleStore;
  append<T>(input: AppendRuntimeEvent<T>): Promise<RuntimeEvent<T>>;
  read(streamId: string, afterSequence?: number): Promise<RuntimeEvent[]>;
  listStreams(): Promise<string[]>;
  delete(streamId: string): Promise<void>;
}

function assertStreamId(streamId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(streamId)) {
    throw new Error(`Invalid runtime stream id: ${JSON.stringify(streamId)}`);
  }
}

function makeEvent<T>(input: AppendRuntimeEvent<T>, sequence: number): RuntimeEvent<T> {
  return {
    id: `rte_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    version: 2,
    streamId: input.streamId,
    sequence,
    timestamp: new Date().toISOString(),
    type: input.type,
    data: input.data,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.causationId ? { causationId: input.causationId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.spanId ? { spanId: input.spanId } : {}),
  };
}

export class MemoryRuntimeEventStore implements RuntimeEventStore {
  private streams = new Map<string, RuntimeEvent[]>();
  readonly lifecycle = new MemorySessionLifecycleStore();

  async append<T>(input: AppendRuntimeEvent<T>): Promise<RuntimeEvent<T>> {
    assertStreamId(input.streamId);
    const events = this.streams.get(input.streamId) ?? [];
    if (input.idempotencyKey) {
      const duplicate = events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (duplicate) return duplicate as RuntimeEvent<T>;
    }
    const current = events.at(-1)?.sequence ?? 0;
    if (input.expectedSequence !== undefined && input.expectedSequence !== current) {
      throw new Error(
        `Runtime stream ${input.streamId} version conflict: expected ${input.expectedSequence}, actual ${current}`,
      );
    }
    const event = makeEvent(input, current + 1);
    events.push(event);
    this.streams.set(input.streamId, events);
    return event;
  }

  async read(streamId: string, afterSequence = 0): Promise<RuntimeEvent[]> {
    assertStreamId(streamId);
    return (this.streams.get(streamId) ?? []).filter((event) => event.sequence > afterSequence);
  }

  async listStreams(): Promise<string[]> {
    return [...this.streams.keys()].sort();
  }

  async delete(streamId: string): Promise<void> {
    assertStreamId(streamId);
    this.streams.delete(streamId);
  }
}

/** 单进程文件事件库；同一 stream 的 append 串行化并 fsync 后才确认。 */
export class FileRuntimeEventStore implements RuntimeEventStore {
  private tails = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  private file(streamId: string): string {
    assertStreamId(streamId);
    return path.join(this.root, `${streamId}.jsonl`);
  }

  private withStreamLock<T>(streamId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(streamId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.tails.set(streamId, current);
    const cleanup = () => {
      if (this.tails.get(streamId) === current) this.tails.delete(streamId);
    };
    // finally() 会创建一个继承 rejection 的新 Promise；若仅 void 丢弃会形成
    // unhandled rejection。双分支 then 只做清理，并显式吞掉清理链结果。
    void current.then(cleanup, cleanup);
    return current;
  }

  async append<T>(input: AppendRuntimeEvent<T>): Promise<RuntimeEvent<T>> {
    return this.withStreamLock(input.streamId, async () => {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      await fs.chmod(this.root, 0o700);
      const events = await this.read(input.streamId);
      if (input.idempotencyKey) {
        const duplicate = events.find((event) => event.idempotencyKey === input.idempotencyKey);
        if (duplicate) return duplicate as RuntimeEvent<T>;
      }
      const current = events.at(-1)?.sequence ?? 0;
      if (input.expectedSequence !== undefined && input.expectedSequence !== current) {
        throw new Error(
          `Runtime stream ${input.streamId} version conflict: expected ${input.expectedSequence}, actual ${current}`,
        );
      }
      const event = makeEvent(input, current + 1);
      const handle = await fs.open(this.file(input.streamId), "a", 0o600);
      try {
        await handle.writeFile(JSON.stringify(event) + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.chmod(this.file(input.streamId), 0o600);
      return event;
    });
  }

  async read(streamId: string, afterSequence = 0): Promise<RuntimeEvent[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file(streamId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: RuntimeEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as RuntimeEvent;
        if (event.version === 2 && event.streamId === streamId && event.sequence > afterSequence) {
          events.push(event);
        }
      } catch {
        // 崩溃可能只留下最后一条半行；以前的完整事件仍可恢复。
      }
    }
    return events.sort((a, b) => a.sequence - b.sequence);
  }

  async listStreams(): Promise<string[]> {
    try {
      return (await fs.readdir(this.root))
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => name.slice(0, -6))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async delete(streamId: string): Promise<void> {
    assertStreamId(streamId);
    await this.withStreamLock(streamId, () => fs.rm(this.file(streamId), { force: true }));
  }
}

export interface RecoveredRuntimeState {
  streamId: string;
  sequence: number;
  phase:
    "idle" | "queued" | "running" | "waiting_permission" | "completed" | "failed" | "cancelled";
  activeTools: string[];
  lastError?: string;
  events: number;
}

export interface RuntimeSnapshot extends RecoveredRuntimeState {
  version: 1;
  createdAt: string;
}

export interface RuntimeSnapshotStore {
  get(streamId: string): Promise<RuntimeSnapshot | undefined>;
  put(snapshot: RuntimeSnapshot): Promise<void>;
  delete(streamId: string): Promise<void>;
}

export class MemoryRuntimeSnapshotStore implements RuntimeSnapshotStore {
  private readonly snapshots = new Map<string, RuntimeSnapshot>();
  async get(streamId: string): Promise<RuntimeSnapshot | undefined> {
    const snapshot = this.snapshots.get(streamId);
    return snapshot ? { ...snapshot, activeTools: [...snapshot.activeTools] } : undefined;
  }
  async put(snapshot: RuntimeSnapshot): Promise<void> {
    this.snapshots.set(snapshot.streamId, { ...snapshot, activeTools: [...snapshot.activeTools] });
  }
  async delete(streamId: string): Promise<void> {
    this.snapshots.delete(streamId);
  }
}

export class FileRuntimeSnapshotStore implements RuntimeSnapshotStore {
  constructor(readonly root: string) {}

  private file(streamId: string): string {
    assertStreamId(streamId);
    return path.join(this.root, `${streamId}.json`);
  }

  async get(streamId: string): Promise<RuntimeSnapshot | undefined> {
    try {
      const snapshot = JSON.parse(
        await fs.readFile(this.file(streamId), "utf8"),
      ) as RuntimeSnapshot;
      return snapshot.version === 1 && snapshot.streamId === streamId ? snapshot : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // snapshot 是加速投影，不是事实源；损坏时丢弃并从 event log 重放。
      return undefined;
    }
  }

  async put(snapshot: RuntimeSnapshot): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);
    const target = this.file(snapshot.streamId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(snapshot) + "\n", {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async delete(streamId: string): Promise<void> {
    await fs.rm(this.file(streamId), { force: true });
  }
}

function projectRuntimeEvents(
  streamId: string,
  events: RuntimeEvent[],
  base?: RecoveredRuntimeState,
): RecoveredRuntimeState {
  const activeTools = new Set(base?.activeTools ?? []);
  let phase: RecoveredRuntimeState["phase"] = base?.phase ?? "idle";
  let lastError = base?.lastError;
  for (const event of events) {
    const data = event.data as Record<string, unknown>;
    if (event.type === "prompt.accepted") phase = "queued";
    else if (event.type === "prompt.recovered") phase = "queued";
    else if (event.type === "session.state") {
      if (data["running"]) phase = "running";
      else if (phase !== "failed" && phase !== "cancelled" && phase !== "completed") phase = "idle";
    } else if (event.type === "permission.requested") phase = "waiting_permission";
    else if (event.type === "tool.started") activeTools.add(String(data["id"] ?? ""));
    else if (event.type === "tool.completed" || event.type === "tool.interrupted")
      activeTools.delete(String(data["id"] ?? ""));
    else if (event.type === "agent.failed") {
      phase = "failed";
      lastError = String(data["error"] ?? "unknown error");
    } else if (event.type === "prompt.completed") {
      if (phase !== "failed" && phase !== "cancelled") phase = "completed";
      lastError = undefined;
    } else if (event.type === "prompt.cancelled") phase = "cancelled";
    else if (event.type === "prompt.failed") {
      phase = "failed";
      lastError = String(data["error"] ?? "unknown error");
    }
  }
  return {
    streamId,
    sequence: events.at(-1)?.sequence ?? base?.sequence ?? 0,
    phase,
    activeTools: [...activeTools].filter(Boolean),
    ...(lastError ? { lastError } : {}),
    events: (base?.events ?? 0) + events.length,
  };
}

export class DurableRuntime {
  readonly lifecycle: SessionLifecycleStore;

  constructor(
    readonly store: RuntimeEventStore,
    readonly snapshots?: RuntimeSnapshotStore,
    readonly snapshotEvery = 50,
    lifecycle?: SessionLifecycleStore,
  ) {
    this.lifecycle = lifecycle ?? store.lifecycle ?? new MemorySessionLifecycleStore();
  }

  async record<T>(input: AppendRuntimeEvent<T>): Promise<RuntimeEvent<T>> {
    const event = await this.store.append(input);
    if (
      this.snapshots &&
      (event.sequence % Math.max(1, this.snapshotEvery) === 0 ||
        ["prompt.completed", "prompt.failed", "prompt.cancelled"].includes(event.type))
    ) {
      await this.writeSnapshot(input.streamId);
    }
    return event;
  }

  events(streamId: string, afterSequence = 0): Promise<RuntimeEvent[]> {
    return this.store.read(streamId, afterSequence);
  }

  async recover(streamId: string): Promise<RecoveredRuntimeState> {
    const snapshot = await this.snapshots?.get(streamId);
    const events = await this.store.read(streamId, snapshot?.sequence ?? 0);
    return projectRuntimeEvents(streamId, events, snapshot);
  }

  async writeSnapshot(streamId: string): Promise<RuntimeSnapshot | undefined> {
    if (!this.snapshots) return undefined;
    const previous = await this.snapshots.get(streamId);
    const events = await this.store.read(streamId, previous?.sequence ?? 0);
    const state = projectRuntimeEvents(streamId, events, previous);
    const snapshot: RuntimeSnapshot = {
      version: 1,
      createdAt: new Date().toISOString(),
      ...state,
    };
    await this.snapshots.put(snapshot);
    return snapshot;
  }

  async deleteStream(streamId: string): Promise<void> {
    await this.snapshots?.delete(streamId);
    await this.store.delete(streamId);
  }

  /**
   * 启动恢复时封口崩溃留下的 tool.started，保证每个 tool call 都有确定性终态；
   * 实际命令是否续跑由 CommandInbox 决定。
   */
  async reconcileInterrupted(streamId: string): Promise<RecoveredRuntimeState> {
    const state = await this.recover(streamId);
    for (const id of state.activeTools) {
      await this.record({
        streamId,
        type: "tool.interrupted",
        data: { id, reason: "runtime restarted before tool completion" },
        idempotencyKey: `recovery:tool.interrupted:${id}`,
      });
    }
    return this.recover(streamId);
  }
}
