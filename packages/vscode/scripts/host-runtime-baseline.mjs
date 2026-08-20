/**
 * VS Code 1.101 is the first Stable release whose desktop/remote Extension Host runs Node 22.
 * Its Electron 35 runtime embeds Node 22.15.1. Keep the manifest, types and emitted syntax tied to
 * this reviewed baseline; changing one value without the others is a release compatibility bug.
 *
 * Source: https://code.visualstudio.com/updates/v1_101#_electron-35-update
 */
export const MINIMUM_VSCODE_VERSION = "1.101.0";
export const MINIMUM_EXTENSION_HOST_NODE_VERSION = "22.15.1";
export const HOST_ESBUILD_TARGET = "node22.15";
