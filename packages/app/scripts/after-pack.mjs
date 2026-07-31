import path from "node:path";
import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";

/** electron-builder afterPack hook: harden the packaged Electron binary before code signing. */
export default async function afterPack(context) {
  const product = context.packager.appInfo.productFilename;
  const platform = context.electronPlatformName;
  const binary =
    platform === "darwin"
      ? path.join(context.appOutDir, `${product}.app`, "Contents", "MacOS", product)
      : platform === "win32"
        ? path.join(context.appOutDir, `${product}.exe`)
        : path.join(context.appOutDir, product);

  await flipFuses(binary, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    resetAdHocDarwinSignature: platform === "darwin" && context.arch === 3,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true,
  });
}
