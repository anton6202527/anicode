/**
 * 会话主机装配（仅依赖 core，不碰 vscode）：构建 SessionManager、解析 provider、
 * 计算模型目录的就绪状态供 QuickPick 展示。
 */

import * as os from "node:os";
import * as path from "node:path";
import {
  SessionManager,
  SessionStore,
  createProvider,
  diagnoseProvider,
  listModelCatalog,
  listProviderDetails,
  probeLocalProviders,
  t,
} from "@anicode/core";

export const DEFAULT_MODEL = "debug/demo";

/** debug/本地 provider 免 key；云端缺 key 给出清晰错误。 */
export function resolveConfiguredProvider(model: string) {
  const d = diagnoseProvider(model);
  if (d.requiresApiKey && !d.hasCredentials) {
    throw new Error(
      t(
        `${d.warnings.join("；")}. You can switch to a no-key model like debug/demo, or configure the corresponding environment variable.`,
        `${d.warnings.join("；")}。可改用 debug/demo 等免 key 模型，或配置对应环境变量。`,
      ),
    );
  }
  return createProvider(model);
}

export function buildManager(sessionsDir?: string): SessionManager {
  const dir = sessionsDir ?? path.join(os.homedir(), ".anicode", "sessions");
  return new SessionManager({
    store: new SessionStore(dir),
    resolveProvider: resolveConfiguredProvider,
    compaction: true,
    permission: { mode: "default" },
    skills: true,
    subagents: true,
    smallModel: true, // 摘要等杂活自动走便宜模型
  });
}

export interface ModelChoice {
  spec: string;
  label: string;
  detail: string;
  ready: boolean;
}

/** 目录 + 就绪状态；主机能读 env 并探测本地服务存活，据此排序与标注。 */
export async function modelChoices(): Promise<ModelChoice[]> {
  const details = listProviderDetails();
  const probed = new Set(
    details.filter((d) => d.local && (d.baseURL || d.baseURLEnv)).map((d) => d.id),
  );
  const live = await probeLocalProviders(details);
  return listModelCatalog()
    .map((entry) => {
      const d = diagnoseProvider(entry.spec);
      let ready: boolean;
      let cred: string;
      if (probed.has(entry.providerId)) {
        // 本地端点：以存活探测为准（未启动 → 不可用），别被「免 key」误导。
        ready = live.has(entry.providerId);
        cred = ready
          ? t(`${entry.providerName} ready`, `${entry.providerName} 已就绪`)
          : t(`Start ${entry.providerName} first`, `需先启动 ${entry.providerName}`);
      } else if (!d.requiresApiKey) {
        ready = true;
        cred = t("No key", "免 key");
      } else {
        ready = d.hasCredentials;
        cred = ready
          ? t(
              `${d.credentialEnv ?? t("credential", "凭证")} configured`,
              `${d.credentialEnv ?? "凭证"} 已配置`,
            )
          : t(
              `Missing ${d.apiKeyEnv.join(" / ") || "API key"}`,
              `缺 ${d.apiKeyEnv.join(" / ") || "API key"}`,
            );
      }
      const tags = [
        entry.free ? t("Free", "免费") : "",
        entry.openWeight ? t("open-weight", "开源") : "",
        entry.local ? t("local", "本地") : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        spec: entry.spec,
        label: `${ready ? "✔" : "✖"} ${entry.label ?? entry.model}`,
        detail: `${entry.spec}${tags ? ` · ${tags}` : ""} · ${cred}`,
        ready,
      };
    })
    .sort((a, b) => Number(b.ready) - Number(a.ready));
}
