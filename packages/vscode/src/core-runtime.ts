/**
 * Narrow runtime facade for the extension bundle.
 *
 * Importing the package root executes every re-export in @anicode/core, including optional
 * server/ACP/code-graph backends that the VS Code host never uses. Keep type imports on the
 * public package, but make the executable dependency graph explicit so activation does not load
 * those unrelated modules or package their JavaScript.
 */
export { loadConfig, loadProjectEnv } from "../../core/src/config.js";
export { t } from "../../core/src/i18n.js";
export {
  createProductionSessionManager,
  createProductionSessionManagerAsync,
} from "../../core/src/production-session-manager.js";
export {
  createProvider,
  diagnoseProvider,
  listModelCatalog,
  listProviderDetails,
} from "../../core/src/provider/registry.js";
export { probeLocalProviders } from "../../core/src/provider/probe.js";
export { WorkspaceTrustStore } from "../../core/src/workspace-trust.js";
