/**
 * Local production host composition root.
 *
 * Keep policy, durability, context and verification defaults in one place so the TUI,
 * Electron app and VS Code extension do not accidentally ship different agents.
 * Host-specific transports and tool marketplaces may still decorate the tool registry.
 */

import * as path from "node:path";
import type { AnicodeConfig } from "./config.js";
import { browserToolOptions, toSubagentDefinitions } from "./config.js";
import { ContextCompiler } from "./runtime/context-compiler.js";
import { ContainerIsolatedRuntime } from "./runtime/container-runtime.js";
import {
  createLocalRuntimeStack,
  telemetryForLocalStack,
  type LocalExecutionMode,
  type LocalRuntimeStackOptions,
  type LocalRuntimeStack,
} from "./runtime/local-stack.js";
import type { Telemetry } from "./runtime/telemetry.js";
import { transactionalExecutionDelegate } from "./runtime/transactional-runtime.js";
import { SecurityPolicyEngine } from "./security/policy.js";
import { MigratingSessionStore, SessionStore } from "./session.js";
import {
  SessionManager,
  type SessionManagerOptions,
  type WorkspaceTrustSource,
} from "./session-manager.js";
import { commandHooksFromConfig } from "./hooks-exec.js";
import {
  defaultTools,
  foregroundOnlyBash,
  restrictedWorkspaceDevelopmentTools,
  selectBrokerWebSearch,
  webSearchBackendFromBroker,
} from "./tools/index.js";
import {
  isIsolatedModuleTool,
  isManagedExternalTool,
  isolatedModuleTool,
  type IsolatedModuleToolManifest,
  type Tool,
  ToolRegistry,
} from "./tools/tool.js";
import { isCoreOwnedTool } from "./tools/core-owned.js";
import type { PermissionMode } from "./permission.js";
import { Verifier } from "./runtime/verifier.js";
import type { WorkspaceTrustAssessment } from "./workspace-trust.js";
import { BrowserRegistry } from "./browser/cdp.js";

export interface ProductionSessionManagerInput {
  cwd: string;
  sessionsDir: string;
  /** Test/plugin override. Production defaults to the runtime stack's instance-bound registry. */
  resolveProvider?: SessionManagerOptions["resolveProvider"];
  /** Pure companion for a custom resolver; production registry supplies this automatically. */
  inspectProvider?: SessionManagerOptions["inspectProvider"];
  config?: AnicodeConfig;
  permissionMode?: PermissionMode;
  /**
   * Declare that this host has an interactive confirmation UI for the audited untrusted-workspace
   * development surface. It does not weaken `inspection-failed` or any runtime capability gate.
   */
  allowRestrictedWorkspaceDevelopment?: boolean;
  /** Optional host/operator override; Agent retains fail-safe production defaults when omitted. */
  runBudget?: SessionManagerOptions["runBudget"];
  shutdownTimeoutMs?: number;
  runtimeStack?: LocalRuntimeStack;
  /** Host-owned paths/options needed while constructing the default local runtime stack. */
  localRuntimeOptions?: LocalRuntimeStackOptions;
  telemetry?: Telemetry;
  env?: NodeJS.ProcessEnv;
  workspaceTrust?: WorkspaceTrustSource;
  onWorkspaceTrustChange?: (change: {
    sessionId: string;
    cwd: string;
    previous?: WorkspaceTrustAssessment;
    current: WorkspaceTrustAssessment;
  }) => void | Promise<void>;
  /**
   * Select enabled built-ins and supply branded extensions (for example, Electron's live plugin
   * registry). Built-in objects are never accepted from this registry; core creates fresh ones.
   */
  tools?: () => ToolRegistry;
  /**
   * Decorate either registry with explicitly classified host extensions. Each Tool must declare
   * execution; arbitrary unmarked closures fail closed in this production composition.
   */
  extraTools?: readonly Tool[];
  deferredTools?: readonly Tool[];
  /** Preferred data-only boundary for third-party ESM bundles. */
  isolatedTools?: readonly IsolatedModuleToolManifest[];
  deferredIsolatedTools?: readonly IsolatedModuleToolManifest[];
  /** Extra discovery roots supplied by installed plugins. */
  skillDirs?: readonly string[];
  subagentDirs?: readonly string[];
  /** Stable mutable list is accepted so marketplace toggles affect newly-created sessions. */
  disabledSkills?: string[];
  /** Internal ownership scope, normally supplied by createProductionSessionManager. */
  browserRegistry?: BrowserRegistry;
}

export interface ProductionSessionManagerComposition {
  manager: SessionManager;
  runtimeStack: LocalRuntimeStack;
  telemetry: Telemetry;
  /** True when this composition created and therefore owns the runtime stack. */
  ownsRuntimeStack: boolean;
  /** Idempotently closes the manager and resources owned by this composition. */
  dispose(): Promise<void>;
}

function toolsAllowedByExecutionMode(
  registry: ToolRegistry,
  executionMode: LocalExecutionMode,
  isolatedModulesSupported = executionMode === "container",
): ToolRegistry {
  const isolatedNames = registry
    .names()
    .filter((name) => registry.get(name)?.execution?.kind === "isolated-module");
  const uncontainedStdio = registry.names().filter((name) => {
    const execution = registry.get(name)?.execution;
    return execution?.kind === "managed-external" && execution.protocol === "mcp-stdio";
  });
  if (uncontainedStdio.length > 0) {
    throw new TypeError(
      `Production stdio MCP tools require a managed process containment boundary: ${uncontainedStdio.join(", ")}`,
    );
  }
  if (isolatedNames.length > 0 && executionMode !== "container") {
    throw new TypeError(
      `Declarative isolated tools require container execution mode: ${isolatedNames.join(", ")}`,
    );
  }
  if (isolatedNames.length > 0 && !isolatedModulesSupported) {
    throw new TypeError(
      "Container execution capability mismatch: isolated runtime is not a container boundary",
    );
  }
  assertProductionIsolatedCapabilities(
    isolatedNames.flatMap((name) => {
      const tool = registry.get(name);
      return tool ? [tool] : [];
    }),
  );
  const existingBash = registry.get("bash");
  if (executionMode === "native-isolated") {
    // Transactional workspace writes cannot safely support a detached global ShellRegistry: its
    // commit/lifecycle would outlive the command/session fence. Advertise the supported foreground
    // contract only, while preserving unrelated trusted persistent tools such as MCP sidecars.
    const foreground = registry.subset(
      registry
        .names()
        .filter(
          (name) =>
            registry.get(name)?.execution?.kind !== "isolated-module" &&
            !["bash", "bash_output", "write_stdin", "list_shells", "kill_shell"].includes(name),
        ),
    );
    // A native POSIX process group cannot contain a child that creates a new session (setsid).
    // Keep shell networking disabled until the runtime can prove whole-workload/cgroup teardown.
    if (existingBash) {
      foreground.register(foregroundOnlyBash(existingBash, { allowNetwork: false }));
    }
    return foreground;
  }
  const filtered = registry.subset(
    registry.names().filter((name) => {
      const tool = registry.get(name);
      // Untrusted module code is production-executable only inside the pinned OCI boundary. Keep
      // pure and foreground-process manifests there; the manifest contract already forbids
      // persistent-process. Native/restricted modes must not advertise a tool that can only fail.
      if (tool?.execution?.kind === "isolated-module") {
        return executionMode === "container" && isolatedModulesSupported;
      }
      const capabilities = tool?.capabilities;
      if (!capabilities || capabilities.length === 0) return false;
      return !capabilities.includes("process") && !capabilities.includes("persistent-process");
    }),
  );
  if (
    executionMode === "container" &&
    existingBash?.capabilities?.includes("process") &&
    !existingBash.capabilities.includes("persistent-process")
  ) {
    // A fresh OCI workload provides the cgroup/container lifetime proof required for a one-shot
    // network grant. Keep this opt-in explicit; the facade defaults to offline.
    filtered.register(foregroundOnlyBash(existingBash, { allowNetwork: true }));
  }
  return filtered;
}

function configuredTools(
  input: ProductionSessionManagerInput,
  executionMode: LocalExecutionMode,
  isolatedModulesSupported: boolean,
): (() => ToolRegistry) | undefined {
  const extra = input.extraTools ?? [];
  const deferred = input.deferredTools ?? [];
  if ((input.isolatedTools?.length ?? 0) + (input.deferredIsolatedTools?.length ?? 0) > 0) {
    if (executionMode !== "container") {
      throw new TypeError("Declarative isolated tools require container execution mode");
    }
    if (!isolatedModulesSupported) {
      throw new TypeError(
        "Container execution capability mismatch: isolated runtime is not a container boundary",
      );
    }
  }
  const isolated = (input.isolatedTools ?? []).map(isolatedModuleTool);
  const deferredIsolated = (input.deferredIsolatedTools ?? []).map(isolatedModuleTool);
  assertProductionIsolatedCapabilities([...isolated, ...deferredIsolated]);
  for (const tool of [...extra, ...deferred]) {
    assertProductionExtension(tool);
  }
  return () => {
    const registry = productionRegistryFromMask(input.tools);
    for (const tool of [...extra, ...isolated]) registerProductionExtension(registry, tool);
    for (const tool of [...deferred, ...deferredIsolated]) {
      registerProductionExtension(registry, tool, { deferred: true });
    }
    return toolsAllowedByExecutionMode(registry, executionMode, isolatedModulesSupported);
  };
}

/**
 * A host-supplied registry is an enable/disable mask for built-ins, never an implementation
 * override. Unknown names are extensions and must carry an unforgeable process-local brand.
 */
function productionRegistryFromMask(factory?: () => ToolRegistry): ToolRegistry {
  const builtins = defaultTools();
  if (!factory) return builtins;

  const supplied = factory();
  if (!(supplied instanceof ToolRegistry)) {
    throw new TypeError("Production tools factory must return a ToolRegistry");
  }
  const builtinByCanonical = new Map(
    builtins.names().map((name) => [canonicalProductionToolName(name), name] as const),
  );
  const enabledBuiltins: string[] = [];
  const extensions: Array<{ tool: Tool; deferred: boolean }> = [];

  for (const suppliedName of supplied.names()) {
    const builtinName = builtinByCanonical.get(canonicalProductionToolName(suppliedName));
    if (builtinName) {
      if (builtinName !== suppliedName) {
        throw new TypeError(
          `Production tool name aliases a built-in: ${suppliedName} / ${builtinName}`,
        );
      }
      // Only the name is used. The potentially replaced object in `supplied` is never executed.
      enabledBuiltins.push(builtinName);
      continue;
    }
    const tool = supplied.get(suppliedName);
    if (!tool) throw new TypeError(`Production registry lost tool ${suppliedName}`);
    extensions.push({ tool, deferred: supplied.isDeferred(suppliedName) });
  }

  const registry = builtins.subset(enabledBuiltins);
  for (const { tool, deferred } of extensions) {
    registerProductionExtension(registry, tool, deferred ? { deferred: true } : undefined);
  }
  return registry;
}

function registerProductionExtension(
  registry: ToolRegistry,
  tool: Tool,
  opts?: { deferred?: boolean },
): void {
  assertProductionExtension(tool);
  registry.registerExtension(tool, opts);
}

function assertProductionExtension(tool: Tool): void {
  // WeakSet.has does not inspect the candidate. Reject an unbranded Proxy before a hostile getter
  // on def/execution can run inside the production host.
  const coreOwned = isCoreOwnedTool(tool);
  const isolated = isIsolatedModuleTool(tool);
  const managed = isManagedExternalTool(tool);
  if (!coreOwned && !isolated && !managed) {
    throw new TypeError("Production extension has no core-owned execution provenance");
  }

  const execution = tool.execution;
  if (!execution) {
    throw new TypeError("Branded production extension has no execution boundary");
  }
  if (
    (execution.kind === "trusted-in-process" && !coreOwned) ||
    (execution.kind === "isolated-module" && !isolated) ||
    (execution.kind === "managed-external" && !managed)
  ) {
    throw new TypeError(
      `Production ${execution.kind} extension provenance does not match boundary`,
    );
  }
  if (execution.kind === "managed-external" && execution.protocol === "mcp-stdio") {
    throw new TypeError(
      `Production stdio MCP tool ${tool.def.name} requires a managed process containment boundary`,
    );
  }
}

/** Permission/tool identifiers use ASCII casing; avoid locale-sensitive folding. */
function canonicalProductionToolName(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

const UNSUPPORTED_PRODUCTION_ISOLATED_CAPABILITIES = new Set([
  "filesystem-read",
  "filesystem-write",
  "network",
]);

function assertProductionIsolatedCapabilities(tools: readonly Tool[]): void {
  for (const tool of tools) {
    if (tool.execution?.kind !== "isolated-module") continue;
    const unsupported = tool.capabilities?.find((capability) =>
      UNSUPPORTED_PRODUCTION_ISOLATED_CAPABILITIES.has(capability),
    );
    if (unsupported) {
      throw new TypeError(
        `Isolated module ${unsupported} capability is unsupported in production; bundles receive no workspace or network projection`,
      );
    }
  }
}

/**
 * Pure option assembly used by every local UI host and directly contract-tested. Callers that
 * need an asynchronously configured Vault/KMS stack create it first and pass it here.
 */
export function productionSessionManagerOptions(
  input: ProductionSessionManagerInput,
  runtimeStack: LocalRuntimeStack,
  telemetry: Telemetry,
): SessionManagerOptions {
  if (runtimeStack.sessions.storageSemantics !== "transactional-primary") {
    throw new TypeError(
      `Production runtime requires a session store declaring transactional-primary semantics; received ${runtimeStack.sessions.storageSemantics ?? "unclassified"}`,
    );
  }
  const config = input.config ?? {};
  const env = input.env ?? process.env;
  // Runtime stacks from older/untyped embedders do not carry a capability declaration. Unknown
  // must mean restricted; inferring support from the presence of run()/prepare() would re-open the
  // raw-spawn downgrade this composition is designed to close.
  const executionMode = runtimeStack.executionMode ?? "restricted";
  const supportsPersistentProcesses = executionMode === "native-isolated";
  const supportsForegroundExecution = executionMode !== "restricted";
  const configuredBrowser = browserToolOptions(config);
  const browserRegistry = input.browserRegistry ?? new BrowserRegistry();
  const browser =
    !supportsPersistentProcesses || configuredBrowser === false
      ? false
      : {
          ...configuredBrowser,
          ...(env.ANICODE_NETWORK_PROXY_URL ? { proxyUrl: env.ANICODE_NETWORK_PROXY_URL } : {}),
          requireProxy: true,
          requireTrustedExecutable: true,
          registry: browserRegistry,
        };
  const definitions = toSubagentDefinitions(config);
  const subagents = {
    discover: true,
    ...(definitions.length ? { definitions } : {}),
    ...(input.subagentDirs?.length ? { dirs: [...input.subagentDirs] } : {}),
  };
  const skills =
    input.skillDirs?.length || input.disabledSkills
      ? {
          ...(input.skillDirs?.length ? { dirs: [...input.skillDirs] } : {}),
          ...(input.disabledSkills ? { disabled: input.disabledSkills } : {}),
        }
      : true;
  const transactionalDelegate = transactionalExecutionDelegate(runtimeStack.isolatedRuntime);
  const containerBoundaryAttested =
    executionMode === "container" &&
    transactionalDelegate instanceof ContainerIsolatedRuntime &&
    transactionalDelegate.toolModuleEnvironment === "container";
  const isolatedModulesSupported = containerBoundaryAttested;
  const tools = configuredTools(input, executionMode, isolatedModulesSupported);
  const webSearchSelection = selectBrokerWebSearch(runtimeStack.broker);
  const webSearch = webSearchSelection
    ? webSearchBackendFromBroker({
        provider: webSearchSelection.provider,
        credentialId: webSearchSelection.credentialId,
        broker: runtimeStack.broker,
        proxy: runtimeStack.networkProxy,
      })
    : undefined;

  return {
    store: new MigratingSessionStore(runtimeStack.sessions, new SessionStore(input.sessionsDir)),
    runtime: runtimeStack.runtime,
    artifacts: runtimeStack.artifacts,
    commandInbox: runtimeStack.commandInbox,
    outbox: runtimeStack.outbox,
    networkProxy: runtimeStack.networkProxy,
    worktreeOwnership: runtimeStack.worktreeOwnership,
    contextCompiler: new ContextCompiler({ tokenBudget: 12_000 }),
    ...(supportsForegroundExecution
      ? {
          verifier: new Verifier({
            autoDiscover: true,
            executionRuntime: runtimeStack.isolatedRuntime,
          }),
        }
      : {}),
    securityPolicy: SecurityPolicyEngine.workspaceBoundary(),
    telemetry,
    isolatedRuntime: runtimeStack.isolatedRuntime,
    // Never rely on lower runtime defaults: TransactionalExecutionRuntime uses this explicit
    // policy to route foreground writes through PatchSet and reject persistent direct writers.
    sandbox: "workspace-write",
    workspaceScope: input.cwd,
    resolveProvider: input.resolveProvider ?? runtimeStack.resolveProviderAsync,
    ...(input.inspectProvider
      ? { inspectProvider: input.inspectProvider }
      : input.resolveProvider === undefined
        ? { inspectProvider: runtimeStack.providers.inspectProvider }
        : {}),
    ...(input.runBudget ? { runBudget: input.runBudget } : {}),
    ...(input.shutdownTimeoutMs !== undefined
      ? { shutdownTimeoutMs: input.shutdownTimeoutMs }
      : {}),
    compaction: true,
    permission: {
      mode: input.permissionMode ?? "default",
      ...(config.permissions?.allow?.length ? { allowRules: config.permissions.allow } : {}),
      ...(config.permissions?.deny?.length ? { denyRules: config.permissions.deny } : {}),
      ...(config.permissions?.ask?.length ? { askRules: config.permissions.ask } : {}),
    },
    ...(input.allowRestrictedWorkspaceDevelopment !== undefined
      ? {
          allowRestrictedWorkspaceDevelopment: input.allowRestrictedWorkspaceDevelopment,
        }
      : {}),
    persistPermissions: true,
    ...(config.permissionProfiles ? { permissionProfiles: config.permissionProfiles } : {}),
    ...(config.permissionProfile ? { permissionProfile: config.permissionProfile } : {}),
    ...(input.workspaceTrust ? { workspaceTrust: input.workspaceTrust } : {}),
    ...(input.onWorkspaceTrustChange
      ? { onWorkspaceTrustChange: input.onWorkspaceTrustChange }
      : {}),
    ...(executionMode !== "native-isolated"
      ? {
          restrictedDevelopmentTools: () =>
            toolsAllowedByExecutionMode(restrictedWorkspaceDevelopmentTools(), executionMode),
        }
      : {}),
    skills,
    ...(supportsPersistentProcesses ? { subagents, checkpoints: true } : {}),
    repoMap: true,
    ...(webSearch ? { webSearch } : {}),
    ...(webSearchSelection
      ? { webSearchProvider: webSearchSelection.provider }
      : { webSearchDisabledReason: "credential_not_configured" }),
    browser,
    ...(browser !== false ? { browserRegistry } : {}),
    ...(tools ? { tools } : {}),
    smallModel: config.smallModel ?? true,
    ...(config.fallbackModels?.length ? { fallbackModels: config.fallbackModels } : {}),
    ...(containerBoundaryAttested && config.hooks?.length
      ? {
          hooks: commandHooksFromConfig(config.hooks, {
            executionRuntime: runtimeStack.isolatedRuntime,
          }),
        }
      : {}),
    autoTitle: true,
  };
}

export class ProductionSessionManagerConstructionError extends Error {
  constructor(
    cause: unknown,
    readonly cleanup: Promise<void>,
  ) {
    super("Failed to construct production SessionManager", { cause });
    this.name = "ProductionSessionManagerConstructionError";
  }
}

async function closeOwnedProductionResources(input: {
  runtimeStack?: LocalRuntimeStack;
  telemetry?: Telemetry;
  browserRegistry?: BrowserRegistry;
  ownsRuntimeStack: boolean;
  ownsTelemetry: boolean;
}): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (close: () => void | Promise<void>): Promise<void> => {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  };
  if (input.browserRegistry) await attempt(() => input.browserRegistry!.closeAll());
  if (input.ownsTelemetry && input.telemetry) {
    await attempt(async () => {
      if (input.telemetry!.shutdown) await input.telemetry!.shutdown();
      else await input.telemetry!.forceFlush?.();
    });
  }
  if (input.ownsRuntimeStack && input.runtimeStack) {
    await attempt(async () => input.runtimeStack!.isolatedRuntime.shutdown?.());
    await attempt(async () => input.runtimeStack!.artifacts.close?.());
    await attempt(() => input.runtimeStack!.networkProxy.close());
    await attempt(() => input.runtimeStack!.database.close());
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to roll back production runtime resources");
  }
}

export function createProductionSessionManager(
  input: ProductionSessionManagerInput,
): ProductionSessionManagerComposition {
  const ownsRuntimeStack = input.runtimeStack === undefined;
  const ownsTelemetry = input.telemetry === undefined;
  let runtimeStack: LocalRuntimeStack | undefined;
  let telemetry: Telemetry | undefined;
  let manager: SessionManager;
  const browserRegistry = input.browserRegistry ?? new BrowserRegistry();
  try {
    runtimeStack =
      input.runtimeStack ??
      createLocalRuntimeStack(
        path.dirname(input.sessionsDir),
        input.env ?? process.env,
        input.localRuntimeOptions,
      );
    telemetry = input.telemetry ?? telemetryForLocalStack(runtimeStack, input.env ?? process.env);
    manager = new SessionManager(
      productionSessionManagerOptions({ ...input, browserRegistry }, runtimeStack, telemetry),
    );
  } catch (error) {
    const cleanup = closeOwnedProductionResources({
      ...(runtimeStack ? { runtimeStack } : {}),
      ...(telemetry ? { telemetry } : {}),
      browserRegistry,
      ownsRuntimeStack,
      ownsTelemetry,
    });
    // Synchronous embedders cannot await construction failure cleanup; attach a handler now and
    // expose the original Promise on the typed error. Async hosts should use the factory below.
    void cleanup.catch(() => undefined);
    throw new ProductionSessionManagerConstructionError(error, cleanup);
  }
  let disposePromise: Promise<void> | undefined;

  return {
    manager,
    runtimeStack,
    telemetry,
    ownsRuntimeStack,
    dispose() {
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
        const failures: unknown[] = [];
        const attempt = async (close: () => void | Promise<void>): Promise<void> => {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        };
        await attempt(() => manager.shutdown());
        await attempt(() => browserRegistry.closeAll());
        if (ownsTelemetry) {
          await attempt(async () => {
            if (telemetry.shutdown) await telemetry.shutdown();
            else await telemetry.forceFlush?.();
          });
        }
        if (ownsRuntimeStack) {
          await attempt(async () => runtimeStack.isolatedRuntime.shutdown?.());
          await attempt(async () => runtimeStack.artifacts.close?.());
          await attempt(() => runtimeStack.networkProxy.close());
          await attempt(() => runtimeStack.database.close());
        }
        if (failures.length) {
          throw new AggregateError(failures, "Failed to dispose production session manager");
        }
      })();
      return disposePromise;
    },
  };
}

/** Async production hosts get a strict construction rollback barrier before the error escapes. */
export async function createProductionSessionManagerAsync(
  input: ProductionSessionManagerInput,
): Promise<ProductionSessionManagerComposition> {
  try {
    return createProductionSessionManager(input);
  } catch (error) {
    if (!(error instanceof ProductionSessionManagerConstructionError)) throw error;
    try {
      await error.cleanup;
    } catch (cleanupError) {
      throw new AggregateError(
        [error.cause ?? error, cleanupError],
        "Production SessionManager construction and rollback failed",
        { cause: cleanupError },
      );
    }
    throw error.cause ?? error;
  }
}
