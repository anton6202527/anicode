/**
 * ContextAssembler —— 会话开始时的一次性静态上下文装配（架构 v2 的 R4，
 * 见 docs/architecture-v2.md §2.2；对应 codex-rs 的 context/ 管线）。
 *
 * 把「拼进 system 的各段上下文」从命令式串行代码变成有序的 provider 管线：
 * 新增上下文源 = 新增一个 ContextProvider + 一行注册，不再编辑 ensureMemory。
 * provider 顺序即注入顺序 —— 与 v1 的 sections.push 顺序逐字节一致（缓存友好）。
 *
 * 错误语义与 v1 对齐：env / repo map 采集失败静默跳过（provider 内部吞掉），
 * 其余 provider 的异常照常向上抛 —— assembler 本身不兜错，避免掩盖真实故障。
 *
 * SkillsProvider 是唯一**有副作用**的 provider（注册 skill 工具 + 并入只读集合），
 * 这是刻意保留的 v1 语义（§4-I：三个副作用缺一不可）。
 */

import { t } from "./i18n.js";
import type { ToolRegistry } from "./tools/tool.js";
import type { HookRunner } from "./hooks.js";
import { gatherEnv } from "./env.js";
import { loadProjectMemory } from "./context.js";
import { gatherRepoMap, type RepoMapOptions } from "./repomap.js";
import { discoverSkills, skillListPrompt, createSkillTool } from "./skills.js";

/** 与 AgentOptions.skills 同形（结构兼容）。 */
export type SkillsOption =
  | boolean
  | {
      dirs?: string[];
      disabled?: string[];
      /** Defaults to true. Set false until Workspace Trust has been granted. */
      includeProject?: boolean;
    };

export interface ContextProviderCtx {
  cwd: string;
  tools: ToolRegistry;
  /** 首轮用户请求，供 repo map / retrieval 做相关性排序。 */
  query?: string;
  /** 把工具名并入权限引擎的只读集合（自动放行）。 */
  markReadOnly: (names: string[]) => void;
}

export interface ContextContribution {
  id: string;
  content: string;
}

export interface ContextProvider {
  readonly id: string;
  /** 返回要拼进 system 的一段；null 表示本次无贡献。 */
  contribute(ctx: ContextProviderCtx): Promise<string | null>;
}

export class ContextAssembler {
  constructor(private readonly providers: ContextProvider[]) {}

  /** 保留 provider 身份，供 Context Compiler 做来源追踪、预算与去重。 */
  async collectContributions(ctx: ContextProviderCtx): Promise<ContextContribution[]> {
    const contributions: ContextContribution[] = [];
    for (const p of this.providers) {
      const content = await p.contribute(ctx);
      if (content) contributions.push({ id: p.id, content });
    }
    return contributions;
  }

  /** 按注册顺序执行全部 provider，收集非空贡献段。 */
  async collect(ctx: ContextProviderCtx): Promise<string[]> {
    return (await this.collectContributions(ctx)).map((item) => item.content);
  }
}

// ---------- 内置 provider ----------

/** 环境接地：会话开始时快照一次（cwd/OS/日期/git 状态）。采集失败不影响主流程。 */
export function envProvider(): ContextProvider {
  return {
    id: "env",
    async contribute({ cwd }) {
      try {
        return await gatherEnv(cwd);
      } catch {
        return null;
      }
    },
  };
}

/** 项目记忆：向上发现 AGENTS.md / CLAUDE.md，止于 .git 边界。 */
export function projectMemoryProvider(includeProject = true): ContextProvider {
  return {
    id: "project-memory",
    async contribute({ cwd }) {
      const memory = await loadProjectMemory(cwd, { includeProject });
      return memory || null;
    },
  };
}

/** Repo map：按 token 预算注入代码骨架，帮模型少盲 grep。采集失败不影响主流程。 */
export function repoMapProvider(opt: boolean | RepoMapOptions): ContextProvider {
  return {
    id: "repo-map",
    async contribute({ cwd, query }) {
      try {
        const opts = typeof opt === "object" ? opt : {};
        const map = await gatherRepoMap(cwd, { ...opts, ...(query ? { query } : {}) });
        return map || null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Skills 渐进加载：清单注入 system（L1），正文经 skill 工具按需加载（L2）。
 * 唯一有副作用的 provider：注册 skill 工具并并入只读集合（三者缺一不可）。
 */
export function skillsProvider(opt: SkillsOption): ContextProvider {
  return {
    id: "skills",
    async contribute({ cwd, tools, markReadOnly }) {
      const o = typeof opt === "object" ? opt : {};
      const extraDirs = o.dirs ?? [];
      const disabled = new Set(o.disabled ?? []);
      const discovered = await discoverSkills(cwd, extraDirs, {
        ...(o.includeProject !== undefined ? { includeProject: o.includeProject } : {}),
      });
      const skills = disabled.size ? discovered.filter((s) => !disabled.has(s.name)) : discovered;
      if (skills.length === 0) return null;
      const skillTool = createSkillTool(skills);
      tools.register(skillTool);
      markReadOnly([skillTool.def.name]);
      return skillListPrompt(skills);
    },
  };
}

/** browser 工具已注册时，注入「写完前端就开页验证」的用法指引（对齐 Codex 内置浏览器习惯）。 */
export function browserUsageProvider(): ContextProvider {
  return {
    id: "browser-usage",
    async contribute({ tools }) {
      if (!tools.get("browser")) return null;
      return t(
        "# Verifying frontend changes\n- After writing or changing frontend/UI code, verify it actually renders and runs by opening the HTTP(S) dev server in the browser tool (e.g. http://localhost:3000). It reports console errors, uncaught exceptions and failed requests, and returns a screenshot. Prefer this over guessing.\n- If no dev server is running, start one with bash run_in_background first, then open the URL. Local file/data/browser-internal URLs are intentionally blocked.\n- Treat console errors, uncaught exceptions, or a blank/error screenshot as a failure to fix, not a done state.",
        "# 验证前端改动\n- 写完或改完前端/UI 代码后，用 browser 工具打开 HTTP(S) dev server（如 http://localhost:3000），确认页面真的能渲染、能跑。它会报告 console 错误、未捕获异常与失败请求，并回传截图。别靠猜。\n- 若没有 dev server 在跑，先用 bash 的 run_in_background 启动，再打开 URL。本地文件、data 与浏览器内部 URL 会被安全策略阻止。\n- 把 console 错误、未捕获异常或白屏/报错截图当成待修的失败，而不是完成态。",
      );
    },
  };
}

/**
 * SessionStart hook：会话装配的最后一步，additionalContext 注入 system
 * （对齐 Codex/Claude Code 的 SessionStart 注入上下文能力）。
 */
export function sessionStartHookProvider(hooks: HookRunner): ContextProvider {
  return {
    id: "session-start-hook",
    async contribute({ cwd }) {
      if (!hooks.has("SessionStart")) return null;
      const h = await hooks.run({ event: "SessionStart", cwd });
      return h.additionalContext || null;
    },
  };
}
