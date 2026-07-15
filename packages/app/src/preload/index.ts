/**
 * Preload：唯一跨越隔离边界的桥。用 contextBridge 暴露一个受控、结构化可克隆的 API，
 * 渲染进程拿不到 ipcRenderer/Node，只能调用这里白名单出的方法。
 */

import { contextBridge, ipcRenderer } from "electron";
import type { AgentxApi, EventEnvelope } from "../shared/api.js";

const EVENT_CHANNEL = "anicode:event";

const api: AgentxApi = {
  appInfo: () => ipcRenderer.invoke("app:info"),

  listSessions: () => ipcRenderer.invoke("host:listSessions"),
  createSession: (input) => ipcRenderer.invoke("host:createSession", input),
  open: (sessionId) => ipcRenderer.invoke("host:open", sessionId),
  close: (subId) => ipcRenderer.invoke("host:close", subId),
  send: (sessionId, text) => ipcRenderer.invoke("host:send", sessionId, text),
  interrupt: (sessionId) => ipcRenderer.invoke("host:interrupt", sessionId),
  setTitle: (sessionId, title) => ipcRenderer.invoke("host:setTitle", sessionId, title),
  deleteSession: (sessionId) => ipcRenderer.invoke("host:deleteSession", sessionId),
  answerPermission: (sessionId, permId, decision) =>
    ipcRenderer.invoke("host:answerPermission", sessionId, permId, decision),

  onEvent: (listener) => {
    const handler = (_e: unknown, envelope: EventEnvelope) => listener(envelope);
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler);
  },

  listModelCatalog: () => ipcRenderer.invoke("meta:catalog"),
  listProviders: () => ipcRenderer.invoke("meta:providers"),
  listUserModels: () => ipcRenderer.invoke("meta:userModels"),
  addUserModel: (model) => ipcRenderer.invoke("meta:addUserModel", model),
  removeUserModel: (spec) => ipcRenderer.invoke("meta:removeUserModel", spec),

  listPlugins: () => ipcRenderer.invoke("plugins:list"),
  setPluginEnabled: (id, enabled) => ipcRenderer.invoke("plugins:setEnabled", id, enabled),
};

contextBridge.exposeInMainWorld("anicode", api);
