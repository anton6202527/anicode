/**
 * Narrow runtime surface used by the packaged CLI/TUI.
 *
 * Keeping this separate from the public catch-all barrel prevents the CLI bundle from evaluating
 * remote workers, PostgreSQL, GitHub and other host-only modules before it can even parse argv.
 */
export {
  createProvider,
  diagnoseProvider,
  listProviderDetails,
  listModelCatalog,
  resolveDefaultModel,
} from "./provider/registry.js";
export { SessionManager, type WorkspaceTrustSource } from "./session-manager.js";
export { LocalSessionHost, type SessionHost } from "./host.js";
export {
  createProductionSessionManager,
  type ProductionSessionManagerInput,
  type ProductionSessionManagerComposition,
} from "./production-session-manager.js";
export {
  DaemonClient,
  HttpDaemonServer,
  HttpSessionHost,
  DEFAULT_HTTP_DAEMON_PORT,
  defaultDaemonSocketPath,
  defaultHttpDaemonAuthTokenPath,
  generateDaemonAuthToken,
  provisionDaemonAuthToken,
  readDaemonAuthToken,
} from "./daemon/index.js";
export {
  loadConfig,
  loadProjectEnv,
  toMcpServerConfigs,
  toLspServers,
  type AnicodeConfig,
} from "./config.js";
export { serveMcp } from "./mcp-server.js";
export { discoverPlugins, type PluginDirs } from "./plugins.js";
export {
  connectMcpServers,
  assertProductionHttpMcpConfigs,
  type McpClient,
  type McpServerConfig,
} from "./mcp.js";
export { DEVELOPMENT_MCP_CATALOG, findDevelopmentMcp } from "./mcp-catalog.js";
export { loadCommands, expandCommand, type CustomCommand } from "./commands.js";
export { createDiagnosticsTool } from "./tools/diagnostics.js";
export { LspPool } from "./lsp.js";
export { AuthStore, type AuthStoreOptions } from "./auth/store.js";
export { ANTHROPIC_SUBSCRIPTION_OAUTH_DISABLED_MESSAGE } from "./auth/oauth.js";
export {
  CloudAuthService,
  type CloudAuthServiceOptions,
  type CloudAuthStatus,
} from "./cloud-auth.js";
export {
  ANICODE_CLOUD_CONFIG,
  ANICODE_CLOUD_DEFAULT_MODEL,
  ANICODE_CLOUD_PROVIDER_ID,
} from "./cloud-config.js";
export { registerAnicodeCloudProvider } from "./cloud-provider.js";
export {
  configuredSecretBackendFromEnv,
  OS_KEYCHAIN_DISABLED_ENV,
  OsKeychainDisabledError,
  OsKeychainSecretBackend,
  type SecretBackend,
} from "./security/secret-backends.js";
export {
  credentialEnvironmentAllowlist,
  isCredentialEnvironmentName,
} from "./security/credentials.js";
export {
  createConfiguredLocalRuntimeStack,
  telemetryForLocalStack,
  type LocalRuntimeStack,
} from "./runtime/local-stack.js";
export { telemetryFromEnv, type Telemetry } from "./runtime/telemetry.js";
export { terminateProcessTree } from "./runtime/isolated-runtime.js";
export { WorkspaceTrustStore, type WorkspaceTrustAssessment } from "./workspace-trust.js";
export { discoverSkills } from "./skills.js";
export { t, getLang, setLang, onLangChange } from "./i18n.js";
export { type Tool } from "./tools/tool.js";
