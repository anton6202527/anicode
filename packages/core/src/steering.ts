/**
 * SteeringInbox —— steering 输入与后台任务完成通知的显式状态机（架构 v2 的 R6，
 * 见 docs/architecture-v2.md §2.5；对应 codex-rs 的 session/input_queue + inject）。
 *
 * v1 用五个散落字段（queued / noticeQueue / pendingTaskNotices /
 * acceptingQueuedInput / onTaskNotice 回调）隐式表达这台状态机；v2 把它显式化，
 * 时序不变量集中在一处：
 *
 * - 接收窗口：drive 中主输入正式进入历史后才开（open），done/error/中断即关。
 *   窗口开着蕴含 Agent 正在运行（open 只会在 drive 内被调用）。
 * - clear 必须先同步关窗、再清队列：interrupt 随后的 abort 可能同步触发外部回调，
 *   回调中新到的消息必须进入下一 drive，不能重新塞进即将终止的本轮。
 * - 任务通知三级投递：运行中且窗口开 → 通知队列（最近的 turn 边界注入，模型当轮
 *   即可处理）；空闲且宿主给了出口 → onIdle（SessionManager 用它自动发起新 drive）；
 *   兜底 → 积压，下一次 send 开始时经 promotePending 注入。
 */

export interface SteeringInboxLimits {
  maxQueuedInputs?: number;
  maxQueuedBytes?: number;
  maxInputBytes?: number;
}

const DEFAULT_MAX_QUEUED_INPUTS = 128;
const DEFAULT_MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 8 * 1024 * 1024;

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return candidate;
}

export class SteeringInbox {
  private accepting = false;
  /** steering：运行中追加的用户输入，turn 边界注入。 */
  private queuedInputs: string[] = [];
  private queuedInputBytes = 0;
  /** drive 运行中到达的任务完成通知：turn 边界作为 internal user 注入。 */
  private notices: string[] = [];
  /** 空闲时到达且无 onIdle 出口的通知：下一次 send 开始时注入。 */
  private pending: string[] = [];

  private readonly maxQueuedInputs: number;
  private readonly maxQueuedBytes: number;
  private readonly maxInputBytes: number;

  constructor(
    private readonly onIdle?: (text: string) => void,
    limits: SteeringInboxLimits = {},
  ) {
    this.maxQueuedInputs = positiveLimit(
      limits.maxQueuedInputs,
      DEFAULT_MAX_QUEUED_INPUTS,
      "maxQueuedInputs",
    );
    this.maxQueuedBytes = positiveLimit(
      limits.maxQueuedBytes,
      DEFAULT_MAX_QUEUED_BYTES,
      "maxQueuedBytes",
    );
    this.maxInputBytes = positiveLimit(
      limits.maxInputBytes,
      DEFAULT_MAX_INPUT_BYTES,
      "maxInputBytes",
    );
  }

  // ---------- 接收窗口 ----------

  get isAccepting(): boolean {
    return this.accepting;
  }

  /**
   * 主输入正式进入历史后开窗。interrupt 可能已发生在异步 hook / 持久化期间，
   * 故由调用方传入 `!signal.aborted` —— closing 不得重新回到 active。
   */
  open(accepting: boolean): void {
    this.accepting = accepting;
  }

  close(): void {
    this.accepting = false;
  }

  // ---------- steering ----------

  /** 追加一条 steering 输入。窗口关着返回 false（调用方应把消息排到下一次 send）。 */
  enqueue(text: string): boolean {
    if (!this.accepting) return false;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > this.maxInputBytes) {
      throw new Error(`Steering input exceeds ${this.maxInputBytes} bytes`);
    }
    if (
      this.queuedInputs.length >= this.maxQueuedInputs ||
      this.queuedInputBytes + bytes > this.maxQueuedBytes
    ) {
      throw new Error(
        `Steering queue capacity exceeded (${this.maxQueuedInputs} inputs / ${this.maxQueuedBytes} bytes)`,
      );
    }
    this.queuedInputs.push(text);
    this.queuedInputBytes += bytes;
    return true;
  }

  /** 中断清空：先同步关窗，再清队列（时序不变量，见文件头）。返回被清掉的数量。 */
  clear(): number {
    this.accepting = false;
    const count = this.queuedInputs.length;
    this.queuedInputs = [];
    this.queuedInputBytes = 0;
    return count;
  }

  hasQueued(): boolean {
    return this.queuedInputs.length > 0;
  }

  get queuedCount(): number {
    return this.queuedInputs.length;
  }

  shiftQueued(): string | undefined {
    const value = this.queuedInputs.shift();
    if (value !== undefined) this.queuedInputBytes -= Buffer.byteLength(value, "utf8");
    return value;
  }

  // ---------- 任务通知（三级投递） ----------

  deliverNotice(text: string, running: boolean): void {
    if (running && this.accepting) {
      this.notices.push(text);
      return;
    }
    if (this.onIdle) {
      this.onIdle(text);
      return;
    }
    this.pending.push(text);
  }

  /**
   * Recovery-only path: retain a notice for the next drive without invoking onIdle while the host
   * is still constructing and has not yet registered the live session.
   */
  holdNotice(text: string): void {
    this.pending.push(text);
  }

  hasNotices(): boolean {
    return this.notices.length > 0;
  }

  shiftNotice(): string | undefined {
    return this.notices.shift();
  }

  /** send 开头：上一轮空闲期积压的通知并入本轮通知队列。返回是否有并入。 */
  promotePending(): boolean {
    if (this.pending.length === 0) return false;
    this.notices.unshift(...this.pending);
    this.pending = [];
    return true;
  }

  /** send 收尾：没赶上 turn 边界的通知改走空闲投递（onIdle 回调或积压）。 */
  flushLeftover(): void {
    const leftover = this.notices;
    this.notices = [];
    for (const text of leftover) this.deliverNotice(text, false);
  }
}
