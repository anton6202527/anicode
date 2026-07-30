/**
 * Electron 主进程入口。
 *
 * 职责：创建窗口、在主进程内启动 core（经 Bridge 暴露给渲染进程）、管理生命周期。
 * 真正的会话逻辑全在 @anicode/core；主进程只做窗口与传输。
 */

import * as path from "node:path";
import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { loadConfig, loadProjectEnv, resolveDefaultModel } from "@anicode/core";
import { Bridge } from "./bridge.js";
import { trustedExternalUrl, trustedRendererDevUrl } from "../shared/security.js";

// electron-vite 会注入渲染层入口：dev 下是 devServer URL，prod 下是打包 HTML。
const rendererDevUrlInput = process.env["ELECTRON_RENDERER_URL"];
const RENDERER_DEV_URL = app.isPackaged ? undefined : trustedRendererDevUrl(rendererDevUrlInput);
if (!app.isPackaged && rendererDevUrlInput && !RENDERER_DEV_URL) {
  throw new Error("Refusing non-loopback ELECTRON_RENDERER_URL");
}

let bridge: Bridge | undefined;
let shutdownStarted = false;
const trustedWebContentsIds = new Set<number>();

function trustedIpcSender(event: IpcMainInvokeEvent): boolean {
  return (
    trustedWebContentsIds.has(event.sender.id) &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame
  );
}

async function createBridge(): Promise<Bridge> {
  const userData = app.getPath("userData");
  const cwd = process.cwd();
  await loadProjectEnv({ cwd });
  const { config } = await loadConfig({ cwd });
  return new Bridge({
    cwd,
    sessionsDir: path.join(userData, "sessions"),
    pluginsFile: path.join(userData, "plugins.json"),
    modelsFile: path.join(userData, "models.json"),
    appName: app.getName(),
    appVersion: app.getVersion(),
    defaultModel: config.model ?? resolveDefaultModel(),
    isTrustedSender: trustedIpcSender,
  });
}

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

app.whenReady().then(async () => {
  bridge = await createBridge();
  bridge.register(ipcMain);
  // 连接已启用的 MCP 插件后再建窗；连接失败不阻塞启动（状态在市场里展示）。
  await bridge.init().catch(() => {});
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  const current = bridge;
  bridge = undefined;
  void (current?.dispose() ?? Promise.resolve())
    .catch((error) => console.error("anicode app: resource shutdown failed", error))
    .finally(() => app.quit());
});
