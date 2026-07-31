import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-package-smoke-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: {
      ...process.env,
      ANICODE_CREDENTIAL_BACKEND: "memory",
      ANICODE_LANG: "en",
      NO_COLOR: "1",
    },
    encoding: "utf8",
    timeout: options.timeout ?? 240_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? "signal"})\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const packed = JSON.parse(
    run(npm, [
      "pack",
      "--workspace",
      "anicode",
      "--pack-destination",
      temporary,
      "--ignore-scripts",
      "--json",
    ]),
  );
  expect(Array.isArray(packed) && packed.length === 1, "npm pack returned an unexpected result");
  const artifact = packed[0];
  const paths = artifact.files.map((entry) => entry.path).sort();
  expect(
    JSON.stringify(paths) === JSON.stringify(["README.md", "dist/cli.js", "package.json"]),
    `published package contains unexpected files: ${paths.join(", ")}`,
  );
  expect(artifact.unpackedSize < 2 * 1024 * 1024, "published CLI exceeds the 2 MiB package budget");

  const project = path.join(temporary, "consumer");
  await fs.mkdir(project);
  await fs.writeFile(
    path.join(project, "package.json"),
    `${JSON.stringify({ private: true, name: "anicode-package-smoke" }, null, 2)}\n`,
  );
  const tarball = path.join(temporary, artifact.filename);
  run(
    npm,
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    { cwd: project },
  );

  const installedRoot = path.join(project, "node_modules", "anicode");
  const installed = JSON.parse(await fs.readFile(path.join(installedRoot, "package.json"), "utf8"));
  expect(
    installed.bin?.anicode === "./dist/cli.js",
    "published package has an invalid bin mapping",
  );
  const entry = path.join(installedRoot, "dist", "cli.js");
  const version = run(process.execPath, [entry, "--version"], { cwd: project });
  expect(
    version === installed.version,
    `--version returned ${version}, expected ${installed.version}`,
  );
  const help = run(process.execPath, [entry, "--help"], { cwd: project });
  expect(/Usage:|用法:/.test(help), "installed CLI --help did not render");
  const models = run(process.execPath, [entry, "--list-models"], { cwd: project });
  expect(models.includes("debug/demo"), "installed CLI model catalog is incomplete");

  process.stdout.write(
    `CLI package smoke passed: ${artifact.filename}, ${artifact.size} packed bytes, ${artifact.entryCount} files\n`,
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
