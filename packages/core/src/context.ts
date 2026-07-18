/**
 * 上下文管理 —— 两件事：
 *
 * 1. 项目记忆（AGENTS.md / CLAUDE.md）：从 cwd 向上逐级查找并拼进 system 提示，
 *    让 agent 知道项目约定。业界已趋同于 AGENTS.md。
 *
 * 2. Compaction：历史增长到接近上下文上限时，把较旧的若干轮压缩成一段摘要，
 *    换回若干 token 空间，同时保留最近若干轮原文。摘要动作用一个「summarizer」
 *    函数完成（可注入 —— 生产用小模型，测试用假实现），因此本模块可离线测试。
 *
 * token 估算用字符数近似（1 token ≈ 4 char），够 compaction 触发判断用；
 * 精确计费仍以 provider 返回的 usage 为准。
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { t } from "./i18n.js";
import type { ChatMessage, ContentPart } from "./types.js";

// ---------- 项目记忆 ----------

const MEMORY_FILES = ["AGENTS.md", "CLAUDE.md"];

/** 从 cwd 向上（到文件系统根或 .git 边界）收集所有记忆文件，就近优先拼接 */
export async function loadProjectMemory(cwd: string): Promise<string> {
  const chunks: string[] = [];
  let dir = path.resolve(cwd);
  const seenGitRoot = { hit: false };

  while (true) {
    for (const name of MEMORY_FILES) {
      const file = path.join(dir, name);
      try {
        const text = await fs.readFile(file, "utf8");
        chunks.push(
          `${t("# Project memory", "# 项目记忆")}（${path.relative(cwd, file) || name}）\n${text.trim()}`,
        );
      } catch {
        /* 文件不存在，跳过 */
      }
    }
    // 到 .git 所在目录就停（项目边界）
    try {
      await fs.access(path.join(dir, ".git"));
      seenGitRoot.hit = true;
    } catch {
      /* no .git here */
    }
    const parent = path.dirname(dir);
    if (parent === dir || seenGitRoot.hit) break;
    dir = parent;
  }
  return chunks.join("\n\n");
}

/** 把项目记忆拼到基础 system 提示后面 */
export function composeSystem(base: string, projectMemory: string): string {
  if (!projectMemory) return base;
  return `${base}\n\n${projectMemory}`;
}

// ---------- token 估算 ----------

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const part of m.content) chars += partChars(part);
  }
  return Math.ceil(chars / 4);
}

function partChars(part: ContentPart): number {
  switch (part.type) {
    case "text":
    case "thinking":
      return part.text.length;
    case "tool_call":
      return part.name.length + JSON.stringify(part.args).length;
    case "tool_result":
      return part.content.length;
    case "image":
      return 1000; // 图片按固定近似
  }
}

// ---------- Compaction ----------

export type Summarizer = (messages: ChatMessage[]) => Promise<string>;

export interface CompactionConfig {
  /** 触发阈值（token 估算）。默认 120k（给 1M 窗口留足余量 + 控成本） */
  triggerTokens?: number;
  /** 压缩后保留的最近轮数（一轮 = 一个 user + 后续 assistant/tool 往返） */
  keepRecentMessages?: number;
  /** microcompaction 保留原文的最近 tool_result 个数（默认 5） */
  keepToolResults?: number;
  summarizer: Summarizer;
}

export interface CompactionResult {
  messages: ChatMessage[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
}

/** 纯文本 user 消息（不含 tool_result）—— 唯一安全的压缩切割点 */
function isPlainUserText(m: ChatMessage): boolean {
  return m.role === "user" && !m.content.some((p) => p.type === "tool_result");
}

/**
 * 找一个安全的切割点：保留窗口必须始于纯文本 user 消息。
 * 若从 cutoff 处切会把 tool_use/tool_result 对切断（保留窗口以 tool_result 开头，
 * 其对应的 tool_use 已被摘要吞掉），provider 回放会直接 400。
 * 策略：从期望 cutoff 向后（更晚）找最近的安全边界；找不到再向前找；都没有则放弃压缩。
 */
function findSafeCutoff(history: ChatMessage[], desired: number): number | null {
  for (let i = desired; i < history.length; i++) {
    if (isPlainUserText(history[i]!)) return i;
  }
  for (let i = desired - 1; i > 0; i--) {
    if (isPlainUserText(history[i]!)) return i;
  }
  return null;
}

/** 已折叠工具结果的稳定前缀标记 —— 用于幂等判定，避免二次折叠越折越怪。 */
const FOLDED_MARKER = t("[Folded old tool result", "[已折叠的旧工具结果");

/**
 * 折叠一个旧 tool_result：保留开头一段（信息密度最高）+ 原始长度，其余清掉。
 * 相比「整段替换成固定占位符」的全丢弃，模型仍能看到结果头部这一线索（对齐 Claude Code
 * 的 microcompaction 思路：不是删除而是卸载/降采样）。head 自适应，保证折叠后必然更短。
 */
function foldToolResult(content: string): string {
  const head = content.slice(0, Math.min(160, Math.floor(content.length * 0.4)));
  const ellipsis = content.length > head.length ? "…" : "";
  return `${FOLDED_MARKER}${t(
    `· ${content.length} chars originally; body cleared to free context, head kept for reference]`,
    `·原 ${content.length} 字符，正文已清理以释放上下文，仅保留开头供参考]`,
  )}\n${head}${ellipsis}`;
}

/**
 * Microcompaction（第一级压缩，对齐 Claude Code 的 "clears older tool outputs first"）：
 * 把较旧的 tool_result 折叠为「开头摘录 + 长度」，只保留最近 keepRecent 个结果原文。
 * 关键不变量：tool_use/tool_result 的配对结构原样保留 —— 只清内容不动骨架，
 * 回放永远合法。比全量摘要便宜（无需模型调用），先试它。
 */
export function microcompact(
  history: ChatMessage[],
  keepRecent = 5,
): { messages: ChatMessage[]; cleared: number } {
  const qualifies = (p: ContentPart): p is Extract<ContentPart, { type: "tool_result" }> =>
    p.type === "tool_result" && p.content.length > 200 && !p.content.startsWith(FOLDED_MARKER);

  let total = 0;
  for (const m of history) for (const p of m.content) if (qualifies(p)) total++;
  const toClear = Math.max(0, total - keepRecent);
  if (toClear === 0) return { messages: history, cleared: 0 };

  let cleared = 0;
  const messages = history.map((m) => {
    if (m.role !== "user" || cleared >= toClear || !m.content.some((p) => qualifies(p))) return m;
    return {
      ...m,
      content: m.content.map((p) => {
        if (cleared < toClear && qualifies(p)) {
          cleared++;
          return { ...p, content: foldToolResult(p.content) };
        }
        return p;
      }),
    };
  });
  return { messages, cleared };
}

/**
 * 两级压缩。超阈值时：
 *   L1 microcompaction —— 清旧 tool_result 为占位符（保配对结构），若已回到阈值
 *      八成以下则到此为止（省一次摘要调用）；
 *   L2 全量摘要 —— [旧消息] → summarizer 摘要成一条 assistant「上下文摘要」消息，
 *      接上最近若干条原文（从安全边界起，见 findSafeCutoff）。
 * 否则原样返回。
 *
 * 保证：
 *   - 第一条一定是 user（摘要包成 user→assistant 对，满足角色交替）
 *   - 保留窗口始于纯文本 user 消息，绝不切断 tool_use/tool_result 对
 */
/**
 * 是否已达压缩触发线（与 maybeCompact 的触发判定完全一致）。
 * 供调用方在真正压缩前触发 PreCompact hook 等前置动作。
 */
export function compactionPending(
  history: ChatMessage[],
  cfg: CompactionConfig,
  actualInputTokens?: number,
): boolean {
  const trigger = cfg.triggerTokens ?? 120_000;
  const before =
    actualInputTokens !== undefined && actualInputTokens > 0
      ? actualInputTokens
      : estimateTokens(history);
  return before >= trigger;
}

export async function maybeCompact(
  history: ChatMessage[],
  cfg: CompactionConfig,
  /**
   * 上一次 provider 调用返回的真实输入 token（含 system+tools，estimateTokens 统计不到）。
   * 有值时用它判定触发、并把后续估算按 真实/估算 比例缩放到真实 token 尺度 ——
   * 中文/代码下 char/4 会显著低估，容易压缩过晚。缺省回退纯估算。
   */
  actualInputTokens?: number,
  /** force：跳过触发线判定，立即压缩（手动 /compact）。 */
  opts?: { force?: boolean },
): Promise<CompactionResult> {
  const original = history;
  const trigger = cfg.triggerTokens ?? 120_000;
  const keep = cfg.keepRecentMessages ?? 6;
  const estBefore = estimateTokens(history);
  const hasActual = actualInputTokens !== undefined && actualInputTokens > 0;
  const before = hasActual ? actualInputTokens! : estBefore;
  // 把 estimateTokens 的结果投影到真实尺度：scale = 真实/估算。
  const scale = hasActual && estBefore > 0 ? actualInputTokens! / estBefore : 1;
  const real = (msgs: ChatMessage[]): number => Math.round(estimateTokens(msgs) * scale);

  if (!opts?.force && before < trigger) {
    return { messages: history, compacted: false, beforeTokens: before, afterTokens: before };
  }

  // L1：microcompaction
  const micro = microcompact(history, cfg.keepToolResults ?? 5);
  if (micro.cleared > 0) {
    const afterMicro = real(micro.messages);
    if (afterMicro <= trigger * 0.8) {
      return {
        messages: micro.messages,
        compacted: true,
        beforeTokens: before,
        afterTokens: afterMicro,
      };
    }
    history = micro.messages; // 保留窗口可用清理版；摘要输入仍必须用 original
  }

  if (history.length <= keep + 2) {
    // 短历史做不了摘要；若 micro 有斩获也算一次有效压缩
    return {
      messages: history,
      compacted: micro.cleared > 0,
      beforeTokens: before,
      afterTokens: real(history),
    };
  }

  const cutoff = findSafeCutoff(history, history.length - keep);
  if (cutoff === null || cutoff === 0) {
    // 没有安全切割点（如整段都是一个超长工具往返），放弃摘要；micro 的斩获仍生效
    return {
      messages: history,
      compacted: micro.cleared > 0,
      beforeTokens: before,
      afterTokens: real(history),
    };
  }
  // 摘要必须看到原始旧历史；若拿 microcompact 后的占位符去摘要，会永久丢掉
  // 正是摘要最该保留的旧工具结论。结构相同，因此 cutoff 可安全复用。
  const older = original.slice(0, cutoff);
  const recent = history.slice(cutoff);

  const summary = await cfg.summarizer(older);
  const compactedPair: ChatMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: t(
            "[The earlier conversation was compacted; a summary follows — continue from it]",
            "[此前对话已压缩，以下是摘要，请据此继续]",
          ),
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: summary }] },
  ];

  // 确保 recent 从 user 开始；若不是，前面的 assistant 摘要对已经保证了交替
  const messages = [...compactedPair, ...recent];
  return { messages, compacted: true, beforeTokens: before, afterTokens: real(messages) };
}

/** 基于 provider 的默认 summarizer 工厂（生产用）。测试可注入假实现。 */
export function providerSummarizer(
  stream: (
    messages: ChatMessage[],
    system: string,
  ) => AsyncIterable<{ type: string; text?: string }>,
): Summarizer {
  return async (messages) => {
    const system = t(
      "You are a context compactor. Compress the conversation history below into a concise but " +
        "information-complete summary: keep the key decisions made, files changed, unfinished tasks, " +
        "and important facts. Use a bullet list, no pleasantries.",
      "你是上下文压缩器。把下面的对话历史压缩成简洁但信息完整的摘要：保留已做的关键决定、" +
        "改动过的文件、未完成的任务、重要事实。用要点列表，不要寒暄。",
    );
    const flattened: ChatMessage = {
      role: "user",
      content: [{ type: "text", text: renderHistory(messages) }],
    };
    let out = "";
    for await (const ev of stream([flattened], system)) {
      if (ev.type === "text" && ev.text) out += ev.text;
    }
    return out.trim() || t("(empty summary)", "（摘要为空）");
  };
}

function renderHistory(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const part of m.content) {
      if (part.type === "text") lines.push(`${m.role}: ${part.text}`);
      else if (part.type === "tool_call")
        lines.push(
          `${m.role} ${t("called tool", "调用工具")} ${part.name}(${JSON.stringify(part.args)})`,
        );
      else if (part.type === "tool_result")
        lines.push(`${t("tool result", "工具结果")}: ${part.content.slice(0, 500)}`);
    }
  }
  return lines.join("\n");
}
