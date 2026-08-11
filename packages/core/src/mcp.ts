/**
 * MCP 客户端 —— 把外部 MCP server 的工具接入 core 的 ToolRegistry。
 *
 * 两种传输：
 *   - stdio（本地进程）：JSON-RPC 2.0，换行分隔帧。
 *   - Streamable HTTP（远程 server）：POST JSON-RPC 到单一 endpoint，响应为
 *     application/json 或 text/event-stream(SSE)。2026-07-28 为无状态请求；旧协议
 *     仍用 initialize + Mcp-Session-Id 维持会话。
 * 客户端先用 server/discover 探测 2026-07-28，旧 server 自动回退 initialize。
 * 支持 tools/list / tools/call。每个 MCP 工具包装成 core Tool
 * （默认非只读——外部工具不可信，一律走权限门）。
 *
 * 自研、无外部依赖：stdio 可用「假 server 脚本」离线测试，HTTP 可用本地 http server 测试。
 *
 * 除 tools 外还支持：
 *   - per-request 超时（对齐 Codex tool_timeout_sec；默认 60s，per-server 可配）
 *   - notifications/tools/list_changed → onToolsChanged 回调（对齐 Claude Code 自动刷新）
 *   - resources/prompts 的客户端方法（listResources/readResource/listPrompts/getPrompt），
 *     供前端做 @资源 提及与 /prompt 命令；按 discover/initialize 声明的能力裁剪。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import type { CredentialBroker } from "./security/credentials.js";
import { sanitizedShellEnv } from "./tools/shell-spawn.js";
import { t } from "./i18n.js";
import type { Tool, ToolContext } from "./tools/tool.js";
import { managedExternalTool, ToolError } from "./tools/tool.js";
import { terminateProcessTree, type ExecutionRuntime } from "./runtime/isolated-runtime.js";
import type { NetworkProxy } from "./runtime/network-proxy.js";
import { noTelemetry, traceparent, type SpanContext, type Telemetry } from "./runtime/telemetry.js";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpHeaderBinding {
  headerName: string;
  path: string[];
  type: "string" | "integer" | "boolean";
}

/** MCP 请求默认超时；挂死的 server 不该无限期占住一次工具调用。 */
const DEFAULT_TIMEOUT_MS = 60_000;
/** 旧 stdio server 可能静默丢弃 server/discover，探测必须使用较短独立上限。 */
const DEFAULT_DISCOVERY_TIMEOUT_MS = 3_000;
const MAX_MCP_STDIO_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_MCP_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_MCP_SSE_EVENTS = 10_000;
const MAX_MCP_PENDING_REQUESTS = 256;
const MAX_MCP_CLOSE_TIMEOUT_MS = 2_000;
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
const MCP_HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_MCP_SCHEMA_NODES = 4_096;
const MAX_MCP_RULE_KEY_DEPTH = 32;
const MAX_MCP_RULE_KEY_NODES = 4_096;
const MAX_MCP_RULE_KEY_ENTRIES = 4_096;
const MAX_MCP_RULE_KEY_HASH_BYTES = 1024 * 1024;
const MCP_RULE_KEY_DIGEST_HEX_CHARS = 32;

class McpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    readonly httpStatus?: number,
  ) {
    super(`MCP ${code}: ${message}`);
    this.name = "McpRpcError";
  }
}

class McpHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`MCP HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "McpHttpError";
  }
}

class McpOutcomeIndeterminateError extends Error {
  constructor() {
    super("MCP HTTP transport closed while a tool call was in flight");
    this.name = "McpOutcomeIndeterminateError";
  }
}

/**
 * Clone JSON/error-shaped values while redacting strings. Keeping the original prototype and
 * property descriptors preserves McpRpcError/McpHttpError classification without retaining the
 * unredacted message in stack, cause, or RPC data.
 */
function redactMcpValue<T>(
  value: T,
  broker: CredentialBroker | undefined,
  seen = new WeakMap<object, unknown>(),
): T {
  if (!broker) return value;
  if (typeof value === "string") return broker.redact(value) as T;
  if (value === null || typeof value !== "object") return value;

  const object = value as object;
  const previous = seen.get(object);
  if (previous !== undefined) return previous as T;
  const prototype = Object.getPrototypeOf(object);
  if (
    !Array.isArray(object) &&
    !(object instanceof Error) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return value;
  }

  const clone: object = Array.isArray(object) ? [] : Object.create(prototype);
  seen.set(object, clone);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) continue;
    if ("value" in descriptor) {
      descriptor.value = redactMcpValue(descriptor.value, broker, seen);
    }
    Object.defineProperty(clone, key, descriptor);
  }
  return clone as T;
}

function redactMcpError(error: unknown, broker: CredentialBroker | undefined): unknown {
  return redactMcpValue(error, broker);
}

async function closeMcpTransportAfterFailure(
  transport: McpTransport,
  failure: unknown,
  broker: CredentialBroker | undefined,
): Promise<never> {
  const redactedFailure = redactMcpError(failure, broker);
  try {
    await transport.close();
  } catch (cleanupFailure) {
    const redactedCleanupFailure = redactMcpError(cleanupFailure, broker);
    throw new AggregateError(
      [redactedFailure, redactedCleanupFailure],
      "MCP startup failed and transport cleanup failed",
      // The raw caught error may contain broker-managed credentials; only the redacted clone may
      // cross this boundary, including through `cause`.
      // eslint-disable-next-line preserve-caught-error
      { cause: redactedCleanupFailure },
    );
  }
  throw redactedFailure;
}

interface McpRuleKeyHashState {
  hash: ReturnType<typeof createHash>;
  bytes: number;
  nodes: number;
  ancestors: WeakSet<object>;
}

function updateMcpRuleKeyHash(state: McpRuleKeyHashState, token: string): void {
  if (token.length > MAX_MCP_RULE_KEY_HASH_BYTES) {
    throw new ToolError("MCP tool input exceeds the rule-key hashing size limit");
  }
  const bytes = Buffer.byteLength(token, "utf8");
  if (state.bytes + bytes > MAX_MCP_RULE_KEY_HASH_BYTES) {
    throw new ToolError("MCP tool input exceeds the rule-key hashing size limit");
  }
  state.hash.update(token);
  state.bytes += bytes;
}

function hashMcpRuleKeyValue(value: unknown, state: McpRuleKeyHashState, depth: number): void {
  if (depth > MAX_MCP_RULE_KEY_DEPTH || ++state.nodes > MAX_MCP_RULE_KEY_NODES) {
    throw new ToolError("MCP tool input exceeds the rule-key hashing complexity limit");
  }
  if (value === null) {
    updateMcpRuleKeyHash(state, "null;");
    return;
  }
  switch (typeof value) {
    case "string":
      updateMcpRuleKeyHash(state, `string:${value.length}:`);
      updateMcpRuleKeyHash(state, value);
      updateMcpRuleKeyHash(state, ";");
      return;
    case "number":
      updateMcpRuleKeyHash(
        state,
        `number:${Object.is(value, -0) ? "-0" : Number.isNaN(value) ? "NaN" : String(value)};`,
      );
      return;
    case "boolean":
      updateMcpRuleKeyHash(state, value ? "boolean:true;" : "boolean:false;");
      return;
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      throw new ToolError("MCP tool input for rule-key hashing must be JSON-compatible");
  }

  const object = value as object;
  if (state.ancestors.has(object)) {
    throw new ToolError("MCP tool input for rule-key hashing must not contain cycles");
  }
  const prototype = Object.getPrototypeOf(object);
  if (!Array.isArray(object) && prototype !== Object.prototype && prototype !== null) {
    throw new ToolError("MCP tool input for rule-key hashing must be a plain JSON object");
  }
  state.ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      if (object.length > MAX_MCP_RULE_KEY_ENTRIES) {
        throw new ToolError("MCP tool input exceeds the rule-key hashing entry limit");
      }
      updateMcpRuleKeyHash(state, `array:${object.length}:[`);
      for (let index = 0; index < object.length; index++) {
        updateMcpRuleKeyHash(state, `${index}:`);
        if (Object.hasOwn(object, index)) hashMcpRuleKeyValue(object[index], state, depth + 1);
        else updateMcpRuleKeyHash(state, "<hole>;");
      }
      updateMcpRuleKeyHash(state, "];");
      return;
    }

    const keys: string[] = [];
    for (const key in object) {
      if (!Object.hasOwn(object, key)) continue;
      keys.push(key);
      if (keys.length > MAX_MCP_RULE_KEY_ENTRIES) {
        throw new ToolError("MCP tool input exceeds the rule-key hashing entry limit");
      }
    }
    keys.sort();
    updateMcpRuleKeyHash(state, `object:${keys.length}:{`);
    for (const key of keys) {
      updateMcpRuleKeyHash(state, `key:${key.length}:`);
      updateMcpRuleKeyHash(state, key);
      updateMcpRuleKeyHash(state, "=");
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && "value" in descriptor) {
        hashMcpRuleKeyValue(descriptor.value, state, depth + 1);
      } else {
        throw new ToolError("MCP tool input for rule-key hashing must not use accessors");
      }
    }
    updateMcpRuleKeyHash(state, "};");
  } finally {
    state.ancestors.delete(object);
  }
}

function mcpRuleKey(name: string, input: Record<string, unknown>): string {
  const state: McpRuleKeyHashState = {
    hash: createHash("sha256"),
    bytes: 0,
    nodes: 0,
    ancestors: new WeakSet(),
  };
  hashMcpRuleKeyValue(input, state, 0);
  state.hash.update(`|nodes:${state.nodes}|bytes:${state.bytes}`);
  const digest = state.hash.digest("hex").slice(0, MCP_RULE_KEY_DIGEST_HEX_CHARS);
  return `${name} sha256:${digest}`;
}

/** server 声明的资源元数据（resources/list）。 */
export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** server 声明的 prompt 模板（prompts/list）。 */
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** initialize 握手里 server 声明的能力面（只保留我们关心的判定位）。 */
export interface McpServerCapabilities {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
}

/** 客户端事件回调（按需传入 McpClient.start / connectMcpServers）。 */
export interface McpClientHandlers {
  /** server 广播 notifications/tools/list_changed 时触发；用 listTools() 重新拉取。 */
  onToolsChanged?: () => void;
  telemetry?: Telemetry;
  /** HTTP MCP 必须经受控出口；宿主不传则 fail-close。 */
  networkProxy?: NetworkProxy;
  /** HTTP header / stdio env 的密钥只允许由 Broker 短租约注入。 */
  credentialBroker?: CredentialBroker;
  /** 宿主提供时，stdio MCP 进程通过同一 OS 隔离边界启动。 */
  executionRuntime?: ExecutionRuntime;
}

/** stdio 传输：本地进程 server。 */
export interface McpStdioConfig {
  /** 前缀名，工具会以 "<name>__<tool>" 暴露，避免与内置工具重名 */
  name: string;
  command: string;
  args?: string[];
  /** 仅用于非敏感配置；疑似密钥的变量会被拒绝。 */
  env?: Record<string, string>;
  /** env 名 → Broker credential id，例如 GITHUB_TOKEN → env:GITHUB_TOKEN。 */
  credentialEnv?: Record<string, string>;
  /** 默认断网；启用时宿主隔离运行时必须具有强制代理出口。 */
  network?: boolean;
  /** 单个请求的超时（毫秒）；默认 60000。 */
  timeoutMs?: number;
  /** 2026-07-28 server/discover 探测上限；默认 min(timeoutMs, 3000)。 */
  discoveryTimeoutMs?: number;
}

/** Streamable HTTP 传输：远程 server（含云端官方 server）。 */
export interface McpHttpConfig {
  name: string;
  /** server endpoint（Streamable HTTP）。 */
  url: string;
  /** 仅用于非敏感请求头；Authorization/Cookie/API key 必须用 credential。 */
  headers?: Record<string, string>;
  /** Broker 中的凭据引用；值不会进入配置、prompt、事件或 Artifact。 */
  credential?: {
    id: string;
    /** 缺省 authorization；必须与 Broker scope.header 一致。 */
    header?: string;
    /** 可选前缀，例如 Bearer。后端保存的仍是原始 token。 */
    scheme?: string;
  };
  /** 单个请求的超时（毫秒）；默认 60000。 */
  timeoutMs?: number;
  /** 2026-07-28 server/discover 探测上限；默认 min(timeoutMs, 3000)。 */
  discoveryTimeoutMs?: number;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

function isHttp(cfg: McpServerConfig): cfg is McpHttpConfig {
  return typeof (cfg as McpHttpConfig).url === "string";
}

/** Production local hosts permit only managed HTTP MCP; reject the whole set before any spawn. */
export function assertProductionHttpMcpConfigs(
  configs: McpServerConfig[],
): asserts configs is McpHttpConfig[] {
  const unsupported = configs.find((config) => !isHttp(config));
  if (unsupported) {
    throw new TypeError(
      `Production stdio MCP server ${unsupported.name} is disabled without a close-confirmed process boundary`,
    );
  }
}

const SENSITIVE_MCP_HEADER =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;
const SENSITIVE_MCP_ENV =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY(?:_ID)?|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY)(?:_|$)/i;

function rejectSensitiveHeaders(headers: Record<string, string> | undefined): void {
  const name = Object.keys(headers ?? {}).find((candidate) => SENSITIVE_MCP_HEADER.test(candidate));
  if (name) {
    throw new Error(`Sensitive MCP header ${name} must use credential.id and Credential Broker`);
  }
}

function safeMcpEnvironment(env: Record<string, string> | undefined): Record<string, string> {
  const name = Object.keys(env ?? {}).find((candidate) => SENSITIVE_MCP_ENV.test(candidate));
  if (name) {
    throw new Error(
      `Sensitive MCP environment variable ${name} must use credentialEnv and Credential Broker`,
    );
  }
  return { ...(env ?? {}) };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shellCommand(file: string, args: readonly string[]): string {
  return [file, ...args].map(shellQuote).join(" ");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 2026-07-28 将原握手信息放入每个请求的 params._meta。 */
function modernParams(params: unknown): Record<string, unknown> {
  const base = asRecord(params);
  const existingMeta = asRecord(base["_meta"]);
  return {
    ...base,
    _meta: {
      ...existingMeta,
      [PROTOCOL_VERSION_META]: MODERN_PROTOCOL_VERSION,
      [CLIENT_INFO_META]: { name: "anicode", version: "0.0.1" },
      [CLIENT_CAPABILITIES_META]: {},
    },
  };
}

function assertCompleteResult(result: unknown, method: string): void {
  const value = asRecord(result);
  const resultType = value["resultType"];
  if (resultType === undefined) {
    throw new Error(`MCP ${method} response is missing required resultType`);
  }
  if (resultType === "complete") return;
  if (resultType === "input_required") {
    throw new Error(`MCP ${method} requires client input, which anicode does not support yet`);
  }
  throw new Error(`MCP ${method} returned unsupported resultType: ${String(resultType)}`);
}

function shouldFallbackToLegacy(error: unknown, http: boolean): boolean {
  // 现代保留错误证明对端理解 2026 协议，永远不能降级。
  if (error instanceof McpRpcError && [-32020, -32021, -32022].includes(error.code)) {
    return false;
  }
  // stdio 无状态码，规范要求除现代保留错误外的探测失败均视作 legacy 证据。
  if (!http) return true;

  const status =
    error instanceof McpRpcError
      ? error.httpStatus
      : error instanceof McpHttpError
        ? error.status
        : undefined;
  // 认证失败、服务故障、超时和网络错误不是协议年代证据，必须原样失败。
  if (status === 401 || status === 403 || (status !== undefined && status >= 500)) return false;
  if (status === 400 || status === 404 || status === 405) return true;
  // 一些旧 Streamable HTTP server 用 200 JSON-RPC 错误响应未知 pre-init 方法。
  return (
    (status === undefined || status === 200) &&
    error instanceof McpRpcError &&
    (error.code === -32601 || error.code === -32602)
  );
}

function compileMcpHeaderBindings(
  inputSchema: unknown,
): { ok: true; bindings: McpHeaderBinding[] } | { ok: false; reason: string } {
  const bindings: McpHeaderBinding[] = [];
  const seenHeaders = new Set<string>();
  let visited = 0;
  try {
    const visit = (
      value: unknown,
      reachable: boolean,
      propertyNode: boolean,
      path: string[],
    ): void => {
      if (Array.isArray(value)) {
        for (const child of value) visit(child, false, false, path);
        return;
      }
      if (value === null || typeof value !== "object") return;
      if (++visited > MAX_MCP_SCHEMA_NODES) throw new Error("input schema is too complex");
      const node = value as Record<string, unknown>;
      if (Object.hasOwn(node, "x-mcp-header")) {
        if (!reachable || !propertyNode) {
          throw new Error("x-mcp-header must annotate a statically reachable property");
        }
        const headerName = node["x-mcp-header"];
        if (typeof headerName !== "string" || !MCP_HEADER_TOKEN.test(headerName)) {
          throw new Error("x-mcp-header must be a non-empty HTTP token");
        }
        const type = node["type"];
        if (type !== "string" && type !== "integer" && type !== "boolean") {
          throw new Error("x-mcp-header requires property type string, integer, or boolean");
        }
        const normalized = headerName.toLowerCase();
        if (seenHeaders.has(normalized)) {
          throw new Error("x-mcp-header names must be case-insensitively unique");
        }
        seenHeaders.add(normalized);
        bindings.push({ headerName, path: [...path], type });
      }

      const properties = node["properties"];
      if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
        for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
          visit(child, reachable, true, [...path, name]);
        }
      }
      for (const [key, child] of Object.entries(node)) {
        if (key === "x-mcp-header" || key === "properties") continue;
        visit(child, false, false, path);
      }
    };
    visit(inputSchema, true, false, []);
    return { ok: true, bindings };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "invalid x-mcp-header" };
  }
}

function mcpParameterHeaders(
  bindings: readonly McpHeaderBinding[],
  input: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const binding of bindings) {
    let current: unknown = input;
    let found = true;
    for (const segment of binding.path) {
      const record = asRecord(current);
      if (!Object.hasOwn(record, segment)) {
        found = false;
        break;
      }
      current = record[segment];
    }
    if (!found) continue;
    const valid =
      (binding.type === "string" && typeof current === "string") ||
      (binding.type === "boolean" && typeof current === "boolean") ||
      (binding.type === "integer" && typeof current === "number" && Number.isSafeInteger(current));
    if (!valid) {
      throw new ToolError(`MCP header parameter ${binding.path.join(".")} must be ${binding.type}`);
    }
    headers[`mcp-param-${binding.headerName}`] = encodeMcpHeaderValue(String(current));
  }
  return headers;
}

// ---------- 传输抽象 ----------

interface McpTransport {
  request(
    method: string,
    params: unknown,
    context?: SpanContext,
    timeoutMs?: number,
    parameterHeaders?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<any>;
  notify(method: string, params: unknown, timeoutMs?: number): void | Promise<void>;
  close(): void | Promise<void>;
  /** 旧 Streamable HTTP 后续请求需要复用 initialize 协商出的版本 header。 */
  setLegacyProtocolVersion?(version: string): void;
  /** server 主动通知（notifications/*）的回调；由客户端在握手后设置。 */
  onNotification?: (method: string, params: unknown) => void;
}

async function initializeLegacy(
  transport: McpTransport,
  cfg: McpServerConfig,
  telemetry: Telemetry,
  http: boolean,
  broker?: CredentialBroker,
): Promise<{ capabilities: Record<string, unknown>; protocolVersion: string }> {
  const span = telemetry.startSpan("anicode.mcp.request", {
    "rpc.system": "jsonrpc",
    "rpc.method": "initialize",
    "anicode.mcp.server": cfg.name,
    "anicode.mcp.transport": http ? "http" : "stdio",
    "anicode.mcp.protocol_era": "legacy",
  });
  try {
    const result = await transport.request(
      "initialize",
      {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "anicode", version: "0.0.1" },
      },
      span.context(),
    );
    span.setStatus({ code: "ok" });
    const protocolVersion =
      typeof result?.protocolVersion === "string"
        ? result.protocolVersion
        : LEGACY_PROTOCOL_VERSION;
    transport.setLegacyProtocolVersion?.(protocolVersion);
    return { capabilities: asRecord(result?.capabilities), protocolVersion };
  } catch (error) {
    const redacted = redactMcpError(error, broker);
    span.recordException(redacted).setStatus({ code: "error" });
    return closeMcpTransportAfterFailure(transport, redacted, broker);
  } finally {
    span.end();
  }
}

// ---------- 客户端 ----------

/** Hydrate only explicitly configured MCP credentials before synchronous lease injection. */
async function prepareMcpCredentials(
  config: McpServerConfig,
  broker: CredentialBroker | undefined,
): Promise<void> {
  if (!broker || isHttp(config)) return;
  for (const credentialId of new Set(Object.values(config.credentialEnv ?? {}))) {
    await broker.trustedValueAsync(credentialId, {
      audience: `mcp:${config.name}`,
      tool: "stdio",
    });
  }
}

export class McpClient {
  /** server/discover 或 initialize 取回的 server 能力面。 */
  readonly capabilities: McpServerCapabilities;
  /** 实际选择的协议版本。 */
  readonly protocolVersion: string;
  private closeTask?: Promise<void>;

  /** 配置里的 server 名（工具/prompt 的前缀）。 */
  get name(): string {
    return this.serverName;
  }

  private constructor(
    private readonly serverName: string,
    private readonly transport: McpTransport,
    capabilities: McpServerCapabilities,
    protocolVersion: string,
    private readonly modern: boolean,
    private readonly http: boolean,
    private readonly telemetry: Telemetry,
    private readonly credentialBroker?: CredentialBroker,
  ) {
    this.capabilities = capabilities;
    this.protocolVersion = protocolVersion;
  }

  /** 启动 server，优先协商 2026-07-28；旧 server 回退 initialize 握手。 */
  static async start(cfg: McpServerConfig, handlers?: McpClientHandlers): Promise<McpClient> {
    const timeoutMs = positiveTimeout(cfg.timeoutMs, DEFAULT_TIMEOUT_MS);
    await prepareMcpCredentials(cfg, handlers?.credentialBroker);
    const transport: McpTransport = isHttp(cfg)
      ? new HttpTransport(cfg, timeoutMs, handlers?.networkProxy, handlers?.credentialBroker)
      : new StdioTransport(cfg, timeoutMs, handlers?.credentialBroker, handlers?.executionRuntime);
    const telemetry = handlers?.telemetry ?? noTelemetry;
    const discoverSpan = telemetry.startSpan("anicode.mcp.request", {
      "rpc.system": "jsonrpc",
      "rpc.method": "server/discover",
      "anicode.mcp.server": cfg.name,
      "anicode.mcp.transport": isHttp(cfg) ? "http" : "stdio",
    });
    let discover: any;
    let legacyFallback = false;
    try {
      discover = await transport.request(
        "server/discover",
        modernParams({}),
        discoverSpan.context(),
        Math.min(timeoutMs, positiveTimeout(cfg.discoveryTimeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS)),
      );
      discoverSpan.setStatus({ code: "ok" });
    } catch (error) {
      if (!shouldFallbackToLegacy(error, isHttp(cfg))) {
        const redacted = redactMcpError(error, handlers?.credentialBroker);
        discoverSpan.recordException(redacted).setStatus({ code: "error" });
        return closeMcpTransportAfterFailure(transport, redacted, handlers?.credentialBroker);
      }
      legacyFallback = true;
      discoverSpan.addEvent("anicode.mcp.legacy_fallback", {
        "anicode.mcp.reason": error instanceof Error ? error.name : "unknown",
      });
      discoverSpan.setStatus({ code: "ok" });
    } finally {
      discoverSpan.end();
    }

    let capabilities: Record<string, unknown>;
    let protocolVersion: string;
    if (legacyFallback) {
      const initialized = await initializeLegacy(
        transport,
        cfg,
        telemetry,
        isHttp(cfg),
        handlers?.credentialBroker,
      );
      capabilities = initialized.capabilities;
      protocolVersion = initialized.protocolVersion;
    } else {
      try {
        assertCompleteResult(discover, "server/discover");
        const supported = Array.isArray(discover?.supportedVersions)
          ? discover.supportedVersions.filter(
              (value: unknown): value is string => typeof value === "string",
            )
          : [];
        if (!supported.includes(MODERN_PROTOCOL_VERSION)) {
          throw new Error(
            `MCP server ${cfg.name} does not support ${MODERN_PROTOCOL_VERSION} (supported: ${supported.join(", ") || "none"})`,
          );
        }
        capabilities = asRecord(discover?.capabilities);
        protocolVersion = MODERN_PROTOCOL_VERSION;
      } catch (error) {
        return closeMcpTransportAfterFailure(transport, error, handlers?.credentialBroker);
      }
    }

    const caps = capabilities;
    const client = new McpClient(
      cfg.name,
      transport,
      {
        tools: Boolean(caps.tools),
        resources: Boolean(caps.resources),
        prompts: Boolean(caps.prompts),
      },
      protocolVersion,
      !legacyFallback,
      isHttp(cfg),
      telemetry,
      handlers?.credentialBroker,
    );
    transport.onNotification = (method) => {
      if (method === "notifications/tools/list_changed") handlers?.onToolsChanged?.();
    };
    if (legacyFallback) {
      try {
        // 旧协议要求 initialized 先于任何普通请求；HTTP 必须等待 2xx，避免 tools/list
        // 在并行负载下抢跑并被严格 server 以 400 拒绝。
        await transport.notify("notifications/initialized", {}, timeoutMs);
      } catch (error) {
        return closeMcpTransportAfterFailure(transport, error, handlers?.credentialBroker);
      }
    }
    return client;
  }

  /** 拉取工具列表并包装成 core Tool 数组 */
  async listTools(): Promise<Tool[]> {
    const res = await this.request("tools/list", {});
    const specs: McpToolSpec[] = res?.tools ?? [];
    const tools: Tool[] = [];
    for (const spec of specs) {
      let bindings: McpHeaderBinding[] = [];
      if (this.modern && this.http) {
        const compiled = compileMcpHeaderBindings(spec.inputSchema);
        if (!compiled.ok) {
          const reason = this.redactText(compiled.reason);
          const span = this.telemetry.startSpan("anicode.mcp.tool_schema_rejected", {
            "anicode.mcp.server": this.serverName,
            "anicode.mcp.tool": this.redactText(String(spec.name)).slice(0, 256),
            "anicode.mcp.reason": reason,
          });
          span.setStatus({ code: "error", message: reason }).end();
          continue;
        }
        bindings = compiled.bindings;
      }
      try {
        tools.push(this.wrap(spec, bindings));
      } catch (error) {
        const reason = this.redactText(
          error instanceof Error ? error.message : "Invalid MCP tool definition",
        );
        const span = this.telemetry.startSpan("anicode.mcp.tool_schema_rejected", {
          "anicode.mcp.server": this.serverName,
          "anicode.mcp.tool": this.redactText(String(spec?.name)).slice(0, 256),
          "anicode.mcp.reason": reason,
        });
        span.setStatus({ code: "error", message: reason }).end();
      }
    }
    return tools;
  }

  /** 列出 server 声明的资源；server 未声明 resources 能力时返回空数组。 */
  async listResources(): Promise<McpResource[]> {
    if (!this.capabilities.resources) return [];
    const res = await this.request("resources/list", {});
    return redactMcpValue((res?.resources ?? []) as McpResource[], this.credentialBroker);
  }

  /** 读取一个资源的文本内容（blob 内容以占位说明代替，不注入二进制）。 */
  async readResource(uri: string): Promise<string> {
    const res = await this.request("resources/read", { uri });
    const contents: any[] = res?.contents ?? [];
    return this.redactText(
      contents
        .map((c) =>
          typeof c?.text === "string"
            ? c.text
            : t(
                `[binary content: ${c?.mimeType ?? "unknown"}]`,
                `[二进制内容: ${c?.mimeType ?? "未知类型"}]`,
              ),
        )
        .join("\n"),
    );
  }

  /** 列出 server 的 prompt 模板；未声明 prompts 能力时返回空数组。 */
  async listPrompts(): Promise<McpPrompt[]> {
    if (!this.capabilities.prompts) return [];
    const res = await this.request("prompts/list", {});
    return redactMcpValue((res?.prompts ?? []) as McpPrompt[], this.credentialBroker);
  }

  /** 取一个 prompt 模板渲染后的消息文本（拼接为可直接作为用户输入的文本）。 */
  async getPrompt(name: string, args?: Record<string, string>): Promise<string> {
    const res = await this.request("prompts/get", {
      name,
      ...(args ? { arguments: args } : {}),
    });
    const messages: any[] = res?.messages ?? [];
    return this.redactText(
      messages
        .map((m) => {
          const content = m?.content;
          if (typeof content?.text === "string") return content.text;
          if (Array.isArray(content))
            return content
              .filter((c: any) => typeof c?.text === "string")
              .map((c: any) => c.text)
              .join("\n");
          return "";
        })
        .filter(Boolean)
        .join("\n"),
    );
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    try {
      this.closeTask = Promise.resolve(this.transport.close()).catch((error) => {
        throw redactMcpError(error, this.credentialBroker);
      });
    } catch (error) {
      this.closeTask = Promise.reject(redactMcpError(error, this.credentialBroker));
    }
    return this.closeTask;
  }

  private redactText(value: string): string {
    return this.credentialBroker?.redact(value) ?? value;
  }

  private async request(
    method: string,
    params: unknown,
    parent?: SpanContext,
    parameterHeaders?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<any> {
    const span = this.telemetry.startSpan(
      "anicode.mcp.request",
      {
        "rpc.system": "jsonrpc",
        "rpc.method": method,
        "anicode.mcp.server": this.serverName,
      },
      parent,
    );
    try {
      const wireParams = this.modern ? modernParams(params) : params;
      const result = await this.transport.request(
        method,
        wireParams,
        span.context(),
        undefined,
        parameterHeaders,
        signal,
      );
      if (this.modern) assertCompleteResult(result, method);
      span.setStatus({ code: "ok" });
      return result;
    } catch (error) {
      const redacted = redactMcpError(error, this.credentialBroker);
      span.recordException(redacted).setStatus({ code: "error" });
      throw redacted;
    } finally {
      span.end();
    }
  }

  private wrap(spec: McpToolSpec, headerBindings: readonly McpHeaderBinding[]): Tool {
    const publicToolName = this.redactText(String(spec.name));
    const fqName = `${this.serverName}__${publicToolName}`;
    const serverName = this.serverName;
    const http = this.http;
    const credentialBroker = this.credentialBroker;
    const redactText = (value: string) => this.redactText(value);
    const callTool = (
      input: Record<string, unknown>,
      parent?: SpanContext,
      signal?: AbortSignal,
    ) => {
      const parameterHeaders =
        this.modern && this.http ? mcpParameterHeaders(headerBindings, input) : undefined;
      return this.request(
        "tools/call",
        { name: spec.name, arguments: input },
        parent,
        parameterHeaders,
        signal,
      );
    };
    const adapter: Tool = {
      readOnly: false, // 外部工具默认不可信，走权限门
      capabilities: http ? ["network"] : ["process", "persistent-process"],
      def: {
        name: fqName,
        description: spec.description
          ? this.redactText(spec.description)
          : `MCP 工具 ${publicToolName}（来自 ${serverName}）`,
        parameters: redactMcpValue(
          (spec.inputSchema as Record<string, unknown>) ?? {
            type: "object",
            properties: {},
          },
          this.credentialBroker,
        ),
      },
      ruleKey: (input) => mcpRuleKey(publicToolName, input),
      async run(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        try {
          const res = await callTool(input, ctx.traceContext, ctx.signal);
          return renderToolResult(res, redactText);
        } catch (error) {
          const redacted = redactMcpError(error, credentialBroker);
          if (
            http &&
            (ctx.signal.aborted ||
              mcpRequestTimedOut(redacted) ||
              redacted instanceof McpOutcomeIndeterminateError)
          ) {
            // Aborting a client-side HTTP request cannot prove whether the remote server committed
            // its side effect. Keep this fixed and credential-free rather than echoing abort causes.
            throw new ToolError(
              "MCP HTTP tool call timed out or was cancelled; remote operation outcome is unknown",
            );
          }
          throw redacted;
        }
      },
    };
    return managedExternalTool(adapter, {
      kind: "managed-external",
      protocol: http ? "mcp-http" : "mcp-stdio",
      namespace: serverName,
      // A stdio request owns and kills its server process tree before rejecting. HTTP can stop
      // local transport work but cannot prove whether a remote side effect committed.
      // A native stdio child can create a detached/session process outside killpg. Until MCP
      // sidecars run inside a cgroup/container/job object, both transports are outcome-indeterminate.
      cancellation: "outcome-indeterminate",
    });
  }
}

function mcpRequestTimedOut(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /\btimed out\b|超时/i.test(message);
}

// ---------- stdio 传输（MCP 规范：换行分隔 JSON，消息内不得含裸换行）----------
// 注意不是 LSP 的 Content-Length 分帧 —— 官方 SDK server 全部按行读写，
// 曾经的 Content-Length 实现对接任何真实 server 都会握手失败。

class StdioTransport implements McpTransport {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private terminalError: Error | undefined;
  private termination: Promise<void> | undefined;
  onNotification?: (method: string, params: unknown) => void;

  constructor(
    config: McpStdioConfig,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    broker?: CredentialBroker,
    executionRuntime?: ExecutionRuntime,
  ) {
    let env: NodeJS.ProcessEnv = { ...sanitizedShellEnv(), ...safeMcpEnvironment(config.env) };
    const credentialLeases: string[] = [];
    for (const [name, credentialId] of Object.entries(config.credentialEnv ?? {})) {
      if (Object.hasOwn(config.env ?? {}, name)) {
        throw new Error(`MCP ${config.name} env ${name} cannot be both static and broker-managed`);
      }
      if (!broker)
        throw new Error(`MCP ${config.name} credential ${credentialId} requires Credential Broker`);
      const lease = broker.lease({
        credentialId,
        audience: `mcp:${config.name}`,
        tool: "stdio",
        ttlMs: 30_000,
        maxUses: 1,
      });
      if (broker.leaseEnvironmentName(lease) !== name) {
        throw new Error(
          `MCP ${config.name} credential ${credentialId} is not scoped for env ${name}`,
        );
      }
      if (executionRuntime) credentialLeases.push(lease);
      else env = broker.injectEnv(lease, env);
    }
    let file = config.command;
    let args = config.args ?? [];
    let cwd: string | undefined;
    if (executionRuntime) {
      if (executionRuntime.managedProcessBoundary !== "close-confirmed") {
        throw new Error(
          "Persistent stdio MCP requires a cgroup/container/job-object process boundary",
        );
      }
      if (!executionRuntime.prepare) {
        throw new Error(
          "Persistent stdio MCP requires an execution runtime with prepare() support",
        );
      }
      const command = shellCommand(config.command, args);
      const prepared = executionRuntime.prepare({
        command,
        cwd: process.cwd(),
        policy: "read-only",
        network: config.network ?? false,
        env,
        ...(credentialLeases.length > 0 ? { credentialLeases } : {}),
      });
      file = prepared.file;
      args = prepared.args;
      env = prepared.env;
      cwd = prepared.cwd;
    }
    this.proc = spawn(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      // 禁止把宿主全部密钥隐式继承给第三方 MCP；只注入该 server 明确声明的 env。
      env,
      ...(cwd ? { cwd } : {}),
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    // A noisy server must not block itself on a full stderr pipe. Diagnostics belong in the
    // explicit debug log at the host boundary; never retain unbounded third-party stderr here.
    this.proc.stderr.on("data", () => {});
    this.proc.on("error", (error) => this.failTransport(error));
    this.proc.on("exit", () => {
      this.failTransport(new Error(t("MCP server has exited", "MCP server 已退出")));
    });
  }

  request(
    method: string,
    params: unknown,
    _context?: SpanContext,
    timeoutOverrideMs?: number,
    _parameterHeaders?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<any> {
    if (this.terminalError) return this.rejectAfterTermination(this.terminalError);
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error(`MCP request cancelled (${method})`));
    }
    if (this.pending.size >= MAX_MCP_PENDING_REQUESTS) {
      return Promise.reject(
        new Error(
          t(
            `MCP client has ${MAX_MCP_PENDING_REQUESTS} requests in flight`,
            `MCP 客户端已有 ${MAX_MCP_PENDING_REQUESTS} 个请求在处理中`,
          ),
        ),
      );
    }
    const id = this.nextId++;
    const requestTimeoutMs = positiveTimeout(timeoutOverrideMs, this.timeoutMs);
    return new Promise((resolve, reject) => {
      let cancelling = false;
      const onAbort = () =>
        cancel(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error(t(`MCP request cancelled (${method})`, `MCP 请求已取消（${method}）`)),
        );
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const cancel = (error: Error) => {
        if (cancelling || !this.pending.has(id)) return;
        cancelling = true;
        cleanup();
        try {
          this.writeFrame({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id, reason: error.message },
          });
        } catch {
          /* the hard process-tree stop below is authoritative */
        }
        this.failTransport(error);
      };
      // 超时：挂死的 server 不该无限期占住一次工具调用；如实告知方法与时限。
      const timer = setTimeout(
        () =>
          cancel(
            new Error(
              t(
                `MCP request timed out (${method}, ${requestTimeoutMs}ms)`,
                `MCP 请求超时（${method}，${requestTimeoutMs}ms）`,
              ),
            ),
          ),
        requestTimeoutMs,
      );
      // The deadline is authoritative even if the server has no live handles of its own.
      this.pending.set(id, {
        resolve: (v) => {
          cleanup();
          resolve(v);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        this.writeFrame({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.writeFrame({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    this.failTransport(new Error(t("MCP client has closed", "MCP 客户端已关闭")));
    await this.stopProcess();
  }

  private writeFrame(obj: unknown): void {
    // JSON.stringify 不会产出裸换行（字符串内换行是 \n 转义），满足单行约束。
    const frame = JSON.stringify(obj) + "\n";
    if (Buffer.byteLength(frame, "utf8") > MAX_MCP_STDIO_FRAME_BYTES) {
      throw new Error(
        t(
          `MCP frame exceeds ${MAX_MCP_STDIO_FRAME_BYTES} bytes`,
          `MCP 帧超过 ${MAX_MCP_STDIO_FRAME_BYTES} bytes`,
        ),
      );
    }
    this.proc.stdin.write(frame);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let nl: number;
    while ((nl = this.buffer.indexOf(0x0a)) >= 0) {
      const lineBuffer = this.buffer.subarray(0, nl);
      this.buffer = this.buffer.subarray(nl + 1);
      if (lineBuffer.length > MAX_MCP_STDIO_FRAME_BYTES) {
        this.failTransport(
          new Error(
            t(
              `MCP frame exceeds ${MAX_MCP_STDIO_FRAME_BYTES} bytes`,
              `MCP 帧超过 ${MAX_MCP_STDIO_FRAME_BYTES} bytes`,
            ),
          ),
        );
        return;
      }
      const line = lineBuffer.toString("utf8").replace(/\r$/, "").trim();
      // 非 JSON 行（server 把日志误写到 stdout）静默跳过，handleMessage 已容错。
      if (line) this.handleMessage(line);
    }
    if (this.buffer.length > MAX_MCP_STDIO_FRAME_BYTES) {
      this.failTransport(
        new Error(
          t(
            `MCP frame exceeds ${MAX_MCP_STDIO_FRAME_BYTES} bytes`,
            `MCP 帧超过 ${MAX_MCP_STDIO_FRAME_BYTES} bytes`,
          ),
        ),
      );
    }
  }

  private failTransport(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.buffer = Buffer.alloc(0);
    const pending = [...this.pending.values()];
    this.pending.clear();
    // Every request that was already on the wire shares one authoritative process-tree close
    // proof. No sibling request may reject early while the server can still commit a late effect.
    void this.stopProcess().then(
      () => {
        for (const request of pending) request.reject(error);
      },
      (terminationError) => {
        const failure = new AggregateError(
          [error, terminationError],
          "Failed to terminate MCP server",
        );
        for (const request of pending) request.reject(failure);
      },
    );
  }

  private stopProcess(): Promise<void> {
    this.termination ??= terminateProcessTree(this.proc);
    return this.termination;
  }

  private async rejectAfterTermination(error: Error): Promise<never> {
    try {
      await this.stopProcess();
    } catch (terminationError) {
      throw new AggregateError([error, terminationError], "Failed to terminate MCP server", {
        cause: terminationError,
      });
    }
    throw error;
  }

  private handleMessage(body: string): void {
    let msg: JsonRpcResponse & { method?: string; params?: unknown };
    try {
      msg = JSON.parse(body);
    } catch {
      return;
    }
    if (typeof msg.id !== "number") {
      // 无 id + 有 method = server 通知（如 notifications/tools/list_changed）。
      if (typeof msg.method === "string") {
        try {
          this.onNotification?.(msg.method, msg.params);
        } catch {
          // Consumer callbacks are isolation boundaries; server frame processing must continue.
        }
      }
      return;
    }
    if (typeof msg.method === "string") {
      // server→client 请求（roots/list、sampling 等）：明确回「不支持」，
      // 不能沉默 —— 等着响应的 server 会挂住。
      this.writeFrame({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "Method not supported by anicode client" },
      });
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new McpRpcError(msg.error.code, msg.error.message, msg.error.data));
    else p.resolve(msg.result);
  }
}

// ---------- Streamable HTTP 传输 ----------

function requestProtocolVersion(params: unknown): string | undefined {
  const value = asRecord(asRecord(params)["_meta"])[PROTOCOL_VERSION_META];
  return typeof value === "string" ? value : undefined;
}

/** MCP HTTP header 只允许安全 ASCII；其他值按规范使用 UTF-8 Base64 sentinel。 */
function encodeMcpHeaderValue(value: string): string {
  const safeAscii = /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
  const sentinel = value.startsWith("=?base64?") && value.endsWith("?=");
  return safeAscii && !sentinel
    ? value
    : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

class HttpTransport implements McpTransport {
  private nextId = 1;
  private sessionId: string | null = null;
  private legacyProtocolVersion: string | undefined;
  private closed = false;
  private closeTask?: Promise<void>;
  private inFlight = 0;
  private readonly activeCancellations = new Set<(reason: Error) => void>();
  onNotification?: (method: string, params: unknown) => void;

  constructor(
    private readonly config: McpHttpConfig,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly proxy?: NetworkProxy,
    private readonly broker?: CredentialBroker,
  ) {
    if (!proxy) throw new Error(`HTTP MCP ${config.name} requires the AniCode Network Proxy`);
    rejectSensitiveHeaders(config.headers);
  }

  request(
    method: string,
    params: unknown,
    context?: SpanContext,
    timeoutOverrideMs?: number,
    parameterHeaders?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<any> {
    const id = this.nextId++;
    const modern = requestProtocolVersion(params) === MODERN_PROTOCOL_VERSION;
    return this.withDeadline(method, timeoutOverrideMs, signal, async (requestSignal) => {
      const res = await this.post(
        { jsonrpc: "2.0", id, method, params },
        requestSignal,
        context,
        parameterHeaders,
      );
      if (requestSignal.aborted) {
        await res.body?.cancel().catch(() => undefined);
        throw requestSignal.reason ?? new Error(`MCP request cancelled (${method})`);
      }
      // 只有旧 initialize 协议允许传输层 session；现代响应即便误带也不得吸收。
      if (!modern) {
        const sid = res.headers.get("mcp-session-id");
        if (sid) this.sessionId = sid;
      }
      const message = await this.readResponse(res, id, requestSignal);
      if (requestSignal.aborted) {
        throw requestSignal.reason ?? new Error(`MCP request cancelled (${method})`);
      }
      if (message.error)
        throw new McpRpcError(
          message.error.code,
          message.error.message,
          message.error.data,
          res.status,
        );
      return message.result;
    });
  }

  notify(method: string, params: unknown, timeoutOverrideMs?: number): Promise<void> {
    return this.withDeadline(method, timeoutOverrideMs, undefined, async (requestSignal) => {
      const res = await this.post({ jsonrpc: "2.0", method, params }, requestSignal);
      if (requestSignal.aborted) {
        await res.body?.cancel().catch(() => undefined);
        throw requestSignal.reason ?? new Error(`MCP request cancelled (${method})`);
      }
      if (!res.ok) {
        throw new McpHttpError(
          res.status,
          await readBoundedResponseText(res, undefined, requestSignal).catch(() => ""),
        );
      }
      // 规范响应通常为 202 空 body；若 server 附带 body，主动释放连接资源。
      await res.body?.cancel().catch(() => undefined);
    });
  }

  setLegacyProtocolVersion(version: string): void {
    this.legacyProtocolVersion = version;
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    const closeError = new McpOutcomeIndeterminateError();
    for (const cancel of [...this.activeCancellations]) cancel(closeError);
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.closeTask = this.closeSession(sessionId);
    return this.closeTask;
  }

  private withDeadline<T>(
    method: string,
    timeoutOverrideMs: number | undefined,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(t("MCP client has closed", "MCP 客户端已关闭")));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error(`MCP request cancelled (${method})`));
    }
    if (this.inFlight >= MAX_MCP_PENDING_REQUESTS) {
      return Promise.reject(
        new Error(
          t(
            `MCP client has ${MAX_MCP_PENDING_REQUESTS} requests in flight`,
            `MCP 客户端已有 ${MAX_MCP_PENDING_REQUESTS} 个请求在处理中`,
          ),
        ),
      );
    }

    const requestTimeoutMs = positiveTimeout(timeoutOverrideMs, this.timeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    let boundarySettled = false;
    let rejectBoundary!: (reason: Error) => void;
    const boundary = new Promise<never>((_resolve, reject) => {
      rejectBoundary = reject;
    });
    const cancel = (reason: Error) => {
      if (boundarySettled) return;
      boundarySettled = true;
      controller.abort(reason);
      rejectBoundary(reason);
    };
    const onAbort = () =>
      cancel(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error(t(`MCP request cancelled (${method})`, `MCP 请求已取消（${method}）`)),
      );
    const timer = setTimeout(() => {
      timedOut = true;
      cancel(new Error(`MCP request timed out (${method})`));
    }, requestTimeoutMs);
    // A custom transport may return a non-cooperative promise with no active handles. Keep this
    // referenced so the caller-visible hard boundary remains enforceable in short-lived clients.
    // `inFlight` counts the physical operation, not only the caller-visible boundary. A custom
    // NetworkProxy/fetch implementation may ignore AbortSignal forever; releasing the slot when
    // the deadline wins would let repeated timeouts create unbounded live requests underneath.
    this.inFlight++;
    this.activeCancellations.add(cancel);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const operation = Promise.resolve()
      .then(() => {
        // withDeadline returns before this microtask starts. close()/external abort may run in
        // that gap; never begin a physical request after the synchronous fence has been raised.
        if (controller.signal.aborted) {
          throw controller.signal.reason ?? new Error(`MCP request cancelled (${method})`);
        }
        return run(controller.signal);
      })
      .finally(() => {
        this.activeCancellations.delete(cancel);
        this.inFlight--;
      });

    return (async () => {
      try {
        return await Promise.race([operation, boundary]);
      } catch (error) {
        if (timedOut) {
          throw new Error(
            t(
              `MCP request timed out (${method}, ${requestTimeoutMs}ms)`,
              `MCP 请求超时（${method}，${requestTimeoutMs}ms）`,
            ),
            { cause: error },
          );
        }
        if (signal?.aborted) throw signal.reason ?? error;
        throw error;
      } finally {
        boundarySettled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    })();
  }

  private async closeSession(sessionId: string | null): Promise<void> {
    if (!sessionId) return;
    const controller = new AbortController();
    const closeTimeoutMs = Math.min(this.timeoutMs, MAX_MCP_CLOSE_TIMEOUT_MS);
    let response: Response | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`MCP session close timed out (${closeTimeoutMs}ms)`));
        void response?.body?.cancel().catch(() => undefined);
        resolve();
      }, closeTimeoutMs);
      // Session cleanup is a hard close fence and must make progress on its own.
    });
    const cleanup = Promise.resolve()
      .then(() =>
        this.fetch({
          method: "DELETE",
          signal: controller.signal,
          headers: {
            ...this.config.headers,
            "mcp-session-id": sessionId,
            ...(this.legacyProtocolVersion === "2025-06-18" ||
            this.legacyProtocolVersion === "2025-11-25"
              ? { "mcp-protocol-version": this.legacyProtocolVersion }
              : {}),
          },
        }),
      )
      .then(async (res) => {
        response = res;
        await res.body?.cancel().catch(() => undefined);
      })
      .catch(() => undefined);
    try {
      await Promise.race([cleanup, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private post(
    body: unknown,
    signal?: AbortSignal,
    context?: SpanContext,
    parameterHeaders?: Record<string, string>,
  ): Promise<Response> {
    const envelope = asRecord(body);
    const method = typeof envelope["method"] === "string" ? envelope["method"] : undefined;
    const params = asRecord(envelope["params"]);
    const protocolVersion = requestProtocolVersion(params);
    const modern = protocolVersion === MODERN_PROTOCOL_VERSION;
    const legacyHeaderVersion =
      !modern &&
      (this.legacyProtocolVersion === "2025-06-18" || this.legacyProtocolVersion === "2025-11-25")
        ? this.legacyProtocolVersion
        : undefined;
    const name =
      method === "tools/call" || method === "prompts/get"
        ? params["name"]
        : method === "resources/read"
          ? params["uri"]
          : undefined;
    return this.fetch({
      method: "POST",
      headers: {
        ...this.config.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(modern && protocolVersion
          ? {
              "mcp-protocol-version": protocolVersion,
              ...(method ? { "mcp-method": method } : {}),
              ...(typeof name === "string" ? { "mcp-name": encodeMcpHeaderValue(name) } : {}),
            }
          : {}),
        ...(legacyHeaderVersion ? { "mcp-protocol-version": legacyHeaderVersion } : {}),
        ...(!modern && this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...(modern ? parameterHeaders : {}),
        ...(context ? { traceparent: traceparent(context) } : {}),
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  }

  private fetch(init: RequestInit): Promise<Response> {
    let headers = new Headers(init.headers);
    const credential = this.config.credential;
    if (credential) {
      if (!this.broker) {
        throw new Error(`HTTP MCP ${this.config.name} credential requires Credential Broker`);
      }
      const url = new URL(this.config.url);
      const lease = this.broker.lease({
        credentialId: credential.id,
        audience: `mcp:${this.config.name}`,
        host: url.hostname,
        tool: "http",
        ttlMs: Math.min(this.timeoutMs, 60_000),
        maxUses: 1,
      });
      headers = this.broker.injectHeaders(lease, headers);
      const header = (credential.header ?? "authorization").toLowerCase();
      const value = headers.get(header);
      if (value === null) {
        throw new Error(`MCP credential ${credential.id} is not scoped for header ${header}`);
      }
      if (credential.scheme) headers.set(header, `${credential.scheme} ${value}`);
    }
    return this.proxy!.fetch(this.config.url, { ...init, headers });
  }

  /** 读取一个 JSON-RPC 响应：application/json 直接解析；text/event-stream 读到匹配 id 的消息。 */
  private async readResponse(
    res: Response,
    id: number,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse> {
    if (!res.ok) {
      const text = await readBoundedResponseText(res, undefined, signal).catch(() => "");
      try {
        const parsed = JSON.parse(text) as JsonRpcResponse;
        if (parsed?.id === id && parsed.error) return parsed;
      } catch {
        // 非 JSON 错误页属于传输错误；由协商层决定是否回退 legacy。
      }
      throw new McpHttpError(res.status, text);
    }
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("application/json")) {
      return checkedJsonRpcResponse(
        JSON.parse(await readBoundedResponseText(res, undefined, signal)),
        id,
      );
    }
    if (ctype.includes("text/event-stream")) {
      const msg = await readSseForId(res, id, this.onNotification, signal);
      if (!msg)
        throw new Error(
          t("MCP SSE stream returned no matching response", "MCP SSE 流未返回匹配的响应"),
        );
      return msg;
    }
    // 少数 server 不带 content-type；尝试当 JSON 解析。
    const text = await readBoundedResponseText(res, undefined, signal);
    try {
      return checkedJsonRpcResponse(JSON.parse(text), id);
    } catch {
      throw new Error(
        t(
          `MCP response could not be parsed: ${text.slice(0, 200)}`,
          `MCP 响应无法解析: ${text.slice(0, 200)}`,
        ),
      );
    }
  }
}

function checkedJsonRpcResponse(value: unknown, expectedId: number): JsonRpcResponse {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { id?: unknown }).id !== expectedId
  ) {
    throw new Error(`MCP JSON-RPC response id mismatch (expected ${expectedId})`);
  }
  return value as JsonRpcResponse;
}

/** 从 SSE 流里读出 id 匹配的 JSON-RPC 响应（读到即返回）；流内通知转交回调。 */
async function readSseForId(
  res: Response,
  id: number,
  onNotification?: (method: string, params: unknown) => void,
  signal?: AbortSignal,
): Promise<JsonRpcResponse | null> {
  const body = res.body;
  if (!body) return null;
  const reader = body.getReader();
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const decoder = new TextDecoder();
  let buf = "";
  let totalBytes = 0;
  let eventCount = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      totalBytes += value?.byteLength ?? 0;
      if (totalBytes > MAX_MCP_HTTP_RESPONSE_BYTES) {
        throw new Error(`MCP SSE response exceeds ${MAX_MCP_HTTP_RESPONSE_BYTES} bytes`);
      }
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      // SSE 事件以空行分隔。
      while ((sep = indexOfDoubleNewline(buf)) >= 0) {
        const rawEvent = buf.slice(0, sep);
        buf = buf.slice(sep).replace(/^(\r?\n){1,2}/, "");
        if (++eventCount > MAX_MCP_SSE_EVENTS) {
          throw new Error(`MCP SSE response exceeds ${MAX_MCP_SSE_EVENTS} events`);
        }
        const data = sseData(rawEvent);
        if (!data) continue;
        try {
          const msg = JSON.parse(data) as JsonRpcResponse & { method?: string; params?: unknown };
          if (msg.id === id) return msg;
          if (msg.id === undefined && typeof msg.method === "string") {
            try {
              onNotification?.(msg.method, msg.params);
            } catch {
              // Consumer callbacks are isolation boundaries; stream processing must continue.
            }
          }
        } catch {
          /* 非 JSON 或部分事件，跳过 */
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return null;
}

async function readBoundedResponseText(
  response: Response,
  maximum = MAX_MCP_HTTP_RESPONSE_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`MCP HTTP response exceeds ${maximum} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        text += decoder.decode();
        return text;
      }
      if (!value) continue;
      total += value.byteLength;
      if (total > maximum) throw new Error(`MCP HTTP response exceeds ${maximum} bytes`);
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function indexOfDoubleNewline(s: string): number {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

/** 从一个 SSE 事件块里拼出 data: 行的内容。 */
function sseData(rawEvent: string): string {
  return rawEvent
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
}

// ---------- 结果渲染 ----------

/** MCP tools/call 结果 → 文本（content 数组里取 text 块拼接） */
function renderToolResult(res: any, redact: (value: string) => string = (value) => value): string {
  const text = redact(extractText(res));
  if (res?.isError) {
    throw new ToolError(text || "MCP 工具返回错误");
  }
  return text || "(无输出)";
}

function extractText(res: any): string {
  const content = res?.content;
  if (!Array.isArray(content)) return typeof res === "string" ? res : "";
  return content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

/** 便捷函数：启动多个 MCP server，收集全部工具。
 * handlers.onToolsChanged 在任一 server 广播工具变更时触发（带 server 名），
 * 调用方可对该 client 重新 listTools() 并更新自己的注册表。 */
const MCP_CONNECT_CONCURRENCY = 8;

export async function connectMcpServers(
  configs: McpServerConfig[],
  handlers?: {
    onToolsChanged?: (serverName: string, client: McpClient) => void;
    telemetry?: Telemetry;
    networkProxy?: NetworkProxy;
    credentialBroker?: CredentialBroker;
    executionRuntime?: ExecutionRuntime;
  },
): Promise<{
  tools: Tool[];
  clients: McpClient[];
}> {
  const connected: PromiseSettledResult<{ client: McpClient; tools: Tool[] }>[] = [];
  for (let offset = 0; offset < configs.length; offset += MCP_CONNECT_CONCURRENCY) {
    const batch = await Promise.allSettled(
      configs
        .slice(offset, offset + MCP_CONNECT_CONCURRENCY)
        .map(async (cfg): Promise<{ client: McpClient; tools: Tool[] }> => {
          let client: McpClient | undefined;
          const perServer: McpClientHandlers = {
            onToolsChanged: () => {
              if (client) handlers?.onToolsChanged?.(cfg.name, client);
            },
            ...(handlers?.telemetry ? { telemetry: handlers.telemetry } : {}),
            ...(handlers?.networkProxy ? { networkProxy: handlers.networkProxy } : {}),
            ...(handlers?.credentialBroker ? { credentialBroker: handlers.credentialBroker } : {}),
            ...(handlers?.executionRuntime ? { executionRuntime: handlers.executionRuntime } : {}),
          };
          client = await McpClient.start(cfg, perServer);
          try {
            return { client, tools: await client.listTools() };
          } catch (error) {
            // A client whose handshake succeeded is owned here until it is returned. Close it locally
            // if tools/list fails so the aggregate cleanup below cannot miss this partial connection.
            const cleanup = await Promise.allSettled([client.close()]);
            const cleanupError = cleanup[0];
            if (cleanupError?.status === "rejected") {
              throw new AggregateError(
                [error, cleanupError.reason],
                `Failed to initialize MCP ${cfg.name}`,
                {
                  cause: error,
                },
              );
            }
            throw error;
          }
        }),
    );
    connected.push(...batch);
    // Preserve the old fail-fast boundary for later configurations. Peers already started in this
    // bounded batch settle and are cleaned below, but a known failure must not launch more servers.
    if (batch.some((result) => result.status === "rejected")) break;
  }
  const successes = connected.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const failures = connected.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    const cleanup = await Promise.allSettled(
      [...successes].reverse().map(({ client }) => client.close()),
    );
    const cleanupFailures = cleanup
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1 && cleanupFailures.length === 0) throw failures[0];
    const cause = failures[0];
    throw new AggregateError(
      [...failures, ...cleanupFailures],
      "Failed to connect and clean up MCP servers",
      { ...(cause !== undefined ? { cause } : {}) },
    );
  }
  return {
    // Promise.allSettled preserves input order, keeping tool schema order byte-stable for provider
    // prompt caching even though independent handshakes run concurrently.
    clients: successes.map(({ client }) => client),
    tools: successes.flatMap(({ tools }) => tools),
  };
}
