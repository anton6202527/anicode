import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const vscodeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PACKAGED_KEYRING_DIRECTORY = path.join("out", "keyring");
export const PACKAGED_KEYRING_MODULE = path.join(PACKAGED_KEYRING_DIRECTORY, "index.js");

function linuxLibc(report = process.report?.getReport?.()) {
  const header = report && typeof report === "object" ? report.header : undefined;
  if (header && typeof header === "object" && header.glibcVersionRuntime) return "gnu";
  const sharedObjects =
    report && typeof report === "object" && Array.isArray(report.sharedObjects)
      ? report.sharedObjects
      : [];
  if (sharedObjects.some((item) => typeof item === "string" && item.includes("musl"))) {
    return "musl";
  }
  throw new Error("Cannot determine Linux libc for the packaged OS Keychain binding");
}

/** Return the optional @napi-rs/keyring package suffix for this native build host. */
export function keyringTarget(
  platform = process.platform,
  architecture = process.arch,
  report = process.report?.getReport?.(),
) {
  if (platform === "darwin" && ["arm64", "x64"].includes(architecture)) {
    return `darwin-${architecture}`;
  }
  if (platform === "win32" && ["arm64", "ia32", "x64"].includes(architecture)) {
    return `win32-${architecture}-msvc`;
  }
  if (platform === "freebsd" && architecture === "x64") return "freebsd-x64";
  if (platform === "linux") {
    if (["arm64", "x64"].includes(architecture)) {
      return `linux-${architecture}-${linuxLibc(report)}`;
    }
    if (architecture === "arm") return "linux-arm-gnueabihf";
    if (architecture === "riscv64") return "linux-riscv64-gnu";
  }
  throw new Error(`Unsupported OS Keychain build target: ${platform}/${architecture}`);
}

export function resolveKeyringRuntimeArtifacts(
  resolve = (specifier) => require.resolve(specifier),
  platform = process.platform,
  architecture = process.arch,
  report = process.report?.getReport?.(),
) {
  const loader = resolve("@napi-rs/keyring");
  const target = keyringTarget(platform, architecture, report);
  const binding = resolve(`@napi-rs/keyring-${target}`);
  const license = path.join(path.dirname(loader), "LICENSE");
  if (!path.isAbsolute(loader) || path.extname(loader) !== ".js") {
    throw new Error("Resolved @napi-rs/keyring loader is not an absolute JavaScript file");
  }
  if (!path.isAbsolute(binding) || path.extname(binding) !== ".node") {
    throw new Error("Resolved @napi-rs/keyring binding is not an absolute native module");
  }
  return Object.freeze({ loader, binding, license, target });
}

/**
 * Copy only the audited JavaScript loader, license, and this build host's native binding.
 * Merely resolving/copying these files cannot open the operating-system credential store.
 */
export async function packageKeyringRuntime({
  outputDirectory = path.join(vscodeDirectory, PACKAGED_KEYRING_DIRECTORY),
  artifacts = resolveKeyringRuntimeArtifacts(),
} = {}) {
  const destination = path.resolve(outputDirectory);
  const bindingName = path.basename(artifacts.binding);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o755 });
  const staging = await mkdtemp(path.join(parent, ".keyring-stage-"));
  try {
    await Promise.all([
      copyFile(artifacts.loader, path.join(staging, "index.js")),
      copyFile(artifacts.binding, path.join(staging, bindingName)),
      copyFile(artifacts.license, path.join(staging, "LICENSE")),
    ]);

    // Fail the build if the copied loader cannot select the concrete local binding. This is a
    // structural check only: the native module is never loaded and no Entry method is called.
    const loaderSource = await readFile(path.join(staging, "index.js"), "utf8");
    if (!loaderSource.includes(`./${bindingName}`)) {
      throw new Error(`@napi-rs/keyring loader does not reference packaged binding ${bindingName}`);
    }
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return Object.freeze({
    modulePath: path.join(destination, "index.js"),
    bindingPath: path.join(destination, bindingName),
  });
}
