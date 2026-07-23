// 把工作区源码打包成一个自包含的 dist/cli.js。
//
// 两个关键处理：
//  1. NodeNext 的相对 import 都写成 ".js"，但真实文件是 .ts/.tsx —— 加一个 resolve
//     插件把 ".js" 重映射到同名 .ts/.tsx（tsx 运行时本来帮我们做这件事，编译时得自己做）。
//  2. externalize：凡是「裸依赖且不属于 @anicode/*」的都留作外部依赖（ink/react/sdk/openai
//     由发布包的 dependencies 在安装时提供）；@anicode/* 与相对路径全部内联，
//     因此发布包不含任何 workspace 依赖，registry 上可独立安装。

import { build } from "esbuild";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "dist", "cli.js");

// 版本号单一事实源：从发布包 package.json 注入，避免源码里硬编码版本与之漂移。
const pkg = JSON.parse(await fs.readFile(path.join(here, "package.json"), "utf8"));

/** 把相对的 ".js" import 解析到实际的 .ts/.tsx 源文件 */
const tsResolvePlugin = {
  name: "ts-resolve",
  setup(b) {
    b.onResolve({ filter: /^\.\.?\// }, async (args) => {
      if (!args.importer) return null; // 入口交给 esbuild 默认解析
      const abs = path.resolve(args.resolveDir, args.path);
      // 已经能直接命中就不管
      const candidates = args.path.endsWith(".js")
        ? [abs.replace(/\.js$/, ".ts"), abs.replace(/\.js$/, ".tsx")]
        : [abs, `${abs}.ts`, `${abs}.tsx`, path.join(abs, "index.ts")];
      for (const c of candidates) {
        try {
          const st = await fs.stat(c);
          if (st.isFile()) return { path: c };
        } catch {
          /* try next */
        }
      }
      return null; // 落回默认解析（如目录带 package.json 的情况）
    });
  },
};

/** 外部化所有非 @anicode 的裸依赖（node: 内建由 platform:node 自动外部化） */
const externalizePlugin = {
  name: "externalize-npm",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const p = args.path;
      if (p.startsWith(".") || p.startsWith("/") || path.isAbsolute(p)) return null;
      if (p.startsWith("@anicode/")) return null; // 内联工作区包（经 exports 解析到 src）
      if (p.startsWith("node:")) return { path: p, external: true };
      return { path: p, external: true }; // ink / react / @anthropic-ai/sdk / openai / ...
    });
  },
};

// 入口直接用 TUI 的 cli.tsx —— 它底部有「自身即主模块时运行 main()」的守护，
// 打包后作为 dist/cli.js 执行会正确触发一次（用 wrapper 再调一次会重复运行）。
const entry = path.resolve(here, "..", "tui", "src", "cli.tsx");

await fs.rm(path.join(here, "dist"), { recursive: true, force: true });
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  jsx: "automatic",
  loader: { ".ts": "ts", ".tsx": "tsx" },
  define: { __ANICODE_VERSION__: JSON.stringify(pkg.version) },
  plugins: [externalizePlugin, tsResolvePlugin],
  logLevel: "info",
});

// cli.tsx 源码自带 `#!/usr/bin/env tsx` shebang，会被 esbuild 保留在产物开头。
// 剥掉产物开头的所有 shebang 行，再补上唯一正确的 node shebang（shebang 只在第 1 行有效）。
let code = await fs.readFile(outfile, "utf8");
code = code.replace(/^(#!.*\n)+/, "");
await fs.writeFile(outfile, `#!/usr/bin/env node\n${code}`, "utf8");
await fs.chmod(outfile, 0o755);
console.log(`✓ 打包完成: ${path.relative(process.cwd(), outfile)}`);
