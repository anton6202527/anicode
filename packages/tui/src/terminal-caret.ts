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

/**
 * Wrap only the stream handed to Ink (never global process.stdout.write). Before Ink writes a
 * frame, return the real cursor to the bottom row that its diff renderer expects; afterwards,
 * park it at an absolute viewport cell for IME anchoring. Absolute CUP avoids the fullscreen
 * relative-cursor ambiguity that differs between terminal emulators.
 */
export function createTerminalCaretOutput(
  output: NodeJS.WriteStream,
  options: { enabled?: boolean } = {},
): { output: NodeJS.WriteStream; controller: TerminalCaretController } {
  const enabled = (options.enabled ?? true) && output.isTTY === true;
  const originalWrite = output.write.bind(output) as (...args: unknown[]) => boolean;
  let target: TerminalCaretTarget | null = null;
  let parked = false;
  let paused = false;
  let disposed = false;

  const rows = () => Math.max(1, output.rows || 24);
  const columns = () => Math.max(1, output.columns || 80);
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
    originalWrite(`\x1b[?25l${cup(rows(), 1)}`);
    parked = false;
  };
  const park = () => {
    if (!enabled || paused || disposed) return;
    const next = normalizedTarget();
    if (!next) return;
    originalWrite(`${cup(next.row, next.col)}\x1b[?25h`);
    parked = true;
  };

  const write = ((...args: unknown[]) => {
    returnToInkOrigin();
    const result = originalWrite(...args);
    park();
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
