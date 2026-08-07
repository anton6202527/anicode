/**
 * Curated MCP catalog for software-development workflows.
 *
 * Keep this list intentionally small: entries must be maintained by the platform vendor or by a
 * well-established developer-tool vendor. Local npm servers are pinned to an exact version so an
 * AniCode restart cannot silently execute different third-party code.
 */

import { t } from "./i18n.js";
import type { McpServerConfig } from "./mcp.js";

export interface DevelopmentMcpCatalogEntry {
  /** Stable id used by `anicode mcp add/remove` and the desktop marketplace. */
  id: string;
  name: string;
  description: string;
  author: string;
  icon: string;
  version: string;
  homepage: string;
  server: McpServerConfig;
  /** Environment credentials that must be present in CredentialBroker before connecting. */
  requiresEnv?: readonly string[];
  /** Executables required to launch a local stdio server. */
  requiresBins?: readonly string[];
}

export const DEVELOPMENT_MCP_CATALOG: readonly DevelopmentMcpCatalogEntry[] = [
  {
    id: "context7",
    name: "Context7",
    description: t(
      "Look up current, version-aware library and framework documentation while coding.",
      "编程时查询最新且区分版本的库与框架文档。",
    ),
    author: "Upstash",
    icon: "📚",
    version: "hosted",
    homepage: "https://context7.com/docs",
    server: { name: "context7", url: "https://mcp.context7.com/mcp" },
  },
  {
    id: "github",
    name: "GitHub",
    description: t(
      "Official GitHub tools for repositories, issues, pull requests, Actions, and code security.",
      "GitHub 官方工具：仓库、Issue、Pull Request、Actions 与代码安全。",
    ),
    author: "GitHub",
    icon: "🐙",
    version: "hosted",
    homepage: "https://github.com/github/github-mcp-server",
    server: {
      name: "github",
      url: "https://api.githubcopilot.com/mcp/",
      headers: {
        "X-MCP-Toolsets": "default,actions,code_security",
        // Hide public issue/PR content from authors without repository push access.
        "X-MCP-Lockdown": "true",
      },
      credential: { id: "env:GITHUB_TOKEN", header: "Authorization", scheme: "Bearer" },
    },
    requiresEnv: ["GITHUB_TOKEN"],
  },
  {
    id: "playwright",
    name: t("Playwright browser", "Playwright 浏览器"),
    description: t(
      "Drive an isolated real browser for navigation, forms, screenshots, and end-to-end checks.",
      "驱动隔离的真实浏览器完成导航、表单、截图与端到端验证。",
    ),
    author: "Microsoft",
    icon: "🎭",
    version: "0.0.78",
    homepage: "https://github.com/microsoft/playwright-mcp",
    server: {
      name: "playwright",
      command: "npx",
      args: ["-y", "@playwright/mcp@0.0.78", "--isolated"],
      network: true,
    },
    requiresBins: ["npx"],
  },
  {
    id: "chrome-devtools",
    name: "Chrome DevTools",
    description: t(
      "Inspect console, network, rendering, and performance with Google's Chrome DevTools server.",
      "使用 Google Chrome DevTools 检查控制台、网络、渲染与性能。",
    ),
    author: "Google Chrome",
    icon: "🧭",
    version: "1.6.0",
    homepage: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    server: {
      name: "chrome-devtools",
      command: "npx",
      args: [
        "-y",
        "chrome-devtools-mcp@1.6.0",
        "--isolated",
        // The server launches a system Chrome binary. Keep that automation-only profile away
        // from the host login Keychain/Secret Service on both supported POSIX desktop families.
        // Unknown platform-specific Chromium switches are ignored on the other platform.
        "--chrome-arg=--use-mock-keychain",
        "--chrome-arg=--password-store=basic",
        "--no-usage-statistics",
        "--no-performance-crux",
      ],
      network: true,
    },
    requiresBins: ["npx"],
  },
  {
    id: "sentry",
    name: "Sentry",
    description: t(
      "Investigate production errors, traces, releases, and performance from a coding session.",
      "在编码会话中排查线上错误、Trace、Release 与性能问题。",
    ),
    author: "Sentry",
    icon: "🚨",
    version: "hosted",
    homepage: "https://github.com/getsentry/sentry-mcp",
    server: {
      name: "sentry",
      url: "https://mcp.sentry.dev/mcp",
      credential: {
        id: "env:SENTRY_ACCESS_TOKEN",
        header: "Authorization",
        scheme: "Sentry-Bearer",
      },
    },
    requiresEnv: ["SENTRY_ACCESS_TOKEN"],
  },
  {
    id: "firebase",
    name: "Firebase",
    description: t(
      "Official Firebase tools for projects, Auth, Firestore, security rules, and deployment.",
      "Firebase 官方工具：项目、Auth、Firestore、安全规则与部署。",
    ),
    author: "Google Firebase",
    icon: "🔥",
    version: "15.25.1",
    homepage: "https://firebase.google.com/docs/ai-assistance/mcp-server",
    server: {
      name: "firebase",
      command: "npx",
      args: ["-y", "firebase-tools@15.25.1", "mcp"],
      network: true,
    },
    requiresBins: ["npx"],
  },
];

export function findDevelopmentMcp(id: string): DevelopmentMcpCatalogEntry | undefined {
  const normalized = id.trim().toLowerCase();
  return DEVELOPMENT_MCP_CATALOG.find(
    (entry) => entry.id === normalized || entry.server.name === normalized,
  );
}
