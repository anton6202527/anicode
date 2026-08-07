/** Killable execution adapter for declarative, self-contained third-party tool modules. */

import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs, type Stats } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RuntimeTerminationError, type ExecutionRuntime } from "../runtime/isolated-runtime.js";
import { ToolError, isIsolatedModuleTool, type Tool, type ToolContext } from "./tool.js";

// Source and input share ExecutionRuntime's 1 MiB stdin envelope after two base64/JSON layers.
// Keeping each at 256 KiB leaves deterministic headroom for the static harness and metadata.
const MAX_MODULE_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_PROGRESS_BYTES = 12 * 1024;
const MAX_PROGRESS_EVENTS = 128;
const MAX_PROTOCOL_BYTES = 48 * 1024;
const MAX_CONCURRENT_PROCESSES = 32;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const RESULT_MARKER_PREFIX = "ANICODE_ISOLATED_TOOL_V1_";

export interface IsolatedToolRunLimits {
  timeoutMs: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxProgressBytes?: number;
  maxProgressEvents?: number;
}

export interface IsolatedToolRunnerOptions {
  maxConcurrent?: number;
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<string>;
}

interface ToolProtocolResponse {
  version: 1;
  status: "ok" | "error";
  content?: string;
  code?: string;
  progress?: unknown[];
  progressTruncated?: boolean;
}

interface Invocation {
  version: 1;
  sourceBase64: string;
  sha256: string;
  exportName: string;
  nonce: string;
  input: Record<string, unknown>;
  maxModuleBytes: number;
  maxOutputBytes: number;
  maxProgressBytes: number;
  maxProgressEvents: number;
  maxProtocolBytes: number;
}

/**
 * Owns only child invocations, not the shared ExecutionRuntime. `close()` aborts every invocation,
 * waits for the runtime's process-tree/container cleanup proof, and returns one stable promise.
 */
export class IsolatedToolRunner {
  private readonly active = new Set<ActiveRun>();
  private readonly maxConcurrent: number;
  private closed = false;
  private closeTask?: Promise<void>;
  private proofFailure?: RuntimeTerminationError;

  constructor(
    private readonly runtime: ExecutionRuntime | undefined,
    options: IsolatedToolRunnerOptions = {},
  ) {
    this.maxConcurrent = boundedInteger(
      options.maxConcurrent,
      8,
      1,
      MAX_CONCURRENT_PROCESSES,
      "isolated tool concurrency",
    );
  }

  run(
    tool: Tool,
    input: Record<string, unknown>,
    context: Pick<ToolContext, "cwd" | "signal" | "emit">,
    limits: IsolatedToolRunLimits,
  ): Promise<string> {
    if (this.closed) return Promise.reject(new ToolError("Isolated tool runner is closed"));
    if (!this.runtime) {
      return Promise.reject(new ToolError("Isolated tool execution runtime is unavailable"));
    }
    if (this.proofFailure) {
      return Promise.reject(new ToolError("Isolated tool runner failed termination proof"));
    }
    if (this.active.size >= this.maxConcurrent) {
      return Promise.reject(
        new ToolError(`Isolated tool concurrency limit reached (${this.maxConcurrent})`),
      );
    }
    if (tool.execution?.kind !== "isolated-module" || !isIsolatedModuleTool(tool)) {
      return Promise.reject(new ToolError("Tool has no isolated-module execution manifest"));
    }
    if (this.runtime.toolModuleEnvironment !== "container") {
      return Promise.reject(
        new ToolError("Isolated tool execution requires a container module boundary"),
      );
    }
    const unsupportedCapability = unsupportedIsolatedCapability(tool);
    if (unsupportedCapability) {
      return Promise.reject(
        new ToolError(
          `Isolated tool ${unsupportedCapability} capability is unsupported without a dedicated projection`,
        ),
      );
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(new ToolError("Isolated tool execution cancelled"));
    if (context.signal.aborted) onAbort();
    else context.signal.addEventListener("abort", onAbort, { once: true });

    let active!: ActiveRun;
    const promise = this.execute(tool, input, context, limits, controller.signal).finally(() => {
      context.signal.removeEventListener("abort", onAbort);
      this.active.delete(active);
    });
    active = { controller, promise };
    this.active.add(active);
    return promise;
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    const active = [...this.active];
    for (const run of active) {
      run.controller.abort(new ToolError("Isolated tool runner is closing"));
    }
    this.closeTask = Promise.allSettled(active.map((run) => run.promise)).then(() => {
      if (this.proofFailure) {
        throw new AggregateError([this.proofFailure], "Isolated tool termination proof failed");
      }
    });
    return this.closeTask;
  }

  private async execute(
    tool: Tool,
    input: Record<string, unknown>,
    context: Pick<ToolContext, "cwd" | "emit">,
    limits: IsolatedToolRunLimits,
    signal: AbortSignal,
  ): Promise<string> {
    const execution = tool.execution;
    if (execution?.kind !== "isolated-module" || !isIsolatedModuleTool(tool)) {
      throw new ToolError("Tool has no isolated-module execution manifest");
    }
    signal.throwIfAborted();

    const inputLimit = boundedInteger(
      limits.maxInputBytes,
      MAX_INPUT_BYTES,
      1,
      MAX_INPUT_BYTES,
      "isolated tool input limit",
    );
    const outputLimit = boundedInteger(
      limits.maxOutputBytes,
      MAX_OUTPUT_BYTES,
      1,
      MAX_OUTPUT_BYTES,
      "isolated tool output limit",
    );
    const progressBytes = boundedInteger(
      limits.maxProgressBytes,
      MAX_PROGRESS_BYTES,
      0,
      MAX_PROGRESS_BYTES,
      "isolated tool progress byte limit",
    );
    const progressEvents = boundedInteger(
      limits.maxProgressEvents,
      MAX_PROGRESS_EVENTS,
      0,
      MAX_PROGRESS_EVENTS,
      "isolated tool progress event limit",
    );
    const timeoutMs = boundedInteger(limits.timeoutMs, 120_000, 1_000, 30 * 60_000, "timeout");

    if (this.runtime?.toolModuleEnvironment !== "container") {
      throw new ToolError("Isolated tool execution requires a container module boundary");
    }
    const unsupportedCapability = unsupportedIsolatedCapability(tool);
    if (unsupportedCapability) {
      throw new ToolError(
        `Isolated tool ${unsupportedCapability} capability is unsupported without a dedicated projection`,
      );
    }
    const { root, source } = await readVerifiedModule(
      context.cwd,
      execution.module,
      execution.sha256,
    );
    signal.throwIfAborted();
    const inputJson = stringifyBoundedPlainJson(input, inputLimit, "isolated tool input");
    const invocation: Invocation = {
      version: 1,
      sourceBase64: source.toString("base64"),
      sha256: execution.sha256,
      exportName: execution.exportName,
      nonce: randomBytes(16).toString("hex"),
      input: JSON.parse(inputJson) as Record<string, unknown>,
      maxModuleBytes: MAX_MODULE_BYTES,
      maxOutputBytes: outputLimit,
      maxProgressBytes: progressBytes,
      maxProgressEvents: progressEvents,
      maxProtocolBytes: MAX_PROTOCOL_BYTES,
    };
    const encoded = Buffer.from(JSON.stringify(invocation), "utf8").toString("base64");
    const stdin = `${ISOLATED_TOOL_HARNESS}\nawait runIsolatedTool(${JSON.stringify(encoded)});\n`;
    // ExecutionRuntime has its own 1 MiB stdin ceiling. Check here as well to return a stable,
    // credential-free error instead of exposing backend-specific details.
    if (Buffer.byteLength(stdin, "utf8") > 1024 * 1024) {
      throw new ToolError("Isolated tool invocation exceeds the process protocol limit");
    }

    const command = toolModuleCommand(tool);
    const privateCwd = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-isolated-run-"));
    let runtimeResult;
    try {
      let executionError: unknown;
      try {
        await fs.chmod(privateCwd, 0o700);
        runtimeResult = await this.runtime!.run({
          command,
          // The original workspace is ownership metadata only. Passing a fresh empty directory
          // makes an accidental runtime downgrade fail closed instead of mounting user files.
          cwd: privateCwd,
          stdin,
          includeTransactionSummary: false,
          policy: "read-only",
          workspaceExposure: "none",
          network: false,
          timeoutMs,
          signal,
          workload: {
            // Local production ownership is workspace-scoped. Both values come from the trusted
            // control plane, never from manifest/input data, and the execution id is single-use.
            tenantId: `workspace:${createHash("sha256").update(root).digest("hex").slice(0, 32)}`,
            actor: `isolated-tool:${tool.def.name}`,
            executionId: `tool:${invocation.nonce}`,
          },
        });
      } catch (error) {
        executionError = error;
      }
      const cleanupError = await fs
        .rm(privateCwd, { recursive: true, force: true })
        .then(() => undefined)
        .catch((error: unknown) => error);
      if (executionError) throw executionError;
      if (cleanupError) throw cleanupError;
    } catch (error) {
      if (error instanceof RuntimeTerminationError) {
        this.poisonAfterProofFailure();
        throw new ToolError("Isolated tool termination proof failed");
      }
      if (signal.aborted) throw new ToolError("Isolated tool execution cancelled");
      throw new ToolError("Isolated tool process failed");
    }
    if (!runtimeResult) throw new ToolError("Isolated tool process failed");
    if (runtimeResult.timedOut) throw new ToolError("Isolated tool process timed out");
    if (signal.aborted) throw new ToolError("Isolated tool execution cancelled");

    const protocolOutput = runtimeResult.controlOutput;
    if (typeof protocolOutput !== "string") {
      throw new ToolError("Isolated tool runtime has no dedicated control output channel");
    }
    const response = parseProtocolResponse(protocolOutput, invocation);
    if (!response) {
      throw new ToolError(
        runtimeResult.exitCode === 0
          ? "Isolated tool returned no valid response"
          : "Isolated tool process failed",
      );
    }
    if (response.status === "error") throw protocolError(response.code);
    if (runtimeResult.exitCode !== 0 || typeof response.content !== "string") {
      throw new ToolError("Isolated tool process failed");
    }
    for (const progress of response.progress ?? []) context.emit?.(progress);
    if (response.progressTruncated) {
      // One extra event intentionally crosses the parent quota and activates its single bounded
      // TOOL_PROGRESS_QUOTA_EXCEEDED warning without retaining attacker-controlled data.
      context.emit?.({ type: "isolated_progress_truncated" });
    }
    return response.content;
  }

  private poisonAfterProofFailure(): void {
    this.proofFailure ??= new RuntimeTerminationError();
    for (const run of this.active) {
      run.controller.abort(new ToolError("Isolated tool termination proof failed"));
    }
  }
}

function toolModuleCommand(tool: Tool): string {
  const processCapable = tool.capabilities?.includes("process") === true;
  const permissionFlags = ["--permission"];
  if (processCapable) permissionFlags.push("--allow-child-process");
  const flags = permissionFlags.map(shellQuote).join(" ");
  // Container images are immutable/digest-pinned. Resolve Node only from fixed system paths;
  // never consult PATH. `/opt/homebrew/bin/node` is a test-host seam and remains a literal path.
  return `NODE_BIN=''; for candidate in /usr/local/bin/node /usr/bin/node /bin/node /opt/homebrew/bin/node; do if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi; done; [ -n "$NODE_BIN" ] || exit 127; ENV_BIN=''; for candidate in /usr/bin/env /bin/env; do if [ -x "$candidate" ]; then ENV_BIN="$candidate"; break; fi; done; [ -n "$ENV_BIN" ] || exit 127; NODE_VERSION=$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null) || exit 126; NODE_MAJOR=\${NODE_VERSION%%.*}; NODE_REST=\${NODE_VERSION#*.}; NODE_MINOR=\${NODE_REST%%.*}; case "$NODE_MAJOR:$NODE_MINOR" in *[!0-9:]*|:*) exit 126;; esac; if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 15 ]; }; then exit 126; fi; exec 3>&1; exec "$ENV_BIN" -i HOME=/tmp NODE_OPTIONS= NODE_PATH= "$NODE_BIN" ${flags} --max-old-space-size=64 --input-type=module - 1>/dev/null 2>/dev/null`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function unsupportedIsolatedCapability(tool: Tool): string | undefined {
  return tool.capabilities?.find((capability) =>
    ["filesystem-read", "filesystem-write", "network", "persistent-process"].includes(capability),
  );
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readVerifiedModule(
  cwd: string,
  relative: string,
  expectedSha256: string,
): Promise<{ root: string; source: Buffer }> {
  const root = await fs.realpath(cwd).catch(() => {
    throw new ToolError("Isolated tool workspace is unavailable");
  });
  const rootStat = await fs.lstat(root).catch(() => undefined);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ToolError("Isolated tool workspace is unavailable");
  }
  if (
    !relative.startsWith("./") ||
    relative.includes("\\") ||
    relative.includes("\0") ||
    relative.includes(",")
  ) {
    throw new ToolError("Isolated tool module path is invalid");
  }
  const segments = relative.slice(2).split("/");
  if (
    segments.some(
      (segment) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment) || segment === "." || segment === "..",
    )
  ) {
    throw new ToolError("Isolated tool module path is invalid");
  }
  let current = root;
  let candidateStat: Stats | undefined;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]!);
    const stat = await fs.lstat(current).catch(() => undefined);
    if (!stat || stat.isSymbolicLink()) {
      throw new ToolError("Isolated tool module is unavailable");
    }
    const last = index === segments.length - 1;
    if ((!last && !stat.isDirectory()) || (last && !stat.isFile())) {
      throw new ToolError("Isolated tool module is unavailable");
    }
    if (last) candidateStat = stat;
  }
  if (!candidateStat || candidateStat.nlink !== 1) {
    throw new ToolError("Isolated tool module is unavailable");
  }
  if (candidateStat.size > MAX_MODULE_BYTES) {
    throw new ToolError(`Isolated tool module exceeds ${MAX_MODULE_BYTES} bytes`);
  }
  const resolvedBefore = await fs.realpath(current).catch(() => undefined);
  if (!resolvedBefore || !isInside(root, resolvedBefore)) {
    throw new ToolError("Isolated tool module is unavailable");
  }

  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(current, fsConstants.O_RDONLY | noFollow).catch(() => {
    throw new ToolError("Isolated tool module is unavailable");
  });
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > MAX_MODULE_BYTES ||
      !sameFile(candidateStat, opened)
    ) {
      throw new ToolError("Isolated tool module changed during verification");
    }
    const buffer = Buffer.allocUnsafe(MAX_MODULE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_MODULE_BYTES) {
      throw new ToolError(`Isolated tool module exceeds ${MAX_MODULE_BYTES} bytes`);
    }
    const after = await handle.stat();
    const atPath = await fs.lstat(current).catch(() => undefined);
    const resolvedAfter = await fs.realpath(current).catch(() => undefined);
    if (
      !atPath ||
      !resolvedAfter ||
      !isInside(root, resolvedAfter) ||
      atPath.isSymbolicLink() ||
      !sameFile(opened, after) ||
      !sameFile(opened, atPath) ||
      after.nlink !== 1 ||
      after.size !== total
    ) {
      throw new ToolError("Isolated tool module changed during verification");
    }
    const source = buffer.subarray(0, total);
    if (createHash("sha256").update(source).digest("hex") !== expectedSha256) {
      throw new ToolError("Isolated tool module integrity check failed");
    }
    return { root, source };
  } finally {
    await handle.close();
  }
}

function stringifyBoundedPlainJson(value: unknown, maxBytes: number, label: string): string {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    if (depth > MAX_JSON_DEPTH) throw new ToolError(`${label} exceeds JSON depth limit`);
    if (++nodes > MAX_JSON_NODES) throw new ToolError(`${label} exceeds JSON node limit`);
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new ToolError(`${label} contains a non-finite number`);
      return;
    }
    if (typeof current !== "object") throw new ToolError(`${label} is not plain JSON`);
    if (seen.has(current)) throw new ToolError(`${label} contains a cycle`);
    seen.add(current);
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(current)) {
      throw new ToolError(`${label} is not plain JSON`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === "symbol") throw new ToolError(`${label} contains a symbol key`);
      if (Array.isArray(current) && key === "length") continue;
      const descriptor = descriptors[key]!;
      if (descriptor.get || descriptor.set || !("value" in descriptor)) {
        throw new ToolError(`${label} contains an accessor`);
      }
      if (!descriptor.enumerable) throw new ToolError(`${label} contains hidden properties`);
      visit(descriptor.value, depth + 1);
    }
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index++) {
        if (!Object.hasOwn(current, index)) throw new ToolError(`${label} contains a sparse array`);
      }
    }
    seen.delete(current);
  };
  visit(value, 0);
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new ToolError(`${label} exceeds ${maxBytes} bytes`);
  }
  return json;
}

function parseProtocolResponse(
  output: string,
  invocation: Invocation,
): ToolProtocolResponse | undefined {
  const marker = `${RESULT_MARKER_PREFIX}${invocation.nonce}:`;
  const totalBytes = Buffer.byteLength(output, "utf8");
  if (totalBytes > invocation.maxProtocolBytes + Buffer.byteLength(marker, "utf8") + 1) {
    return undefined;
  }
  // fd 3 carries exactly one frame. Do not accept surrounding attacker-controlled output or a
  // second frame even if one of them happens to parse successfully.
  if (!output.endsWith("\n")) return undefined;
  const line = output.slice(0, -1);
  if (line.includes("\n") || line.includes("\r") || !line.startsWith(marker)) return undefined;
  const payload = line.slice(marker.length);
  if (Buffer.byteLength(payload, "utf8") > invocation.maxProtocolBytes) return undefined;
  try {
    const value = JSON.parse(payload) as ToolProtocolResponse;
    if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
      return undefined;
    }
    if (value.status === "error") {
      const keys = Object.keys(value).sort().join(",");
      if (keys !== "code,status,version" || typeof value.code !== "string") return undefined;
      if (
        ![
          "INTEGRITY",
          "MODULE_LIMIT",
          "INVALID_EXPORT",
          "INVALID_RESULT",
          "OUTPUT_LIMIT",
          "HANDLER_FAILED",
        ].includes(value.code)
      ) {
        return undefined;
      }
      return value;
    }
    if (value.status !== "ok") return undefined;
    const keys = Object.keys(value).sort().join(",");
    if (keys !== "content,progress,progressTruncated,status,version") return undefined;
    if (
      typeof value.content !== "string" ||
      Buffer.byteLength(value.content, "utf8") > invocation.maxOutputBytes ||
      !Array.isArray(value.progress) ||
      value.progress.length > invocation.maxProgressEvents ||
      typeof value.progressTruncated !== "boolean"
    ) {
      return undefined;
    }
    let progressBytes = 0;
    for (const progress of value.progress) {
      const encoded = JSON.stringify(progress);
      if (encoded === undefined) return undefined;
      progressBytes += Buffer.byteLength(encoded, "utf8");
      if (progressBytes > invocation.maxProgressBytes) return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function protocolError(code: string | undefined): ToolError {
  switch (code) {
    case "INTEGRITY":
      return new ToolError("Isolated tool module integrity check failed");
    case "MODULE_LIMIT":
      return new ToolError(`Isolated tool module exceeds ${MAX_MODULE_BYTES} bytes`);
    case "INVALID_EXPORT":
      return new ToolError("Isolated tool module export is invalid");
    case "INVALID_RESULT":
      return new ToolError("Isolated tool returned a non-string result");
    case "OUTPUT_LIMIT":
      return new ToolError("Isolated tool output limit exceeded");
    default:
      return new ToolError("Isolated tool execution failed");
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  }
  return Math.min(candidate, maximum);
}

// Static, core-owned adapter. The invocation contains the exact source bytes already bounded and
// hashed by the parent; no workspace path crosses into the private container. The child re-hashes
// those bytes before importing a data URL. Relative transitive imports therefore fail, so authors
// must provide one self-contained ESM entry bundle.
const ISOLATED_TOOL_HARNESS = String.raw`
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";

const MARKER_PREFIX = "ANICODE_ISOLATED_TOOL_V1_";
const forceExit = process.exit.bind(process);
const writeControl = writeSync.bind(null, 3);

function finish(response, exitCode, request) {
  let payload = JSON.stringify(response);
  if (Buffer.byteLength(payload, "utf8") > request.maxProtocolBytes) {
    payload = JSON.stringify({ version: 1, status: "error", code: "OUTPUT_LIMIT" });
    exitCode = 1;
  }
  const marker = MARKER_PREFIX + request.nonce + ":";
  try { writeControl(Buffer.from(marker + payload + "\n", "utf8")); }
  finally { forceExit(exitCode); }
}

async function runIsolatedTool(encoded) {
  let request;
  try {
    request = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    forceExit(1);
    return;
  }
  const responseLimit = request.maxProtocolBytes;
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("cancelled"));
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const progress = [];
  let progressBytes = 0;
  let progressTruncated = false;
  const emit = (value) => {
    if (progressTruncated) return;
    let json;
    try { json = JSON.stringify(value); } catch { progressTruncated = true; return; }
    if (json === undefined) { progressTruncated = true; return; }
    const bytes = Buffer.byteLength(json, "utf8");
    if (progress.length >= request.maxProgressEvents || progressBytes + bytes > request.maxProgressBytes) {
      progressTruncated = true;
      return;
    }
    progress.push(json);
    progressBytes += bytes;
  };
  try {
    if (typeof request.sourceBase64 !== "string") {
      finish({ version: 1, status: "error", code: "INTEGRITY" }, 1, request);
      return;
    }
    const source = Buffer.from(request.sourceBase64, "base64");
    if (
      source.length > request.maxModuleBytes ||
      source.toString("base64") !== request.sourceBase64
    ) {
      finish({ version: 1, status: "error", code: "MODULE_LIMIT" }, 1, request);
      return;
    }
    if (createHash("sha256").update(source).digest("hex") !== request.sha256) {
      finish({ version: 1, status: "error", code: "INTEGRITY" }, 1, request);
      return;
    }
    const url = "data:text/javascript;base64," + source.toString("base64");
    const namespace = await import(url);
    const handler = namespace[request.exportName];
    if (typeof handler !== "function") {
      finish({ version: 1, status: "error", code: "INVALID_EXPORT" }, 1, request);
      return;
    }
    const content = await handler(request.input, {
      cwd: process.cwd(),
      signal: controller.signal,
      emit,
    });
    if (typeof content !== "string") {
      finish({ version: 1, status: "error", code: "INVALID_RESULT" }, 1, request);
      return;
    }
    if (Buffer.byteLength(content, "utf8") > request.maxOutputBytes) {
      finish({ version: 1, status: "error", code: "OUTPUT_LIMIT" }, 1, request);
      return;
    }
    const payload = "{\"version\":1,\"status\":\"ok\",\"content\":" + JSON.stringify(content) +
      ",\"progress\":[" + progress.join(",") + "],\"progressTruncated\":" +
      (progressTruncated ? "true" : "false") + "}";
    if (Buffer.byteLength(payload, "utf8") > responseLimit) {
      finish({ version: 1, status: "error", code: "OUTPUT_LIMIT" }, 1, request);
      return;
    }
    try { writeControl(Buffer.from(MARKER_PREFIX + request.nonce + ":" + payload + "\n", "utf8")); }
    finally { forceExit(0); }
  } catch (error) {
    const code = error?.code === "MODULE_LIMIT" ? "MODULE_LIMIT" : "HANDLER_FAILED";
    finish({ version: 1, status: "error", code }, 1, request);
  }
}
`;
