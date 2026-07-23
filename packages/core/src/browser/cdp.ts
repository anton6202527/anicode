/**
 * Chrome DevTools Protocol 驱动 —— 启动本机已装的 Chrome（headless），用自研 WsClient
 * 连上，导航到页面并采集验证信号：console 输出、未捕获异常、失败请求、标题、截图。
 *
 * 零依赖：不装 playwright、不下载浏览器。发现本机 Chrome/Chromium/Edge 二进制后以
 * `--remote-debugging-port=0` 启动，从 user-data-dir 的 DevToolsActivePort 文件读回端口，
 * 走 CDP flat-session（Target.attachToTarget flatten）多路复用页面会话。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WsClient } from "./ws.js";

/** 平台候选二进制路径（按优先级）。可被显式路径 / 环境变量覆盖。 */
function chromeCandidates(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (process.platform === "win32") {
    const pf = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    return [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/snap/bin/chromium",
  ];
}

/** 解析要用的 Chrome 二进制：显式 > 环境变量 ANICODE_BROWSER_PATH > 平台候选。找不到抛错。 */
export function resolveChromePath(explicit?: string): string {
  const tried: string[] = [];
  const push = (p: string | undefined): string | undefined => {
    if (!p) return undefined;
    tried.push(p);
    return existsSync(p) ? p : undefined;
  };
  const found =
    push(explicit) ?? push(process.env["ANICODE_BROWSER_PATH"]) ?? chromeCandidates().find(existsSync);
  if (!found) {
    throw new Error(
      `No Chrome/Chromium/Edge found. Set ANICODE_BROWSER_PATH or config browser.executablePath. Tried: ${[
        ...tried,
        ...chromeCandidates(),
      ].join(", ")}`,
    );
  }
  return found;
}

export interface ConsoleEntry {
  /** log / info / warning / error / debug 等；exception 表示未捕获异常。 */
  level: string;
  text: string;
  /** 来源 url:line（若有）。 */
  location?: string;
}

export interface NavigateResult {
  finalUrl: string;
  title: string;
  status?: number;
  console: ConsoleEntry[];
  failedRequests: { url: string; error: string }[];
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 所有存活的浏览器实例；进程退出或显式 closeAllBrowsers() 时统一收尸。 */
const LIVE = new Set<Browser>();
let exitHooked = false;

/** 关闭所有存活的浏览器（供宿主优雅退出、测试收尾调用）。 */
export function closeAllBrowsers(): void {
  for (const b of [...LIVE]) b.close();
}

/** 一个已启动的浏览器进程 + 浏览器级 WS 连接。newPage() 开一个隔离标签会话。 */
export class Browser {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly sessionListeners = new Map<string, (method: string, params: any) => void>();

  private ws!: WsClient;

  private constructor(
    private readonly proc: ChildProcess,
    private readonly userDataDir: string,
  ) {}

  static async launch(opts: {
    executablePath?: string;
    headless?: boolean;
    launchTimeoutMs?: number;
    args?: string[];
  }): Promise<Browser> {
    const bin = resolveChromePath(opts.executablePath);
    const userDataDir = mkdtempSync(join(tmpdir(), "anicode-browser-"));
    const headless = opts.headless !== false;
    const args = [
      ...(headless ? ["--headless=new"] : []),
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--window-size=1280,800",
      ...(opts.args ?? []),
      "about:blank",
    ];
    const proc = spawn(bin, args, { stdio: "ignore" });
    // unref：Chrome 子进程不拖住 Node 事件循环退出（退出钩子仍会 kill 它）。
    proc.unref();
    proc.on("error", () => {
      /* 由 wsUrl 超时兜底报错 */
    });
    const timeoutMs = opts.launchTimeoutMs ?? 15_000;
    let wsUrl: string;
    try {
      wsUrl = await readDevToolsWsUrl(userDataDir, timeoutMs, proc);
    } catch (e) {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      rmSync(userDataDir, { recursive: true, force: true });
      throw e;
    }
    const self = new Browser(proc, userDataDir);
    self.ws = await WsClient.connect(
      wsUrl,
      {
        onMessage: (text) => self.dispatch(text),
      },
      timeoutMs,
    );
    LIVE.add(self);
    if (!exitHooked) {
      exitHooked = true;
      process.once("exit", closeAllBrowsers);
    }
    return self;
  }

  /** 发一条 CDP 命令。sessionId 有值时定向到某个页面会话（flat 模式）。 */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg["sessionId"] = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }

  /** 开一个新页面（隔离标签），返回可导航的 Page。 */
  async newPage(): Promise<Page> {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    this.sessionListeners.set(sessionId, (method, params) => page.handleEvent(method, params));
    await page.init();
    return page;
  }

  closePage(sessionId: string, targetId: string): void {
    this.sessionListeners.delete(sessionId);
    void this.send("Target.closeTarget", { targetId }).catch(() => {});
  }

  close(): void {
    LIVE.delete(this);
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    rmSync(this.userDataDir, { recursive: true, force: true });
  }

  private dispatch(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? String(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // 事件：带 sessionId 的分派给对应页面。
    if (msg.method && msg.sessionId) {
      this.sessionListeners.get(msg.sessionId)?.(msg.method, msg.params ?? {});
    }
  }
}

/** 轮询 user-data-dir 下的 DevToolsActivePort 文件，读回 `ws://127.0.0.1:<port><path>`。 */
async function readDevToolsWsUrl(
  userDataDir: string,
  timeoutMs: number,
  proc: ChildProcess,
): Promise<string> {
  const file = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  proc.on("exit", () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error("Chrome exited before DevTools was ready");
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf8").trim();
      const [port, path] = raw.split("\n");
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    }
    await sleep(50);
  }
  throw new Error(`Chrome DevTools not ready after ${timeoutMs}ms`);
}

/** 一个页面会话：负责导航、采集 console/异常/失败请求、截图、执行 JS。 */
export class Page {
  private readonly console: ConsoleEntry[] = [];
  private readonly failedRequests: { url: string; error: string }[] = [];
  private readonly requestUrls = new Map<string, string>();
  private loadFired = false;
  private inflight = 0;

  constructor(
    private readonly browser: Browser,
    readonly sessionId: string,
    private readonly targetId: string,
  ) {}

  private cmd(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.browser.send(method, params, this.sessionId);
  }

  async init(): Promise<void> {
    await this.cmd("Page.enable");
    await this.cmd("Runtime.enable");
    await this.cmd("Log.enable");
    await this.cmd("Network.enable");
  }

  handleEvent(method: string, params: any): void {
    switch (method) {
      case "Page.loadEventFired":
        this.loadFired = true;
        break;
      case "Runtime.consoleAPICalled":
        this.console.push({
          level: String(params.type ?? "log"),
          text: (params.args ?? []).map(previewArg).join(" "),
        });
        break;
      case "Runtime.exceptionThrown": {
        const d = params.exceptionDetails ?? {};
        const text =
          d.exception?.description ?? d.text ?? d.exception?.value ?? "Uncaught exception";
        this.console.push({
          level: "exception",
          text: String(text),
          ...(d.url ? { location: `${d.url}:${d.lineNumber ?? 0}` } : {}),
        });
        break;
      }
      case "Log.entryAdded": {
        const e = params.entry ?? {};
        if (e.level === "error" || e.level === "warning") {
          this.console.push({
            level: String(e.level),
            text: String(e.text ?? ""),
            ...(e.url ? { location: String(e.url) } : {}),
          });
        }
        break;
      }
      case "Network.requestWillBeSent":
        this.inflight++;
        if (params.requestId && params.request?.url) {
          this.requestUrls.set(String(params.requestId), String(params.request.url));
        }
        break;
      case "Network.loadingFinished":
      case "Network.loadingFailed":
        if (this.inflight > 0) this.inflight--;
        if (method === "Network.loadingFailed") {
          // canceled 多为主动中止（如 fetch abort），不算页面错误。
          if (!params.canceled) {
            this.failedRequests.push({
              url: this.requestUrls.get(String(params.requestId)) ?? "",
              error: String(params.errorText ?? "failed"),
            });
          }
        }
        break;
    }
  }

  /** 导航并按 waitUntil 等待；返回采集到的验证信号。 */
  async navigate(
    url: string,
    opts: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeoutMs?: number } = {},
  ): Promise<NavigateResult> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const waitUntil = opts.waitUntil ?? "load";
    this.loadFired = false;
    const nav = await this.cmd("Page.navigate", { url });
    if (nav.errorText) {
      throw new Error(`navigation failed: ${nav.errorText}`);
    }
    const deadline = Date.now() + timeoutMs;
    if (waitUntil === "load") {
      while (!this.loadFired && Date.now() < deadline) await sleep(50);
    } else if (waitUntil === "domcontentloaded") {
      // DOMContentLoaded 早于 load；用 readyState 轮询近似。
      while (Date.now() < deadline) {
        const rs = await this.evaluate("document.readyState").catch(() => "");
        if (rs === "interactive" || rs === "complete") break;
        await sleep(50);
      }
    } else {
      // networkidle：load 触发后再等 500ms 无在途请求。
      while (!this.loadFired && Date.now() < deadline) await sleep(50);
      let idleSince = Date.now();
      while (Date.now() < deadline) {
        if (this.inflight === 0) {
          if (Date.now() - idleSince >= 500) break;
        } else {
          idleSince = Date.now();
        }
        await sleep(50);
      }
    }
    const title = await this.evaluate("document.title").catch(() => "");
    const finalUrl = await this.evaluate("location.href").catch(() => url);
    return {
      finalUrl: String(finalUrl ?? url),
      title: String(title ?? ""),
      console: [...this.console],
      failedRequests: [...this.failedRequests],
    };
  }

  /** 在页面里等某个选择器出现（存在即返回 true；超时返回 false）。 */
  async waitForSelector(selector: string, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const expr = `!!document.querySelector(${JSON.stringify(selector)})`;
    while (Date.now() < deadline) {
      if (await this.evaluate(expr).catch(() => false)) return true;
      await sleep(100);
    }
    return false;
  }

  /** 执行 JS 表达式，返回值（returnByValue）。 */
  async evaluate(expression: string): Promise<unknown> {
    const res = await this.cmd("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
    }
    return res.result?.value;
  }

  /** 截图，返回 PNG 的 base64。fullPage 时截整页。 */
  async screenshot(opts: { fullPage?: boolean } = {}): Promise<string> {
    const params: Record<string, unknown> = { format: "png", captureBeyondViewport: !!opts.fullPage };
    const res = await this.cmd("Page.captureScreenshot", params);
    return String(res.data ?? "");
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.cmd("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  close(): void {
    this.browser.closePage(this.sessionId, this.targetId);
  }
}

/** CDP Runtime.RemoteObject → 简短文本（console 参数预览）。 */
function previewArg(arg: any): string {
  if (arg == null) return "null";
  if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  if (arg.description) return String(arg.description);
  if (arg.preview?.properties) {
    return JSON.stringify(
      Object.fromEntries(arg.preview.properties.map((p: any) => [p.name, p.value])),
    );
  }
  return arg.type === "undefined" ? "undefined" : String(arg.type ?? "");
}
