import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

/** Parse the common `$EDITOR="code --wait"` form without invoking a shell. */
export function parseEditorCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (escaped || quote) throw new Error("Invalid EDITOR command: unterminated escape or quote");
  if (current) args.push(current);
  if (args.length === 0) throw new Error("EDITOR is empty");
  return args;
}

export async function editInExternalEditor(
  initial: string,
  options: {
    cwd: string;
    suspendTerminal: (callback: () => void | Promise<void>) => Promise<void>;
    editor?: string;
  },
): Promise<string> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-editor-"));
  const file = path.join(temporary, "prompt.md");
  try {
    await fs.writeFile(file, initial, { encoding: "utf8", mode: 0o600 });
    const [executable, ...args] = parseEditorCommand(
      options.editor ?? process.env.VISUAL ?? process.env.EDITOR ?? "vi",
    );
    await options.suspendTerminal(
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(executable!, [...args, file], {
            cwd: options.cwd,
            stdio: "inherit",
            shell: false,
          });
          child.once("error", reject);
          child.once("exit", (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`Editor exited with ${signal ?? `code ${code ?? "unknown"}`}`));
          });
        }),
    );
    return await fs.readFile(file, "utf8");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
