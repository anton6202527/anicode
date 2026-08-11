import { createClient } from "@supabase/supabase-js";
import { bearerToken } from "./auth.ts";
import { supabaseApiKey } from "./environment.ts";
import {
  boundedJson,
  configuredModels,
  DEFAULT_MAX_OUTPUT_TOKENS,
  normalizeChatRequest,
  reservationTokens,
  safeJsonError,
} from "./policy.ts";
import { type GatewaySettlementStatus, meteredSseStream } from "./usage.ts";

const DEEPSEEK_CHAT_URL = "https://api.deepseek.com/v1/chat/completions";
const UPSTREAM_TIMEOUT_MS = 135_000;

interface RpcError {
  code?: string;
  message: string;
}

interface AdminClient {
  rpc(
    name: string,
    parameters: Record<string, unknown>,
  ): Promise<{ error: RpcError | null }>;
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required server configuration: ${name}`);
  return value;
}

function publicApiKey(): string {
  return supabaseApiKey(
    {
      named: Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"),
      single: Deno.env.get("SUPABASE_PUBLISHABLE_KEY"),
      legacy: Deno.env.get("SUPABASE_ANON_KEY"),
    },
    "Supabase publishable",
  );
}

function secretApiKey(): string {
  return supabaseApiKey(
    {
      named: Deno.env.get("SUPABASE_SECRET_KEYS"),
      single: Deno.env.get("SUPABASE_SECRET_KEY"),
      legacy: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    },
    "Supabase secret",
  );
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    return fallback;
  }
  return parsed;
}

/**
 * Function-level verification is authoritative. config.toml deliberately disables the legacy
 * gateway verifier so modern asymmetric Supabase signing keys remain deployable, but no route
 * reaches models or quota RPCs until Auth has validated the bearer token for this exact project.
 */
async function authenticatedUser(
  request: Request,
): Promise<{ id: string } | undefined> {
  const token = bearerToken(request);
  if (!token) return undefined;
  const client = createClient(requiredEnv("SUPABASE_URL"), publicApiKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user?.id) return undefined;
  return { id: data.user.id };
}

function adminClient(): AdminClient {
  return createClient(requiredEnv("SUPABASE_URL"), secretApiKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  }) as unknown as AdminClient;
}

type ReservationOutcome = "reserved" | "quota-exceeded" | "unavailable";

async function reserve(
  admin: AdminClient,
  userId: string,
  requestId: string,
  tokens: number,
): Promise<ReservationOutcome> {
  try {
    const { error } = await admin.rpc("reserve_anicode_llm_request", {
      p_user_id: userId,
      p_request_id: requestId,
      p_reserved_tokens: tokens,
    });
    if (!error) return "reserved";
    return error.code === "P0001" ? "quota-exceeded" : "unavailable";
  } catch {
    return "unavailable";
  }
}

async function settle(
  admin: AdminClient,
  requestId: string,
  chargedTokens: number,
  status: GatewaySettlementStatus,
): Promise<void> {
  try {
    const { error } = await admin.rpc("settle_anicode_llm_request", {
      p_request_id: requestId,
      p_charged_tokens: chargedTokens,
      p_status: status,
    });
    if (error) {
      console.error("anicode gateway quota settlement failed", requestId);
    }
  } catch {
    // Never include the RPC error: SDK metadata may contain server configuration or request data.
    console.error("anicode gateway quota settlement failed", requestId);
  }
}

function modelList(models: ReadonlySet<string>): Response {
  return Response.json(
    {
      object: "list",
      data: [...models].map((id) => ({
        id,
        object: "model",
        owned_by: "anicode",
      })),
    },
    {
      headers: {
        "cache-control": "private, max-age=60",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

async function chat(request: Request, userId: string): Promise<Response> {
  const allowedModels = configuredModels(
    Deno.env.get("ANICODE_DEEPSEEK_MODELS"),
  );
  const maximumOutputTokens = positiveInteger(
    Deno.env.get("ANICODE_GATEWAY_MAX_OUTPUT_TOKENS"),
    DEFAULT_MAX_OUTPUT_TOKENS,
    32_768,
  );
  let parsed: Awaited<ReturnType<typeof boundedJson>>;
  let normalized: ReturnType<typeof normalizeChatRequest>;
  try {
    parsed = await boundedJson(request);
    normalized = normalizeChatRequest(
      parsed.value,
      allowedModels,
      maximumOutputTokens,
    );
  } catch (error) {
    const message = error instanceof RangeError || error instanceof TypeError
      ? error.message
      : "invalid JSON request body";
    return safeJsonError(400, message, "invalid_request");
  }

  const requestId = crypto.randomUUID();
  const reservedTokens = reservationTokens(parsed.bytes, normalized.maxTokens);
  let admin: AdminClient;
  try {
    admin = adminClient();
  } catch {
    return safeJsonError(
      503,
      "model gateway is not configured",
      "gateway_unavailable",
    );
  }
  const reservation = await reserve(admin, userId, requestId, reservedTokens);
  if (reservation !== "reserved") {
    return reservation === "quota-exceeded"
      ? safeJsonError(
        429,
        "usage limit reached; retry later",
        "rate_limit_exceeded",
      )
      : safeJsonError(
        503,
        "usage service is temporarily unavailable",
        "quota_unavailable",
      );
  }

  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = AbortSignal.any([request.signal, timeout]);
  let upstream: Response;
  try {
    upstream = await fetch(DEEPSEEK_CHAT_URL, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${requiredEnv("DEEPSEEK_API_KEY")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(normalized.body),
    });
  } catch {
    await settle(
      admin,
      requestId,
      0,
      request.signal.aborted ? "aborted" : "failed",
    );
    return safeJsonError(
      502,
      "model gateway is temporarily unavailable",
      "upstream_unavailable",
    );
  }

  const contentType = upstream.headers.get("content-type")?.split(";", 1)[0]
    ?.trim().toLowerCase();
  if (!upstream.ok || !upstream.body || contentType !== "text/event-stream") {
    await upstream.body?.cancel().catch(() => undefined);
    await settle(admin, requestId, 0, "failed");
    const status = upstream.status === 429 ? 429 : 502;
    return safeJsonError(
      status,
      status === 429
        ? "model capacity is temporarily limited"
        : "model request failed",
      status === 429 ? "upstream_rate_limited" : "upstream_failed",
    );
  }

  const { readable, completion } = meteredSseStream(upstream.body, {
    signal: request.signal,
    reservedTokens,
    settle: (chargedTokens, status) =>
      settle(admin, requestId, chargedTokens, status),
  });
  // Supabase needs the pipe/settlement promise to remain live after the streaming Response returns.
  // The catch is defensive even though settle itself is deliberately non-throwing.
  const guardedCompletion = completion.catch(() => undefined);
  const edgeRuntime = globalThis as typeof globalThis & {
    EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
  };
  edgeRuntime.EdgeRuntime?.waitUntil(guardedCompletion);

  return new Response(readable, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
      "x-anicode-request-id": requestId,
      "x-content-type-options": "nosniff",
    },
  });
}

Deno.serve(async (request) => {
  try {
    if (request.method !== "GET" && request.method !== "POST") {
      return safeJsonError(405, "method not allowed", "method_not_allowed");
    }
    let user: { id: string } | undefined;
    try {
      user = await authenticatedUser(request);
    } catch {
      return safeJsonError(
        503,
        "authentication service is unavailable",
        "auth_unavailable",
      );
    }
    if (!user) return safeJsonError(401, "sign in required", "unauthorized");

    const pathname = new URL(request.url).pathname.replace(/\/+$/u, "");
    const models = configuredModels(Deno.env.get("ANICODE_DEEPSEEK_MODELS"));
    if (request.method === "GET" && pathname.endsWith("/v1/models")) {
      return modelList(models);
    }
    if (
      request.method === "POST" && pathname.endsWith("/v1/chat/completions")
    ) {
      return chat(request, user.id);
    }
    return safeJsonError(404, "endpoint not found", "not_found");
  } catch {
    return safeJsonError(
      503,
      "model gateway is temporarily unavailable",
      "gateway_unavailable",
    );
  }
});
