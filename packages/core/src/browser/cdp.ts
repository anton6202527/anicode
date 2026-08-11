/**
 * Chrome DevTools Protocol 驱动 —— 启动本机已装的 Chrome（headless），用自研 WsClient
 * 连上，导航到页面并采集验证信号：console 输出、未捕获异常、失败请求、标题、截图。
 *
 * 零依赖：不装 playwright、不下载浏览器。发现本机 Chrome/Chromium/Edge 二进制后以
 * `--remote-debugging-port=0` 启动，从 user-data-dir 的 DevToolsActivePort 文件读回端口，
 * 走 CDP flat-session（Target.attachToTarget flatten）多路复用页面会话。
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  promises as fs,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { terminateProcessTree } from "../runtime/isolated-runtime.js";
import { sanitizedShellEnv } from "../tools/shell-spawn.js";
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
export function resolveChromePath(
  explicit?: string,
  options: { requireTrustedExecutable?: boolean } = {},
): string {
  const tried: string[] = [];
  const push = (p: string | undefined): string | undefined => {
    if (!p) return undefined;
    tried.push(p);
    return existsSync(p) ? p : undefined;
  };
  const found =
    push(explicit) ??
    push(process.env["ANICODE_BROWSER_PATH"]) ??
    chromeCandidates().find(existsSync);
  if (!found) {
    throw new Error(
      `No Chrome/Chromium/Edge found. Set ANICODE_BROWSER_PATH or config browser.executablePath. Tried: ${[
        ...tried,
        ...chromeCandidates(),
      ].join(", ")}`,
    );
  }
  return options.requireTrustedExecutable ? trustedBrowserExecutable(found) : found;
}

function trustedBrowserExecutable(candidate: string): string {
  if (!isAbsolute(candidate)) {
    throw new Error("Production browser executable must use an absolute path");
  }
  let canonical: string;
  let stat: ReturnType<typeof statSync>;
  try {
    canonical = realpathSync(candidate);
    stat = statSync(canonical);
  } catch (error) {
    throw new Error(`Cannot verify browser executable ${candidate}`, { cause: error });
  }
  if (!stat.isFile()) throw new Error(`Browser executable is not a regular file: ${candidate}`);

  if (process.platform === "win32") {
    const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"]]
      .filter((value): value is string => Boolean(value))
      .map((value) => normalize(value).toLowerCase());
    const target = normalize(canonical).toLowerCase();
    if (!roots.some((root) => target === root || target.startsWith(root + sep))) {
      throw new Error("Production browser executable must be installed under Program Files");
    }
    return canonical;
  }

  // Project-controlled binaries and writable system shims are code execution, not configuration.
  // Production only accepts an administrator-owned executable whose group/other write bits are off.
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error(
      "Production browser executable must be root-owned and not group/world writable",
    );
  }
  return canonical;
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
  timeout: NodeJS.Timeout;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const BROWSER_PROFILE_PREFIX = "anicode-browser-";

/**
 * These switches define the local automation boundary and must never be delegated to project or
 * model-controlled browser arguments. Chromium generally lets a later duplicate switch win, so we
 * both reject duplicates and append the authoritative values after all allowed extra switches.
 */
const PROTECTED_BROWSER_SWITCHES = new Set([
  "password-store",
  "profile-directory",
  "remote-debugging-address",
  "remote-debugging-port",
  "use-mock-keychain",
  "user-data-dir",
]);

export interface BrowserLaunchArgumentOptions {
  userDataDir: string;
  platform?: NodeJS.Platform;
  headless?: boolean;
  extraArgs?: readonly string[];
}

/**
 * Keep Chromium's auxiliary state in the same disposable private profile as its user data.
 *
 * `sanitizedShellEnv` intentionally points generic shell tools at `/nonexistent`, but recent Linux
 * Chrome builds require a writable HOME/XDG runtime while their crash handler starts. Giving the
 * browser the real developer HOME would re-open the credential/config boundary, so browser
 * processes receive only profile-scoped locations instead.
 */
export function buildBrowserProcessEnvironment(
  userDataDir: string,
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (!isAbsolute(userDataDir) || userDataDir.includes("\0")) {
    throw new Error("Browser user-data directory must be an absolute path");
  }
  const env = sanitizedShellEnv(source);
  delete env["CHROME_CONFIG_HOME"];
  delete env["CHROME_USER_DATA_DIR"];
  env["HOME"] = userDataDir;
  env["USERPROFILE"] = userDataDir;
  if (platform === "win32") {
    env["APPDATA"] = join(userDataDir, "app-data");
    env["LOCALAPPDATA"] = join(userDataDir, "local-app-data");
  } else {
    env["XDG_CONFIG_HOME"] = join(userDataDir, "xdg-config");
    env["XDG_DATA_HOME"] = join(userDataDir, "xdg-data");
    env["XDG_STATE_HOME"] = join(userDataDir, "xdg-state");
    env["XDG_CACHE_HOME"] = join(userDataDir, "xdg-cache");
    env["XDG_RUNTIME_DIR"] = userDataDir;
  }
  return env;
}

function chromiumSwitchName(argument: string): string | undefined {
  const match = /^--([^=\s]+)(?:=.*)?$/.exec(argument);
  return match?.[1]?.toLowerCase();
}

function validateExtraBrowserArguments(extraArgs: readonly string[]): void {
  if (extraArgs.length > 64) throw new Error("Too many additional browser arguments");
  for (const argument of extraArgs) {
    if (Buffer.byteLength(argument, "utf8") > 4_096 || argument.includes("\0")) {
      throw new Error("Additional browser argument exceeds the safe boundary");
    }
    const name = chromiumSwitchName(argument);
    if (!name) {
      throw new Error("Additional browser arguments must be Chromium switches");
    }
    if (PROTECTED_BROWSER_SWITCHES.has(name)) {
      throw new Error(`Additional browser arguments cannot override --${name}`);
    }
  }
}

/**
 * Build arguments for AniCode's one-shot automation profile without starting a browser.
 *
 * macOS Chrome otherwise consults the login Keychain for its safe-storage key. The mock Keychain
 * switch confines encryption to this disposable profile. Linux Chromium can otherwise discover
 * libsecret/KWallet through the user session, so its basic store is confined to the same profile.
 * Neither switch changes host Keychain, desktop keyring, proxy, DNS, route or certificate state.
 */
export function buildBrowserLaunchArguments(options: BrowserLaunchArgumentOptions): string[] {
  if (!isAbsolute(options.userDataDir) || options.userDataDir.includes("\0")) {
    throw new Error("Browser user-data directory must be an absolute path");
  }
  const extraArgs = options.extraArgs ?? [];
  validateExtraBrowserArguments(extraArgs);
  const platform = options.platform ?? process.platform;
  const credentialIsolationArgs =
    platform === "darwin"
      ? ["--use-mock-keychain"]
      : platform === "linux"
        ? ["--password-store=basic"]
        : [];

  return [
    ...(options.headless === false ? [] : ["--headless=new"]),
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    ...extraArgs,
    // Authoritative boundary switches stay after extensibility arguments as defense in depth.
    ...credentialIsolationArgs,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${options.userDataDir}`,
    "--window-size=1280,800",
    "about:blank",
  ];
}

interface BrowserAutomationProfile {
  readonly parent: string;
  readonly directory: string;
}

/** @internal Exported so hermetic tests can prove profile permissions without launching Chrome. */
export function createPrivateBrowserAutomationProfile(): BrowserAutomationProfile {
  const parent = realpathSync(tmpdir());
  const parentStat = statSync(parent);
  if (!parentStat.isDirectory()) throw new Error("Browser temporary root is not a directory");
  const directory = mkdtempSync(join(parent, BROWSER_PROFILE_PREFIX));
  try {
    const initial = lstatSync(directory);
    if (!initial.isDirectory() || initial.isSymbolicLink()) {
      throw new Error("Browser automation profile is not a real directory");
    }
    if (process.platform !== "win32") {
      chmodSync(directory, 0o700);
      const secured = lstatSync(directory);
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (
        !secured.isDirectory() ||
        secured.isSymbolicLink() ||
        (uid !== undefined && secured.uid !== uid) ||
        (secured.mode & 0o077) !== 0
      ) {
        throw new Error("Browser automation profile must be private to the current user");
      }
    }
    return Object.freeze({ parent, directory });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Pure path check used before recursively deleting an automation profile. */
export function isManagedBrowserAutomationProfile(profile: BrowserAutomationProfile): boolean {
  if (!isAbsolute(profile.parent) || !isAbsolute(profile.directory)) return false;
  const parent = resolve(profile.parent);
  const directory = resolve(profile.directory);
  const leaf = basename(directory);
  return (
    dirname(directory) === parent &&
    leaf.startsWith(BROWSER_PROFILE_PREFIX) &&
    leaf.length > BROWSER_PROFILE_PREFIX.length
  );
}

/** 所有存活的浏览器实例；进程退出或显式 closeAllBrowsers() 时统一收尸。 */
const LIVE = new Set<Browser>();
let exitHooked = false;

export interface BrowserResource {
  close(): Promise<void>;
}

/** An ownership scope lets one host/session-manager dispose only the browsers it launched. */
export class BrowserRegistry {
  private readonly browsers = new Set<BrowserResource>();
  private readonly launches = new Set<Promise<unknown>>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  async add<T extends BrowserResource>(browser: T): Promise<T> {
    if (this.closed) {
      await browser.close();
      throw new Error("Browser registry is closed");
    }
    this.browsers.add(browser);
    return browser;
  }

  delete(browser: BrowserResource): void {
    this.browsers.delete(browser);
  }

  launch(opts: Omit<Parameters<typeof Browser.launch>[0], "registry">): Promise<Browser> {
    if (this.closed) return Promise.reject(new Error("Browser registry is closed"));
    const launch = Browser.launch({ ...opts, registry: this });
    this.launches.add(launch);
    void launch.finally(() => this.launches.delete(launch)).catch(() => undefined);
    return launch;
  }

  closeAll(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      const launchResults = await Promise.allSettled([...this.launches]);
      const closeResults = await Promise.allSettled(
        [...this.browsers].map((browser) => browser.close()),
      );
      const failures = [...launchResults, ...closeResults].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      const unexpected = failures.filter(
        (failure) =>
          !(failure instanceof Error && failure.message === "Browser registry is closed"),
      );
      if (unexpected.length > 0) {
        throw new AggregateError(unexpected, "Failed to close browsers");
      }
    })();
    return this.closePromise;
  }
}

/** 关闭所有存活的浏览器（供宿主优雅退出、测试收尾调用）。 */
export async function closeAllBrowsers(): Promise<void> {
  const results = await Promise.allSettled([...LIVE].map((browser) => browser.close()));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) throw new AggregateError(failures, "Failed to close browsers");
}

/** 一个已启动的浏览器进程 + 浏览器级 WS 连接。newPage() 开一个隔离标签会话。 */
export class Browser {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly sessionListeners = new Map<string, (method: string, params: any) => void>();

  private ws!: WsClient;
  private closePromise: Promise<void> | undefined;
  private terminalError: Error | undefined;

  private constructor(
    private readonly proc: ChildProcess,
    private readonly profile: BrowserAutomationProfile,
    private readonly commandTimeoutMs: number,
    private readonly registry?: BrowserRegistry,
  ) {}

  static async launch(opts: {
    executablePath?: string;
    requireTrustedExecutable?: boolean;
    headless?: boolean;
    launchTimeoutMs?: number;
    commandTimeoutMs?: number;
    args?: string[];
    registry?: BrowserRegistry;
  }): Promise<Browser> {
    const bin = resolveChromePath(
      opts.executablePath,
      opts.requireTrustedExecutable ? { requireTrustedExecutable: true } : {},
    );
    validateExtraBrowserArguments(opts.args ?? []);
    const profile = createPrivateBrowserAutomationProfile();
    const args = buildBrowserLaunchArguments({
      userDataDir: profile.directory,
      ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
      ...(opts.args ? { extraArgs: opts.args } : {}),
    });
    let proc: ChildProcess;
    try {
      proc = spawn(bin, args, {
        stdio: "ignore",
        env: buildBrowserProcessEnvironment(profile.directory),
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      await removeUserDataDir(profile);
      throw error;
    }
    // unref：Chrome 子进程不拖住 Node 事件循环退出（退出钩子仍会 kill 它）。
    proc.unref();
    proc.on("error", () => {
      /* 由 wsUrl 超时兜底报错 */
    });
    const timeoutMs = opts.launchTimeoutMs ?? 15_000;
    let wsUrl: string;
    try {
      wsUrl = await readDevToolsWsUrl(profile.directory, timeoutMs, proc);
    } catch (e) {
      await terminateChild(proc);
      await removeUserDataDir(profile);
      throw e;
    }
    const requestedCommandTimeout = opts.commandTimeoutMs ?? 30_000;
    const commandTimeoutMs =
      Number.isSafeInteger(requestedCommandTimeout) && requestedCommandTimeout > 0
        ? Math.min(requestedCommandTimeout, 5 * 60_000)
        : 30_000;
    const self = new Browser(proc, profile, commandTimeoutMs, opts.registry);
    try {
      self.ws = await WsClient.connect(
        wsUrl,
        {
          onMessage: (text) => self.dispatch(text),
          onClose: () => self.failPending(new Error("Chrome DevTools connection closed")),
          onError: (error) => self.failPending(error),
        },
        timeoutMs,
      );
    } catch (error) {
      await terminateChild(proc);
      await removeUserDataDir(profile);
      throw error;
    }
    proc.once("exit", () => {
      self.failPending(new Error("Chrome process exited"));
      void self.close().catch(() => undefined);
    });
    LIVE.add(self);
    if (opts.registry) await opts.registry.add(self);
    if (!exitHooked) {
      exitHooked = true;
      // A normal event-loop drain can await process termination and profile removal completely.
      process.once("beforeExit", () => {
        void closeAllBrowsers().catch(() => undefined);
      });
      // exit 事件不能等待 Promise，但 close() 在首次 await 前会同步关闭 WS 并 kill Chrome。
      process.once("exit", () => void closeAllBrowsers());
    }
    return self;
  }

  /** 发一条 CDP 命令。sessionId 有值时定向到某个页面会话（flat 模式）。 */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.closePromise) return Promise.reject(new Error("Browser closed"));
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.pending.size >= 256) {
      return Promise.reject(new Error("Too many Chrome DevTools commands in flight"));
    }
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg["sessionId"] = sessionId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        if (this.pending.size === 0) this.ws.unref();
        reject(new Error(`Chrome DevTools command timed out: ${method}`));
      }, this.commandTimeoutMs);
      timeout.unref();
      this.pending.set(id, { resolve, reject, timeout });
      // The browser process and idle socket are normally unref'ed. A live command, however,
      // must keep the event loop referenced or Node 22 can cancel the awaiting test/process.
      this.ws.ref();
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        if (this.pending.size === 0) this.ws.unref();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
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

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    LIVE.delete(this);
    this.registry?.delete(this);
    this.closePromise = (async () => {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      const closed = new Error("Browser closed");
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(closed);
      }
      this.pending.clear();
      this.sessionListeners.clear();
      await terminateChild(this.proc);
      await removeUserDataDir(this.profile);
    })();
    return this.closePromise;
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
      clearTimeout(p.timeout);
      if (this.pending.size === 0) this.ws.unref();
      if (msg.error) p.reject(new Error(msg.error.message ?? String(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // 事件：带 sessionId 的分派给对应页面。
    if (msg.method && msg.sessionId) {
      this.sessionListeners.get(msg.sessionId)?.(msg.method, msg.params ?? {});
    }
  }

  private failPending(error: Error): void {
    this.terminalError ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.terminalError);
    }
    this.pending.clear();
    this.sessionListeners.clear();
    try {
      this.ws?.unref();
    } catch {
      /* connection setup/teardown race */
    }
  }
}

/**
 * Chromium 会在收到 SIGTERM 后继续短暂写 profile；先等进程退出，再删除目录。
 * SIGTERM 超时才升级 SIGKILL，两个等待都有硬上限，避免宿主退出被卡死。
 */
async function terminateChild(proc: ChildProcess): Promise<void> {
  if (proc.pid === undefined) return;
  await terminateProcessTree(proc, { graceMs: 2_000, killWaitMs: 1_000 });
}

async function removeUserDataDir(profile: BrowserAutomationProfile): Promise<void> {
  if (!isManagedBrowserAutomationProfile(profile)) {
    throw new Error("Refusing to remove an unmanaged browser automation profile");
  }
  await fs.rm(profile.directory, {
    recursive: true,
    force: true,
    // 防病毒/Spotlight/Chromium helper 仍可能短暂持有或重建文件。
    maxRetries: 8,
    retryDelay: 50,
  });
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
    const params: Record<string, unknown> = {
      format: "png",
      captureBeyondViewport: !!opts.fullPage,
    };
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
  if (arg.value !== undefined)
    return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  if (arg.description) return String(arg.description);
  if (arg.preview?.properties) {
    return JSON.stringify(
      Object.fromEntries(arg.preview.properties.map((p: any) => [p.name, p.value])),
    );
  }
  return arg.type === "undefined" ? "undefined" : String(arg.type ?? "");
}
