// Flat ESLint config for the anicode monorepo.
// - typescript-eslint "recommended" (non-type-checked: fast, no per-file project wiring)
// - formatting is delegated to Prettier (eslint-config-prettier turns off stylistic rules)
// - a few rules relaxed to fit the existing hand-written style (empty catches, `as never`, etc.)
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/build/**",
      "**/release/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "**/.anicode-dev/**",
      "**/coverage/**",
      "packages/vscode/src/webview/**/*.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // 允许 `catch {}` 静默降级（代码里大量有意为之，均带注释）。
      "no-empty": ["error", { allowEmptyCatch: true }],
      // 下划线前缀表示「有意未用」。
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // 少量 `as never` / provider 边界处的动态类型是有意的，降为告警而非报错。
      "@typescript-eslint/no-explicit-any": "off",
      // ANSI/控制字符正则是终端渲染必需（相关处已就地 disable no-control-regex）。
      "no-control-regex": "off",
      // 允许「先在闭包里读、后赋值」的 timer 模式（clearTimeout(timer) 定义在赋值之前）。
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    },
  },
  {
    // React 前端：启用 hooks 规则；exhaustive-deps 设为告警（不阻断 CI，仅提示）。
    files: ["packages/tui/**/*.tsx", "packages/app/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // 测试与脚本更宽松：允许非空断言、空函数等测试惯用写法。
    files: ["**/*.test.ts", "**/*.test.tsx", "**/testutil/**", "**/demo.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },
);
