import React, { useCallback, useEffect, useState } from "react";
import { t, type ProviderDescriptor, type SessionSummary } from "@anicode/core";
import type { AppInfo, ModelRow, PluginEntry, UserModel } from "../../shared/api.js";
import { Sidebar, type View } from "./components/Sidebar.js";
import { ChatView } from "./components/ChatView.js";
import { Composer } from "./components/Composer.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { Marketplace } from "./components/Marketplace.js";
import { useSession, errorMessage } from "./useSession.js";

const DEFAULT_MODEL = "debug/demo";

/** 用首条用户消息的首句生成简短标题。 */
function deriveTitle(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  const title = line.length > 40 ? line.slice(0, 40) + "…" : line;
  return title || t("New chat", "新对话");
}

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [catalog, setCatalog] = useState<ModelRow[]>([]);
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [userModels, setUserModels] = useState<UserModel[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState<string>(DEFAULT_MODEL);
  const [view, setView] = useState<View>("chat");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const { state, answerPermission } = useSession(currentId);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await window.anicode.listSessions());
    } catch (err) {
      setBanner(errorMessage(err));
    }
  }, []);

  const startSession = useCallback(
    async (model: string): Promise<string | null> => {
      if (!appInfo) return null;
      try {
        const meta = await window.anicode.createSession({ cwd: appInfo.cwd, model });
        setCurrentModel(model);
        setCurrentId(meta.id);
        setView("chat");
        void refreshSessions();
        return meta.id;
      } catch (err) {
        setBanner(errorMessage(err));
        return null;
      }
    },
    [appInfo, refreshSessions],
  );

  // 首屏加载：元数据 + 一个默认会话（零网络 debug/demo，开箱即用）。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [info, cat, provs, plugs, ums] = await Promise.all([
          window.anicode.appInfo(),
          window.anicode.listModelCatalog(),
          window.anicode.listProviders(),
          window.anicode.listPlugins(),
          window.anicode.listUserModels(),
        ]);
        if (cancelled) return;
        setAppInfo(info);
        setCatalog(cat);
        setProviders(provs);
        setPlugins(plugs);
        setUserModels(ums);
        const meta = await window.anicode.createSession({ cwd: info.cwd, model: DEFAULT_MODEL });
        if (cancelled) return;
        setCurrentId(meta.id);
        void refreshSessions();
      } catch (err) {
        if (!cancelled) setBanner(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSessions]);

  const sendAndMaybeTitle = useCallback(
    (id: string, text: string, isFirst: boolean) => {
      void window.anicode
        .send(id, text)
        .then(() => {
          // 首条消息 + 无标题 → 自动用首句生成标题（离线、无需额外模型调用）。
          if (isFirst)
            return window.anicode.setTitle(id, deriveTitle(text)).then(() => refreshSessions());
          return undefined;
        })
        .catch((err) => setBanner(errorMessage(err)));
    },
    [refreshSessions],
  );

  const onSend = useCallback(
    (text: string) => {
      const id = currentId;
      const isFirst = !state.meta?.title && !state.items.some((i) => i.kind === "user");
      if (!id) {
        void startSession(currentModel).then((newId) => {
          if (newId) sendAndMaybeTitle(newId, text, true);
        });
        return;
      }
      sendAndMaybeTitle(id, text, isFirst);
    },
    [currentId, currentModel, startSession, sendAndMaybeTitle, state.meta, state.items],
  );

  const onInterrupt = useCallback(() => {
    if (currentId) void window.anicode.interrupt(currentId).catch(() => {});
  }, [currentId]);

  const onSelectSession = useCallback((s: SessionSummary) => {
    setCurrentModel(s.model);
    setCurrentId(s.id);
    setView("chat");
  }, []);

  const onDeleteSession = useCallback(
    async (id: string) => {
      try {
        await window.anicode.deleteSession(id);
      } catch (err) {
        setBanner(errorMessage(err));
        return;
      }
      const remaining = await window.anicode.listSessions();
      setSessions(remaining);
      // 删掉的是当前会话 → 切到其余最近一个，没有则新建。
      if (id === currentId) {
        const next = remaining[0];
        if (next) onSelectSession(next);
        else void startSession(currentModel);
      }
    },
    [currentId, currentModel, onSelectSession, startSession],
  );

  const onTogglePlugin = useCallback((id: string, enabled: boolean) => {
    void window.anicode
      .setPluginEnabled(id, enabled)
      .then(setPlugins)
      .catch((err) => setBanner(errorMessage(err)));
  }, []);

  const onAddUserModel = useCallback(async (model: UserModel) => {
    const rows = await window.anicode.addUserModel(model);
    setCatalog(rows);
    setUserModels(await window.anicode.listUserModels());
  }, []);

  const onRemoveUserModel = useCallback(async (spec: string) => {
    const rows = await window.anicode.removeUserModel(spec);
    setCatalog(rows);
    setUserModels(await window.anicode.listUserModels());
  }, []);

  const modelLabel = catalog.find((r) => r.spec === currentModel)?.label ?? currentModel;

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        currentId={currentId}
        view={view}
        onNew={() => void startSession(currentModel)}
        onSelect={(id) => {
          const s = sessions.find((x) => x.id === id);
          if (s) onSelectSession(s);
        }}
        onDelete={(id) => void onDeleteSession(id)}
        onNavigate={setView}
      />

      <main className="main">
        {banner ? (
          <div className="banner" onClick={() => setBanner(null)}>
            {banner} <span className="banner-x">✕</span>
          </div>
        ) : null}

        {view === "chat" ? (
          <>
            <ChatView state={state} onAnswerPermission={answerPermission} />
            <Composer
              running={state.running}
              modelLabel={modelLabel}
              disabled={!appInfo}
              onSend={onSend}
              onInterrupt={onInterrupt}
              onOpenModelPicker={() => setPickerOpen(true)}
            />
          </>
        ) : null}

        {view === "marketplace" ? (
          <Marketplace plugins={plugins} onToggle={onTogglePlugin} />
        ) : null}

        {view === "settings" ? (
          <SettingsView
            info={appInfo}
            providers={providers}
            model={currentModel}
            userModels={userModels}
            onAddUserModel={onAddUserModel}
            onRemoveUserModel={onRemoveUserModel}
          />
        ) : null}
      </main>

      {pickerOpen ? (
        <ModelPicker
          rows={catalog}
          currentSpec={currentModel}
          onPick={(spec) => {
            setPickerOpen(false);
            void startSession(spec);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

function SettingsView({
  info,
  providers,
  model,
  userModels,
  onAddUserModel,
  onRemoveUserModel,
}: {
  info: AppInfo | null;
  providers: ProviderDescriptor[];
  model: string;
  userModels: UserModel[];
  onAddUserModel: (model: UserModel) => Promise<void>;
  onRemoveUserModel: (spec: string) => Promise<void>;
}) {
  return (
    <div className="settings">
      <h1>{t("Settings", "设置")}</h1>
      <CustomModels
        providers={providers}
        userModels={userModels}
        onAdd={onAddUserModel}
        onRemove={onRemoveUserModel}
      />
      <section className="settings-card">
        <h2>{t("Application", "应用")}</h2>
        <dl>
          <dt>{t("Version", "版本")}</dt>
          <dd>{info?.version ?? "—"}</dd>
          <dt>{t("Current model", "当前模型")}</dt>
          <dd>{model}</dd>
          <dt>{t("Working directory", "工作目录")}</dt>
          <dd>{info?.cwd ?? "—"}</dd>
          <dt>{t("Session directory", "会话目录")}</dt>
          <dd>{info?.sessionsDir ?? "—"}</dd>
        </dl>
      </section>
      <section className="settings-card">
        <h2>{t("Provider credentials", "Provider 凭证")}</h2>
        <p className="settings-note">
          {t(
            "Credentials are injected via environment variables and not stored in the app. Providers missing credentials are marked unavailable in the model picker.",
            "凭证通过环境变量注入，不在应用内保存。缺少凭证的 provider 在模型选择器里会标为不可用。",
          )}
        </p>
        <table className="prov-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>{t("Location", "位置")}</th>
              <th>{t("Credential variable", "凭证变量")}</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.local ? t("Local", "本地") : t("Cloud", "云端")}</td>
                <td>
                  {p.requiresApiKey
                    ? p.apiKeyEnv.join(" / ") || "—"
                    : t("No key needed", "无需 key")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function CustomModels({
  providers,
  userModels,
  onAdd,
  onRemove,
}: {
  providers: ProviderDescriptor[];
  userModels: UserModel[];
  onAdd: (model: UserModel) => Promise<void>;
  onRemove: (spec: string) => Promise<void>;
}) {
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [label, setLabel] = useState("");
  const [free, setFree] = useState(false);
  const [openWeight, setOpenWeight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const effectiveProvider = provider || providers[0]?.id || "";

  const submit = async () => {
    setError(null);
    if (!effectiveProvider || !model.trim()) {
      setError(
        t("Please select a provider and enter a model id", "请选择 provider 并填写 model id"),
      );
      return;
    }
    setBusy(true);
    try {
      await onAdd({
        provider: effectiveProvider,
        model: model.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
        free,
        openWeight,
      });
      setModel("");
      setLabel("");
      setFree(false);
      setOpenWeight(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-card">
      <h2>{t("Custom models", "自定义模型")}</h2>
      <p className="settings-note">
        {t(
          "Beyond the built-in catalog, you can add models to any existing provider; once saved they appear in the model picker. Persisted to models.json.",
          "内置目录之外，可为任意已有 provider 追加模型；保存后即出现在模型选择器里。持久化到 models.json。",
        )}
      </p>

      <div className="model-form">
        <select
          className="mf-input"
          value={effectiveProvider}
          onChange={(e) => setProvider(e.target.value)}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id} {p.local ? t("(local)", "（本地）") : ""}
            </option>
          ))}
        </select>
        <input
          className="mf-input grow"
          placeholder={t("model id, e.g. llama-4-scout:free", "model id，如 llama-4-scout:free")}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <input
          className="mf-input"
          placeholder={t("Display name (optional)", "展示名（可选）")}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <label className="mf-check">
          <input type="checkbox" checked={free} onChange={(e) => setFree(e.target.checked)} />{" "}
          {t("Free", "免费")}
        </label>
        <label className="mf-check">
          <input
            type="checkbox"
            checked={openWeight}
            onChange={(e) => setOpenWeight(e.target.checked)}
          />{" "}
          {t("Open-weight", "开源")}
        </label>
        <button className="btn allow" disabled={busy} onClick={() => void submit()}>
          {t("Add", "添加")}
        </button>
      </div>
      {error ? <div className="mf-error">{error}</div> : null}

      {userModels.length > 0 ? (
        <div className="user-model-list">
          {userModels.map((m) => {
            const spec = `${m.provider}/${m.model}`;
            return (
              <div key={spec} className="user-model-row">
                <span className="um-label">{m.label ?? m.model}</span>
                {m.free ? <span className="tag">{t("Free", "免费")}</span> : null}
                {m.openWeight ? <span className="tag">{t("Open-weight", "开源")}</span> : null}
                <span className="um-spec">{spec}</span>
                <button
                  className="um-remove"
                  title={t("Remove", "移除")}
                  onClick={() => void onRemove(spec)}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="settings-note">{t("No custom models yet.", "尚无自定义模型。")}</div>
      )}
    </section>
  );
}
