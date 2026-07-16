/**
 * App —— Ink 前端，只依赖 SessionHost 接口（本地 or daemon 一视同仁）。
 *
 * 职责：订阅当前会话的事件流并渲染；收集输入（含 /斜杠命令）；把权限请求
 * 变成 y/a/n 交互回 answerPermission。会话逻辑全在 core，App 不碰。
 *
 * 斜杠命令：/help · /status · /providers · /model <provider/model> · /sessions · /resume <id> · /new [标题] · /undo · /exit
 */

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout, type DOMElement } from "ink";
import {
  probeLocalProviders,
  expandCommand,
  t,
  getLang,
  setLang,
  onLangChange,
} from "@anicode/core";
import type {
  ChatMessage,
  CustomCommand,
  ModelCatalogEntry,
  ProviderDescriptor,
  SessionEvent,
  SessionHost,
  SessionMeta,
  SessionSummary,
  TodoItem,
  Usage,
} from "@anicode/core";
import { expandFileMentions } from "./mentions.js";
import {
  messagesToItems,
  todosFromMessages,
  firstLine,
  truncate,
  type Item,
} from "./transcript.js";
import { ensureOllama } from "./ollama.js";
import {
  compositeFrame,
  buildModelPickerOverlay,
  buildSessionsOverlay,
  buildPermissionOverlay,
  buildCommandMenuOverlay,
  windowHorizontally,
  dispWidth,
  truncWidth,
  type Sprite,
  type CommandMenuRow,
} from "./overlay.js";

// dispWidth 现居 overlay.ts（合成层与渲染层共用）；沿用旧导出路径供测试引用。
export { dispWidth };

/** transcript 行：既有条目 + 欢迎 logo（logo 放进 Static 只画一次，避免动态区重绘鬼影）。 */
type Row = Item | { kind: "logo" };

interface State {
  /** 只追加的已完成 transcript；Ink Static 不支持原位更新。 */
  items: Row[];
  /** 尚未产生 tool_result 的调用，在 Static 下方动态渲染。 */
  activeTools: Map<string, Extract<Item, { kind: "tool" }>>;
  liveText: string;
  running: boolean;
  usage: Usage;
  todos: TodoItem[];
  meta: { id: string; cwd: string; model: string; title?: string };
  /** 每次成功 open 都重挂 Static，避免会话切换时沿用旧索引。 */
  generation: number;
  opening: boolean;
}

type Action =
  | {
      t: "reset";
      items: Row[];
      activeTools: Map<string, Extract<Item, { kind: "tool" }>>;
      usage: Usage;
      running: boolean;
      todos: TodoItem[];
      meta: State["meta"];
    }
  | { t: "opening"; v: boolean }
  | { t: "push"; item: Item }
  | { t: "live"; delta: string }
  | { t: "resetLive" }
  | { t: "flushLive" }
  | { t: "toolStart"; id: string; name: string; ruleKey: string }
  | { t: "toolDeny"; id: string }
  | { t: "toolFinish"; id: string; status: "ok" | "err"; detail?: string }
  | { t: "running"; v: boolean }
  | { t: "usage"; u: Usage }
  | { t: "todos"; todos: TodoItem[] };

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case "reset":
      return {
        items: a.items,
        activeTools: a.activeTools,
        liveText: "",
        running: a.running,
        usage: a.usage,
        todos: a.todos,
        meta: a.meta,
        generation: s.generation + 1,
        opening: false,
      };
    case "opening":
      return { ...s, opening: a.v };
    case "push":
      return { ...s, items: [...s.items, a.item] };
    case "live":
      return { ...s, liveText: s.liveText + a.delta };
    case "resetLive":
      return { ...s, liveText: "" };
    case "flushLive":
      if (!s.liveText) return s;
      return { ...s, items: [...s.items, { kind: "assistant", text: s.liveText }], liveText: "" };
    case "toolStart": {
      const activeTools = new Map(s.activeTools);
      const previous = activeTools.get(a.id);
      activeTools.set(a.id, {
        kind: "tool",
        id: a.id,
        name: a.name,
        ruleKey: a.ruleKey,
        status: previous?.status === "deny" ? "deny" : "run",
      });
      return { ...s, activeTools };
    }
    case "toolDeny": {
      const current = s.activeTools.get(a.id);
      if (!current) return s;
      const activeTools = new Map(s.activeTools);
      activeTools.set(a.id, { ...current, status: "deny" });
      return { ...s, activeTools };
    }
    case "toolFinish": {
      const current = s.activeTools.get(a.id);
      if (!current) return s;
      const activeTools = new Map(s.activeTools);
      activeTools.delete(a.id);
      const status = current.status === "deny" ? "deny" : a.status;
      const item: Extract<Item, { kind: "tool" }> = {
        ...current,
        status,
        ...(a.detail ? { detail: a.detail } : {}),
      };
      return { ...s, activeTools, items: [...s.items, item] };
    }
    case "running":
      return { ...s, running: a.v };
    case "usage":
      return { ...s, usage: a.u };
    case "todos":
      return { ...s, todos: a.todos };
  }
}

const emptyUsage: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** 品牌名（欢迎页 logo 与状态栏）。 */
export const APP_NAME = "anicode";

/** 内置斜杠命令（名字不含前导 `/`），供命令补全菜单展示与运行。描述按当前语言取词。 */
function builtinCommands(): CommandMenuRow[] {
  return [
    { name: "help", description: t("Show command help", "显示命令帮助") },
    {
      name: "status",
      description: t("Show current session, model and directory", "显示当前会话、模型与目录"),
    },
    {
      name: "providers",
      description: t("List providers and credential hints", "列出 provider 及凭证提示"),
    },
    {
      name: "model",
      description: t(
        "Open the built-in model picker (incl. free/open)",
        "打开内置模型选择器（含免费/开源）",
      ),
    },
    { name: "sessions", description: t("List recent sessions", "列出最近会话") },
    {
      name: "resume",
      description: t("Resume an existing session /resume <id>", "载入已有会话 /resume <id>"),
    },
    {
      name: "new",
      description: t("New session with current model and directory", "以当前模型和目录新建会话"),
    },
    {
      name: "undo",
      description: t(
        "Undo the last turn's file changes (git rollback)",
        "撤销上一轮文件改动（git 回滚）",
      ),
    },
    {
      name: "plan",
      description: t(
        "Toggle plan mode: read-only planning /plan [on|off]",
        "切换计划模式：只读规划 /plan [on|off]",
      ),
    },
    {
      name: "lang",
      description: t("Switch UI language /lang <en|zh>", "切换界面语言 /lang <en|zh>"),
    },
    { name: "exit", description: t("Exit", "退出") },
  ];
}

/**
 * 依据输入框内容筛选斜杠命令补全项。仅在「正在敲命令名」阶段返回非空：
 * 以 `/` 开头且尚未出现空格（还没进参数）。空 `/` 列全部；否则前缀匹配优先，
 * 无前缀命中再回落子串匹配。
 */
export function matchCommands(all: readonly CommandMenuRow[], text: string): CommandMenuRow[] {
  if (!text.startsWith("/")) return [];
  const rest = text.slice(1);
  if (/\s/.test(rest)) return [];
  const q = rest.toLowerCase();
  if (q === "") return [...all];
  const prefix = all.filter((c) => c.name.toLowerCase().startsWith(q));
  if (prefix.length > 0) return prefix;
  return all.filter((c) => c.name.toLowerCase().includes(q));
}
// 生成中的 braille spinner 帧（对齐 opencode 的动画指示手感）。
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** 元素相对整帧顶端的行号：yoga 只给出相对父节点的偏移，逐级累加即绝对行。 */
function absoluteTop(el: DOMElement): number {
  let top = 0;
  for (let n: DOMElement | undefined = el; n; n = n.parentNode) {
    top += n.yogaNode?.getComputedTop() ?? 0;
  }
  return top;
}

/**
 * Ink 的 clearTerminal 全屏擦除序列（`ESC[2J`=清屏 `ESC[3J`=清回滚 `ESC[H`=归位）。
 * 整帧高度 >= 终端高度时 Ink 每帧都以它开头（见 ink/build/ink.js 的 outputHeight 分支）。
 */
const INK_CLEAR_TERMINAL = "\x1b[2J\x1b[3J\x1b[H";

/**
 * 把 Ink 的「先擦成空屏再重画」改写成「原地重绘」，消除逐键全屏闪烁/抖动。
 *
 * 整帧高度 == 终端高度 → Ink 每帧先发 `ESC[2J ESC[3J`（连回滚一起擦成空白）再从
 * 第 1 行重画；两步之间终端会短暂全白，逐键输入时就是肉眼可见的抖动。这里不擦屏，
 * 只归位到左上角（`ESC[H`），并在每行末尾补 `ESC[K` 擦到行尾覆盖旧字符、帧末补
 * `ESC[J` 清掉下方残留——屏幕栅格始终有效，绝不出现空帧。行首各补 `ESC[0m` 复位，
 * 避免 BCE 用上一段的背景色去擦行。
 *
 * 关键：仍保留 `ESC[H` 归位，故帧首行 == 终端第 1 行不变，下面按绝对坐标停放 IME
 * 光标的算法（absoluteTop(panel)+2）依旧成立。
 */
function inPlaceRedraw(chunk: string, overlay: Sprite | null): string {
  const body = chunk.slice(INK_CLEAR_TERMINAL.length);
  let lines = body.split("\n");
  // 浮层弹框：把精灵行覆盖到整帧对应行的中间列上，背景四周照旧透出（对齐 opencode）。
  if (overlay) lines = compositeFrame(lines, overlay);
  return "\x1b[H" + lines.map((l) => l + "\x1b[0m\x1b[K").join("\n") + "\x1b[0m\x1b[K\x1b[J";
}

/**
 * 把终端真实光标停在输入框插入点上。
 *
 * 输入法候选框由终端按真实光标位置弹出，而 Ink 画完一帧后光标停在画面末尾，
 * 中文候选框因此卡在右下角。见 inPlaceRedraw：我们把整帧重绘钉在终端第 1 行起，
 * 故帧内行号 == 终端行号，可以直接按绝对坐标停放光标，也不会干扰下一帧的重画起点。
 *
 * onRender 有 32ms 节流、可能晚于 React effect 触发，所以这里包住 stdout.write：
 * 每次写出前藏起光标、写完后按最新坐标重新停放。返回值需在每次提交后调用以更新坐标。
 */
interface FrameCompositor {
  /** 把真实光标停到插入点（输入法候选框跟随）；null 表示藏起（弹框打开时）。 */
  setCaret: (target: { row: number; col: number } | null) => void;
  /** 设置/清除当前浮层弹框精灵；下一帧写出时合成到整帧上。 */
  setOverlay: (overlay: Sprite | null) => void;
}

function useFrameCompositor(): FrameCompositor {
  const targetRef = useRef<{ row: number; col: number } | null>(null);
  const overlayRef = useRef<Sprite | null>(null);
  // 最近一帧 Ink 的原始清屏帧；弹框开/关/翻页时据此立刻重合成，不必等下一次 Ink 渲染。
  const lastChunkRef = useRef<string | null>(null);
  const parkRef = useRef<() => void>(() => {});
  const repaintRef = useRef<() => void>(() => {});
  useEffect(() => {
    const out = process.stdout;
    if (!out.isTTY) return;
    const orig = out.write.bind(out) as (...args: unknown[]) => boolean;
    const park = () => {
      const t = targetRef.current;
      if (t) orig(`\x1b[${t.row};${t.col}H\x1b[?25h`);
    };
    parkRef.current = park;
    repaintRef.current = () => {
      const chunk = lastChunkRef.current;
      if (!chunk) return;
      orig("\x1b[?25l");
      orig(inPlaceRedraw(chunk, overlayRef.current));
      park();
    };
    out.write = function (...args: unknown[]) {
      // 拦下 Ink 的全屏清屏帧，改成原地重绘 + 合成浮层；其余写出（OSC、park 序列等）原样透传。
      if (typeof args[0] === "string" && args[0].startsWith(INK_CLEAR_TERMINAL)) {
        lastChunkRef.current = args[0];
        args = [inPlaceRedraw(args[0], overlayRef.current), ...args.slice(1)];
      }
      orig("\x1b[?25l");
      const ret = orig(...args);
      park();
      return ret;
    } as NodeJS.WriteStream["write"];
    return () => {
      out.write = orig as NodeJS.WriteStream["write"];
      parkRef.current = () => {};
      repaintRef.current = () => {};
      orig("\x1b[?25l");
    };
  }, []);
  const setCaret = useCallback((target: { row: number; col: number } | null) => {
    targetRef.current = target;
    parkRef.current();
  }, []);
  const setOverlay = useCallback((overlay: Sprite | null) => {
    const changed = overlayRef.current !== overlay;
    overlayRef.current = overlay;
    // 立刻按新浮层重绘最近一帧：保证弹框开/关/内容变化即时可见，与 Ink 渲染节流解耦。
    if (changed) repaintRef.current();
  }, []);
  return { setCaret, setOverlay };
}

/** 终端尺寸（rows/cols）；resize 时更新。非 TTY（测试）给合理默认值。 */
function useTerminalSize(): { rows: number; cols: number } {
  const { stdout } = useStdout();
  const read = (): { rows: number; cols: number } => ({
    rows: stdout && stdout.rows > 0 ? stdout.rows : 24,
    cols: stdout && stdout.columns > 0 ? stdout.columns : 80,
  });
  const [size, setSize] = useState(read);
  useEffect(() => {
    if (!stdout || typeof stdout.on !== "function") return;
    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => {
      stdout.off?.("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout]);
  return size;
}

interface PendingPerm {
  permId: string;
  toolName: string;
  ruleKey: string;
}

export interface AppProps {
  host: SessionHost;
  cwd: string;
  model: string;
  sessionId: string;
  /** CLI/daemon 提供的 canonical provider 安全元数据，不含任何 key 值。 */
  providers?: readonly ProviderDescriptor[];
  /** 内置可选模型目录（含免费/开源模型），供 /model 选择器使用。 */
  catalog?: readonly ModelCatalogEntry[];
  /** 仅本地 host 可安全读取当前进程 env；daemon 的凭证属于服务端进程。 */
  inspectProviderCredentials?: boolean;
  /** 自定义斜杠命令（.anicode/command/*.md）。 */
  commands?: readonly CustomCommand[];
  /** CLI 版本号，显示在底部状态栏。 */
  version?: string;
}

export function App({
  host,
  cwd,
  model,
  sessionId: initialId,
  providers = [],
  catalog = [],
  inspectProviderCredentials = false,
  commands = [],
  version = "0.0.1",
}: AppProps) {
  const { exit } = useApp();
  const { rows: termRows, cols: termCols } = useTerminalSize();
  const { stdout } = useStdout();
  // 浮层模式：仅当 Ink 直接驱动真实 TTY 时启用「盖屏弹框」帧合成；
  // ink-testing 用的是另一个 stdout（stdout !== process.stdout），仍走 in-tree 渲染，测试不受影响。
  const overlayMode = stdout === process.stdout && !!process.stdout.isTTY;
  // 进入 alt-screen 占满终端，退出时还原原有回滚缓冲（仅真实 TTY；测试跳过）。
  // 同时用 OSC 17/19 把鼠标选区配色设成 VS Code 同款（选中背景 #264f78 / 前景 #dcdcdc），
  // 退出时 OSC 117/119 复位；iTerm2 等 xterm 兼容终端支持。选中即复制由终端负责
  // （iTerm2 默认开启「Copy to pasteboard on selection」）。
  useEffect(() => {
    const out = process.stdout;
    if (!out.isTTY) return;
    out.write("\x1b[?1049h\x1b[H");
    // 整屏背景对齐 opencode（近纯黑 #0a0a0a）；选区配色对齐 VS Code（#264f78/#dcdcdc）。
    out.write("\x1b]11;#0a0a0a\x07");
    out.write("\x1b]17;#264f78\x07\x1b]19;#dcdcdc\x07");
    return () => {
      out.write("\x1b]111\x07"); // 复位背景
      out.write("\x1b]117\x07\x1b]119\x07");
      out.write("\x1b[?1049l");
    };
  }, []);
  const [sessionId, setSessionId] = useState(initialId);
  const [state, dispatch] = useReducer(reducer, {
    items: [],
    activeTools: new Map(),
    liveText: "",
    running: false,
    usage: emptyUsage,
    todos: [],
    meta: { id: initialId, cwd, model },
    generation: 0,
    opening: true,
  });
  const [input, setInput] = useState("");
  // 光标位置（0..input.length）。用 ref 与渲染态双写，保证同 tick 内多次编辑基于最新值。
  const [cursor, setCursor] = useState(0);
  // 输入面板节点 + 真实光标停放（输入法候选框跟随真实光标）。
  const panelRef = useRef<DOMElement | null>(null);
  const { setCaret, setOverlay } = useFrameCompositor();
  const cursorRef = useRef(0);
  // 已提交行的历史，供 ↑/↓ 回溯（最新在末尾）。histRef 为当前浏览位置（null=不在浏览）。
  const historyRef = useRef<string[]>([]);
  const histPosRef = useRef<number | null>(null);
  // PTY paste 可能一次把整段文本连同 \r/\n 交给 useInput；用 ref 保证同一 tick
  // 内的分块输入也基于最新值，而不是 React 上一帧的闭包。
  const inputRef = useRef("");
  // paste 的最后一个换行可能和前文分成多个 stdin chunk。延迟到当前 I/O
  // 批次结束再提交，让后续 chunk 有机会合并并取消旧提交。
  const pasteSubmitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 权限请求队列：并行只读工具可能同时产生多个 ask（如 askRules 命中），逐个裁决
  const [pendings, setPendings] = useState<PendingPerm[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  // /model 选择器：非空即打开，index 为高亮项，filter 为搜索词。
  const [picker, setPicker] = useState<{ rows: PickerRow[]; index: number; filter: string } | null>(
    null,
  );
  // /lang 切换语言：整屏重渲染，让所有 t() 就地重取。
  const [, bumpLang] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onLangChange(bumpLang), []);
  // 斜杠命令补全菜单：内置命令 + 自定义命令；菜单开关由输入框内容派生，menuIndex 为高亮项。
  // 依赖 getLang() 使切换语言时描述随之更新。
  const lang = getLang();
  const allCommands = useMemo<CommandMenuRow[]>(
    () => [
      ...builtinCommands(),
      ...commands.map((c) => ({
        name: c.name,
        description: c.description || t("Custom command", "自定义命令"),
      })),
    ],
    // lang 是有意的重算触发器：builtinCommands()/t() 读的是当前语言，切换时须重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commands, lang],
  );
  const [menuIndex, setMenuIndex] = useState(0);
  const menuIndexRef = useRef(0);
  // 计划模式：/plan 切换；只读规划，退出后执行。会话切换时回到默认。
  const [planMode, setPlanMode] = useState(false);
  // 超窄终端下弹框横向滚动偏移（列）；仅当弹框比屏还宽时生效，切换弹框时归零。
  const [hoff, setHoff] = useState(0);
  const hoffRef = useRef(0);
  const setHscroll = useCallback((n: number): void => {
    const v = Math.max(0, n);
    hoffRef.current = v;
    setHoff(v);
  }, []);
  const setMenuIdx = useCallback((i: number): void => {
    menuIndexRef.current = i;
    setMenuIndex(i);
  }, []);
  // 回看滚动偏移：0=贴底看最新，>0=向上回看的条目数。
  const [scrollOffset, setScrollOffset] = useState(0);
  const closeRef = useRef<(() => void) | null>(null);
  const flushRef = useRef<(() => void) | null>(null);
  // 流式生成指示：running 期间以 ~120ms 步进推进 spinner 帧并刷新计时。
  const [spin, setSpin] = useState(0);
  const runStartRef = useRef(0);
  useEffect(() => {
    if (!state.running) return;
    runStartRef.current = Date.now();
    const id = setInterval(() => setSpin((n) => n + 1), 120);
    return () => clearInterval(id);
  }, [state.running]);

  const selectModel = useCallback(
    async (spec: string): Promise<void> => {
      // 本地 Ollama 模型：选中即尝试自启动服务，省去手动 `ollama serve`。
      if (spec.startsWith("ollama/")) {
        setPicker(null);
        dispatch({
          t: "push",
          item: {
            kind: "info",
            text: t("Ensuring the local Ollama is started…", "正在确保本地 Ollama 已启动…"),
          },
        });
        const r = await ensureOllama();
        if (r === "missing") {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(
                "The ollama command was not found; please install Ollama first (https://ollama.com).",
                "未检测到 ollama 命令，请先安装 Ollama（https://ollama.com）。",
              ),
            },
          });
          return;
        }
        if (r === "timeout") {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(
                "Ollama startup timed out; please run `ollama serve` manually and retry.",
                "Ollama 启动超时，请手动运行 `ollama serve` 后重试。",
              ),
            },
          });
          return;
        }
        dispatch({
          t: "push",
          item: {
            kind: "info",
            text:
              r === "started"
                ? t("Ollama has been started automatically.", "Ollama 已自动启动。")
                : t("Ollama is already running.", "Ollama 已在运行。"),
          },
        });
      }
      // 模型是会话持久化元数据；始终新建会话，不在原会话上热改。
      // provider/model 的最终校验由 host（本地或 daemon）作为唯一事实源。
      const meta = await host.createSession({ cwd: state.meta.cwd, model: spec });
      setSessions(null);
      setPicker(null);
      setSessionId(meta.id);
    },
    [host, state.meta.cwd],
  );

  useEffect(
    () => () => {
      if (pasteSubmitRef.current) clearTimeout(pasteSubmitRef.current);
    },
    [],
  );

  // 订阅当前会话：载入 snapshot → 渲染，之后实时收事件
  useEffect(() => {
    let closed = false;
    let ready = false;
    const buffered: SessionEvent[] = [];
    closeRef.current?.();
    closeRef.current = null;
    setPendings([]);
    setPlanMode(false); // 新会话回到默认模式
    dispatch({ t: "opening", v: true });
    // 事件合流：流式 token 高频到达时，把一帧内的事件攒成一批，
    // 用 ~16ms 定时器统一 flush（React18 会自动 batch 这些 dispatch），
    // 把「每 token 一次全屏重渲染」降到 ~60fps 上限。
    const queue: SessionEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (queue.length === 0) return;
      const batch = queue.splice(0, queue.length);
      for (const ev of batch) handleEvent(ev, dispatch, setPendings);
    };
    flushRef.current = flush;
    const onEvent = (ev: SessionEvent) => {
      if (closed) return;
      if (!ready) {
        buffered.push(ev);
        return;
      }
      queue.push(ev);
      if (!flushTimer) flushTimer = setTimeout(flush, 16);
    };
    void host
      .open(sessionId, onEvent)
      .then((handle) => {
        if (closed) {
          handle.close();
          return;
        }
        closeRef.current = handle.close;
        const snap = handle.snapshot;
        const restored = restoreTranscript(snap.messages);
        // 会话边界始终保留；空会话在其后加一次性 logo（放进 Static 只画一次，避免动态区重绘鬼影）。
        const initialItems: Row[] =
          restored.items.length === 0
            ? [sessionBoundary(snap.meta), { kind: "logo" }]
            : [sessionBoundary(snap.meta), ...restored.items];
        dispatch({
          t: "reset",
          items: initialItems,
          activeTools: restored.activeTools,
          usage: snap.usage,
          running: snap.running,
          todos: todosFromMessages(snap.messages),
          meta: {
            id: snap.meta.id,
            cwd: snap.meta.cwd,
            model: snap.meta.model,
            ...(snap.meta.title ? { title: snap.meta.title } : {}),
          },
        });
        setPendings(snap.pendingPermissions);
        setScrollOffset(0);
        // open 先建立订阅再返回 snapshot。响应飞行期间的事件必须在
        // snapshot 之后按原顺序回放，不能只特判 permission_request。
        ready = true;
        for (const ev of buffered) handleEvent(ev, dispatch, setPendings);
      })
      .catch((err) => {
        if (closed) return;
        dispatch({ t: "opening", v: false });
        dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } });
      });
    return () => {
      closed = true;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      flushRef.current = null;
      closeRef.current?.();
      closeRef.current = null;
    };
  }, [host, sessionId]);

  const runSlash = useCallback(
    async (line: string): Promise<boolean> => {
      const [cmd = "", ...rest] = line.slice(1).trim().split(/\s+/);
      if (cmd === "exit" || cmd === "quit") {
        exit();
        return true;
      }
      if (cmd === "help") {
        dispatch({ t: "push", item: { kind: "info", text: helpText() } });
        return true;
      }
      if (cmd === "status") {
        dispatch({
          t: "push",
          item: {
            kind: "info",
            text:
              t(
                `Session ${state.meta.id} · ${state.meta.model} · ${state.meta.cwd}`,
                `会话 ${state.meta.id} · ${state.meta.model} · ${state.meta.cwd}`,
              ) +
              ` · ${state.running ? t("running", "运行中") : t("idle", "空闲")}` +
              (state.meta.title ? ` · ${state.meta.title}` : ""),
          },
        });
        return true;
      }
      if (cmd === "providers") {
        dispatch({
          t: "push",
          item: { kind: "info", text: providersText(providers, inspectProviderCredentials) },
        });
        return true;
      }
      if (cmd === "model") {
        const spec = rest[0];
        if (!spec) {
          // 不带参数：打开内置模型选择器（含免费/开源模型）。本地 provider 先探测存活，
          // 免得把没启动的 Ollama/LM Studio 标成就绪、选中后 Connection error。
          const liveLocal = inspectProviderCredentials ? await probeLive(providers) : undefined;
          const rows = buildPickerRows(catalog, providers, inspectProviderCredentials, liveLocal);
          if (rows.length === 0) {
            dispatch({
              t: "push",
              item: {
                kind: "error",
                text: t(
                  "The built-in model catalog is empty; use /model <provider/model> to specify",
                  "内置模型目录为空；用 /model <provider/model> 指定",
                ),
              },
            });
            return true;
          }
          setSessions(null);
          setPicker({ rows, index: 0, filter: "" });
          return true;
        }
        await selectModel(spec);
        return true;
      }
      if (cmd === "sessions") {
        const list = await host.listSessions();
        setSessions(list);
        return true;
      }
      if (cmd === "resume") {
        const id = rest[0];
        if (!id) {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t("Usage: /resume <sessionId>", "用法: /resume <sessionId>"),
            },
          });
          return true;
        }
        setSessions(null);
        setSessionId(id); // 触发 useEffect 重新订阅
        return true;
      }
      if (cmd === "new") {
        const title = rest.join(" ") || undefined;
        const meta = await host.createSession({
          cwd: state.meta.cwd,
          model: state.meta.model,
          ...(title ? { title } : {}),
        });
        setSessions(null);
        setSessionId(meta.id);
        return true;
      }
      if (cmd === "undo") {
        // 成功提示由广播的 reverted 事件统一渲染（所有订阅者一致）；这里只兜错误。
        try {
          await host.undo(sessionId, rest[0]);
        } catch (err) {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(`Undo failed: ${errorMessage(err)}`, `撤销失败：${errorMessage(err)}`),
            },
          });
        }
        return true;
      }
      if (cmd === "plan") {
        if (!host.setPermissionMode) {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(
                "This transport doesn't support runtime plan mode; start with --permission-mode plan.",
                "当前传输不支持运行时计划模式；可用 --permission-mode plan 启动。",
              ),
            },
          });
          return true;
        }
        const arg = (rest[0] ?? "").toLowerCase();
        const next = arg === "on" ? true : arg === "off" ? false : !planMode;
        try {
          await host.setPermissionMode(sessionId, next ? "plan" : "default");
          setPlanMode(next);
          dispatch({
            t: "push",
            item: {
              kind: "info",
              text: next
                ? t(
                    "Plan mode ON: read-only. Ask for a plan, then /plan off to execute.",
                    "已进入计划模式：只读。先让它给方案，再 /plan off 退出执行。",
                  )
                : t("Plan mode OFF.", "已退出计划模式。"),
            },
          });
        } catch (err) {
          dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } });
        }
        return true;
      }
      if (cmd === "lang") {
        const want = (rest[0] ?? "").toLowerCase();
        const next = want.startsWith("zh")
          ? "zh"
          : want.startsWith("en")
            ? "en"
            : getLang() === "zh"
              ? "en"
              : "zh";
        setLang(next);
        dispatch({
          t: "push",
          item: {
            kind: "info",
            text: t(`Language switched to English`, `界面语言已切换为中文`),
          },
        });
        return true;
      }
      // 自定义命令（.anicode/command/*.md）：展开模板后作为提示发送。
      const custom = commands.find((c) => c.name === cmd);
      if (custom) {
        const prompt = expandCommand(custom, rest.join(" "));
        dispatch({ t: "running", v: true });
        void host.send(sessionId, prompt).catch((err) => {
          dispatch({ t: "running", v: false });
          dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } });
        });
        return true;
      }
      dispatch({
        t: "push",
        item: { kind: "error", text: t(`Unknown command: /${cmd}`, `未知命令: /${cmd}`) },
      });
      return true;
    },
    [
      host,
      providers,
      catalog,
      inspectProviderCredentials,
      selectModel,
      state.meta,
      state.running,
      exit,
      commands,
      sessionId,
      planMode,
    ],
  );

  // 输入缓冲区与光标一起改写：ref 供同 tick 内连续编辑，state 供渲染。
  // 文本变化时把命令菜单高亮重置到首项（新筛选集从头选），仅移动光标时不动高亮。
  const setBuf = useCallback((text: string, cur: number): void => {
    const c = Math.max(0, Math.min(cur, text.length));
    if (text !== inputRef.current) {
      menuIndexRef.current = 0;
      setMenuIndex(0);
    }
    inputRef.current = text;
    cursorRef.current = c;
    setInput(text);
    setCursor(c);
  }, []);

  const submitLine = useCallback(
    (raw: string): void => {
      setScrollOffset(0); // 提交后回到底部跟随最新
      const text = raw.trim();
      if (text) {
        const h = historyRef.current;
        if (h[h.length - 1] !== text) h.push(text);
        if (h.length > 200) h.shift();
      }
      histPosRef.current = null;
      if (!text) return;
      if (text.startsWith("/")) {
        void runSlash(text).catch((err) =>
          dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } }),
        );
        return;
      }
      // 运行中发送 = steering（core 在 turn 边界注入）；user 条目由事件渲染。
      // 先展开 @文件引用（把文件内容拼进消息），再发送。
      dispatch({ t: "running", v: true });
      void expandFileMentions(text, state.meta.cwd)
        .then(({ text: expanded, missing }) => {
          for (const m of missing) {
            dispatch({
              t: "push",
              item: {
                kind: "info",
                text: t(`@${m}: file not found, kept as-is`, `@${m}: 未找到该文件，已按原文保留`),
              },
            });
          }
          return host.send(sessionId, expanded);
        })
        .catch((err) => {
          dispatch({ t: "running", v: false });
          dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } });
        });
    },
    [host, runSlash, sessionId, state.meta.cwd],
  );

  useInput((ch, key) => {
    // Ctrl+Z 退出（与 Ctrl+C 一致）；raw 模式下 Ctrl+Z 可能是 "z" 或 SUB 字符。
    if (key.ctrl && (ch === "z" || ch === "\u001a")) {
      exit();
      return;
    }
    // 弹框/命令菜单打开时，主界面不参与回看滚动（对齐需求：弹框在，主界面不滚动）。
    const dialogOpen = !!(picker || pendings[0] || sessions);
    const menuRows = dialogOpen ? [] : matchCommands(allCommands, inputRef.current);
    const menuOpen = menuRows.length > 0;
    // 回看历史：PageUp 往上翻一屏，PageDown 往下；到底部即回到跟随最新。
    if (key.pageUp) {
      if (dialogOpen || menuOpen) return;
      const page = Math.max(1, termRows - 2);
      setScrollOffset((o) => Math.min(o + page, Math.max(0, state.items.length - 1)));
      return;
    }
    if (key.pageDown) {
      if (dialogOpen || menuOpen) return;
      const page = Math.max(1, termRows - 2);
      setScrollOffset((o) => Math.max(0, o - page));
      return;
    }
    if (picker) {
      const visible = filterPickerRows(picker.rows, picker.filter);
      if (key.escape) {
        setPicker(null);
        return;
      }
      // 超窄终端弹框比屏还宽时，←/→ 横向滚动查看被裁掉的内容（不宽则无副作用）。
      if (key.leftArrow) return setHscroll(hoffRef.current - 4);
      if (key.rightArrow) return setHscroll(hoffRef.current + 4);
      if (key.upArrow) {
        setPicker((p) => {
          if (!p) return p;
          const n = filterPickerRows(p.rows, p.filter).length || 1;
          return { ...p, index: (p.index - 1 + n) % n };
        });
        return;
      }
      if (key.downArrow) {
        setPicker((p) => {
          if (!p) return p;
          const n = filterPickerRows(p.rows, p.filter).length || 1;
          return { ...p, index: (p.index + 1) % n };
        });
        return;
      }
      if (key.return) {
        const spec = visible[picker.index]?.spec;
        if (spec) {
          void selectModel(spec).catch((err) => {
            setPicker(null);
            dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } });
          });
        }
        return;
      }
      if (key.backspace || key.delete) {
        setPicker((p) => (p ? { ...p, filter: p.filter.slice(0, -1), index: 0 } : p));
        return;
      }
      // 可打印字符 → 追加到搜索词并回到首行。
      if (ch && !key.ctrl && !key.meta && !key.tab) {
        setPicker((p) => (p ? { ...p, filter: p.filter + ch, index: 0 } : p));
        return;
      }
      return;
    }
    const pending = pendings[0];
    if (pending) {
      if (key.escape) {
        const interrupted = pendings;
        setPendings([]);
        void host.interrupt(sessionId).catch((err) => {
          setPendings((q) => mergePendings(interrupted, q));
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(`Interrupt failed: ${errorMessage(err)}`, `中断失败: ${errorMessage(err)}`),
            },
          });
        });
        return;
      }
      const kind =
        ch === "y" || ch === "Y"
          ? "allow"
          : ch === "a" || ch === "A"
            ? "allow_remember"
            : ch === "n" || ch === "N"
              ? "deny"
              : null;
      if (!kind) return; // 方向键/误触等不应被当成拒绝
      setPendings((q) => q.slice(1));
      void host
        .answerPermission(sessionId, pending.permId, kind)
        .then((answered) => {
          if (answered === false) {
            dispatch({
              t: "push",
              item: {
                kind: "info",
                text: t(
                  "This permission request was already handled by another client",
                  "该授权请求已由其他客户端处理",
                ),
              },
            });
          }
        })
        .catch((err) => {
          setPendings((q) => mergePendings([pending], q));
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(
                `Permission reply failed: ${errorMessage(err)}`,
                `授权答复失败: ${errorMessage(err)}`,
              ),
            },
          });
        });
      return;
    }
    // 会话列表浮层不拦截输入（仍可键入 /resume <id>），仅 esc 关闭。
    if (sessions && key.escape) {
      setSessions(null);
      return;
    }
    if (state.running && key.escape) {
      void host.interrupt(sessionId);
      return;
    }
    // 斜杠命令补全菜单（输入框正上方、方向朝上）：正在敲命令名时接管方向键/Tab/Enter/Esc。
    if (menuOpen) {
      const n = menuRows.length;
      const cur = Math.min(menuIndexRef.current, n - 1);
      if (key.upArrow) return setMenuIdx((cur - 1 + n) % n);
      if (key.downArrow) return setMenuIdx((cur + 1) % n);
      if (key.escape) return setBuf("", 0); // 关闭菜单（清掉半截命令）
      const picked = menuRows[cur]!.name;
      if (key.tab) return setBuf(`/${picked} `, picked.length + 2); // 补全命令名，留空格待输参数
      if (key.return) {
        setBuf("", 0);
        submitLine(`/${picked}`); // 直接运行高亮命令
        return;
      }
      // 其余可打印键/退格继续落到下方常规编辑，实时收窄候选。
    }
    const buf = inputRef.current;
    const cur = cursorRef.current;
    const isCtrl = (letter: string, code: string) => key.ctrl && (ch === letter || ch === code);

    // —— 光标移动 ——
    if (key.leftArrow) return setBuf(buf, cur - 1);
    if (key.rightArrow) return setBuf(buf, cur + 1);
    if (isCtrl("a", "")) return setBuf(buf, 0); // 行首
    if (isCtrl("e", "")) return setBuf(buf, buf.length); // 行尾

    // —— 历史回溯（↑ 往旧，↓ 往新，越过最新回到空行）——
    if (key.upArrow) {
      const h = historyRef.current;
      if (h.length === 0) return;
      const pos = Math.max(0, (histPosRef.current ?? h.length) - 1);
      histPosRef.current = pos;
      return setBuf(h[pos]!, h[pos]!.length);
    }
    if (key.downArrow) {
      const h = historyRef.current;
      if (histPosRef.current === null) return;
      const pos = histPosRef.current + 1;
      if (pos >= h.length) {
        histPosRef.current = null;
        return setBuf("", 0);
      }
      histPosRef.current = pos;
      return setBuf(h[pos]!, h[pos]!.length);
    }

    // —— 删除 ——
    if (isCtrl("u", "")) return setBuf(buf.slice(cur), 0); // 删到行首
    if (isCtrl("k", "")) return setBuf(buf.slice(0, cur), cur); // 删到行尾
    if (isCtrl("w", "")) {
      // 删除光标前一个词：先吃掉空白，再吃掉非空白。
      let i = cur;
      while (i > 0 && /\s/.test(buf[i - 1]!)) i--;
      while (i > 0 && !/\s/.test(buf[i - 1]!)) i--;
      return setBuf(buf.slice(0, i) + buf.slice(cur), i);
    }

    if (pasteSubmitRef.current) {
      clearTimeout(pasteSubmitRef.current);
      pasteSubmitRef.current = null;
    }
    const normalized = ch.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const pastedNewline =
      normalized.includes("\n") && (normalized.replace(/\n/g, "").length > 0 || !key.return);
    if (pastedNewline) {
      // 单行 TUI：内部换行只折成空格；只有 paste 本身以换行结尾时才等价
      // 于 Enter。短 debounce 可合并落在相邻 event-loop tick 的 PTY chunks。
      const ins = normalized.replace(/\n+/g, " ");
      histPosRef.current = null;
      setBuf(buf.slice(0, cur) + ins + buf.slice(cur), cur + ins.length);
      if (normalized.endsWith("\n")) {
        const scheduled = setTimeout(() => {
          if (pasteSubmitRef.current !== scheduled) return;
          pasteSubmitRef.current = null;
          const text = inputRef.current;
          setBuf("", 0);
          submitLine(text);
        }, 25);
        pasteSubmitRef.current = scheduled;
      }
    } else if (key.return) {
      const text = inputRef.current;
      setBuf("", 0);
      submitLine(text);
    } else if (key.backspace || key.delete) {
      if (cur === 0) return;
      histPosRef.current = null;
      setBuf(buf.slice(0, cur - 1) + buf.slice(cur), cur - 1);
    } else if (ch && !key.ctrl && !key.meta) {
      histPosRef.current = null;
      setBuf(buf.slice(0, cur) + normalized + buf.slice(cur), cur + normalized.length);
    }
  });

  // 每次提交后按最新布局把真实光标停到插入点：面板首行是空行，输入行在其下一行；
  // 列 = 竖条(1) + 前导空格(1) + 光标在可见窗口内的列偏移，再 +1 转成 1-based。
  // 浮层弹框打开时藏起真实光标——弹框自绘搜索光标块，不再跟随输入框。
  useEffect(() => {
    if (overlayMode && (picker || pendings[0] || sessions)) return setCaret(null);
    const panel = panelRef.current;
    if (!panel) return setCaret(null);
    const { caretX, startX } = inputView(input, cursor, termCols);
    setCaret({ row: absoluteTop(panel) + 2, col: 3 + caretX - startX });
  });

  // 浮层弹框精灵：把当前打开的弹框算成一组定宽 ANSI 行，交给写入层合成到整帧上。
  // 仅浮层模式（真实 TTY）生效；非 TTY 下清空，弹框改由下方 in-tree 渲染（测试可见）。
  // 切换弹框时横向滚动归零（新弹框从左端看起）。
  const dialogKey = picker ? "picker" : pendings[0] ? "perm" : sessions ? "sess" : "none";
  useEffect(() => {
    setHscroll(0);
  }, [dialogKey, setHscroll]);

  useEffect(() => {
    if (!overlayMode) return setOverlay(null);
    // 超窄终端下弹框可能比屏还宽：统一过一遍横向开窗（不宽则原样返回），补横向滚动条。
    const show = (s: Sprite) => setOverlay(windowHorizontally(s, termCols, hoff));
    if (picker) {
      const visible = filterPickerRows(picker.rows, picker.filter);
      return show(
        buildModelPickerOverlay(visible, picker.index, picker.filter, termRows, termCols),
      );
    }
    if (pendings[0]) return show(buildPermissionOverlay(pendings, termRows, termCols));
    if (sessions) return show(buildSessionsOverlay(sessions, termRows, termCols));
    // 斜杠命令菜单：钉在输入框正上方（需读输入面板的绝对行号）。菜单宽度已封顶屏宽，无需横向开窗。
    const menu = matchCommands(allCommands, input);
    const panel = panelRef.current;
    if (menu.length > 0 && panel) {
      return setOverlay(
        buildCommandMenuOverlay(menu, menuIndex, absoluteTop(panel), termRows, termCols),
      );
    }
    return setOverlay(null);
  }, [
    overlayMode,
    picker,
    pendings,
    sessions,
    input,
    menuIndex,
    allCommands,
    termRows,
    termCols,
    hoff,
    lang,
    setOverlay,
  ]);

  const u = state.usage;
  const conversationEmpty =
    !state.items.some((i) => i.kind === "user" || i.kind === "assistant" || i.kind === "tool") &&
    !state.liveText &&
    state.activeTools.size === 0;

  // 只渲染可见窗口内的条目：窗口约 2×termRows 个（历史条目不进 yoga 布局），
  // 把整棵树的布局代价与会话长度解耦。scrollOffset 决定窗口结束位置（0=贴底）。
  const WIN = termRows * 2 + 16;
  const winEnd = Math.max(1, state.items.length - scrollOffset);
  const winStart = Math.max(0, winEnd - WIN);
  const visibleItems = conversationEmpty ? state.items : state.items.slice(winStart, winEnd);
  const baseKey = conversationEmpty ? 0 : winStart;

  const spinner = state.running ? SPINNER[spin % SPINNER.length]! : "●";
  const elapsedS =
    state.running && runStartRef.current
      ? Math.floor((Date.now() - runStartRef.current) / 1000)
      : 0;

  // /model 选择器：非浮层模式（测试）下以居中弹框接管整屏；浮层模式改由写入层合成盖屏。
  if (picker && !overlayMode) {
    return (
      <Box height={termRows} flexDirection="column" justifyContent="center" alignItems="center">
        <ModelPicker
          rows={picker.rows}
          index={picker.index}
          filter={picker.filter}
          width={Math.min(Math.max(48, termCols - 8), 80)}
          maxRows={termRows}
        />
      </Box>
    );
  }

  // 浮层模式下背景常驻可见（对齐 opencode），故弹框打开时仍渲染输入框；
  // 非浮层模式沿用旧行为：被授权弹窗/选择器接管时不渲染输入框。
  const showInput = overlayMode || (!pendings[0] && !picker);
  // 非浮层模式（测试）下命令菜单改由 in-tree 渲染在输入框上方；浮层模式由写入层合成盖屏。
  const inTreeMenu = !overlayMode ? matchCommands(allCommands, input) : [];
  const inputCluster = showInput ? (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {inTreeMenu.length > 0 ? <CommandMenu rows={inTreeMenu} index={menuIndex} /> : null}
      <InputPanel
        panelRef={panelRef}
        text={input}
        cursor={cursor}
        model={state.meta.model}
        cwd={state.meta.cwd}
        {...(state.meta.title ? { title: state.meta.title } : {})}
        running={state.running}
        spinner={spinner}
        width={termCols}
      />
      <Box justifyContent="flex-end">
        <Text dimColor wrap="truncate">
          {fitHints(
            state.running
              ? [t("esc interrupt", "esc 中断"), t("enter append", "enter 追加")]
              : [
                  // 计划模式置顶提示：让「现在是只读」这件事一眼可见。
                  ...(planMode ? [t("◆ plan mode (read-only)", "◆ 计划模式（只读）")] : []),
                  t("/model switch model", "/model 换模型"),
                  t("↑↓ history", "↑↓ 历史"),
                  t("PageUp scroll back", "PageUp 回看"),
                  t("ctrl+z exit", "ctrl+z 退出"),
                ],
            termCols,
          )}
        </Text>
      </Box>
    </Box>
  ) : null;

  // 底部状态栏（窄屏下逐段让位，避免折行把整屏布局顶掉）。
  const brand = `${APP_NAME} v${version}`;
  const statusLine = `${state.meta.model} · in ${u.inputTokens} / out ${u.outputTokens} tokens`;

  // 底部控件：会话列表 / 授权弹窗 / 输入框。浮层模式下前两者改为盖屏合成，这里只留输入框。
  const controls = (
    <>
      {!overlayMode && sessions ? <SessionList sessions={sessions} /> : null}
      {!overlayMode && pendings[0] ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow">
            {t("⚠ Permission request: ", "⚠ 授权请求: ")}
            <Text bold>{pendings[0].toolName}</Text>
            {pendings.length > 1 ? (
              <Text dimColor>
                {t(
                  `(${pendings.length - 1} more pending)`,
                  `（还有 ${pendings.length - 1} 个待裁决）`,
                )}
              </Text>
            ) : null}
          </Text>
          <Text dimColor>{truncate(pendings[0].ruleKey, 100)}</Text>
          <Text>
            [<Text color="green">y</Text>
            {t("] allow [", "] 允许 [")}
            <Text color="cyan">a</Text>
            {t("] allow and remember [", "] 允许并记住 [")}
            <Text color="red">n</Text>
            {t("] deny", "] 拒绝")}
          </Text>
        </Box>
      ) : null}
      {inputCluster}
    </>
  );

  return (
    <Box flexDirection="column" height={termRows}>
      {conversationEmpty ? (
        // 空会话：顶部保留会话边界，logo + 输入框作为一组在垂直方向居中（对齐 opencode）。
        <>
          {state.items
            .filter((i) => i.kind !== "logo")
            .map((item, i) => (
              <ItemView key={`top:${i}`} item={item as Item} />
            ))}
          <Box flexGrow={1} flexDirection="column" justifyContent="center">
            <Welcome width={termCols} />
            {controls}
          </Box>
        </>
      ) : (
        <>
          {/* 会话进行中：记录贴底（最新可见），输入框固定在下方。 */}
          <Box flexGrow={1} flexDirection="column" overflow="hidden" justifyContent="flex-end">
            {visibleItems.map((item, i) =>
              item.kind === "logo" ? null : <ItemView key={baseKey + i} item={item} />,
            )}

            {state.liveText ? (
              <Box>
                <Text color="green">{spinner} </Text>
                <Text>{state.liveText}</Text>
              </Box>
            ) : state.running ? (
              <Box>
                <Text color="yellow">{spinner} </Text>
                <Text dimColor>
                  {t(
                    `generating… ${elapsedS}s (esc interrupt)`,
                    `生成中… ${elapsedS}s（esc 中断）`,
                  )}
                </Text>
              </Box>
            ) : null}

            {[...state.activeTools.values()].map((tool) => (
              <ItemView key={tool.id} item={tool} />
            ))}

            {state.todos.length > 0 ? <TodoList todos={state.todos} /> : null}
          </Box>

          {scrollOffset > 0 ? (
            <Box justifyContent="center">
              <Text color="cyan">
                {t(
                  "↑ scrolling back through history · PageDown to bottom",
                  "↑ 回看历史中 · PageDown 回到底部",
                )}
              </Text>
            </Box>
          ) : null}

          {controls}
        </>
      )}

      <Box flexDirection="column" marginTop={1}>
        <Box justifyContent="space-between">
          {/* 版本号定宽先占位，路径拿剩下的列；路径从头部截断，保留更有信息量的尾巴 */}
          <Text dimColor wrap="truncate">
            {truncWidthStart(tildify(state.meta.cwd), termCols - dispWidth(brand) - 1)}
          </Text>
          <Text dimColor wrap="truncate">
            {brand}
          </Text>
        </Box>
        <Text dimColor wrap="truncate">
          {truncWidth(statusLine, termCols)}
        </Text>
      </Box>
    </Box>
  );
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** 用 ~ 缩写 home 目录，其余原样（状态栏展示路径用）。 */
function tildify(p: string): string {
  const home = process.env["HOME"] || "";
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function handleEvent(
  se: SessionEvent,
  dispatch: React.Dispatch<Action>,
  setPendings: React.Dispatch<React.SetStateAction<PendingPerm[]>>,
) {
  if (se.type === "state") {
    dispatch({ t: "running", v: se.running });
    if (!se.running) dispatch({ t: "flushLive" });
    return;
  }
  if (se.type === "permission_request") {
    setPendings((q) =>
      mergePendings(q, [{ permId: se.permId, toolName: se.toolName, ruleKey: se.ruleKey }]),
    );
    return;
  }
  if (se.type === "permission_resolved") {
    setPendings((q) => q.filter((p) => p.permId !== se.permId));
    return;
  }
  if (se.type === "reverted") {
    // undo 也可能由其它订阅者（另一个 TUI/CLI）触发；所有观察者都提示一下。
    dispatch({
      t: "push",
      item: {
        kind: "info",
        text: t(
          `↩ Workspace rolled back: restored ${se.restored} files, deleted ${se.deleted} new files`,
          `↩ 工作区已回滚：恢复 ${se.restored} 个文件，删除 ${se.deleted} 个新增文件`,
        ),
      },
    });
    return;
  }
  // se.type === "agent"
  const ev = se.event;
  switch (ev.type) {
    case "user_message":
      dispatch({ t: "flushLive" });
      dispatch({ t: "push", item: { kind: "user", text: ev.text } });
      break;
    case "text":
      dispatch({ t: "live", delta: ev.text });
      break;
    case "thinking":
    case "tool_input_delta":
      break;
    case "tool_progress":
      if (isTodoProgress(ev.event)) dispatch({ t: "todos", todos: ev.event.todos });
      break;
    case "turn_reset":
      dispatch({ t: "resetLive" });
      break;
    case "retry":
      dispatch({
        t: "push",
        item: {
          kind: "info",
          text: t(
            `⟳ provider transient error, retry #${ev.attempt} after ${ev.delayMs}ms (${firstLine(ev.reason)})`,
            `⟳ provider 瞬时错误，${ev.delayMs}ms 后第 ${ev.attempt} 次重试（${firstLine(ev.reason)}）`,
          ),
        },
      });
      break;
    case "tool_start":
      dispatch({ t: "flushLive" });
      dispatch({ t: "toolStart", id: ev.id, name: ev.name, ruleKey: ev.ruleKey });
      break;
    case "tool_permission":
      if (ev.decision === "deny") dispatch({ t: "toolDeny", id: ev.id });
      break;
    case "tool_result":
      dispatch({
        t: "toolFinish",
        id: ev.id,
        status: ev.isError ? "err" : "ok",
        detail: firstLine(ev.content),
      });
      break;
    case "turn_end":
      dispatch({ t: "usage", u: ev.usage });
      break;
    case "compacted":
      dispatch({
        t: "push",
        item: {
          kind: "info",
          text: t(
            `Context compacted ${ev.beforeTokens}→${ev.afterTokens} tokens`,
            `上下文已压缩 ${ev.beforeTokens}→${ev.afterTokens} tokens`,
          ),
        },
      });
      break;
    case "done":
      dispatch({ t: "flushLive" });
      dispatch({ t: "usage", u: ev.usage });
      break;
    case "error":
      dispatch({ t: "flushLive" });
      dispatch({ t: "push", item: { kind: "error", text: ev.message } });
      break;
  }
}

function restoreTranscript(messages: readonly ChatMessage[]): {
  items: Item[];
  activeTools: Map<string, Extract<Item, { kind: "tool" }>>;
} {
  const items: Item[] = [];
  const activeTools = new Map<string, Extract<Item, { kind: "tool" }>>();
  for (const item of messagesToItems(messages)) {
    if (item.kind === "tool" && item.status === "run") activeTools.set(item.id, item);
    else items.push(item);
  }
  return { items, activeTools };
}

function sessionBoundary(meta: SessionMeta): Item {
  return {
    kind: "info",
    text:
      t(
        `── Session boundary ${meta.id} · ${meta.model}`,
        `── 会话边界 ${meta.id} · ${meta.model}`,
      ) +
      (meta.title ? ` · ${meta.title}` : "") +
      " ──",
  };
}

function helpText(): string {
  return [
    t("/help                 Show command help", "/help                 显示命令帮助"),
    t(
      "/status               Show current session, model and directory",
      "/status               显示当前会话、模型与目录",
    ),
    t(
      "/providers            List canonical providers and credential hints",
      "/providers            列出 canonical provider 及凭证提示",
    ),
    t(
      "/model                Open the built-in model picker (including Free/open-weight models)",
      "/model                打开内置模型选择器（含免费/开源模型）",
    ),
    t(
      "/model <provider/model> Start a new session directly with the given model",
      "/model <provider/model> 直接以指定模型新建会话",
    ),
    t("/sessions             List recent sessions", "/sessions             列出最近会话"),
    t("/resume <sessionId>   Load an existing session", "/resume <sessionId>   载入已有会话"),
    t(
      "/new [title]          Start a new session with the current model and directory",
      "/new [标题]           以当前模型和目录新建会话",
    ),
    t(
      "/undo                 Undo the last turn's file changes (git snapshot rollback, conversation unchanged)",
      "/undo                 撤销上一轮的文件改动（git 快照回滚，不改对话）",
    ),
    t(
      "/plan [on|off]        Toggle plan mode: read-only planning; exit to execute",
      "/plan [on|off]        切换计划模式：只读规划；退出后再执行",
    ),
    t("/lang <en|zh>         Switch UI language", "/lang <en|zh>         切换界面语言"),
    t("/exit                 Exit", "/exit                 退出"),
  ].join("\n");
}

function providersText(
  providers: readonly ProviderDescriptor[],
  inspectCredentials: boolean,
): string {
  if (providers.length === 0) {
    return t(
      "The current host does not provide a provider list; you can still use /model <provider/model> and let the host validate",
      "当前宿主未提供 provider 列表；仍可用 /model <provider/model> 交由 host 校验",
    );
  }
  return [
    t(
      "Provider (canonical id · protocol · location · credential)",
      "Provider（canonical id · 协议 · 位置 · 凭证）",
    ),
    ...providers.map((provider) => {
      const configuredEnv = inspectCredentials
        ? provider.apiKeyEnv.find((name) => Boolean(process.env[name]?.trim()))
        : undefined;
      const credential = !provider.requiresApiKey
        ? t("No API key required", "无需 API key")
        : !inspectCredentials
          ? t(
              `Credential validated by host (${provider.apiKeyEnv.join(t(" or ", " 或 ")) || "API key"})`,
              `凭证由宿主校验（${provider.apiKeyEnv.join(t(" or ", " 或 ")) || "API key"}）`,
            )
          : configuredEnv
            ? t(`${configuredEnv} configured`, `${configuredEnv} 已配置`)
            : t(
                `Missing ${provider.apiKeyEnv.join(t(" or ", " 或 ")) || t("API key env var", "API key 环境变量")}`,
                `缺少 ${provider.apiKeyEnv.join(t(" or ", " 或 ")) || t("API key env var", "API key 环境变量")}`,
              );
      return `${provider.id} · ${provider.name} · ${provider.protocol} · ${provider.local ? t("local", "本地") : t("cloud", "云端")} · ${credential}`;
    }),
  ].join("\n");
}

interface PickerRow {
  spec: string;
  label: string;
  providerName: string;
  free: boolean;
  openWeight: boolean;
  recommended: boolean;
  local: boolean;
  note?: string;
  /** 凭证是否就绪；无法本地探测时为 undefined（由宿主校验）。 */
  ready: boolean | undefined;
  readyHint: string;
}

/** 把打平的模型目录转成选择器行，并按（就绪·推荐）优先稳定排序。 */
export function buildPickerRows(
  catalog: readonly ModelCatalogEntry[],
  providers: readonly ProviderDescriptor[],
  inspectCredentials: boolean,
  liveLocal?: { probed: Set<string>; live: Set<string> },
): PickerRow[] {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const rows = catalog.map((entry): PickerRow => {
    const descriptor = byId.get(entry.providerId);
    const apiKeyEnv = descriptor?.apiKeyEnv ?? [];
    let ready: boolean | undefined;
    let readyHint: string;
    if (liveLocal?.probed.has(entry.providerId)) {
      // 有本地端点的 provider：以存活探测为准，未启动就别标成就绪（否则选了必然 Connection error）。
      ready = liveLocal.live.has(entry.providerId);
      readyHint = ready
        ? t(`${entry.providerName} ready`, `${entry.providerName} 已就绪`)
        : t(`Start ${entry.providerName} first`, `需先启动 ${entry.providerName}`);
    } else if (!entry.requiresApiKey) {
      ready = true;
      readyHint = entry.local ? t("local/no key", "本地/免 key") : t("no key", "免 key");
    } else if (!inspectCredentials) {
      ready = undefined;
      readyHint = t("Credential validated by host", "凭证由宿主校验");
    } else {
      const configured = apiKeyEnv.find((name) => Boolean(process.env[name]?.trim()));
      ready = Boolean(configured);
      readyHint = configured
        ? t(`${configured} configured`, `${configured} 已配置`)
        : t(
            `Missing ${apiKeyEnv.join("/") || "API key"}`,
            `缺 ${apiKeyEnv.join("/") || "API key"}`,
          );
    }
    return {
      spec: entry.spec,
      label: entry.label ?? entry.model,
      providerName: entry.providerName,
      free: Boolean(entry.free),
      openWeight: Boolean(entry.openWeight),
      recommended: Boolean(entry.recommended),
      local: entry.local,
      ...(entry.note ? { note: entry.note } : {}),
      ready,
      readyHint,
    };
  });
  // 保留目录顺序（已按 provider 聚合），便于选择器按 provider 分组展示。
  return rows;
}

/** 按搜索词过滤选择器行（匹配 label / spec / provider）。 */
export function filterPickerRows(rows: readonly PickerRow[], filter: string): PickerRow[] {
  const q = filter.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter(
    (r) =>
      r.spec.toLowerCase().includes(q) ||
      r.label.toLowerCase().includes(q) ||
      r.providerName.toLowerCase().includes(q),
  );
}

/** 探测本地 provider 存活，返回 {有端点的, 确实在跑的} 两个集合供就绪判定。 */
async function probeLive(
  providers: readonly ProviderDescriptor[],
): Promise<{ probed: Set<string>; live: Set<string> }> {
  const probed = new Set(
    providers.filter((p) => p.local && (p.baseURL || p.baseURLEnv)).map((p) => p.id),
  );
  const live = await probeLocalProviders(providers);
  return { probed, live };
}

// opencode 同款选择器高亮色（暖橙）。
const PICKER_HL = "#f6b17a";

/** 同 truncWidth，但保留尾部、省略号放在头部（路径的尾巴比头部有信息量）。 */
function truncWidthStart(s: string, max: number): string {
  if (dispWidth(s) <= max) return s;
  if (max <= 0) return "";
  const chars = [...s];
  let out = "";
  let w = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = dispWidth(chars[i]!);
    if (w + cw > max - 1) break;
    out = chars[i]! + out;
    w += cw;
  }
  return "…" + out;
}

/** 提示条：按 " · " 连接，放不下就从尾部整条丢弃——截成半截词没有意义。 */
function fitHints(hints: readonly string[], width: number): string {
  let n = hints.length;
  while (n > 0 && dispWidth(hints.slice(0, n).join(" · ")) > width) n--;
  return hints.slice(0, n).join(" · ");
}

function ModelPicker({
  rows,
  index,
  filter,
  width = 72,
  maxRows = 24,
}: {
  rows: PickerRow[];
  index: number;
  filter: string;
  width?: number;
  maxRows?: number;
}) {
  const visible = filterPickerRows(rows, filter);
  const inner = Math.max(24, width - 6); // 扣掉边框(2) + 左右内边距(4)
  // 列表开窗：让高亮项始终可见，超长目录只画一段。
  const maxItems = Math.max(6, maxRows - 10);
  let start = 0;
  if (visible.length > maxItems) {
    start = Math.min(Math.max(0, index - Math.floor(maxItems / 2)), visible.length - maxItems);
  }
  const windowRows = visible.slice(start, start + maxItems);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={2}
      paddingY={1}
      width={width}
    >
      <Box justifyContent="space-between">
        <Text bold>{t("Select model", "选择模型")}</Text>
        <Text dimColor>esc</Text>
      </Box>
      <Box marginTop={1}>
        {filter ? (
          <Text>
            {filter}
            <Text backgroundColor={PICKER_HL}> </Text>
          </Text>
        ) : (
          <Text dimColor>
            <Text backgroundColor={PICKER_HL}> </Text>
            {t("Search…", "搜索…")}
          </Text>
        )}
      </Box>

      {visible.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>{t("(no matching models)", "（无匹配模型）")}</Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        {windowRows.map((row, i) => {
          const globalIdx = start + i;
          const selected = globalIdx === index;
          const prev = windowRows[i - 1];
          const showHeader = i === 0 || prev?.providerName !== row.providerName;
          const rightTag = row.free ? "Free" : row.ready === false ? row.readyHint : "";
          // 选中行画成整行暖橙底、深色字（对齐 opencode）。
          if (selected) {
            const rightW = dispWidth(rightTag);
            const left = truncWidth(`● ${row.label}`, inner - rightW - 1);
            const pad = Math.max(1, inner - dispWidth(left) - rightW);
            return (
              <React.Fragment key={row.spec}>
                {showHeader ? <ProviderHeader name={row.providerName} /> : null}
                <Text backgroundColor={PICKER_HL} color="black">
                  {left}
                  {" ".repeat(pad)}
                  {rightTag}
                </Text>
              </React.Fragment>
            );
          }
          return (
            <React.Fragment key={row.spec}>
              {showHeader ? <ProviderHeader name={row.providerName} /> : null}
              <Box justifyContent="space-between">
                <Text>
                  {"  "}
                  {row.label}
                </Text>
                <Text dimColor>{rightTag}</Text>
              </Box>
            </React.Fragment>
          );
        })}
      </Box>

      <Box marginTop={1} justifyContent="space-between">
        <Text dimColor>{t("↑/↓ select · Enter confirm", "↑/↓ 选择 · Enter 确认")}</Text>
        <Text dimColor>{t("esc cancel", "esc 取消")}</Text>
      </Box>
    </Box>
  );
}

function ProviderHeader({ name }: { name: string }) {
  return (
    <Box marginTop={1}>
      <Text color="magenta" bold>
        {name}
      </Text>
    </Box>
  );
}

// ---------- 欢迎页 logo ----------

/** 取 s 在 [from, to) 这段全局列区间内的可见部分；s 自身占据 [offset, offset+s.length)。 */
function clipSegment(s: string, offset: number, from: number, to: number): string {
  const a = Math.max(from, offset);
  const b = Math.min(to, offset + s.length);
  return b <= a ? "" : s.slice(a - offset, b - offset);
}

// opencode 同款：3 行半块（▀▄█）大字 wordmark。前段 ani 中灰、后段 code 亮白。
// 每个字形三行等宽，字间留 1 列。窄屏放不下时回落到紧凑单行，不折行不变形。
const LOGO_GLYPHS: Record<string, [string, string, string]> = {
  a: ["█▀▀█", "█▀▀█", "▀  ▀"],
  n: ["█▀▀▄", "█  █", "▀  ▀"],
  i: ["█", "█", "▀"],
  c: ["█▀▀", "█  ", "▀▀▀"],
  o: ["█▀▀█", "█  █", "▀▀▀▀"],
  d: ["█▀▀▄", "█  █", "▀▀▀ "],
  e: ["█▀▀", "█▀▀", "▀▀▀"],
};

/** 把若干字母拼成 3 行块字（字间 1 空列）。 */
function bigWord(letters: string): [string, string, string] {
  const rows: [string, string, string] = ["", "", ""];
  const chars = [...letters];
  chars.forEach((ch, idx) => {
    const g = LOGO_GLYPHS[ch]!;
    for (let r = 0; r < 3; r++) rows[r] += (idx > 0 ? " " : "") + g[r];
  });
  return rows;
}

export function Welcome({ width }: { width: number }) {
  const head = bigWord("ani");
  const tail = bigWord("code");
  const headW = head[0].length;
  const bigW = headW + 1 + tail[0].length; // ani + 空列 + code
  // 始终画 3 行大 logo；放不下就居中裁两侧（大不了两边显示不全），不回落单行、不折行。
  const from = Math.max(0, Math.floor((bigW - width) / 2));
  const to = from + Math.min(width, bigW);
  return (
    <Box flexDirection="column" alignItems="center">
      {[0, 1, 2].map((r) => (
        <Text key={r} wrap="truncate">
          <Text color="#6b6b6b">{clipSegment(head[r]!, 0, from, to)}</Text>
          <Text>{clipSegment(" ", headW, from, to)}</Text>
          <Text color="#e6e6e6" bold>
            {clipSegment(tail[r]!, headW + 1, from, to)}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function mergePendings(a: PendingPerm[], b: PendingPerm[]): PendingPerm[] {
  const merged = new Map<string, PendingPerm>();
  for (const p of [...a, ...b]) merged.set(p.permId, p);
  return [...merged.values()];
}

function isTodoProgress(value: unknown): value is { type: "todos"; todos: TodoItem[] } {
  if (!value || typeof value !== "object") return false;
  const v = value as { type?: unknown; todos?: unknown };
  return v.type === "todos" && Array.isArray(v.todos);
}

function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text dimColor>{t("Task list", "任务清单")}</Text>
      {todos.map((todo, i) => {
        const mark = todo.status === "completed" ? "✔" : todo.status === "in_progress" ? "●" : "○";
        const markColor =
          todo.status === "completed" ? "green" : todo.status === "in_progress" ? "yellow" : "gray";
        const text =
          todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content;
        return (
          <Text key={`${i}:${todo.content}`}>
            <Text color={markColor as never}>{mark} </Text>
            <Text
              {...(todo.status === "in_progress"
                ? { color: "yellow" as const, bold: true }
                : todo.status === "completed"
                  ? { dimColor: true }
                  : {})}
            >
              {text}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}

/** 斜杠命令补全菜单（in-tree 版，用于非浮层模式/测试）；高亮项暖橙底。 */
function CommandMenu({ rows, index }: { rows: CommandMenuRow[]; index: number }) {
  const idx = Math.max(0, Math.min(index, rows.length - 1));
  const nameCol = Math.min(18, Math.max(1, ...rows.map((r) => dispWidth("/" + r.name)))) + 2;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {rows.map((r, i) => {
        const name = "/" + r.name;
        const namePad = name + " ".repeat(Math.max(1, nameCol - dispWidth(name)));
        if (i === idx) {
          return (
            <Text key={r.name} backgroundColor={PICKER_HL} color="black">
              {namePad}
              {r.description}
            </Text>
          );
        }
        return (
          <Text key={r.name}>
            <Text color="#f6b17a">{namePad}</Text>
            <Text dimColor>{r.description}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function SessionList({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        {t("Sessions (/resume <id> to load)", "会话列表（/resume <id> 载入）")}
      </Text>
      {sessions.length === 0 ? <Text dimColor>{t("(no sessions)", "（暂无会话）")}</Text> : null}
      {sessions.slice(0, 10).map((s) => (
        <Text key={s.id}>
          <Text color="green">{s.id}</Text>
          {s.running ? <Text color="yellow">{t(" ●running", " ●运行中")}</Text> : null}
          <Text dimColor>
            {" "}
            {s.title ?? t("(untitled)", "(无标题)")} · {s.model}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

// opencode 同款输入面板：整块底色比屏底稍亮一档、左侧青色竖条，撑满整行宽度。
const PANEL_BG = "#1e1e1e";
const PANEL_BAR = "#22d3ee";
// 取词放到调用点（渲染时），保证 /lang 切换后占位文案随之更新（不是 import 期冻结一次）。
const panelPlaceholder = () =>
  t(
    "Type a request to begin… e.g. “fix a failing test”",
    "输入需求开始… 例如「修复一个失败的测试」",
  );
const PANEL_DIM = "#9a9a9a";

function pad(width: number, used: number): string {
  return " ".repeat(Math.max(0, width - used));
}

/** 按显示列取 s 的 [from, to) 段；宽字符被窗口边界劈开时用空格占位，避免整行错列。 */
function sliceCols(s: string, from: number, to: number): string {
  let x = 0;
  let out = "";
  for (const ch of s) {
    const start = x;
    const end = x + dispWidth(ch);
    x = end;
    if (end <= from || start >= to) continue;
    out += start < from || end > to ? " ".repeat(Math.min(end, to) - Math.max(start, from)) : ch;
  }
  return out;
}

type Seg = { t: string; color: string };

/** 按列预算依次裁剪各段：整段放得下就原样，跨越边界的那段截断，之后的整段丢弃。 */
function fitSegments(segs: Seg[], budget: number): Seg[] {
  const out: Seg[] = [];
  let left = budget;
  for (const s of segs) {
    if (left <= 0) break;
    const w = dispWidth(s.t);
    if (w <= left) {
      out.push(s);
      left -= w;
    } else {
      out.push({ ...s, t: truncWidth(s.t, left) });
      left = 0;
    }
  }
  return out;
}

/**
 * 输入行的水平滚动窗口。单行输入放不下时不折行（会撑破面板）也不截断（会看不见正在敲的字），
 * 而是让窗口跟着光标走：文本放得下就从头显示，放不下就把光标块钉在右边缘。
 * App 用它算真实光标该停在第几列，InputPanel 用它取可见片段——两边必须同一套算法。
 */
export function inputView(text: string, cursor: number, width: number) {
  const avail = Math.max(1, width - 2); // 竖条 + 前导空格之后留给文本的列数
  const c = Math.max(0, Math.min(cursor, text.length));
  const caretX = dispWidth(text.slice(0, c));
  const at = text.slice(c, c + 1) || " "; // 文末光标是一个空块
  const endX = caretX + dispWidth(at);
  const totalX = Math.max(dispWidth(text), endX);
  const startX = totalX <= avail ? 0 : Math.min(caretX, Math.max(0, endX - avail));
  return { avail, caretX, at, endX, startX };
}

export function InputPanel({
  panelRef,
  text,
  cursor,
  model,
  cwd,
  title,
  running,
  spinner,
  width,
}: {
  panelRef?: React.Ref<DOMElement>;
  text: string;
  cursor: number;
  model: string;
  cwd: string;
  title?: string;
  running: boolean;
  spinner: string;
  width: number;
}) {
  const barColor = running ? "gray" : PANEL_BAR;
  const cursorCell = (ch: string) => (
    <Text color="black" backgroundColor="#dcdcdc">
      {ch}
    </Text>
  );

  // 输入行内容（不含左侧竖条）：前导空格 + 文本/占位 + 光标。inputW 含前导空格。
  const { avail, caretX, at, endX, startX } = inputView(text, cursor, width);
  let inputNode: React.ReactNode;
  let inputW: number;
  if (text) {
    // 只画窗口内的部分：光标块两侧各取可见片段，宽度合计不超过 avail。
    const before = sliceCols(text, startX, caretX);
    const after = sliceCols(text, endX, startX + avail);
    inputNode = (
      <>
        {" "}
        {before}
        {cursorCell(at)}
        {after}
      </>
    );
    inputW = 1 + dispWidth(before) + dispWidth(at) + dispWidth(after);
  } else {
    // 占位文案按剩余列截断，窄屏下才不会折行把面板撑破。
    const ph = truncWidth(panelPlaceholder(), Math.max(0, avail - 1));
    inputNode = (
      <>
        {" "}
        {cursorCell(" ")}
        <Text color={PANEL_DIM}>{ph}</Text>
      </>
    );
    inputW = 1 + 1 + dispWidth(ph);
  }

  // 模型行：前导空格 + spinner + 空格 之后，把各段按剩余列预算依次裁掉。
  const metaSegs = fitSegments(
    [
      { t: model, color: "white" },
      { t: ` · ${basename(cwd)}`, color: PANEL_DIM },
      ...(title ? [{ t: ` · ${truncate(title, 20)}`, color: PANEL_DIM }] : []),
    ],
    Math.max(0, width - 4),
  );
  const metaUsed = 3 + metaSegs.reduce((w, s) => w + dispWidth(s.t), 0);

  // 每行统一：竖条(▎, 1/4 块，宽 1 格) + 内容 + 补白；竖条贯穿整块高度（对齐 opencode）。
  // wrap=truncate 兜底：上面的列宽都算准了才不会真截到字，但即便算漏一格，
  // 也只是少画一列，而不是折行把面板撑成两行、竖条断掉。
  const bar = <Text color={barColor}>▎</Text>;
  const rowLine = (content: React.ReactNode, used: number) => (
    <Text backgroundColor={PANEL_BG} wrap="truncate">
      {bar}
      {content}
      {pad(width, 1 + used)}
    </Text>
  );

  return (
    <Box flexDirection="column" width={width} ref={panelRef}>
      {rowLine(null, 0)}
      {rowLine(inputNode, inputW)}
      {rowLine(null, 0)}
      {rowLine(
        <>
          {" "}
          <Text color={running ? "yellow" : PANEL_BAR}>{spinner}</Text>{" "}
          {metaSegs.map((s) => (
            <Text key={s.t} color={s.color}>
              {s.t}
            </Text>
          ))}
        </>,
        metaUsed,
      )}
      {rowLine(null, 0)}
    </Box>
  );
}

// memo：历史条目引用不变时跳过重渲染，流式期间只有尾部活动条目会更新。
const ItemView = React.memo(ItemViewImpl);

function ItemViewImpl({ item }: { item: Item }) {
  switch (item.kind) {
    case "info":
      return <Text dimColor>{item.text}</Text>;
    case "user":
      return (
        <Box>
          <Text color="blue" bold>
            ❯{" "}
          </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box>
          <Text color="green">● </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "tool": {
      const mark =
        item.status === "run"
          ? "⚙"
          : item.status === "ok"
            ? "✔"
            : item.status === "deny"
              ? "⊘"
              : "✖";
      const color =
        item.status === "ok"
          ? "cyan"
          : item.status === "err"
            ? "red"
            : item.status === "deny"
              ? "yellow"
              : "gray";
      return (
        <Box>
          <Text color={color as never}> {mark} </Text>
          <Text bold>{item.name}</Text>
          <Text dimColor> {truncate(item.ruleKey, 50)}</Text>
          {item.detail ? <Text dimColor> — {item.detail}</Text> : null}
        </Box>
      );
    }
    case "error":
      return <Text color="red">✖ {item.text}</Text>;
  }
}
