export * from "./types.js";
export {
  t,
  getLang,
  setLang,
  detectLang,
  clearLangOverride,
  onLangChange,
  type Lang,
} from "./i18n.js";
export {
  AnthropicProvider,
  buildAnthropicRequest,
  type AnthropicProviderOptions,
} from "./provider/anthropic.js";
export {
  OpenAICompatProvider,
  type OpenAICompatOptions,
  type MaxTokensField,
} from "./provider/openai-compat.js";
export { DebugProvider, type DebugProviderOptions } from "./provider/debug.js";
export {
  createProvider,
  inspectProvider,
  bindProviderRegistry,
  configureProviderCredentialBroker,
  configureProviderNetworkProxy,
  diagnoseProvider,
  registerProvider,
  registerOpenAICompatibleProvider,
  listProviders,
  listProviderDetails,
  listModelCatalog,
  discoverProviderModels,
  sanitizeProviderId,
  sanitizeDiscoveredModels,
  resolveDefaultModel,
  defaultSmallModel,
  estimateCostUSD,
  type ModelCost,
  type ProviderKind,
  type ProviderProtocol,
  type ProviderCapabilities,
  type ProviderLimits,
  type ProviderModelProfile,
  type ProviderCatalogEntry,
  type ModelCatalogEntry,
  type ProviderDescriptor,
  type ProviderModelInfo,
  type ProviderDiagnostics,
  type ResolvedModel,
  type CreatedModel,
  type InspectedModel,
  type OpenAICompatibleProviderRegistration,
  type ProviderRuntimeBindings,
  type BoundProviderRegistry,
} from "./provider/registry.js";

export { probeEndpoint, probeLocalProviders } from "./provider/probe.js";

export {
  Agent,
  repairHistory,
  validateRunBudgetSnapshot,
  type AgentEvent,
  type AgentOptions,
  type AgentModelInfo,
  type AgentResolvedModel,
  type PersistenceConfig,
  type AgentSnapshot,
  type RetryConfig,
  type RunBudgetConfig,
  type RunBudgetSnapshot,
} from "./agent.js";
export type { ToolExecutionFenceRequest } from "./tool-executor.js";
export {
  HookRunner,
  type HookEventName,
  type HookPayload,
  type HookResult,
  type HookHandler,
  type HookRegistration,
  type HookOutcome,
} from "./hooks.js";
export {
  createTaskTool,
  createTaskTools,
  TaskRegistry,
  GENERAL_SUBAGENT,
  EXPLORE_SUBAGENT,
  type SubagentDefinition,
  type TaskToolOptions,
  type TaskTools,
  type TaskRecord,
  type TaskStatus,
  type PersistedTaskRecord,
  type TaskUsageCredit,
} from "./subagent.js";
export { Chan } from "./chan.js";
export {
  discoverSkills,
  skillListPrompt,
  createSkillTool,
  type SkillMeta,
  type SkillDiscoveryOptions,
} from "./skills.js";
export {
  discoverSubagents,
  parseSubagentFile,
  type SubagentDiscoveryOptions,
} from "./agents-fs.js";
export { discoverPlugins, type PluginDirs, type PluginDiscoveryOptions } from "./plugins.js";
export {
  commandHook,
  commandHooksFromConfig,
  isHookEventName,
  type CommandHookConfig,
  type CommandHookOptions,
} from "./hooks-exec.js";
export {
  parseFrontmatter,
  stripFrontmatter,
  fmString,
  fmStringList,
  type FrontmatterValue,
} from "./frontmatter.js";
export {
  SessionManager,
  type SessionManagerOptions,
  type SessionModelInspection,
  type WorkspaceTrustResolver,
  type WorkspaceTrustSource,
  type SessionEvent,
  type SessionSnapshot,
  type BackgroundTaskSummary,
  type SessionSummary,
  type SessionListener,
  type GlobalListener,
  type Checkpoint,
  type RewindMode,
  type PermissionAnswer,
  type PendingPermission,
} from "./session-manager.js";
export {
  createProductionSessionManager,
  createProductionSessionManagerAsync,
  ProductionSessionManagerConstructionError,
  productionSessionManagerOptions,
  type ProductionSessionManagerInput,
  type ProductionSessionManagerComposition,
} from "./production-session-manager.js";
export { SnapshotStore, type Snapshot, type RestoreResult } from "./snapshot.js";
export {
  buildAuthUrl,
  exchangeCode,
  refreshTokens,
  parseCallbackCode,
  parseTokenResponse,
  createVerifier,
  challengeFromVerifier,
  type OAuthTokens,
  type AuthorizationRequest,
  type OAuthRequestDeps,
  ANTHROPIC_CLIENT_ID,
  ANTHROPIC_OAUTH_BETA,
  ANTHROPIC_SUBSCRIPTION_OAUTH_DISABLED_MESSAGE,
} from "./auth/oauth.js";
export {
  AuthStore,
  AuthStorePersistenceError,
  type AuthStoreBackendKind,
  type AuthStoreCommitOutcome,
  type AuthStoreOptions,
  type Credential,
  type OAuthCredential,
} from "./auth/store.js";
export { AnthropicOAuthTokenSource, type TokenSource } from "./auth/token-source.js";
export {
  type SessionHost,
  type OpenHandle,
  type PermissionDecisionKind,
  LocalSessionHost,
} from "./host.js";
export {
  SessionStore,
  MigratingSessionStore,
  newSessionId,
  assertSessionId,
  type ISessionStore,
  type SessionStoreSemantics,
  type SessionMeta,
  type SessionData,
} from "./session.js";
export { SqliteSessionStore, sqliteAvailable } from "./session-sqlite.js";
export * from "./daemon/index.js";
export { serveMcp, type McpServeOptions } from "./mcp-server.js";
export {
  AcpAgentAdapter,
  ACP_V1_METHODS,
  validateAcpV1Request,
  serveAcpStdio,
  type AcpAdapterOptions,
  type AcpPeer,
  type AcpStdioOptions,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from "./acp.js";
export {
  McpClient,
  connectMcpServers,
  assertProductionHttpMcpConfigs,
  type McpServerConfig,
  type McpResource,
  type McpPrompt,
  type McpServerCapabilities,
  type McpClientHandlers,
} from "./mcp.js";
export {
  DEVELOPMENT_MCP_CATALOG,
  findDevelopmentMcp,
  type DevelopmentMcpCatalogEntry,
} from "./mcp-catalog.js";
export {
  loadConfig,
  loadConfigWithWorkspaceTrust,
  loadProjectEnv,
  isForbiddenProjectEnvName,
  toMcpServerConfigs,
  toSubagentDefinitions,
  toLspServers,
  browserToolOptions,
  type AnicodeConfig,
  type ConfigAgent,
  type LoadedConfig,
  type LoadConfigOptions,
  type LoadWorkspaceConfigOptions,
  type LoadProjectEnvOptions,
} from "./config.js";
export {
  WorkspaceTrustStore,
  canonicalWorkspaceIdentity,
  defaultWorkspaceTrustFile,
  revalidateWorkspaceTrust,
  workspaceExecutionConfig,
  workspaceExecutionFingerprint,
  type WorkspaceIdentity,
  type WorkspaceTrustAssessment,
  type WorkspaceTrustGrantExpectation,
  type WorkspaceTrustReason,
  type WorkspaceTrustStoreOptions,
} from "./workspace-trust.js";
export {
  LspClient,
  LspPool,
  pickLspServer,
  type LspServerConfig,
  type Diagnostic,
  type LspLocation,
  type LspSymbol,
} from "./lsp.js";
export { createDiagnosticsTool } from "./tools/diagnostics.js";
export { createToolSearchTool } from "./tools/tool-search.js";
export {
  createLspNavTools,
  createDefinitionTool,
  createReferencesTool,
  createSymbolsTool,
} from "./tools/lsp-nav.js";
export {
  loadCommands,
  expandCommand,
  type CustomCommand,
  type LoadCommandsOptions,
} from "./commands.js";
export {
  loadProjectMemory,
  composeSystem,
  estimateTokens,
  maybeCompact,
  microcompact,
  providerSummarizer,
  type CompactionConfig,
  type CompactionResult,
  type ProjectMemoryOptions,
  type Summarizer,
} from "./context.js";
export {
  PermissionEngine,
  globMatch,
  BUILTIN_PROFILES,
  type PermissionConfig,
  type PermissionDecision,
  type PermissionRequest,
  type PermissionMode,
  type PermissionProfile,
  type ConfirmFn,
} from "./permission.js";
export { appendLocalAllowRules, localSettingsPath } from "./permission-store.js";
export {
  buildRepoMap,
  gatherRepoMap,
  extractSymbols,
  type RepoMapOptions,
  type SourceFile,
} from "./repomap.js";
export {
  ToolRegistry,
  ToolError,
  isolatedModuleTool,
  type Tool,
  type ToolContext,
  type ToolExecutionBoundary,
  type IsolatedModuleToolManifest,
} from "./tools/tool.js";
export {
  PatchSetService,
  PatchSetConflictError,
  PatchSetSessionOwnershipError,
  threeWayMerge,
  type PatchSet,
  type PatchSetStatus,
  type PatchSetChange,
  type PatchSetChangeInput,
  type PatchSetApproval,
  type PatchSetRebaseResult,
  type PatchSetServiceOptions,
  type PatchSetWorkspaceLockInfo,
  type ThreeWayMergeResult,
} from "./runtime/patchset.js";
export {
  IncrementalCodeIndex,
  type IndexedCodeFile,
  type IndexedSymbol,
  type CodeIndexSnapshot,
  type HybridSearchHit,
  type CodeEmbedding,
  type IncrementalCodeIndexOptions,
} from "./runtime/code-index.js";
export {
  DurableWorkerQueue,
  MemoryWorkerQueueStore,
  FileWorkerQueueStore,
  PersistentWorker,
  WorktreeOwnership,
  type WorkerJob,
  type WorkerJobStatus,
  type WorkerCancellationResult,
  type WorkerQueueStore,
  type FileWorkerQueueStoreOptions,
  type WorkerEnqueueQuota,
  type WorkerHandler,
  type WorktreeLease,
} from "./runtime/worker.js";
export { RemoteRuntime, type RemoteRuntimeOptions } from "./runtime/remote.js";
export {
  GitHubDelivery,
  buildSlsaProvenance,
  type GitHubDeliveryOptions,
  type GitHubDeliveryInput,
  type GitHubDeliveryResult,
  type GitHubCheckOutput,
  type GitHubCheckConclusion,
  type GitHubCheckRun,
  type GitHubAuditEvent,
  type SlsaProvenanceInput,
} from "./runtime/github-delivery.js";
export {
  GitHubAppInstallationTokenSource,
  type GitHubAccessTokenProvider,
  type GitHubAppInstallationTokenOptions,
} from "./runtime/github-app.js";
export {
  GitHubWebhookController,
  GitHubWebhookServer,
  verifyGitHubWebhookSignature,
  createGitHubRepairWorker,
  createGitHubAgentWorker,
  createGitHubWorkflowExecutor,
  type GitHubWebhookControllerOptions,
  type GitHubWebhookResult,
  type GitHubRepairJob,
  type GitHubRepairWorkerOptions,
  type GitHubAgentJobType,
  type GitHubAgentWorkerResult,
  type GitHubAgentWorkerOptions,
} from "./runtime/github-webhook.js";
export {
  MemoryArtifactStore,
  FileArtifactStore,
  S3ArtifactStore,
  configuredS3ArtifactStoreFromEnv,
  type Artifact,
  type ArtifactKind,
  type ArtifactInput,
  type ArtifactStreamInput,
  type ArtifactRecord,
  type ArtifactStreamRecord,
  type ArtifactStore,
  type S3ArtifactStoreOptions,
} from "./runtime/artifacts.js";
export {
  DurableRuntime,
  MemoryRuntimeEventStore,
  FileRuntimeEventStore,
  type RuntimeEvent,
  type AppendRuntimeEvent,
  type RuntimeEventStore,
  type RecoveredRuntimeState,
  MemoryRuntimeSnapshotStore,
  FileRuntimeSnapshotStore,
  type RuntimeSnapshot,
  type RuntimeSnapshotStore,
} from "./runtime/durable.js";
export {
  CommandInbox,
  MemoryCommandInboxStore,
  FileCommandInboxStore,
  DurableOutbox,
  MemoryOutboxStore,
  FileOutboxStore,
  CommandIdempotencyConflictError,
  type DurableCommand,
  type CommandStatus,
  type AcceptCommandInput,
  type CommandInboxStore,
  type OutboxMessage,
  type OutboxStatus,
  type OutboxStore,
} from "./runtime/commands.js";
export {
  ContextCompiler,
  type ContextCompilerOptions,
  type ContextSource,
  type ContextKind,
  type CompiledContext,
} from "./runtime/context-compiler.js";
export {
  TaskScheduler,
  type ScheduledTask,
  type TaskExecution,
  type TaskSchedulerOptions,
  type TaskResource,
  type SchedulerEvent,
} from "./runtime/scheduler.js";
export {
  Verifier,
  renderVerificationReport,
  type VerificationPolicy,
  type VerificationCheck,
  type VerificationReport,
  type VerificationCheckResult,
} from "./runtime/verifier.js";
export {
  noTelemetry,
  fromOpenTelemetry,
  InMemoryTelemetry,
  OtlpHttpTelemetry,
  telemetryFromEnv,
  traceparent,
  parseTraceparent,
  type Telemetry,
  type TelemetrySpan,
  type TelemetryAttribute,
  type SpanContext,
  type OpenTelemetryTracerLike,
  type RecordedSpan,
  type OtlpHttpTelemetryOptions,
  type TelemetryExporterStats,
  type TelemetryFromEnvOptions,
} from "./runtime/telemetry.js";
export {
  DisabledExecutionRuntime,
  IsolatedRuntime,
  terminateProcessTree,
  type ExecutionRuntime,
  type IsolatedRuntimeOptions,
  type IsolatedRunRequest,
  type IsolatedRunResult,
  type ProcessTreeTerminationOptions,
  type PreparedIsolatedCommand,
} from "./runtime/isolated-runtime.js";
export {
  ContainerIsolatedRuntime,
  type ContainerIsolatedRuntimeOptions,
} from "./runtime/container-runtime.js";
export {
  TransactionalExecutionRuntime,
  withDiscardedWorkspace,
  type TransactionalExecutionRuntimeOptions,
} from "./runtime/transactional-runtime.js";
export {
  KubernetesCredentialRevocationError,
  KubernetesJobRuntime,
  type KubernetesJobRuntimeOptions,
} from "./runtime/kubernetes-runtime.js";
export {
  RemoteRuntimeHttpServer,
  RemoteExecutionService,
  createClaimRemoteRuntimeAuthorizer,
  type RemoteRuntimeServerOptions,
  type RemoteRuntimeTransportSecurity,
  type RemoteExecutionRequest,
  type RemoteExecutionView,
  type RemoteIdentity,
  type RemoteExecutionGrant,
  type RemoteRuntimeAuthorizer,
  type ClaimRemoteRuntimeAuthorizerOptions,
} from "./runtime/remote-server.js";
export {
  createRemoteOidcAuthenticator,
  type RemoteOidcAuthenticatorOptions,
} from "./runtime/remote-auth.js";
export {
  NetworkProxy,
  NetworkProxyServer,
  NetworkProxyCredentialAuthority,
  NetworkProxyCredentialClient,
  isPrivateAddress,
  type NetworkPolicy,
  type NetworkProxyOptions,
  type NetworkAuditEvent,
  type NetworkProxyServerOptions,
  type NetworkProxyCredentialAuthorityOptions,
  type NetworkProxyCredentialClientOptions,
  type ScopedProxyCredentialIssuer,
  type ScopedProxyCredentialLease,
  type ScopedProxyCredentialRequest,
} from "./runtime/network-proxy.js";
export {
  SecurityPolicyEngine,
  CapabilityAuthority,
  type SecurityRule,
  type SecurityRequest,
  type SecurityDecision,
  type SecurityEffect,
  type SecurityPolicyOptions,
  type CapabilityGrant,
} from "./security/policy.js";
export {
  CredentialBroker,
  CredentialRotationError,
  credentialBrokerFromEnv,
  credentialBrokerFromBackend,
  credentialBrokerFromLazyBackend,
  credentialEnvironmentAllowlist,
  credentialScopesForEnvironment,
  isCredentialEnvironmentName,
  isSensitiveEnvironmentName,
  type CredentialAvailability,
  type CredentialRotationMetadata,
  type CredentialRotationOptions,
  type CredentialRotationOutcome,
  type CredentialAuditEvent,
  type CredentialBrokerOptions,
  type CredentialScope,
  type CredentialRegistration,
  type CredentialLeaseRequest,
} from "./security/credentials.js";
export { type CredentialIoOptions } from "./security/credential-io.js";
export {
  OsKeychainSecretBackend,
  OsKeychainDisabledError,
  OsKeychainMutationError,
  OS_KEYCHAIN_DISABLED_ENV,
  VaultKvV2SecretBackend,
  VaultJwtTokenProvider,
  StaticVaultTokenProvider,
  AwsKmsSecretBackend,
  githubActionsOidcProvider,
  oidcTokenFileProvider,
  configuredSecretBackendFromEnv,
  type SecretBackend,
  type SyncSecretBackend,
  type OsKeychainMutationFailureReason,
  type OsKeychainSecretBackendOptions,
  type OidcTokenProvider,
  type VaultTokenProvider,
  type AwsKmsSecretBackendOptions,
  type KmsLikeClient,
} from "./security/secret-backends.js";
export {
  CredentialRotationManager,
  type IssuedCredentialRotation,
  type CredentialRotationPolicy,
  type CredentialRotationEvent,
} from "./security/rotation.js";
export {
  SqliteRuntimeDatabase,
  SqliteRuntimeEventStore,
  SqliteRuntimeSnapshotStore,
  SqliteRuntimeSessionStore,
  SqliteSessionLifecycleStore,
  SqliteCommandInboxStore,
  SqliteOutboxStore,
  SqliteWorkerQueueStore,
  SqliteArtifactStore,
  type RuntimeAuditRecord,
} from "./runtime/sqlite.js";
export {
  PostgresRuntimeDatabase,
  PostgresRuntimeEventStore,
  PostgresRuntimeSnapshotStore,
  PostgresSessionStore,
  PostgresSessionLifecycleStore,
  PostgresCommandInboxStore,
  PostgresOutboxStore,
  PostgresWorkerQueueStore,
  PostgresArtifactStore,
} from "./runtime/postgres.js";
export {
  MemorySessionLifecycleStore,
  SessionLifecycleUnavailableError,
  SessionLifecycleLeaseLostError,
  type SessionLifecycleStore,
  type SessionLifecycleState,
  type SessionLifecycleRecord,
  type SessionOperationLease,
  type SessionDeletionClaim,
} from "./runtime/session-lifecycle.js";
export {
  TypedCodeGraph,
  extractTreeSitterSymbols,
  type TypedCodeGraphOptions,
  type TypedCodeGraphSnapshot,
  type TypedCodeFile,
  type TypedCodeSymbol,
  type TypedCodeReference,
  type CodeReferenceKind,
  type TypedGraphSearchHit,
  type CodeLanguage,
  type CodeRange,
} from "./runtime/typed-code-graph.js";
export {
  SqliteVectorStore,
  PostgresVectorStore,
  localCodeEmbedding,
  type VectorStore,
  type VectorRecord,
  type VectorSearchHit,
} from "./runtime/vector-store.js";
export {
  createLocalRuntimeStack,
  createConfiguredLocalRuntimeStack,
  resolveLocalExecutionMode,
  telemetryForLocalStack,
  type LocalExecutionMode,
  type LocalRuntimeStack,
  type LocalRuntimeStackOptions,
} from "./runtime/local-stack.js";
export {
  defaultTools,
  foregroundOnlyBash,
  foregroundOnlyBashTool,
  LOCAL_PROCESS_TOOL_NAMES,
  PERSISTENT_PROCESS_TOOL_NAMES,
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  bashTool,
  createWebFetchTool,
  webFetchTool,
  htmlToText,
  createWebSearchTool,
  formatSearchResults,
  tavilyBackend,
  braveBackend,
  parseTavilyResponse,
  parseBraveResponse,
  webSearchBackendFromEnv,
  webSearchBackendFromBroker,
  type BrokerWebSearchOptions,
  type WebSearchBackend,
  type WebSearchResult,
  type WebSearchQuery,
  splitShellCommand,
  analyzeShellCommand,
  type ShellCommandAnalysis,
  createTodoTool,
  type TodoItem,
  type SandboxPolicy,
  type SandboxSpec,
  wrapWithSandbox,
  buildSeatbeltProfile,
  resolveSandboxPolicy,
  createBrowserTool,
  type BrowserToolOptions,
} from "./tools/index.js";
export { sanitizedShellEnv } from "./tools/shell-spawn.js";
export {
  Browser,
  BrowserRegistry,
  Page,
  resolveChromePath,
  closeAllBrowsers,
  type BrowserResource,
  type NavigateResult,
  type ConsoleEntry,
} from "./browser/cdp.js";
export { createId, deterministicId, type IdPrefix } from "./id.js";
export {
  messagesToParts,
  PartsProjector,
  type PartsProjectorOptions,
  type MessageInfo,
  type UserMessageInfo,
  type AssistantMessageInfo,
  type MessageWithParts,
  type MessagePart,
  type MessageTextPart,
  type MessageReasoningPart,
  type MessageFilePart,
  type MessageStepStartPart,
  type MessageStepFinishPart,
  type MessageToolPart,
  type ToolPartState,
  type ProjectedEvent,
} from "./parts.js";
