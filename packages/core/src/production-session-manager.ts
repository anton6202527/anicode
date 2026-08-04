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
import {
  createLocalRuntimeStack,
  telemetryForLocalStack,
  type LocalExecutionMode,
  type LocalRuntimeStack,
} from "./runtime/local-stack.js";
import type { Telemetry } from "./runtime/telemetry.js";
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
} from "./tools/index.js";
import type { Tool, ToolRegistry } from "./tools/tool.js";
import type { PermissionMode } from "./permission.js";
import { Verifier } from "./runtime/verifier.js";
import type { WorkspaceTrustAssessment } from "./workspace-trust.js";
import { BrowserRegistry } from "./browser/cdp.js";

export interface ProductionSessionManagerInput {
  cwd: string;
  sessionsDir: string;
  /** Test/plugin override. Production defaults to the runtime stack's instance-bound registry. */
  resolveProvider?: SessionManagerOptions["resolveProvider"];
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
  telemetry?: Telemetry;
  env?: NodeJS.ProcessEnv;
  workspaceTrust?: WorkspaceTrustSource;
  onWorkspaceTrustChange?: (change: {
    sessionId: string;
    cwd: string;
    previous?: WorkspaceTrustAssessment;
    current: WorkspaceTrustAssessment;
  }) => void | Promise<void>;
  /** Replace the built-in registry (for example, Electron's live plugin registry). */
  tools?: () => ToolRegistry;
  /** Decorate either the built-in or host-provided registry. */
  extraTools?: readonly Tool[];
  deferredTools?: readonly Tool[];
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
): ToolRegistry {
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
            !["bash", "bash_output", "write_stdin", "list_shells", "kill_shell"].includes(name),
        ),
    );
    if (existingBash) foreground.register(foregroundOnlyBash(existingBash));
    return foreground;
  }
  const filtered = registry.subset(
    registry.names().filter((name) => {
      const capabilities = registry.get(name)?.capabilities;
      if (!capabilities || capabilities.length === 0) return false;
      return !capabilities.includes("process") && !capabilities.includes("persistent-process");
    }),
  );
  if (
    executionMode === "container" &&
    existingBash?.capabilities?.includes("process") &&
    !existingBash.capabilities.includes("persistent-process")
  ) {
    filtered.register(foregroundOnlyBash(existingBash));
  }
  return filtered;
}

function configuredTools(
  input: ProductionSessionManagerInput,
  executionMode: LocalExecutionMode,
): (() => ToolRegistry) | undefined {
  const extra = input.extraTools ?? [];
  const deferred = input.deferredTools ?? [];
  return () => {
    const registry = input.tools?.() ?? defaultTools();
    for (const tool of extra) registry.register(tool);
    for (const tool of deferred) registry.register(tool, { deferred: true });
    return toolsAllowedByExecutionMode(registry, executionMode);
  };
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
  const tools = configuredTools(input, executionMode);

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
    resolveProvider: input.resolveProvider ?? runtimeStack.resolveProvider,
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
    browser,
    ...(browser !== false ? { browserRegistry } : {}),
    ...(tools ? { tools } : {}),
    smallModel: config.smallModel ?? true,
    ...(config.fallbackModels?.length ? { fallbackModels: config.fallbackModels } : {}),
    ...(supportsPersistentProcesses && config.hooks?.length
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
      createLocalRuntimeStack(path.dirname(input.sessionsDir), input.env ?? process.env);
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
