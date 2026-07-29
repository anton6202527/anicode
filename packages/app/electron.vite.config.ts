import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// main/preload 走 Node，把第三方依赖保持 external；但 @anicode/core 以 TS 源码
// 形式发布（exports 指向 ./src/index.ts），Node 无法直接 require，必须打进包里。
const bundleCore = externalizeDepsPlugin({ exclude: ["@anicode/core"] });
const nativeCoreDependencies = [
  /^@napi-rs\/keyring(?:\/|$)/,
  /^@ast-grep\/napi(?:\/|$)/,
  /^@ast-grep\/lang-(?:python|go|rust|java)(?:\/|$)/,
];

export default defineConfig({
  main: {
    plugins: [bundleCore],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
        // N-API bindings must remain real runtime dependencies; Rollup cannot inline platform
        // `.node` binaries. electron-builder picks them (and their optional platform package) up
        // from package.json.
        external: nativeCoreDependencies,
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
    plugins: [react({})],
  },
});
