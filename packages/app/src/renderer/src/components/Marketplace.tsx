import React, { useMemo, useState } from "react";
import { t } from "@anicode/core";
import type { PluginEntry, PluginCategory } from "../../../shared/plugins.js";

interface Props {
  plugins: PluginEntry[];
  onToggle: (id: string, enabled: boolean) => void;
}

const CATEGORY_LABEL: Record<PluginCategory | "all", string> = {
  all: t("All", "全部"),
  tool: t("Built-in tools", "内建工具"),
  mcp: t("MCP services", "MCP 服务"),
  skill: t("Skills", "技能"),
};

export function Marketplace({ plugins, onToggle }: Props) {
  const [filter, setFilter] = useState<PluginCategory | "all">("all");

  const shown = useMemo(
    () => (filter === "all" ? plugins : plugins.filter((p) => p.category === filter)),
    [plugins, filter],
  );
  const enabledCount = plugins.filter((p) => p.enabled).length;

  return (
    <div className="market">
      <header className="market-head">
        <div>
          <h1>{t("Marketplace", "插件市场")}</h1>
          <p>
            {t(
              `Extend agent capabilities: built-in tools, MCP services, and skills. Enabled ${enabledCount} / ${plugins.length}.`,
              `为 agent 扩展能力：内建工具、MCP 服务与技能。已启用 ${enabledCount} / ${plugins.length}。`,
            )}
          </p>
        </div>
      </header>

      <div className="market-tabs">
        {(["all", "tool", "mcp", "skill"] as const).map((c) => (
          <button
            key={c}
            className={`market-tab ${filter === c ? "active" : ""}`}
            onClick={() => setFilter(c)}
          >
            {CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>

      <div className="market-grid">
        {shown.map((p) => (
          <div key={p.id} className={`plugin-card ${p.enabled ? "on" : ""}`}>
            <div className="plugin-top">
              <span className="plugin-icon">{p.icon}</span>
              <div className="plugin-meta">
                <div className="plugin-name">
                  {p.name}
                  {p.builtin ? (
                    <span className="plugin-badge builtin">{t("Built-in", "内建")}</span>
                  ) : null}
                  <span className="plugin-badge cat">{CATEGORY_LABEL[p.category]}</span>
                </div>
                <div className="plugin-sub">
                  {p.author} · v{p.version}
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={(e) => onToggle(p.id, e.target.checked)}
                />
                <span className="slider" />
              </label>
            </div>
            <p className="plugin-desc">{p.description}</p>
            {p.mcpServer ? (
              <code className="plugin-cmd">
                {p.mcpServer.command} {p.mcpServer.args.join(" ")}
              </code>
            ) : null}
            {p.toolNames && p.toolNames.length > 0 ? (
              <div className="plugin-tools">
                {t(`Tools: ${p.toolNames.join(" · ")}`, `工具：${p.toolNames.join(" · ")}`)}
              </div>
            ) : null}
            {p.requiresEnv && p.requiresEnv.length > 0 ? (
              <div className="plugin-env">
                {t(
                  `Requires env vars: ${p.requiresEnv.join(", ")}`,
                  `需要环境变量：${p.requiresEnv.join(", ")}`,
                )}
              </div>
            ) : null}
            {p.enabled && p.runtime ? (
              <div className={`plugin-status ${p.runtime.connected ? "ok" : "err"}`}>
                {p.runtime.connected
                  ? t(
                      `● Connected${p.runtime.toolCount != null ? ` · ${p.runtime.toolCount} tools` : ""}`,
                      `● 已连接${p.runtime.toolCount != null ? ` · ${p.runtime.toolCount} 个工具` : ""}`,
                    )
                  : t(
                      `● Not connected: ${p.runtime.error ?? t("Connection failed", "连接失败")}`,
                      `● 未连接：${p.runtime.error ?? t("Connection failed", "连接失败")}`,
                    )}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
