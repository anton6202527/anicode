import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const input = process.argv[2]?.trim() ?? "";
const version = input.startsWith("v") ? input.slice(1) : input;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Release tag must be a SemVer version, received: ${input || "<empty>"}`);
}

for (const relative of ["packages/app/package.json", "packages/vscode/package.json"]) {
  const file = path.resolve(relative);
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.version = version;
  await writeFile(file, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

process.stdout.write(`Prepared desktop and VS Code packages for ${version}\n`);
