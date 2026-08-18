import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ProviderDescriptor, SessionSummary } from "@anicode/core";
import { t } from "@anicode/core/i18n";
import type {
  AppInfo,
  CloudAuthStatus,
  ModelRow,
  PluginEntry,
  UserModel,
} from "../../shared/api.js";
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
  const [cloudAuth, setCloudAuth] = useState<CloudAuthStatus | null>(null);

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

  // 首屏加载：主进程结合项目配置与凭证选出默认模型；无可用云端凭证时回退 debug/demo。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Plugin discovery/MCP readiness can involve external processes or networks. Load it in
        // parallel without holding back the first shell paint and the local model catalog.
        void window.anicode
          .listPlugins()
          .then((plugs) => {
            if (!cancelled) setPlugins(plugs);
          })
          .catch((err) => {
            if (!cancelled) setBanner(errorMessage(err));
          });
        const [info, cat, provs, ums, auth] = await Promise.all([
          window.anicode.appInfo(),
          window.anicode.listModelCatalog(),
          window.anicode.listProviders(),
          window.anicode.listUserModels(),
          window.anicode.authStatus(),
        ]);
        if (cancelled) return;
        setAppInfo(info);
        setCatalog(cat);
        setProviders(provs);
        setUserModels(ums);
        setCloudAuth(auth);
        setCurrentModel(info.defaultModel);
        const meta = await window.anicode.createSession({
          cwd: info.cwd,
          model: info.defaultModel,
        });
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

  // Refresh the server-owned auth state whenever settings is opened. This lets an expired or
  // remotely revoked refresh session surface as signed out without exposing any token to React.
  useEffect(() => {
    if (view !== "settings") return;
    let cancelled = false;
    void window.anicode
      .authStatus()
      .then((status) => {
        if (!cancelled) setCloudAuth(status);
      })
      .catch((err) => {
        if (!cancelled) setBanner(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [view]);

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

  const onCloudSignIn = useCallback(
    async (email: string, password: string): Promise<void> => {
      const auth = await window.anicode.authSignIn(email, password);
      const [info, rows] = await Promise.all([
        window.anicode.appInfo(),
        window.anicode.listModelCatalog(),
      ]);
      setCloudAuth(auth);
      setAppInfo(info);
      setCatalog(rows);
      setCurrentModel(info.defaultModel);
      const meta = await window.anicode.createSession({ cwd: info.cwd, model: info.defaultModel });
      setCurrentId(meta.id);
      setView("chat");
      void refreshSessions();
    },
    [refreshSessions],
  );

  const onCloudSignOut = useCallback(async (): Promise<void> => {
    const auth = await window.anicode.authSignOut();
    const [info, rows] = await Promise.all([
      window.anicode.appInfo(),
      window.anicode.listModelCatalog(),
    ]);
    setCloudAuth(auth);
    setAppInfo(info);
    setCatalog(rows);
    if (currentModel.startsWith("anicode-cloud/")) void startSession(info.defaultModel);
  }, [currentModel, startSession]);

  const modelLabel = useMemo(
    () => catalog.find((r) => r.spec === currentModel)?.label ?? currentModel,
    [catalog, currentModel],
  );
  const onNewSession = useCallback(() => {
    void startSession(currentModel);
  }, [currentModel, startSession]);
  const onSelectSessionId = useCallback(
    (id: string) => {
      const session = sessions.find((candidate) => candidate.id === id);
      if (session) onSelectSession(session);
    },
    [onSelectSession, sessions],
  );
  const onDeleteSessionId = useCallback(
    (id: string) => {
      void onDeleteSession(id);
    },
    [onDeleteSession],
  );
  const openModelPicker = useCallback(() => setPickerOpen(true), []);
  const closeModelPicker = useCallback(() => setPickerOpen(false), []);
  const pickModel = useCallback(
    (spec: string) => {
      setPickerOpen(false);
      void startSession(spec);
    },
    [startSession],
  );

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        currentId={currentId}
        view={view}
        onNew={onNewSession}
        onSelect={onSelectSessionId}
        onDelete={onDeleteSessionId}
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
              onOpenModelPicker={openModelPicker}
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
            cloudAuth={cloudAuth}
            onCloudSignIn={onCloudSignIn}
            onCloudSignOut={onCloudSignOut}
            onAddUserModel={onAddUserModel}
            onRemoveUserModel={onRemoveUserModel}
          />
        ) : null}
      </main>

      {pickerOpen ? (
        <ModelPicker
          rows={catalog}
          currentSpec={currentModel}
          onPick={pickModel}
          onClose={closeModelPicker}
        />
      ) : null}
    </div>
  );
}

const SettingsView = React.memo(function SettingsView({
  info,
  providers,
  model,
  userModels,
  cloudAuth,
  onCloudSignIn,
  onCloudSignOut,
  onAddUserModel,
  onRemoveUserModel,
}: {
  info: AppInfo | null;
  providers: ProviderDescriptor[];
  model: string;
  userModels: UserModel[];
  cloudAuth: CloudAuthStatus | null;
  onCloudSignIn: (email: string, password: string) => Promise<void>;
  onCloudSignOut: () => Promise<void>;
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
      <CloudAccount status={cloudAuth} onSignIn={onCloudSignIn} onSignOut={onCloudSignOut} />
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
            "AniCode Cloud uses your signed-in Supabase session; the shared DeepSeek key stays on the server. Personal provider keys use environment variables or the OS credential store.",
            "AniCode Cloud 使用 Supabase 登录会话，共享 DeepSeek Key 始终留在服务端；个人 Provider Key 通过环境变量或系统凭证库存放。",
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
                  {p.id === "anicode-cloud"
                    ? t("Supabase account", "Supabase 登录")
                    : p.requiresApiKey
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
});

const CloudAccount = React.memo(function CloudAccount({
  status,
  onSignIn,
  onSignOut,
}: {
  status: CloudAuthStatus | null;
  onSignIn: (email: string, password: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSignIn(email, password);
      setPassword("");
    } catch (err) {
      setError(errorMessage(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSignOut();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-card">
      <h2>{t("AniCode Cloud", "AniCode Cloud")}</h2>
      <p className="settings-note">
        {t(
          "Sign in for a daily free DeepSeek Flash allowance. The OS credential store keeps the refresh session and a random installation credential; the DeepSeek key never reaches this app.",
          "登录即可使用每日免费 DeepSeek Flash 额度。系统凭证库保存刷新会话和随机安装凭证，DeepSeek Key 不会下发到本应用。",
        )}
      </p>
      {status?.signedIn ? (
        <div className="cloud-account-row">
          <div>
            <strong>{status.user?.email ?? t("Signed in", "已登录")}</strong>
            <div className="settings-note">
              {t("Daily free allowance enabled", "已启用每日免费额度")}
            </div>
          </div>
          <button className="btn" disabled={busy} onClick={() => void logout()}>
            {busy ? t("Signing out…", "正在退出…") : t("Sign out", "退出登录")}
          </button>
        </div>
      ) : (
        <div className="cloud-auth-form">
          <input
            className="mf-input grow"
            type="email"
            autoComplete="email"
            placeholder={t("Supabase account email", "Supabase 账号邮箱")}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <input
            className="mf-input grow"
            type="password"
            autoComplete="current-password"
            placeholder={t("Password", "密码")}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !busy) void submit();
            }}
          />
          <button
            className="btn allow"
            disabled={busy || !email || !password}
            onClick={() => void submit()}
          >
            {busy ? t("Signing in…", "正在登录…") : t("Sign in", "登录")}
          </button>
        </div>
      )}
      {status?.state === "configured" ? (
        <div className="settings-note">
          {t(
            "A saved session exists but could not be refreshed. Check the network and sign in again if needed.",
            "检测到已保存会话，但暂时无法刷新；请检查网络，必要时重新登录。",
          )}
        </div>
      ) : null}
      {error ? <div className="mf-error">{error}</div> : null}
    </section>
  );
});

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
