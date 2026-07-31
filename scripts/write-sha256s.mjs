import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import * as path from "node:path";

const [outputArg, directoryArg, ...extensions] = process.argv.slice(2);
if (!outputArg || !directoryArg || extensions.length === 0) {
  throw new Error("Usage: write-sha256s.mjs <output> <directory> <.ext> [...ext]");
}

const output = path.resolve(outputArg);
const directory = path.resolve(directoryArg);
const allowed = new Set(extensions);
const files = (await fs.readdir(directory, { withFileTypes: true }))
  .filter(
    (entry) =>
      entry.isFile() &&
      path.resolve(directory, entry.name) !== output &&
      allowed.has(path.extname(entry.name)),
  )
  .map((entry) => entry.name)
  .sort();
if (files.length === 0) throw new Error(`No release artifacts found in ${directory}`);
if (files.some((name) => /[\r\n]/.test(name))) throw new Error("Unsafe release artifact filename");

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const lines = [];
for (const name of files) lines.push(`${await sha256(path.join(directory, name))}  ${name}`);
await fs.writeFile(output, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o644 });
process.stdout.write(`Wrote ${files.length} SHA-256 checksums to ${output}\n`);
