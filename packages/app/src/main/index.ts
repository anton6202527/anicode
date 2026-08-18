/**
 * Electron 主进程入口。
 *
 * 职责：创建窗口、在主进程内启动 core（经 Bridge 暴露给渲染进程）、管理生命周期。
 * 真正的会话逻辑全在 @anicode/core；主进程只做窗口与传输。
 */

import * as path from "node:path";
import { createRequire } from "node:module";
import {
  app,
  BrowserWindow,
  crashReporter,
  ipcMain,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent,
} from "electron";
import { autoUpdater } from "electron-updater";
import { loadConfig, loadProjectEnv, WorkspaceTrustStore } from "@anicode/core";
import { Bridge } from "./bridge.js";
import {
  ElectronUtilityKeychainBackend,
  type ElectronKeychainUtilityFactory,
  type ElectronKeychainUtilityProcess,
} from "./electron-keychain-backend.js";
import { trustedExternalUrl, trustedRendererDevUrl } from "../shared/security.js";
import { CloudAuthService } from "./cloud-auth.js";
import { ANICODE_CLOUD_CONFIG, ANICODE_CLOUD_DEFAULT_MODEL } from "./cloud-config.js";
import { registerAnicodeCloudProvider } from "./cloud-provider.js";
import { resolveAppStartupPolicy } from "./startup-policy.js";

// electron-vite 会注入渲染层入口：dev 下是 devServer URL，prod 下是打包 HTML。
const rendererDevUrlInput = process.env["ELECTRON_RENDERER_URL"];
const RENDERER_DEV_URL = app.isPackaged ? undefined : trustedRendererDevUrl(rendererDevUrlInput);
if (!app.isPackaged && rendererDevUrlInput && !RENDERER_DEV_URL) {
  throw new Error("Refusing non-loopback ELECTRON_RENDERER_URL");
}

let bridge: Bridge | undefined;
let shutdownStarted = false;
let updateTimer: NodeJS.Timeout | undefined;
const trustedWebContentsIds = new Set<number>();

// Crashpad starts before any renderer. Reports remain local unless an operator explicitly opts in
// and supplies an HTTPS collector; this avoids silently exporting user workspace data.
const crashSubmitUrl = process.env["ANICODE_CRASH_REPORT_URL"]?.trim();
const crashUploadEnabled = process.env["ANICODE_CRASH_REPORT_UPLOAD"] === "1";
const trustedCrashSubmitUrl = (() => {
  if (!crashSubmitUrl) return undefined;
  try {
    const parsed = new URL(crashSubmitUrl);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
})();
if (crashUploadEnabled && !trustedCrashSubmitUrl) {
  throw new Error("ANICODE_CRASH_REPORT_UPLOAD=1 requires an HTTPS ANICODE_CRASH_REPORT_URL");
}
crashReporter.start({
  uploadToServer: crashUploadEnabled,
  ...(trustedCrashSubmitUrl ? { submitURL: trustedCrashSubmitUrl } : {}),
  compress: true,
  rateLimit: true,
});

function startAutoUpdates(): void {
  if (!app.isPackaged || process.env["ANICODE_AUTO_UPDATE"] === "0") return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (error) => console.error("anicode app: update check failed", error));
  const check = () => void autoUpdater.checkForUpdatesAndNotify().catch(() => undefined);
  updateTimer = setTimeout(() => {
    check();
    updateTimer = setInterval(check, 6 * 60 * 60 * 1000);
    updateTimer.unref();
  }, 15_000);
  updateTimer.unref();
}

function trustedIpcSender(event: IpcMainInvokeEvent): boolean {
  return (
    trustedWebContentsIds.has(event.sender.id) &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame
  );
}

async function createBridge(): Promise<Bridge> {
  const userData = app.getPath("userData");
  const developmentWorkspace =
    process.env["ANICODE_DEV_WORKSPACE"] ??
    process.env["npm_config_local_prefix"] ??
    process.env["INIT_CWD"];
  const developmentDefaultModel = process.env["ANICODE_DEV_DEFAULT_MODEL"];
  const startup = resolveAppStartupPolicy({
    isPackaged: app.isPackaged,
    processCwd: process.cwd(),
    developmentDirect: process.env["ANICODE_DEV_DIRECT"] === "1",
    ...(developmentWorkspace ? { developmentWorkspace } : {}),
    ...(developmentDefaultModel ? { developmentDefaultModel } : {}),
  });
  const cwd = startup.cwd;
  const workspaceTrustStore = new WorkspaceTrustStore();
  const workspaceTrust = await workspaceTrustStore.assess(cwd);
  if (startup.loadProjectEnv) await loadProjectEnv({ cwd, workspaceTrust });
  const { config } = await loadConfig({ cwd, workspaceTrust });
  const credentialKind = process.env["ANICODE_CREDENTIAL_BACKEND"]?.trim() || "keychain";
  const credentialBackend =
    credentialKind === "keychain"
      ? createElectronKeychainBackend(
          process.env["ANICODE_KEYCHAIN_SERVICE"] ?? "dev.anicode.credentials",
        )
      : undefined;
  const cloudAuth =
    startup.cloudEnabled && credentialKind === "keychain"
      ? new CloudAuthService({
          backend: createElectronKeychainBackend("dev.anicode.cloud-auth"),
          projectUrl: ANICODE_CLOUD_CONFIG.projectUrl,
          publishableKey: ANICODE_CLOUD_CONFIG.publishableKey,
        })
      : undefined;
  if (cloudAuth) {
    // Packaged desktop startup must not wait on an unavailable Keychain/network. Development
    // explicitly uses the repository .env through the memory Broker and never constructs Cloud.
    await cloudAuth.restore({ signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
    registerAnicodeCloudProvider(cloudAuth);
  }
  try {
    return await Bridge.create({
      cwd,
      sessionsDir: path.join(userData, "sessions"),
      pluginsFile: path.join(userData, "plugins.json"),
      modelsFile: path.join(userData, "models.json"),
      appName: app.getName(),
      appVersion: app.getVersion(),
      ...(startup.defaultModel
        ? { defaultModel: startup.defaultModel }
        : config.model
          ? { defaultModel: config.model }
          : {}),
      config,
      workspaceTrust: workspaceTrustStore,
      workspaceTrusted: workspaceTrust.trusted,
      isTrustedSender: trustedIpcSender,
      ...(credentialBackend ? { credentialBackend } : {}),
      ...(cloudAuth ? { cloudAuth, cloudDefaultModel: ANICODE_CLOUD_DEFAULT_MODEL } : {}),
    });
  } catch (error) {
    await cloudAuth?.close();
    throw error;
  }
}

function createElectronKeychainBackend(service: string): ElectronUtilityKeychainBackend {
  return new ElectronUtilityKeychainBackend({
    service,
    helperPath: path.join(__dirname, "keychain-utility-helper.js"),
    modulePath: createRequire(__filename).resolve("@napi-rs/keyring"),
    utilityFactory: electronKeychainUtilityFactory,
    workingDirectory: path.dirname(process.execPath),
    environment: process.env,
  });
}

const electronKeychainUtilityFactory: ElectronKeychainUtilityFactory = {
  fork(modulePath, args, options): ElectronKeychainUtilityProcess {
    const environment = Object.fromEntries(
      Object.entries(options.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    return utilityProcess.fork(modulePath, [...args], {
      cwd: options.cwd,
      env: environment,
      execArgv: [...options.execArgv],
      serviceName: options.serviceName,
      stdio: options.stdio,
    }) as unknown as ElectronKeychainUtilityProcess;
  },
};

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "AniCode Zen",
    backgroundColor: "#1a1a1a",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  trustedWebContentsIds.add(win.webContents.id);
  win.webContents.once("destroyed", () => trustedWebContentsIds.delete(win.webContents.id));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    const trusted = trustedExternalUrl(url);
    if (trusted) void shell.openExternal(trusted).catch(() => undefined);
    return { action: "deny" };
  });
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  win.once("ready-to-show", () => win.show());

  if (RENDERER_DEV_URL) {
    void win.loadURL(RENDERER_DEV_URL);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(async () => {
    bridge = await createBridge();
    bridge.register(ipcMain);
    // Start trust/skill/MCP initialization first, but overlap it with window and renderer startup.
    // Bridge gates the first agent drive and plugin mutations on this shared readiness Promise.
    const initialization = bridge.init();
    createWindow();
    startAutoUpdates();
    void initialization.catch((error) =>
      console.error("anicode app: background initialization failed", error),
    );

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  if (updateTimer) clearTimeout(updateTimer);
  const current = bridge;
  bridge = undefined;
  void (current?.dispose() ?? Promise.resolve())
    .catch((error) => console.error("anicode app: resource shutdown failed", error))
    .finally(() => app.quit());
});
