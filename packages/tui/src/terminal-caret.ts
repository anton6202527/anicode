export interface TerminalCaretTarget {
  /** Absolute terminal row, one-based. */
  row: number;
  /** Absolute terminal column, one-based. */
  col: number;
}

export interface TerminalCaretController {
  readonly enabled: boolean;
  setTarget(target: TerminalCaretTarget | null): void;
  pause(): void;
  resume(): void;
  dispose(): void;
}

const BEGIN_SYNCHRONIZED_UPDATE = "\x1b[?2026h";
const END_SYNCHRONIZED_UPDATE = "\x1b[?2026l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
export const RESET_FULLSCREEN_VIEWPORT = "\x1b[r\x1b[2J\x1b[3J\x1b[H";

function chunkText(chunk: unknown): string | undefined {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  return undefined;
}

/** Remove terminal control sequences while retaining printable cells and newlines. */
function renderPayload(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

/**
 * Wrap only the stream handed to Ink (never global process.stdout.write). Before Ink writes a
 * frame, return the real cursor to the bottom row that its diff renderer expects; afterwards,
 * park it at an absolute viewport cell for IME anchoring. Absolute CUP avoids the fullscreen
 * relative-cursor ambiguity that differs between terminal emulators.
 */
export function createTerminalCaretOutput(
  output: NodeJS.WriteStream,
  options: { enabled?: boolean; resetOnResize?: boolean } = {},
): { output: NodeJS.WriteStream; controller: TerminalCaretController } {
  const enabled = (options.enabled ?? true) && output.isTTY === true;
  const resetOnResize = options.resetOnResize === true && output.isTTY === true;
  const originalWrite = output.write.bind(output) as (...args: unknown[]) => boolean;
  let target: TerminalCaretTarget | null = null;
  let parked = false;
  let paused = false;
  let disposed = false;
  let synchronizedUpdate = false;
  let resizeResetPending = false;

  const rows = () => Math.max(1, output.rows || 24);
  const columns = () => Math.max(1, output.columns || 80);
  // Ink's diff starts from the bottom of its previous logical frame, which is not necessarily
  // the terminal's new bottom while a resize is being processed.
  let frameBottomRow = rows();
  const cup = (row: number, col: number) => `\x1b[${row};${col}H`;
  const normalizedTarget = (): TerminalCaretTarget | null => {
    if (!target) return null;
    return {
      row: Math.max(1, Math.min(rows(), target.row)),
      col: Math.max(1, Math.min(columns(), target.col)),
    };
  };
  const returnToInkOrigin = () => {
    if (!enabled || !parked || disposed) return;
    originalWrite(`${HIDE_CURSOR}${cup(Math.min(rows(), frameBottomRow), 1)}`);
    parked = false;
  };
  const park = () => {
    if (!enabled || paused || disposed || resizeResetPending || synchronizedUpdate) return;
    const next = normalizedTarget();
    if (!next) return;
    originalWrite(`${cup(next.row, next.col)}${SHOW_CURSOR}`);
    parked = true;
  };

  const onResize = () => {
    if (disposed) return;
    // The TTY dimensions have already changed when `resize` fires. Return to the bottom of the
    // old logical frame before Ink's earlier-registered diff renderer observes the new size.
    returnToInkOrigin();
    frameBottomRow = Math.min(frameBottomRow, rows());
    if (resetOnResize) resizeResetPending = true;
  };
  if (enabled || resetOnResize) output.on("resize", onResize);

  const write = ((chunk: unknown, ...args: unknown[]) => {
    const text = chunkText(chunk);
    const beginsSynchronizedUpdate = text === BEGIN_SYNCHRONIZED_UPDATE;
    const endsSynchronizedUpdate = text === END_SYNCHRONIZED_UPDATE;
    const printable = text === undefined ? "" : renderPayload(text);
    const writesFrame =
      text !== undefined &&
      text !== BEGIN_SYNCHRONIZED_UPDATE &&
      text !== END_SYNCHRONIZED_UPDATE &&
      text !== HIDE_CURSOR &&
      text !== SHOW_CURSOR &&
      printable.length > 0;

    if (!synchronizedUpdate || beginsSynchronizedUpdate) returnToInkOrigin();
    if (beginsSynchronizedUpdate) synchronizedUpdate = true;

    // Reset and paint remain inside Ink's synchronized-output transaction. A full reset paired
    // with an incremental diff would omit unchanged rows, so the CLI deliberately uses complete
    // frames (incrementalRendering=false).
    const resetsViewport = writesFrame && resizeResetPending;
    if (resetsViewport) {
      originalWrite(RESET_FULLSCREEN_VIEWPORT);
      resizeResetPending = false;
    }
    const result = originalWrite(chunk, ...args);

    if (writesFrame && text !== undefined) {
      const newlineCount = text.length - text.replaceAll("\n", "").length;
      if (newlineCount > 0) {
        frameBottomRow = Math.max(1, Math.min(rows(), newlineCount + 1));
      } else if (resetsViewport) {
        frameBottomRow = rows();
      }
    }
    if (endsSynchronizedUpdate) synchronizedUpdate = false;
    if (!synchronizedUpdate && !resizeResetPending) park();
    return result;
  }) as NodeJS.WriteStream["write"];

  const controller: TerminalCaretController = {
    enabled,
    setTarget(next) {
      if (disposed) return;
      target = next;
      if (!next) {
        returnToInkOrigin();
        return;
      }
      // Layout effects run after Ink committed the frame, so an absolute park is immediately safe.
      park();
    },
    pause() {
      if (disposed || paused) return;
      returnToInkOrigin();
      paused = true;
    },
    resume() {
      if (disposed || !paused) return;
      paused = false;
      park();
    },
    dispose() {
      if (disposed) return;
      returnToInkOrigin();
      if (enabled || resetOnResize) output.off("resize", onResize);
      target = null;
      paused = true;
      disposed = true;
    },
  };

  const proxy = new Proxy(output, {
    get(stream, property) {
      if (property === "write") return write;
      const value = Reflect.get(stream, property, stream) as unknown;
      return typeof value === "function" ? value.bind(stream) : value;
    },
  });
  return { output: proxy, controller };
}
