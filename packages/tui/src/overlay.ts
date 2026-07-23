/**
 * overlay —— 终端「浮层弹框」的帧合成层（对齐 opencode 的盖屏弹框观感）。
 *
 * Ink（flexbox 单遍布局）没有 z-index / 绝对定位，无法把一个子树叠在另一个之上。
 * 于是这里在「写 stdout」这一层做真正的合成：主界面照常整帧渲染，弹框被单独算成一组
 * 带 ANSI 样式、定宽的「精灵行」，再按居中坐标把这些行覆盖到主界面帧对应行的中间列上。
 * 背景因此在弹框四周仍然可见（截图里输入框/记录从弹框边缘透出即是此效果）。
 *
 * 只在真实 TTY 生效；ink-testing 用的是另一个 stdout，测试仍走 app.tsx 的 in-tree 渲染。
 */

import { t } from "@anicode/core";

// ---------- 显示宽度 ----------

/** 终端显示宽度：CJK/全角/emoji 记 2，其余记 1。 */
export function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      c >= 0x1100 &&
      (c <= 0x115f ||
        c === 0x2329 ||
        c === 0x232a ||
        (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe4f) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6) ||
        (c >= 0x1f300 && c <= 0x1faff) ||
        (c >= 0x20000 && c <= 0x3fffd));
    w += wide ? 2 : 1;
  }
  return w;
}

/** 按显示宽度截断，超出补省略号（保证浮层行不因超宽而折行）。 */
export function truncWidth(s: string, max: number): string {
  if (dispWidth(s) <= max) return s;
  if (max <= 0) return "";
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = dispWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

// ---------- ANSI 基元 ----------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function truecolor(hex: string, layer: 38 | 48): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[${layer};2;${r};${g};${b}m`;
}
const fgOf = (hex: string) => truecolor(hex, 38);
const bgOf = (hex: string) => truecolor(hex, 48);

/** 弹框配色（取自 opencode 截图：近黑面板 + 紫色分组标题 + 暖橙高亮/光标）。 */
export const DLG = {
  bg: "#1c1c1c",
  text: "#e6e6e6",
  dim: "#7d7d7d",
  title: "#f5f5f5",
  section: "#a78bfa",
  hlBg: "#f6b17a",
  hlFg: "#1c1c1c",
  accent: "#f6b17a",
  ok: "#7ee787",
  err: "#ff7b72",
} as const;

interface Span {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
}

function renderSpan(s: Span, baseBg: string): string {
  let pre = bgOf(s.bg ?? baseBg);
  if (s.fg) pre += fgOf(s.fg);
  if (s.bold) pre += BOLD;
  if (s.dim) pre += DIM;
  return pre + s.text + RESET;
}

/**
 * 一整行浮层内容：把各 span 顺序渲染（每段自带底色，故段间无缝，不会漏出页面底色），
 * 末尾用 baseBg 补白到定宽 width。返回串的显示宽度恒为 width。
 */
function line(width: number, spans: Span[], baseBg: string = DLG.bg): string {
  let out = "";
  let w = 0;
  for (const s of spans) {
    out += renderSpan(s, baseBg);
    w += dispWidth(s.text);
  }
  if (w < width) out += bgOf(baseBg) + " ".repeat(width - w) + RESET;
  return out;
}

/** 两端对齐行：左段靠左、右段靠右，中间用 baseBg 撑开。 */
function lineLR(width: number, left: Span[], right: Span[], baseBg: string = DLG.bg): string {
  const lw = left.reduce((a, s) => a + dispWidth(s.text), 0);
  const rw = right.reduce((a, s) => a + dispWidth(s.text), 0);
  const gap = Math.max(1, width - lw - rw);
  return line(width, [...left, { text: " ".repeat(gap) }, ...right], baseBg);
}

// ---------- 帧合成 ----------

export interface Sprite {
  /** 精灵首行相对整帧顶端的行号（0 基）。 */
  top: number;
  /** 精灵左列相对整帧左缘的列号（0 基）。 */
  left: number;
  /** 精灵定宽（显示列数）。 */
  width: number;
  /** 逐行 ANSI 串，每行显示宽度均为 width。 */
  lines: string[];
  /** 可点击精灵每个本地行对应的选项索引；标题、留白等不可点击行用 null。 */
  hitRows?: Array<number | null>;
}

/** 用 xterm SGR 的 1 基坐标命中精灵选项；弹框外或不可点击行返回 null。 */
export function hitTestSprite(sprite: Sprite, column: number, row: number): number | null {
  const x = column - 1;
  const y = row - 1;
  if (x < sprite.left || x >= sprite.left + sprite.width) return null;
  const localRow = y - sprite.top;
  if (localRow < 0 || localRow >= sprite.lines.length) return null;
  return sprite.hitRows?.[localRow] ?? null;
}

/** 去掉 ANSI 控制序列，仅留可见字符（用于量可见宽度）。 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function visWidth(s: string): number {
  return dispWidth(stripAnsi(s));
}

/**
 * 取 ANSI 串在可见列区间 [start, end) 内的片段，保留样式：
 * 从 start 起第一次落笔时补齐此刻仍生效的 SGR 状态（右半段切片才能续上颜色），
 * 被窗口边界劈开的宽字符用空格占位以免整行错列。末尾复位。
 */
export function sliceAnsi(str: string, start: number, end: number): string {
  let col = 0;
  let out = "";
  let style = ""; // 自上次 reset 以来累积的 SGR 序列
  let emitted: string | null = null; // 已落笔的样式，避免重复吐同一串 SGR
  let i = 0;
  const sgr = /\x1b\[[0-9;]*m/y;
  while (i < str.length) {
    const ch = str[i]!;
    if (ch === "\x1b") {
      sgr.lastIndex = i;
      const m = sgr.exec(str);
      if (m) {
        const seq = m[0];
        if (seq === "\x1b[0m" || seq === "\x1b[m") style = "";
        else style += seq;
        i += seq.length;
        continue;
      }
      // 其它 CSI 控制序列：跳过不计宽（帧体里一般只有 SGR，这里兜底）。
      let j = i + 2;
      while (j < str.length && !/[A-Za-z]/.test(str[j]!)) j++;
      i = j + 1;
      continue;
    }
    const cp = str.codePointAt(i)!;
    const chStr = String.fromCodePoint(cp);
    const cw = dispWidth(chStr);
    const cStart = col;
    const cEnd = col + cw;
    if (cStart >= end) break;
    if (cEnd <= start) {
      col = cEnd;
      i += chStr.length;
      continue;
    }
    if (emitted !== style) {
      out += style || RESET;
      emitted = style;
    }
    if (cStart < start || cEnd > end) {
      // 边界劈开的宽字符：只画落在窗口内的那部分列，用空格顶位。
      out += " ".repeat(Math.min(cEnd, end) - Math.max(cStart, start));
    } else {
      out += chStr;
    }
    col = cEnd;
    i += chStr.length;
  }
  return out + RESET;
}

/** 把 insert（定宽 insertW）覆盖到 bgLine 的 [left, left+insertW) 列上，两侧背景续接。 */
function spliceAnsi(bgLine: string, left: number, insert: string, insertW: number): string {
  const leftPart = sliceAnsi(bgLine, 0, left);
  const bgW = visWidth(bgLine);
  const pad = left > bgW ? " ".repeat(left - bgW) : "";
  const rightPart = sliceAnsi(bgLine, left + insertW, Number.POSITIVE_INFINITY);
  return leftPart + RESET + pad + insert + RESET + rightPart + RESET;
}

/** 把精灵合成进整帧的行数组（就地返回新数组）。 */
export function compositeFrame(lines: string[], sprite: Sprite): string[] {
  const out = lines.slice();
  for (let i = 0; i < sprite.lines.length; i++) {
    const row = sprite.top + i;
    if (row < 0) continue;
    while (out.length <= row) out.push("");
    out[row] = spliceAnsi(out[row]!, sprite.left, sprite.lines[i]!, sprite.width);
  }
  return out;
}

// ---------- 弹框精灵构建 ----------

const PADX = 2;
const PAD: Span = { text: " ".repeat(PADX) };

/**
 * 居中定位并封装成 Sprite。弹框整体高度封顶（不铺满整屏）：留出上下边距，
 * 超高时由各构建器自行开窗（此处只兜底，正常不会触发）。
 */
function place(lines: string[], width: number, termRows: number, termCols: number): Sprite {
  const top = Math.max(0, Math.floor((termRows - lines.length) / 2));
  const left = Math.max(0, Math.floor((termCols - width) / 2));
  return { top, left, width, lines };
}

/**
 * 贴着锚点行「向上」停放：精灵末行落在 anchorTop-1（锚点行之上），首行据高度上推。
 * 用于把斜杠命令菜单钉在输入框正上方（对齐截图：面板方向朝上、位于输入框之上）。
 */
function placeAbove(lines: string[], width: number, anchorTop: number, left: number): Sprite {
  const top = Math.max(0, anchorTop - lines.length);
  return { top, left: Math.max(0, left), width, lines };
}

/** 弹框宽度上限与可读下限：随终端变窄而缩，但不缩到看不清；比屏还窄触发横向滚动。 */
export const DIALOG_MAX = 64;
export const DIALOG_MIN = 30;

function dialogWidth(termCols: number): number {
  // 想要留 2 列边距、封顶 64；终端更窄就跟着缩，直到可读下限 DIALOG_MIN。
  // 低于下限（超窄终端）时仍按 DIALOG_MIN 出图，交由 windowHorizontally 横向开窗。
  return Math.min(DIALOG_MAX, Math.max(DIALOG_MIN, termCols - 2));
}

/** 横向滚动条：轨道 ─、滑块 █、两端 ◀▶ 表示还可左右；整行显示宽度恒为 view。 */
function hbar(view: number, total: number, off: number): string {
  const maxOff = total - view;
  const inner = Math.max(1, view - 2);
  const thumb = Math.max(1, Math.min(inner, Math.round((inner * view) / total)));
  const pos = maxOff <= 0 ? 0 : Math.round((off / maxOff) * (inner - thumb));
  let track = "";
  for (let i = 0; i < inner; i++) track += i >= pos && i < pos + thumb ? "█" : "─";
  const left = off > 0 ? "◀" : " ";
  const right = off < maxOff ? "▶" : " ";
  return fgOf(DLG.accent) + left + fgOf(DLG.dim) + track + fgOf(DLG.accent) + right + RESET;
}

/**
 * 超窄终端兜底：精灵比屏还宽（弹框已缩到可读下限仍放不下）时，把它横向开窗到屏宽，
 * 底部补一行横向滚动条指示可见区间。hoff 为左端裁掉的列数（自动 clamp 到 [0, width-view]）。
 * 精灵不比屏宽时原样返回（正常情况不触发）。
 */
export function windowHorizontally(sprite: Sprite, termCols: number, hoff: number): Sprite {
  if (sprite.width <= termCols || termCols < 2) return sprite;
  const view = termCols;
  const off = Math.max(0, Math.min(hoff, sprite.width - view));
  const lines = sprite.lines.map((l) => sliceAnsi(l, off, off + view));
  lines.push(hbar(view, sprite.width, off));
  // 多出的滚动条行占一行高度：整体上移一行，避免越过屏底。
  return {
    top: Math.max(0, sprite.top - 1),
    left: 0,
    width: view,
    lines,
    ...(sprite.hitRows ? { hitRows: [...sprite.hitRows, null] } : {}),
  };
}

/** 固定高度仍需适配矮终端：正常取 ideal，放不下时留出上下各 2 行背景。 */
function fixedOverlayHeight(termRows: number, ideal: number, minimum: number): number {
  return Math.min(termRows, Math.min(ideal, Math.max(minimum, termRows - 4)));
}

/** 围绕当前高亮行开窗；内容不足时补满，保证弹框高度不随筛选结果跳动。 */
function scrollWindow<T>(
  rows: readonly T[],
  selected: number,
  height: number,
  filler: () => T,
): T[] {
  if (height <= 0) return [];
  const idx = Math.max(0, Math.min(selected, rows.length - 1));
  const start =
    rows.length > height
      ? Math.min(Math.max(0, idx - Math.floor(height / 2)), rows.length - height)
      : 0;
  const visible = rows.slice(start, start + height);
  while (visible.length < height) visible.push(filler());
  return visible;
}

/** 模型选择器精灵（对齐截图：标题/esc、搜索行、紫色分组标题、暖橙整行高亮、右侧 Free 标签）。 */
export interface PickerLikeRow {
  label: string;
  providerName: string;
  free: boolean;
  ready: boolean | undefined;
  readyHint: string;
}

export function buildModelPickerOverlay(
  visible: readonly PickerLikeRow[],
  index: number,
  filter: string,
  termRows: number,
  termCols: number,
): Sprite {
  const width = dialogWidth(termCols);
  const height = fixedOverlayHeight(termRows, 22, 8);
  const viewportHeight = Math.max(1, height - 6);
  const inner = width - 2 * PADX;
  const blank = () => line(width, []);
  const bodyL = (spans: Span[], baseBg: string = DLG.bg) => line(width, [PAD, ...spans], baseBg);
  const bodyLR = (l: Span[], r: Span[], baseBg: string = DLG.bg) =>
    lineLR(width, [PAD, ...l], [...r, PAD], baseBg);

  const L: string[] = [];
  L.push(blank());
  L.push(
    bodyLR(
      [{ text: t("Select model", "选择模型"), fg: DLG.title, bold: true }],
      [{ text: "esc", fg: DLG.dim }],
    ),
  );
  L.push(blank());
  // 搜索行：词后跟一格橙色光标块；无词时光标块在最前、占位整段灰字（不反白盖住整个字）。
  L.push(
    filter
      ? bodyL([
          { text: filter, fg: DLG.text },
          { text: " ", bg: DLG.accent },
        ])
      : bodyL([
          { text: " ", bg: DLG.accent },
          { text: t("Search…", "搜索…"), fg: DLG.dim },
        ]),
  );

  L.push(blank());
  const content: Array<{ rendered: string; modelIndex?: number }> = [];
  if (visible.length === 0) {
    content.push({
      rendered: bodyL([{ text: t("(no matching models)", "（无匹配模型）"), fg: DLG.dim }]),
    });
  } else {
    visible.forEach((row, modelIndex) => {
      const prev = visible[modelIndex - 1];
      if (modelIndex === 0 || prev?.providerName !== row.providerName) {
        content.push({ rendered: blank() });
        content.push({
          rendered: bodyL([{ text: row.providerName, fg: DLG.section, bold: true }]),
        });
      }
      const tag = row.free ? "Free" : row.ready === false ? row.readyHint : "";
      if (modelIndex === index) {
        const label = truncWidth(`● ${row.label}`, inner - dispWidth(tag) - 1);
        content.push({
          modelIndex,
          rendered: bodyLR(
            [{ text: label, fg: DLG.hlFg, bold: true }],
            [{ text: tag, fg: DLG.hlFg }],
            DLG.hlBg,
          ),
        });
      } else {
        const label = truncWidth(row.label, inner - dispWidth(tag) - 3);
        content.push({
          modelIndex,
          rendered: bodyLR([{ text: `  ${label}`, fg: DLG.text }], [{ text: tag, fg: DLG.dim }]),
        });
      }
    });
  }
  const selectedLine = Math.max(
    0,
    content.findIndex((entry) => entry.modelIndex === index),
  );
  const win = scrollWindow<{ rendered: string; modelIndex?: number }>(
    content,
    selectedLine,
    viewportHeight,
    () => ({ rendered: blank() }),
  );
  L.push(...win.map((entry) => entry.rendered));
  L.push(blank());
  return {
    ...place(L, width, termRows, termCols),
    hitRows: [null, null, null, null, null, ...win.map((entry) => entry.modelIndex ?? null), null],
  };
}

/** 会话列表精灵。 */
export interface SessionLikeRow {
  id: string;
  running: boolean;
  title?: string;
  model: string;
}

export interface SessionsOverlayOptions {
  /** 当前筛选结果里的高亮索引。 */
  index?: number;
  /** 搜索框内容；筛选本身由调用方完成，浮层只负责回显。 */
  filter?: string;
  /** 当前已经打开的会话，用圆点标记。 */
  currentId?: string;
}

export function buildSessionsOverlay(
  sessions: readonly SessionLikeRow[],
  termRows: number,
  termCols: number,
  options: SessionsOverlayOptions = {},
): Sprite {
  const width = dialogWidth(termCols);
  const height = fixedOverlayHeight(termRows, 18, 8);
  const viewportHeight = Math.max(1, height - 7);
  const inner = width - 2 * PADX;
  const index = Math.max(0, Math.min(options.index ?? 0, sessions.length - 1));
  const filter = options.filter ?? "";
  const blank = () => line(width, []);
  const bodyL = (spans: Span[], baseBg: string = DLG.bg) => line(width, [PAD, ...spans], baseBg);
  const bodyLR = (l: Span[], r: Span[], baseBg: string = DLG.bg) =>
    lineLR(width, [PAD, ...l], [...r, PAD], baseBg);

  const L: string[] = [];
  L.push(blank());
  L.push(
    bodyLR(
      [{ text: t("Sessions", "会话列表"), fg: DLG.title, bold: true }],
      [{ text: "esc", fg: DLG.dim }],
    ),
  );
  L.push(blank());
  L.push(
    filter
      ? bodyL([
          { text: filter, fg: DLG.text },
          { text: " ", bg: DLG.accent },
        ])
      : bodyL([
          { text: " ", bg: DLG.accent },
          { text: t("Search sessions…", "搜索会话…"), fg: DLG.dim },
        ]),
  );
  L.push(blank());

  const content = sessions.map((s, sessionIndex) => {
    const selected = sessionIndex === index;
    const current = s.id === options.currentId;
    const state = s.running ? t("running", "运行中") : current ? t("current", "当前") : "";
    const prefix = `${current ? "●" : " "} ${s.title ?? t("(untitled)", "(无标题)")} · ${s.id}`;
    const right = state || s.model;
    const label = truncWidth(prefix, Math.max(1, inner - dispWidth(right) - 1));
    return {
      sessionIndex,
      rendered: bodyLR(
        [{ text: label, fg: selected ? DLG.hlFg : current ? DLG.ok : DLG.text, bold: selected }],
        [{ text: right, fg: selected ? DLG.hlFg : s.running ? DLG.accent : DLG.dim }],
        selected ? DLG.hlBg : DLG.bg,
      ),
    };
  });
  if (content.length === 0) {
    content.push({
      rendered: bodyL([
        {
          text: filter
            ? t("(no matching sessions)", "（无匹配会话）")
            : t("(no sessions)", "（暂无会话）"),
          fg: DLG.dim,
        },
      ]),
      sessionIndex: -1,
    });
  }
  const win = scrollWindow(content, index, viewportHeight, () => ({
    rendered: blank(),
    sessionIndex: -1,
  }));
  L.push(...win.map((entry) => entry.rendered));
  L.push(
    bodyLR(
      [{ text: t("Enter open", "Enter 打开"), fg: DLG.dim }],
      [{ text: t("↑↓ select", "↑↓ 选择"), fg: DLG.dim }],
    ),
  );
  L.push(blank());
  return {
    ...place(L, width, termRows, termCols),
    hitRows: [
      null,
      null,
      null,
      null,
      null,
      ...win.map((entry) => (entry.sessionIndex >= 0 ? entry.sessionIndex : null)),
      null,
      null,
    ],
  };
}

/** 授权请求精灵。 */
export interface PermissionLike {
  toolName: string;
  ruleKey: string;
}

export function buildPermissionOverlay(
  pendings: readonly PermissionLike[],
  termRows: number,
  termCols: number,
): Sprite {
  const width = dialogWidth(termCols);
  const inner = width - 2 * PADX;
  const p = pendings[0]!;
  const blank = () => line(width, []);
  const bodyL = (spans: Span[]) => line(width, [PAD, ...spans]);
  const bodyLR = (l: Span[], r: Span[]) => lineLR(width, [PAD, ...l], [...r, PAD]);

  const L: string[] = [];
  L.push(blank());
  L.push(
    bodyLR(
      [{ text: t("⚠ Permission request", "⚠ 授权请求"), fg: DLG.accent, bold: true }],
      pendings.length > 1
        ? [
            {
              text: t(`${pendings.length - 1} more`, `还有 ${pendings.length - 1} 个`),
              fg: DLG.dim,
            },
          ]
        : [],
    ),
  );
  L.push(blank());
  L.push(
    bodyL([
      { text: t("Tool ", "工具 "), fg: DLG.dim },
      { text: p.toolName, fg: DLG.text, bold: true },
    ]),
  );
  L.push(bodyL([{ text: truncWidth(p.ruleKey, inner), fg: DLG.dim }]));
  L.push(blank());
  L.push(
    bodyL([
      { text: "[", fg: DLG.dim },
      { text: "y", fg: DLG.ok, bold: true },
      { text: t("] allow   [", "] 允许   ["), fg: DLG.dim },
      { text: "a", fg: DLG.accent, bold: true },
      { text: t("] allow and remember   [", "] 允许并记住   ["), fg: DLG.dim },
      { text: "n", fg: DLG.err, bold: true },
      { text: t("] deny", "] 拒绝"), fg: DLG.dim },
    ]),
  );
  L.push(blank());
  L.push(bodyLR([{ text: t("esc interrupt", "esc 中断"), fg: DLG.dim }], []));
  L.push(blank());
  return place(L, width, termRows, termCols);
}

/** 斜杠命令菜单行（名字不含前导 `/`）。 */
export interface CommandMenuRow {
  name: string;
  description: string;
}

/**
 * 斜杠命令补全菜单精灵：钉在输入框正上方、方向朝上（对齐截图 #1）。
 * 左列命令名对齐、右侧描述灰字；高亮项整行暖橙底。菜单固定高度，超长列表在
 * 内容区域内随高亮项滚动。anchorTop 为输入框首行的整帧行号，菜单末行落在其上一行。
 */
export function buildCommandMenuOverlay(
  rows: readonly CommandMenuRow[],
  index: number,
  anchorTop: number,
  termRows: number,
  termCols: number,
): Sprite {
  // 命令菜单平铺整屏宽（对齐输入框左右缘）；放不下的描述按列截断，故无需横向滚动。
  const width = Math.max(1, termCols);
  const inner = Math.max(1, width - 2 * PADX);
  const blank = () => line(width, []);
  const bodyL = (spans: Span[], baseBg: string = DLG.bg) => line(width, [PAD, ...spans], baseBg);

  // 命令名列宽：取最长命令名（含 `/`）但不超过 18 列，之后留 2 列间隔再接描述。
  const nameCol = Math.min(18, Math.max(1, ...rows.map((r) => dispWidth("/" + r.name)))) + 2;
  const height = Math.max(1, Math.min(12, anchorTop, termRows));
  const viewportHeight = Math.max(0, height - 2);
  const idx = Math.max(0, Math.min(index, rows.length - 1));
  const start =
    rows.length > viewportHeight
      ? Math.min(Math.max(0, idx - Math.floor(viewportHeight / 2)), rows.length - viewportHeight)
      : 0;
  const win = rows.slice(start, start + viewportHeight);

  const L: string[] = [];
  L.push(blank());
  win.forEach((row, i) => {
    const gi = start + i;
    const selected = gi === idx;
    const name = "/" + row.name;
    const namePad = name + " ".repeat(Math.max(1, nameCol - dispWidth(name)));
    const desc = truncWidth(row.description, Math.max(1, inner - dispWidth(namePad)));
    if (selected) {
      L.push(
        bodyL(
          [
            { text: namePad, fg: DLG.hlFg, bold: true },
            { text: desc, fg: DLG.hlFg },
          ],
          DLG.hlBg,
        ),
      );
    } else {
      L.push(
        bodyL([
          { text: namePad, fg: DLG.accent },
          { text: desc, fg: DLG.dim },
        ]),
      );
    }
  });
  while (L.length < height - 1) L.push(blank());
  if (L.length < height) L.push(blank());
  // 与输入框左缘对齐（列 0），末行停在输入框上一行。
  return {
    ...placeAbove(L, width, anchorTop, 0),
    hitRows: [
      null,
      ...win.map((_, i) => start + i),
      ...Array.from({ length: Math.max(0, height - win.length - 1) }, () => null),
    ],
  };
}
