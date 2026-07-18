/**
 * 权限系统 —— UI 无关。
 *
 * 决策链（第一个命中即返回，deny 永远最先——即使 bypass 也压不过显式 deny）：
 *   1. denyRules 命中        → deny（用户明令禁止，最高优先级）
 *   2. askRules 命中         → 强制走 confirm（即使 bypass/只读/allowRules 也要问）
 *   3. mode=bypass           → allow（危险，仅限沙箱/CI 明确授权）
 *   4. 只读工具              → allow（Read/Grep/Glob 等无副作用）
 *   5. 已记住的决定          → allow
 *   6. allowRules 命中       → allow（用户/项目预授权规则）
 *   7. mode=acceptEdits 且工具是文件编辑类 → allow（bash 等仍要问）
 *   8. mode=auto             → allow（写/执行也自动放行）
 *   9. 交给 confirm 回调     → 由前端（TUI/App/CI）决定
 *
 * confirm 回调是 core 与前端的唯一耦合点：core 不知道谁在确认，
 * 前端返回 allow / deny / allow-and-remember。
 */

import { t } from "./i18n.js";

export type PermissionMode = "default" | "acceptEdits" | "auto" | "bypass" | "plan";

export interface PermissionDecision {
  behavior: "allow" | "deny";
  /** allow 时可改写入参（如收窄 bash 命令）；deny 时无意义 */
  updatedInput?: Record<string, unknown>;
  /** deny 时给模型看的原因，让它自行改路 */
  message?: string;
  /**
   * 记住本次决定：true/"session" 仅本会话内存；"always" 额外持久化——
   * 追加为 allow 规则并通过 persistAllowRule 写盘（跨会话生效，对齐
   * Claude Code 的 .claude/settings.local.json 允许清单）。
   */
  remember?: boolean | "session" | "always";
}

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  /** 工具自报的"人类可读的动作摘要"，用于 UI 展示与规则匹配 */
  ruleKey: string;
  /**
   * 规则匹配的独立单元（bash 复合命令拆分后的各子命令）。缺省 [ruleKey]。
   * allow 要求每个单元都命中；deny/ask 任一单元命中即生效 ——
   * "git status && rm -rf /" 因此不会被 "Bash(git *)" 放行。
   */
  ruleParts?: string[];
  /** false 表示 ruleParts 只是保守近似，不能用于细粒度自动放行。 */
  rulePartsComplete?: boolean;
  /** PreToolUse hook 显式放行 —— 跳过 mode/confirm，但压不过 deny/ask 规则 */
  hookAllowed?: boolean;
  /** 触发本次授权的工具调用 id —— 供前端把授权提示关联到对应的 tool_start 行 */
  toolCallId: string;
  signal: AbortSignal;
}

export type ConfirmFn = (req: PermissionRequest) => Promise<PermissionDecision>;

export interface PermissionConfig {
  mode?: PermissionMode;
  /** 预授权规则，形如 "Bash", "Bash(git *)", "Write" —— 命中即放行 */
  allowRules?: string[];
  /** 禁止规则，同语法 —— 命中即拒绝，优先级最高（压过 bypass/allowRules） */
  denyRules?: string[];
  /** 强制询问规则，同语法 —— 命中必走 confirm（压过只读放行与 allowRules） */
  askRules?: string[];
  /** 只读工具名集合（默认 Read/Grep/Glob/List） */
  readOnlyTools?: string[];
  /** 文件编辑类工具名集合（acceptEdits 模式自动放行这些） */
  editTools?: string[];
  confirm?: ConfirmFn;
  /**
   * remember="always" 时的持久化回调：收到形如 "Tool(ruleKey)" 的规则串，
   * 由调用方写入项目本地设置（.anicode/settings.local.json）。失败不影响本次放行。
   */
  persistAllowRule?: (rule: string) => void | Promise<void>;
}

/**
 * 权限档位（profile）：一组可整体切换的 mode + 规则叠加层。
 *
 * 语义：profile 的规则**叠加**在构造时的基础配置之上（绝不替换用户既有的
 * deny/ask 基础规则——deny 永远最高优先级，切档位洗不掉）；mode 有值时覆盖当前模式。
 * 运行时 /profile <name> 一次切换整套行为，对齐 Codex 的 permission profiles。
 */
export interface PermissionProfile {
  mode?: PermissionMode;
  allowRules?: string[];
  denyRules?: string[];
  askRules?: string[];
  /** 展示用一句话说明。 */
  description?: string;
}

/** 内置档位：readonly（只读探索）/ default（逐项确认）/ workspace（编辑自动放行）/ full（全自动）。 */
export const BUILTIN_PROFILES: Record<string, PermissionProfile> = {
  readonly: { mode: "plan", description: "read-only: explore & plan, no writes/exec" },
  default: { mode: "default", description: "confirm each side-effecting action" },
  workspace: { mode: "acceptEdits", description: "auto-approve file edits; bash still asks" },
  full: { mode: "auto", description: "auto-approve everything except deny/ask rules" },
};

const DEFAULT_READONLY = ["read", "grep", "glob", "list"];

export class PermissionEngine {
  private mode: PermissionMode;
  private readOnly: Set<string>;
  private editTools: Set<string>;
  private allowRules: string[];
  private denyRules: string[];
  private askRules: string[];
  /** 构造时的基础规则——profile 叠加层永远建立在它之上，切档位不丢用户配置。 */
  private readonly baseAllow: string[];
  private readonly baseDeny: string[];
  private readonly baseAsk: string[];
  private profileName: string | null = null;
  private remembered = new Set<string>();
  private confirm?: ConfirmFn;
  private persistAllowRule?: (rule: string) => void | Promise<void>;

  constructor(cfg: PermissionConfig = {}) {
    this.mode = cfg.mode ?? "default";
    this.readOnly = new Set((cfg.readOnlyTools ?? DEFAULT_READONLY).map((s) => s.toLowerCase()));
    this.editTools = new Set((cfg.editTools ?? []).map((s) => s.toLowerCase()));
    this.baseAllow = cfg.allowRules ?? [];
    this.baseDeny = cfg.denyRules ?? [];
    this.baseAsk = cfg.askRules ?? [];
    this.allowRules = this.baseAllow;
    this.denyRules = this.baseDeny;
    this.askRules = this.baseAsk;
    if (cfg.confirm) this.confirm = cfg.confirm;
    if (cfg.persistAllowRule) this.persistAllowRule = cfg.persistAllowRule;
  }

  /** 动态注册工具时同步其权限元数据（skills 在首次 send 时才会被发现）。 */
  addReadOnlyTools(names: Iterable<string>): void {
    for (const name of names) this.readOnly.add(name.toLowerCase());
  }

  addEditTools(names: Iterable<string>): void {
    for (const name of names) this.editTools.add(name.toLowerCase());
  }

  /** 运行时切换权限模式（如 /plan 进入/退出计划模式）。直接切模式后档位名不再准确，清掉。 */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
    this.profileName = null;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  /**
   * 应用一个权限档位：规则叠加在基础配置之上（替换上一个档位的叠加层），
   * mode 有值时覆盖当前模式。
   */
  applyProfile(name: string, profile: PermissionProfile): void {
    this.profileName = name;
    this.allowRules = [...this.baseAllow, ...(profile.allowRules ?? [])];
    this.denyRules = [...this.baseDeny, ...(profile.denyRules ?? [])];
    this.askRules = [...this.baseAsk, ...(profile.askRules ?? [])];
    if (profile.mode) this.mode = profile.mode;
  }

  /** 当前生效的档位名；直接 setMode 或从未切过档位时为 null。 */
  getProfile(): string | null {
    return this.profileName;
  }

  async check(req: PermissionRequest): Promise<PermissionDecision> {
    // 无法完整分析复杂命令时，只要该工具配置了 deny 规则就保守拒绝，避免
    // `git status $(rm ...)` 之类把被禁动作藏进细粒度规则看不到的位置。
    if (this.matchesDeny(req)) {
      return { behavior: "deny", message: `操作被 deny 规则禁止: ${req.toolName}(${req.ruleKey})` };
    }
    // 计划模式：只读工具放行，任何有副作用的操作一律拒绝——让模型先给出方案，
    // 用户确认（退出计划模式）后再执行。拒绝理由是反射式的，引导模型转为规划。
    if (this.mode === "plan" && !this.readOnly.has(req.toolName.toLowerCase())) {
      return {
        behavior: "deny",
        message: t(
          `Plan mode: read-only. Don't edit or run commands yet — first lay out a concise plan (files to change, steps). The user will approve and exit plan mode before you execute.`,
          `计划模式：当前只读。先不要改文件或执行命令——请先给出简洁方案（要改哪些文件、分几步）。用户确认并退出计划模式后再执行。`,
        ),
      };
    }
    // ask：任一单元命中则强制走 confirm（压过 bypass / hook allow / 只读 / allowRules）
    const parts = req.ruleParts?.length ? req.ruleParts : [req.ruleKey];
    const complete = req.rulePartsComplete !== false;
    const forceAsk = this.matchesAsk(req);
    if (!forceAsk) {
      if (this.mode === "bypass") return { behavior: "allow" };
      if (req.hookAllowed) return { behavior: "allow" };
      if (this.readOnly.has(req.toolName.toLowerCase())) return { behavior: "allow" };

      const memoKey = `${req.toolName}::${req.ruleKey}`;
      if (this.remembered.has(memoKey)) return { behavior: "allow" };
      // allow：要求每个单元都命中（复合命令的每个子命令都被预授权）
      // 裸工具规则是用户明确放行该工具的全部动作；细粒度规则则只在分析完整时生效。
      if (
        hasBareRuleForTool(this.allowRules, req.toolName) ||
        (complete && parts.every((p) => matchesAnyRule(this.allowRules, req.toolName, p)))
      ) {
        return { behavior: "allow" };
      }

      if (this.mode === "acceptEdits" && this.editTools.has(req.toolName.toLowerCase())) {
        return { behavior: "allow" };
      }
      if (this.mode === "auto") return { behavior: "allow" };
    }

    if (!this.confirm) {
      return {
        behavior: "deny",
        message: `工具 ${req.toolName} 需要授权，但未配置确认回调（非交互环境）`,
      };
    }
    const decision = await this.confirm(req);
    if (decision.behavior === "allow" && decision.remember && !decision.updatedInput) {
      this.remembered.add(`${req.toolName}::${req.ruleKey}`);
      if (decision.remember === "always") {
        // 持久化为 allow 规则：写进 baseAllow（切档位重建叠加层时不丢），
        // 并回调写盘。写盘失败只影响下次会话，本会话已经 remembered。
        const rule = `${req.toolName}(${req.ruleKey})`;
        this.baseAllow.push(rule);
        // 未切过档位时 allowRules 与 baseAllow 同引用，避免重复推入
        if (this.allowRules !== this.baseAllow) this.allowRules.push(rule);
        if (this.persistAllowRule) {
          try {
            await this.persistAllowRule(rule);
          } catch {
            /* 写盘失败不阻断本次放行 */
          }
        }
      }
    }
    // 不能把「原始输入 → 经 UI 改写后才允许」记成原始输入的永久放行。
    // 否则下一次命中 remembered 时不会重放改写，会直接执行原始危险动作。
    return decision.updatedInput && decision.remember ? { ...decision, remember: false } : decision;
  }

  /**
   * confirm 改写输入后，对真正要执行的动作再做一次不可绕过的策略校验。
   * deny 仍然最高优先级；若新动作命中 ask，则要求模型以新动作重新发起，
   * 避免一次针对 A 的确认被扩大成对 B 的授权。
   */
  validateUpdatedInput(req: PermissionRequest): PermissionDecision {
    if (this.matchesDeny(req)) {
      return {
        behavior: "deny",
        message: `修改后的操作被 deny 规则禁止: ${req.toolName}(${req.ruleKey})`,
      };
    }
    if (this.matchesAsk(req)) {
      return {
        behavior: "deny",
        message: `修改后的操作命中 ask 规则，请以新参数重新发起授权: ${req.toolName}(${req.ruleKey})`,
      };
    }
    return { behavior: "allow" };
  }

  private matchesDeny(req: PermissionRequest): boolean {
    const parts = req.ruleParts?.length ? req.ruleParts : [req.ruleKey];
    const complete = req.rulePartsComplete !== false;
    return (
      (!complete && hasRuleForTool(this.denyRules, req.toolName)) ||
      parts.some((p) => matchesAnyRule(this.denyRules, req.toolName, p))
    );
  }

  private matchesAsk(req: PermissionRequest): boolean {
    const parts = req.ruleParts?.length ? req.ruleParts : [req.ruleKey];
    const complete = req.rulePartsComplete !== false;
    return (
      (!complete && hasRuleForTool(this.askRules, req.toolName)) ||
      parts.some((p) => matchesAnyRule(this.askRules, req.toolName, p))
    );
  }
}

/** 规则匹配：精确工具名，或 "Tool(glob)" 形式对 ruleKey 做 glob */
function matchesAnyRule(rules: string[], toolName: string, ruleKey: string): boolean {
  for (const rule of rules) {
    const m = /^([^()]+?)(?:\((.*)\))?$/.exec(rule.trim());
    if (!m) continue;
    const [, ruleTool, pattern] = m;
    if (ruleTool!.toLowerCase() !== toolName.toLowerCase()) continue;
    if (pattern === undefined) return true; // 裸工具名，匹配全部
    if (globMatch(pattern, ruleKey)) return true;
  }
  return false;
}

function hasRuleForTool(rules: string[], toolName: string): boolean {
  return rules.some((rule) => {
    const m = /^([^()]+?)(?:\((.*)\))?$/.exec(rule.trim());
    return m?.[1]?.toLowerCase() === toolName.toLowerCase();
  });
}

function hasBareRuleForTool(rules: string[], toolName: string): boolean {
  return rules.some((rule) => rule.trim().toLowerCase() === toolName.toLowerCase());
}

/** 极简 glob：* 匹配任意字符（含空格），其余字面匹配。hooks 的 matcher 也复用它。 */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*") + "$",
  );
  return re.test(value);
}
