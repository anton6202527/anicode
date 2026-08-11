/**
 * Durable command inbox/outbox.
 *
 * Inbox 持久化“要做什么”，Runtime Event 持久化“发生过什么”；两者不能混为一谈。
 * command payload 使用独立 0600 文件保存，避免把 prompt 正文复制进审计事件。
 * Outbox 先把待发布事件落盘，再投递到 RuntimeEventStore，进程崩溃后可安全重放。
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AppendRuntimeEvent, DurableRuntime, RuntimeEvent } from "./durable.js";

export type CommandStatus = "accepted" | "running" | "completed" | "failed" | "cancelled";

export interface DurableCommand {
  id: string;
  sessionId: string;
  text: string;
  model?: string;
  traceparent?: string;
  idempotencyKey: string;
  messageCountBefore: number;
  status: CommandStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  /** 每次成功 claim 单调递增；旧 worker 即使 owner 名相同也不能提交。 */
  fencingToken?: number;
  error?: string;
}

export interface AcceptCommandInput {
  sessionId: string;
  text: string;
  model?: string;
  traceparent?: string;
  idempotencyKey?: string;
  messageCountBefore?: number;
}

export class CommandIdempotencyConflictError extends Error {
  readonly code = "COMMAND_IDEMPOTENCY_CONFLICT";

  constructor(readonly idempotencyKey: string) {
    super(
      `Durable command idempotency key ${JSON.stringify(
        idempotencyKey,
      )} was reused with a different prompt or model`,
    );
    this.name = "CommandIdempotencyConflictError";
  }
}

export interface CommandInboxStore {
  read(sessionId: string): Promise<DurableCommand[]>;
  write(sessionId: string, commands: DurableCommand[]): Promise<void>;
  transact?<T>(sessionId: string, fn: (commands: DurableCommand[]) => T | Promise<T>): Promise<T>;
  listSessions(): Promise<string[]>;
  insertCommand?(command: DurableCommand): Promise<DurableCommand>;
  claimCommand?(
    sessionId: string,
    commandId: string,
    owner: string,
    leaseMs: number,
    now: number,
  ): Promise<DurableCommand>;
  heartbeatCommand?(
    sessionId: string,
    commandId: string,
    owner: string,
    leaseMs: number,
    fencingToken?: number,
  ): Promise<void>;
  finishCommand?(
    sessionId: string,
    commandId: string,
    status: Extract<CommandStatus, "completed" | "failed" | "cancelled">,
    error?: string,
    lease?: { owner: string; fencingToken: number },
  ): Promise<void>;
  getCommand?(sessionId: string, commandId: string): Promise<DurableCommand | undefined>;
  recoverableCommands?(sessionId: string, now: number): Promise<DurableCommand[]>;
  deleteSession?(sessionId: string): Promise<void>;
}

function assertId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

function cloneCommand(command: DurableCommand): DurableCommand {
  return { ...command };
}

/**
 * An idempotency key names one immutable command payload. Returning an earlier command for a
 * different prompt/model would make retries execute data the caller did not submit and turns a
 * convenient dedupe key into a cross-request confused-deputy boundary.
 */
function assertSameCommandPayload(existing: DurableCommand, proposed: DurableCommand): void {
  if (existing.text !== proposed.text || existing.model !== proposed.model) {
    throw new CommandIdempotencyConflictError(proposed.idempotencyKey);
  }
}

export class MemoryCommandInboxStore implements CommandInboxStore {
  private readonly sessions = new Map<string, DurableCommand[]>();

  async read(sessionId: string): Promise<DurableCommand[]> {
    return (this.sessions.get(sessionId) ?? []).map(cloneCommand);
  }

  async write(sessionId: string, commands: DurableCommand[]): Promise<void> {
    this.sessions.set(sessionId, commands.map(cloneCommand));
  }

  async listSessions(): Promise<string[]> {
    return [...this.sessions.keys()].sort();
  }

  async deleteSession(sessionId: string): Promise<void> {
    assertId(sessionId, "command session id");
    this.sessions.delete(sessionId);
  }
}

/** 单进程文件 inbox；每个会话一个原子替换的私有 JSON 文档。 */
export class FileCommandInboxStore implements CommandInboxStore {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(readonly root: string) {}

  private file(sessionId: string): string {
    assertId(sessionId, "command session id");
    return path.join(this.root, `${sessionId}.json`);
  }

  async read(sessionId: string): Promise<DurableCommand[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(sessionId), "utf8")) as {
        version?: number;
        commands?: DurableCommand[];
      };
      return parsed.version === 1 && Array.isArray(parsed.commands)
        ? parsed.commands.map(cloneCommand)
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async write(sessionId: string, commands: DurableCommand[]): Promise<void> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
        await fs.chmod(this.root, 0o700);
        const target = this.file(sessionId);
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify({ version: 1, commands }, null, 2) + "\n", {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
          });
          // Windows requires write access on a handle passed to FlushFileBuffers/FileHandle.sync.
          const handle = await fs.open(temporary, "r+");
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
          await fs.rename(temporary, target);
          await fs.chmod(target, 0o600);
        } finally {
          await fs.rm(temporary, { force: true });
        }
      });
    this.tails.set(sessionId, current);
    const cleanup = () => {
      if (this.tails.get(sessionId) === current) this.tails.delete(sessionId);
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  async listSessions(): Promise<string[]> {
    try {
      return (await fs.readdir(this.root))
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -5))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => fs.rm(this.file(sessionId), { force: true }));
    this.tails.set(sessionId, current);
    try {
      await current;
    } finally {
      if (this.tails.get(sessionId) === current) this.tails.delete(sessionId);
    }
  }
}

export class CommandInbox {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(readonly store: CommandInboxStore = new MemoryCommandInboxStore()) {}

  private transact<T>(
    sessionId: string,
    fn: (commands: DurableCommand[]) => Promise<T>,
  ): Promise<T> {
    assertId(sessionId, "command session id");
    if (this.store.transact) return this.store.transact(sessionId, fn);
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const commands = await this.store.read(sessionId);
        const result = await fn(commands);
        await this.store.write(sessionId, commands);
        return result;
      });
    this.locks.set(sessionId, current);
    const cleanup = () => {
      if (this.locks.get(sessionId) === current) this.locks.delete(sessionId);
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  accept(input: AcceptCommandInput): Promise<DurableCommand> {
    const key = input.idempotencyKey ?? `cmd:${randomUUID()}`;
    const now = new Date().toISOString();
    const proposed: DurableCommand = {
      id: `cmd_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      sessionId: input.sessionId,
      text: input.text,
      ...(input.model ? { model: input.model } : {}),
      ...(input.traceparent ? { traceparent: input.traceparent } : {}),
      idempotencyKey: key,
      messageCountBefore: Math.max(0, Math.floor(input.messageCountBefore ?? 0)),
      status: "accepted",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (this.store.insertCommand) return this.store.insertCommand(proposed);
    return this.transact(input.sessionId, async (commands) => {
      const duplicate = commands.find((command) => command.idempotencyKey === key);
      if (duplicate) {
        assertSameCommandPayload(duplicate, proposed);
        return cloneCommand(duplicate);
      }
      commands.push(proposed);
      return cloneCommand(proposed);
    });
  }

  claim(
    sessionId: string,
    commandId: string,
    owner: string,
    leaseMs = 60_000,
    now = Date.now(),
  ): Promise<DurableCommand> {
    if (this.store.claimCommand) {
      return this.store.claimCommand(sessionId, commandId, owner, leaseMs, now);
    }
    return this.transact(sessionId, async (commands) => {
      const command = commands.find((candidate) => candidate.id === commandId);
      if (!command) throw new Error(`Unknown durable command: ${commandId}`);
      const leaseActive =
        command.leaseExpiresAt !== undefined && Date.parse(command.leaseExpiresAt) > now;
      if (command.status === "running" && leaseActive) {
        throw new Error(`Durable command ${commandId} is leased by ${command.leaseOwner}`);
      }
      if (!["accepted", "running"].includes(command.status)) {
        throw new Error(`Durable command ${commandId} is already ${command.status}`);
      }
      command.status = "running";
      command.attempts++;
      command.fencingToken = (command.fencingToken ?? 0) + 1;
      command.leaseOwner = owner;
      command.leaseExpiresAt = new Date(now + Math.max(1_000, leaseMs)).toISOString();
      command.updatedAt = new Date(now).toISOString();
      return cloneCommand(command);
    });
  }

  heartbeat(
    sessionId: string,
    commandId: string,
    owner: string,
    leaseMs = 60_000,
    fencingToken?: number,
  ): Promise<void> {
    if (this.store.heartbeatCommand) {
      return this.store.heartbeatCommand(sessionId, commandId, owner, leaseMs, fencingToken);
    }
    return this.transact(sessionId, async (commands) => {
      const command = commands.find((candidate) => candidate.id === commandId);
      if (!command || command.status !== "running" || command.leaseOwner !== owner) {
        throw new Error(`Cannot heartbeat unowned command ${commandId}`);
      }
      if (fencingToken !== undefined && command.fencingToken !== fencingToken) {
        throw new Error(`Stale fencing token for command ${commandId}`);
      }
      if (!command.leaseExpiresAt || Date.parse(command.leaseExpiresAt) <= Date.now()) {
        throw new Error(`Expired lease for command ${commandId}`);
      }
      command.leaseExpiresAt = new Date(Date.now() + Math.max(1_000, leaseMs)).toISOString();
      command.updatedAt = new Date().toISOString();
    });
  }

  finish(
    sessionId: string,
    commandId: string,
    status: Extract<CommandStatus, "completed" | "failed" | "cancelled">,
    error?: string,
    lease?: { owner: string; fencingToken: number },
  ): Promise<void> {
    if (this.store.finishCommand) {
      return this.store.finishCommand(sessionId, commandId, status, error, lease);
    }
    return this.transact(sessionId, async (commands) => {
      const command = commands.find((candidate) => candidate.id === commandId);
      if (!command) throw new Error(`Unknown durable command: ${commandId}`);
      if (["completed", "failed", "cancelled"].includes(command.status)) {
        if (!lease && command.status === status && command.error === (error || undefined)) return;
        throw new Error(`Durable command ${commandId} is already ${command.status}`);
      }
      if (
        lease &&
        (command.leaseOwner !== lease.owner ||
          command.fencingToken !== lease.fencingToken ||
          !command.leaseExpiresAt ||
          Date.parse(command.leaseExpiresAt) <= Date.now())
      ) {
        throw new Error(`Stale fencing token for command ${commandId}`);
      }
      command.status = status;
      command.updatedAt = new Date().toISOString();
      delete command.leaseOwner;
      delete command.leaseExpiresAt;
      if (error) command.error = error;
      else delete command.error;
    });
  }

  async get(sessionId: string, commandId: string): Promise<DurableCommand | undefined> {
    if (this.store.getCommand) return this.store.getCommand(sessionId, commandId);
    return (await this.store.read(sessionId)).find((command) => command.id === commandId);
  }

  async recoverable(sessionId: string, now = Date.now()): Promise<DurableCommand[]> {
    if (this.store.recoverableCommands) return this.store.recoverableCommands(sessionId, now);
    return (await this.store.read(sessionId)).filter(
      (command) =>
        command.status === "accepted" ||
        (command.status === "running" &&
          (!command.leaseExpiresAt || Date.parse(command.leaseExpiresAt) <= now)),
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    assertId(sessionId, "command session id");
    if (this.store.deleteSession) {
      await this.store.deleteSession(sessionId);
      return;
    }
    await this.transact(sessionId, async (commands) => {
      commands.length = 0;
    });
  }
}

export type OutboxStatus = "pending" | "sent";

export interface OutboxMessage {
  id: string;
  status: OutboxStatus;
  event: AppendRuntimeEvent;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  sentEventId?: string;
  error?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  fencingToken?: number;
}

export interface OutboxStore {
  read(): Promise<OutboxMessage[]>;
  write(messages: OutboxMessage[]): Promise<void>;
  transact?<T>(fn: (messages: OutboxMessage[]) => T | Promise<T>): Promise<T>;
  insertMessage?(message: OutboxMessage): Promise<OutboxMessage>;
  claimMessage?(owner: string, leaseMs: number): Promise<OutboxMessage | undefined>;
  markSent?(message: OutboxMessage, owner: string, sentEventId: string): Promise<void>;
  markFailed?(message: OutboxMessage, owner: string, error: string): Promise<void>;
  getMessage?(id: string): Promise<OutboxMessage | undefined>;
  pendingMessages?(): Promise<OutboxMessage[]>;
}

export class MemoryOutboxStore implements OutboxStore {
  private messages: OutboxMessage[] = [];
  async read(): Promise<OutboxMessage[]> {
    return this.messages.map((message) => ({ ...message, event: { ...message.event } }));
  }
  async write(messages: OutboxMessage[]): Promise<void> {
    this.messages = messages.map((message) => ({ ...message, event: { ...message.event } }));
  }
}

export class FileOutboxStore implements OutboxStore {
  constructor(readonly file: string) {}

  async read(): Promise<OutboxMessage[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as {
        version?: number;
        messages?: OutboxMessage[];
      };
      return parsed.version === 1 && Array.isArray(parsed.messages) ? parsed.messages : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async write(messages: OutboxMessage[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.file), 0o700);
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, messages }, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      // Windows requires write access on a handle passed to FlushFileBuffers/FileHandle.sync.
      const handle = await fs.open(temporary, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, this.file);
      await fs.chmod(this.file, 0o600);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

/** Transactional-outbox 语义：enqueue 落盘成功后才尝试发布，发布依靠 event 幂等键去重。 */
export class DurableOutbox {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly owner = `outbox-${process.pid}-${randomUUID()}`;

  constructor(
    readonly store: OutboxStore,
    readonly runtime: DurableRuntime,
  ) {}

  private transact<T>(fn: (messages: OutboxMessage[]) => Promise<T>): Promise<T> {
    if (this.store.transact) return this.store.transact(fn);
    const current = this.tail
      .catch(() => undefined)
      .then(async () => {
        const messages = await this.store.read();
        const result = await fn(messages);
        await this.store.write(messages);
        return result;
      });
    this.tail = current;
    return current;
  }

  async enqueue(event: AppendRuntimeEvent): Promise<OutboxMessage> {
    const stableEvent = {
      ...event,
      idempotencyKey: event.idempotencyKey ?? `outbox:${randomUUID()}`,
    };
    const now = new Date().toISOString();
    const proposed: OutboxMessage = {
      id: `out_${randomUUID()}`,
      status: "pending",
      event: stableEvent,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (this.store.insertMessage) return this.store.insertMessage(proposed);
    return this.transact(async (messages) => {
      const duplicate = messages.find(
        (message) => message.event.idempotencyKey === stableEvent.idempotencyKey,
      );
      if (duplicate) return { ...duplicate, event: { ...duplicate.event } };
      messages.push(proposed);
      return { ...proposed, event: { ...proposed.event } };
    });
  }

  async flush(limit = 100): Promise<RuntimeEvent[]> {
    const published: RuntimeEvent[] = [];
    // 每条投递后立即持久化 ack，避免一个大批次末尾崩溃导致全部重发；重发本身也幂等。
    for (;;) {
      const pending = this.store.claimMessage
        ? await this.store.claimMessage(this.owner, 60_000)
        : (await this.store.read()).find((message) => message.status === "pending");
      if (!pending || published.length >= limit) break;
      try {
        const event = await this.runtime.record(pending.event);
        if (this.store.markSent) await this.store.markSent(pending, this.owner, event.id);
        else
          await this.transact(async (messages) => {
            const current = messages.find((message) => message.id === pending.id);
            if (!current) return;
            current.status = "sent";
            current.sentEventId = event.id;
            current.attempts++;
            current.updatedAt = new Date().toISOString();
            delete current.error;
          });
        published.push(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.store.markFailed) await this.store.markFailed(pending, this.owner, message);
        else
          await this.transact(async (messages) => {
            const current = messages.find((candidate) => candidate.id === pending.id);
            if (!current) return;
            current.attempts++;
            current.error = message;
            current.updatedAt = new Date().toISOString();
          });
        throw error;
      }
    }
    return published;
  }

  async publish(event: AppendRuntimeEvent): Promise<RuntimeEvent> {
    const message = await this.enqueue(event);
    const events = await this.flush();
    const published = events.find(
      (candidate) => candidate.idempotencyKey === message.event.idempotencyKey,
    );
    if (published) return published;
    const sent = this.store.getMessage
      ? await this.store.getMessage(message.id)
      : (await this.store.read()).find((candidate) => candidate.id === message.id);
    if (!sent?.sentEventId) throw new Error(`Outbox message ${message.id} was not published`);
    const existing = (await this.runtime.events(message.event.streamId)).find(
      (candidate) => candidate.id === sent.sentEventId,
    );
    if (!existing) throw new Error(`Published runtime event ${sent.sentEventId} is missing`);
    return existing;
  }

  async pending(): Promise<OutboxMessage[]> {
    if (this.store.pendingMessages) return this.store.pendingMessages();
    return (await this.store.read()).filter((message) => message.status === "pending");
  }

  async deleteStream(streamId: string): Promise<void> {
    await this.transact(async (messages) => {
      for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]!.event.streamId === streamId) messages.splice(index, 1);
      }
    });
  }
}
