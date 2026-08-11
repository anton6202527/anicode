/**
 * Chan —— 极简异步多写单读通道（Claude Code h2A 队列的同类物）。
 *
 * 用途：把「回调式的并发事件产生者」桥接成「单一 AsyncIterable 消费面」。
 * agent loop 靠它做两件事：
 *   1. 并行工具执行 —— N 个并发工具各自 push 事件，loop 端 yield* 单通道顺序消费
 *   2. 工具进度回流 —— tool.run 期间经 ctx.emit push（如 subagent 的内部事件）
 *
 * 语义：push 后立即可读（有缓冲，写端永不阻塞）；close 后读端把余量读完即结束；
 * close 后 push 静默丢弃。单读者假设 —— 不做多读者分发。
 */

export class Chan<T> implements AsyncIterable<T> {
  private buf: T[] = [];
  private head = 0;
  private closed = false;
  private wake: (() => void) | null = null;

  push(value: T): void {
    if (this.closed) return;
    this.buf.push(value);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      // Advancing an index keeps a burst of progress/streaming events O(n). Array.shift() moves
      // every remaining element and turns a large buffered burst into O(n²) work.
      while (this.head < this.buf.length) yield this.buf[this.head++]!;
      if (this.head > 0) {
        this.buf = [];
        this.head = 0;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = null;
          resolve();
        };
      });
    }
  }
}
