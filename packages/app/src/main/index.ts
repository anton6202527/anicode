/**
 * Electron 主进程入口。
 *
 * 职责：创建窗口、在主进程内启动 core（经 Bridge 暴露给渲染进程）、管理生命周期。
 * 真正的会话逻辑全在 @anicode/core；主进程只做窗口与传输。
 */

import * as path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { Bridge } from "./bridge.js";

// electron-vite 会注入渲染层入口：dev 下是 devServer URL，prod 下是打包 HTML。
const RENDERER_DEV_URL = process.env["ELECTRON_RENDERER_URL"];

let bridge: Bridge | undefined;

function createBridge(): Bridge {
  const userData = app.getPath("userData");
  return new Bridge({
    cwd: process.cwd(),
    sessionsDir: path.join(userData, "sessions"),
    pluginsFile: path.join(userData, "plugins.json"),
    modelsFile: path.join(userData, "models.json"),
    appName: app.getName(),
    appVersion: app.getVersion(),
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "anicode",
    backgroundColor: "#1a1a1a",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  if (RENDERER_DEV_URL) {
    void win.loadURL(RENDERER_DEV_URL);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  bridge = createBridge();
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

app.on("will-quit", () => {
  bridge?.dispose();
  bridge = undefined;
});
