/**
 * App —— Ink 前端，只依赖 SessionHost 接口（本地 or daemon 一视同仁）。
 *
 * 职责：订阅当前会话的事件流并渲染；收集输入（含 /斜杠命令）；把权限请求
 * 变成 y/a/n 交互回 answerPermission。会话逻辑全在 core，App 不碰。
 *
 * 斜杠命令：/help · /status · /providers · /model <provider/model> · /sessions · /resume <id> · /new [标题] · /exit
 */

import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { probeLocalProviders } from "@anicode/core";
import type {
  ChatMessage,
  ModelCatalogEntry,
  ProviderDescriptor,
  SessionEvent,
  SessionHost,
  SessionMeta,
  SessionSummary,
  TodoItem,
  Usage,
} from "@anicode/core";
import { messagesToItems, todosFromMessages, firstLine, truncate, type Item } from "./transcript.js";

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

const emptyUsage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** 品牌名（欢迎页 logo 与状态栏）。 */
export const APP_NAME = "anicode";

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
  version = "0.0.1",
}: AppProps) {
  const { exit } = useApp();
  const { rows: termRows } = useTerminalSize();
  // 进入 alt-screen 占满终端，退出时还原原有回滚缓冲（仅真实 TTY；测试跳过）。
  useEffect(() => {
    const out = process.stdout;
    if (!out.isTTY) return;
    out.write("\x1b[?1049h\x1b[H");
    return () => {
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
  const [picker, setPicker] = useState<{ rows: PickerRow[]; index: number; filter: string } | null>(null);
  const closeRef = useRef<(() => void) | null>(null);
  const flushRef = useRef<(() => void) | null>(null);

  const selectModel = useCallback(
    async (spec: string): Promise<void> => {
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
              `会话 ${state.meta.id} · ${state.meta.model} · ${state.meta.cwd}` +
              ` · ${state.running ? "运行中" : "空闲"}` +
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
          const liveLocal = inspectProviderCredentials
            ? await probeLive(providers)
            : undefined;
          const rows = buildPickerRows(catalog, providers, inspectProviderCredentials, liveLocal);
          if (rows.length === 0) {
            dispatch({ t: "push", item: { kind: "error", text: "内置模型目录为空；用 /model <provider/model> 指定" } });
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
          dispatch({ t: "push", item: { kind: "error", text: "用法: /resume <sessionId>" } });
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
      dispatch({ t: "push", item: { kind: "error", text: `未知命令: /${cmd}` } });
      return true;
    },
    [host, providers, catalog, inspectProviderCredentials, selectModel, state.meta, state.running, exit],
  );

  const submitLine = useCallback(
    (raw: string): void => {
      const text = raw.trim();
      if (!text) return;
      if (text.startsWith("/")) {
        void runSlash(text).catch((err) =>
          dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } }),
        );
        return;
      }
      // 运行中发送 = steering（core 在 turn 边界注入）；user 条目由事件渲染。
      dispatch({ t: "running", v: true });
      void host.send(sessionId, text).catch((err) => {
        dispatch({ t: "running", v: false });
        dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } });
      });
    },
    [host, runSlash, sessionId],
  );

  useInput((ch, key) => {
    // Ctrl+Z 退出（与 Ctrl+C 一致）；raw 模式下 Ctrl+Z 可能是 "z" 或 SUB 字符。
    if (key.ctrl && (ch === "z" || ch === "\u001a")) {
      exit();
      return;
    }
    if (picker) {
      const visible = filterPickerRows(picker.rows, picker.filter);
      if (key.escape) {
        setPicker(null);
        return;
      }
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
          dispatch({ t: "push", item: { kind: "error", text: `中断失败: ${errorMessage(err)}` } });
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
              item: { kind: "info", text: "该授权请求已由其他客户端处理" },
            });
          }
        })
        .catch((err) => {
          setPendings((q) => mergePendings([pending], q));
          dispatch({ t: "push", item: { kind: "error", text: `授权答复失败: ${errorMessage(err)}` } });
        });
      return;
    }
    if (state.running && key.escape) {
      void host.interrupt(sessionId);
      return;
    }
    if (pasteSubmitRef.current) {
      clearTimeout(pasteSubmitRef.current);
      pasteSubmitRef.current = null;
    }
    const normalized = ch.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const pastedNewline =
      normalized.includes("\n") &&
      (normalized.replace(/\n/g, "").length > 0 || !key.return);
    if (pastedNewline) {
      // 单行 TUI：内部换行只折成空格；只有 paste 本身以换行结尾时才等价
      // 于 Enter。短 debounce 可合并落在相邻 event-loop tick 的 PTY chunks。
      const next = inputRef.current + normalized.replace(/\n+/g, " ");
      inputRef.current = next;
      setInput(next);
      if (normalized.endsWith("\n")) {
        const scheduled = setTimeout(() => {
          if (pasteSubmitRef.current !== scheduled) return;
          pasteSubmitRef.current = null;
          const text = inputRef.current;
          inputRef.current = "";
          setInput("");
          submitLine(text);
        }, 25);
        pasteSubmitRef.current = scheduled;
      }
    } else if (key.return) {
      const text = inputRef.current;
      inputRef.current = "";
      setInput("");
      submitLine(text);
    } else if (key.backspace || key.delete) {
      const next = inputRef.current.slice(0, -1);
      inputRef.current = next;
      setInput(next);
    } else if (ch && !key.ctrl && !key.meta) {
      const next = inputRef.current + normalized;
      inputRef.current = next;
      setInput(next);
    }
  });

  const u = state.usage;
  const conversationEmpty =
    !state.items.some((i) => i.kind === "user" || i.kind === "assistant" || i.kind === "tool") &&
    !state.liveText &&
    state.activeTools.size === 0;

  // 只渲染贴底可见的尾部条目：屏幕至多容纳 termRows 行，取 2×termRows 个条目
  // 足以覆盖可见区（历史条目不进 yoga 布局），把整棵树的布局代价与会话长度解耦。
  const visibleItems = conversationEmpty
    ? state.items
    : state.items.slice(-(termRows * 2 + 16));
  const baseKey = state.items.length - visibleItems.length;

  return (
    <Box flexDirection="column" height={termRows}>
      {/* 内容区弹性铺满：有对话时贴底（最新可见）；空会话时贴顶（logo 在上）。 */}
      <Box
        flexGrow={1}
        flexDirection="column"
        overflow="hidden"
        justifyContent={conversationEmpty ? "flex-start" : "flex-end"}
      >
        {visibleItems.map((item, i) =>
          item.kind === "logo" ? (
            <Welcome key={baseKey + i} />
          ) : (
            <ItemView key={baseKey + i} item={item} />
          ),
        )}

        {state.liveText ? (
          <Box>
            <Text color="green">● </Text>
            <Text>{state.liveText}</Text>
          </Box>
        ) : null}

        {[...state.activeTools.values()].map((tool) => (
          <ItemView key={tool.id} item={tool} />
        ))}

        {state.todos.length > 0 ? <TodoList todos={state.todos} /> : null}
      </Box>

      {sessions ? <SessionList sessions={sessions} /> : null}

      {picker ? <ModelPicker rows={picker.rows} index={picker.index} filter={picker.filter} /> : null}

      {pendings[0] ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow">
            ⚠ 授权请求: <Text bold>{pendings[0].toolName}</Text>
            {pendings.length > 1 ? <Text dimColor>（还有 {pendings.length - 1} 个待裁决）</Text> : null}
          </Text>
          <Text dimColor>{truncate(pendings[0].ruleKey, 100)}</Text>
          <Text>[<Text color="green">y</Text>] 允许 [<Text color="cyan">a</Text>] 允许并记住 [<Text color="red">n</Text>] 拒绝</Text>
        </Box>
      ) : null}

      {!pendings[0] && !picker && (
        <Box flexDirection="column" marginTop={1}>
          <Box
            borderStyle="single"
            borderColor={state.running ? "gray" : "cyan"}
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            paddingLeft={1}
            flexDirection="column"
          >
            <Box>
              {input ? (
                <Text>{input}<Text inverse> </Text></Text>
              ) : (
                <Text dimColor>输入需求开始… 例如「修复一个失败的测试」<Text inverse> </Text></Text>
              )}
            </Box>
            <Text>
              <Text color={state.running ? "yellow" : "cyan"}>● </Text>
              <Text color="white">{state.meta.model}</Text>
              <Text dimColor> · {basename(state.meta.cwd)}</Text>
              {state.meta.title ? <Text dimColor> · {truncate(state.meta.title, 20)}</Text> : null}
            </Text>
          </Box>
          <Box justifyContent="flex-end">
            <Text dimColor>
              {state.running ? "esc 中断 · enter 追加" : "/model 换模型 · /help 命令 · ctrl+z 退出"}
            </Text>
          </Box>
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        <Box justifyContent="space-between">
          <Text dimColor>{tildify(state.meta.cwd)}</Text>
          <Text dimColor>{APP_NAME} v{version}</Text>
        </Box>
        <Text dimColor>{state.meta.model} · in {u.inputTokens} / out {u.outputTokens} tokens</Text>
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
    setPendings((q) => mergePendings(q, [{ permId: se.permId, toolName: se.toolName, ruleKey: se.ruleKey }]));
    return;
  }
  if (se.type === "permission_resolved") {
    setPendings((q) => q.filter((p) => p.permId !== se.permId));
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
      dispatch({ t: "push", item: { kind: "info", text: `⟳ provider 瞬时错误，${ev.delayMs}ms 后第 ${ev.attempt} 次重试（${firstLine(ev.reason)}）` } });
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
      dispatch({ t: "push", item: { kind: "info", text: `上下文已压缩 ${ev.beforeTokens}→${ev.afterTokens} tokens` } });
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
      `── 会话边界 ${meta.id} · ${meta.model}` +
      (meta.title ? ` · ${meta.title}` : "") +
      " ──",
  };
}

function helpText(): string {
  return [
    "/help                 显示命令帮助",
    "/status               显示当前会话、模型与目录",
    "/providers            列出 canonical provider 及凭证提示",
    "/model                打开内置模型选择器（含免费/开源模型）",
    "/model <provider/model> 直接以指定模型新建会话",
    "/sessions             列出最近会话",
    "/resume <sessionId>   载入已有会话",
    "/new [标题]           以当前模型和目录新建会话",
    "/exit                 退出",
  ].join("\n");
}

function providersText(
  providers: readonly ProviderDescriptor[],
  inspectCredentials: boolean,
): string {
  if (providers.length === 0) {
    return "当前宿主未提供 provider 列表；仍可用 /model <provider/model> 交由 host 校验";
  }
  return [
    "Provider（canonical id · 协议 · 位置 · 凭证）",
    ...providers.map((provider) => {
      const configuredEnv = inspectCredentials
        ? provider.apiKeyEnv.find((name) => Boolean(process.env[name]?.trim()))
        : undefined;
      const credential = !provider.requiresApiKey
        ? "无需 API key"
        : !inspectCredentials
          ? `凭证由宿主校验（${provider.apiKeyEnv.join(" 或 ") || "API key"}）`
          : configuredEnv
          ? `${configuredEnv} 已配置`
          : `缺少 ${provider.apiKeyEnv.join(" 或 ") || "API key 环境变量"}`;
      return `${provider.id} · ${provider.name} · ${provider.protocol} · ${provider.local ? "本地" : "云端"} · ${credential}`;
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
      readyHint = ready ? `${entry.providerName} 已就绪` : `需先启动 ${entry.providerName}`;
    } else if (!entry.requiresApiKey) {
      ready = true;
      readyHint = entry.local ? "本地/免 key" : "免 key";
    } else if (!inspectCredentials) {
      ready = undefined;
      readyHint = "凭证由宿主校验";
    } else {
      const configured = apiKeyEnv.find((name) => Boolean(process.env[name]?.trim()));
      ready = Boolean(configured);
      readyHint = configured ? `${configured} 已配置` : `缺 ${apiKeyEnv.join("/") || "API key"}`;
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

function ModelPicker({ rows, index, filter }: { rows: PickerRow[]; index: number; filter: string }) {
  const visible = filterPickerRows(rows, filter);
  const selectedSpec = visible[index]?.spec;
  // 按 provider 分组并保留出现顺序；只显示当前高亮项附近的一段，避免超长列表撑爆终端。
  const groups: { provider: string; items: PickerRow[] }[] = [];
  for (const row of visible) {
    const last = groups[groups.length - 1];
    if (last && last.provider === row.providerName) last.items.push(row);
    else groups.push({ provider: row.providerName, items: [row] });
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={2} paddingY={0}>
      <Box justifyContent="space-between">
        <Text bold>选择模型</Text>
        <Text dimColor>Esc</Text>
      </Box>
      <Box>
        <Text color="yellow">🔍 </Text>
        {filter ? <Text>{filter}<Text inverse> </Text></Text> : <Text dimColor>输入以搜索…<Text inverse> </Text></Text>}
      </Box>
      {visible.length === 0 ? <Text dimColor>（无匹配模型）</Text> : null}
      {groups.map((g) => (
        <Box key={g.provider} flexDirection="column" marginTop={1}>
          <Text color="magenta" bold>{g.provider}</Text>
          {g.items.map((row) => {
            const selected = row.spec === selectedSpec;
            const mark = row.ready === false ? "✖" : row.ready === true ? "✔" : "·";
            const markColor = row.ready === false ? "red" : row.ready === true ? "green" : "gray";
            return (
              <Box key={row.spec} justifyContent="space-between">
                <Text {...(selected ? { color: "cyan" as const, bold: true } : {})}>
                  {selected ? "❯ " : "  "}
                  <Text color={markColor as never}>{mark}</Text> {row.label}
                </Text>
                <Text dimColor>
                  {row.free ? "Free " : ""}
                  {row.ready === false ? row.readyHint : ""}
                </Text>
              </Box>
            );
          })}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ 选择 · Enter 确认 · Esc 取消</Text>
      </Box>
    </Box>
  );
}

// ---------- 欢迎页 logo ----------

const LOGO_GLYPHS: Record<string, string[]> = {
  a: [" ██ ", "█  █", "████", "█  █", "█  █"],
  n: ["█  █", "██ █", "█ ██", "█  █", "█  █"],
  i: ["███", " █ ", " █ ", " █ ", "███"],
  c: [" ███", "█   ", "█   ", "█   ", " ███"],
  o: [" ██ ", "█  █", "█  █", "█  █", " ██ "],
  d: ["██  ", "█ █ ", "█  █", "█ █ ", "██  "],
  e: ["████", "█   ", "███ ", "█   ", "████"],
};

function wordmarkRows(word: string): string[] {
  const rows = ["", "", "", "", ""];
  for (const ch of word) {
    const g = LOGO_GLYPHS[ch] ?? ["", "", "", "", ""];
    for (let r = 0; r < 5; r++) rows[r] += g[r] + " ";
  }
  return rows;
}

function Welcome() {
  // 对齐 opencode 的双色 wordmark：前段灰、后段亮白。
  const head = wordmarkRows("ani");
  const tail = wordmarkRows("code");
  return (
    <Box flexDirection="column" alignItems="center" marginTop={1} marginBottom={1}>
      {head.map((row, i) => (
        <Text key={i}>
          <Text color="gray">{row}</Text>
          <Text color="white" bold>{tail[i]}</Text>
        </Text>
      ))}
      <Box marginTop={1}>
        <Text dimColor>anicode · 自研 AI coding agent</Text>
      </Box>
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
      <Text dimColor>任务清单</Text>
      {todos.map((todo, i) => {
        const mark = todo.status === "completed" ? "✔" : todo.status === "in_progress" ? "●" : "○";
        const text = todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content;
        return (
          <Text
            key={`${i}:${todo.content}`}
            {...(todo.status === "in_progress" ? { color: "yellow" as const } : {})}
          >
            {mark} {text}
          </Text>
        );
      })}
    </Box>
  );
}

function SessionList({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>会话列表（/resume &lt;id&gt; 载入）</Text>
      {sessions.length === 0 ? <Text dimColor>（暂无会话）</Text> : null}
      {sessions.slice(0, 10).map((s) => (
        <Text key={s.id}>
          <Text color="green">{s.id}</Text>
          {s.running ? <Text color="yellow"> ●运行中</Text> : null}
          <Text dimColor> {s.title ?? "(无标题)"} · {s.model}</Text>
        </Text>
      ))}
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
      return <Box><Text color="blue" bold>❯ </Text><Text>{item.text}</Text></Box>;
    case "assistant":
      return <Box><Text color="green">● </Text><Text>{item.text}</Text></Box>;
    case "tool": {
      const mark = item.status === "run" ? "⚙" : item.status === "ok" ? "✔" : item.status === "deny" ? "⊘" : "✖";
      const color = item.status === "ok" ? "cyan" : item.status === "err" ? "red" : item.status === "deny" ? "yellow" : "gray";
      return (
        <Box>
          <Text color={color as never}>  {mark} </Text>
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
