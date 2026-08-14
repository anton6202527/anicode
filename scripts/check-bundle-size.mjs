import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const mib = 1024 * 1024;
const budgets = [
  ["Electron main bundle", "packages/app/out/main/index.js", 4.5 * mib],
  ["VS Code extension host", "packages/vscode/out/extension.js", 6 * mib],
  ["VS Code webview", "packages/vscode/out/webview.js", 0.1 * mib],
];

let failed = false;

const cliAssets = path.resolve("packages/cli/dist");
async function directoryJavaScriptBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryJavaScriptBytes(target);
    else if (entry.isFile() && entry.name.endsWith(".js")) total += (await stat(target)).size;
  }
  return total;
}

const cliJavaScript = await directoryJavaScriptBytes(cliAssets);
const cliMaximum = 2 * mib;
process.stdout.write(
  `${cliJavaScript <= cliMaximum ? "OK  " : "OVER"} CLI JavaScript: ${(cliJavaScript / mib).toFixed(2)} MiB / ${(cliMaximum / mib).toFixed(2)} MiB\n`,
);
if (cliJavaScript > cliMaximum) failed = true;

for (const [label, file, maximum] of budgets) {
  const bytes = (await stat(path.resolve(file))).size;
  const status = bytes <= maximum ? "OK" : "OVER";
  process.stdout.write(
    `${status.padEnd(4)} ${label}: ${(bytes / mib).toFixed(2)} MiB / ${(maximum / mib).toFixed(2)} MiB\n`,
  );
  if (bytes > maximum) failed = true;
}

const rendererAssets = path.resolve("packages/app/out/renderer/assets");
const rendererEntries = await readdir(rendererAssets);
const rendererJavaScript = (
  await Promise.all(
    rendererEntries
      .filter((name) => name.endsWith(".js"))
      .map(async (name) => (await stat(path.join(rendererAssets, name))).size),
  )
).reduce((total, bytes) => total + bytes, 0);
const rendererMaximum = 0.75 * mib;
process.stdout.write(
  `${rendererJavaScript <= rendererMaximum ? "OK  " : "OVER"} Electron renderer JS: ${(rendererJavaScript / mib).toFixed(2)} MiB / ${(rendererMaximum / mib).toFixed(2)} MiB\n`,
);
if (rendererJavaScript > rendererMaximum) failed = true;

if (failed) throw new Error("Bundle size budget exceeded; justify and review any budget increase");
