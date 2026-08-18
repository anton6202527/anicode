import { createClient } from "@supabase/supabase-js";
import { bearerToken } from "./auth.ts";
import { installationToken, quotaSubjects } from "./device.ts";
import { supabaseApiKey } from "./environment.ts";
import {
  boundedJson,
  configuredModels,
  DEFAULT_MAX_OUTPUT_TOKENS,
  normalizeChatRequest,
  reservationTokens,
  safeJsonError,
} from "./policy.ts";
import {
  type GatewayRpcError,
  type QuotaRejection,
  quotaRejection,
  quotaResponseHeaders,
} from "./quota.ts";
import {
  type GatewaySettlementStatus,
  type GatewayUsage,
  meteredSseStream,
} from "./usage.ts";
import { upstreamFailure } from "./upstream.ts";

const DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions";
const UPSTREAM_TIMEOUT_MS = 135_000;

interface AdminClient {
  rpc(
    name: string,
    parameters: Record<string, unknown>,
  ): Promise<{ data?: unknown; error: GatewayRpcError | null }>;
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

type ReservationOutcome =
  | { state: "reserved" }
  | { state: "rejected"; rejection: QuotaRejection }
  | { state: "unavailable" };

async function reclaimStale(admin: AdminClient): Promise<number | undefined> {
  const { data, error } = await admin.rpc(
    "reclaim_anicode_llm_stale_requests_v2",
    {},
  );
  if (error || !Number.isSafeInteger(data) || Number(data) < 0) {
    return undefined;
  }
  return Number(data);
}

async function reserveOnce(
  admin: AdminClient,
  userId: string,
  deviceSubject: string,
  requestId: string,
  tokens: number,
  model: string,
): Promise<ReservationOutcome> {
  const { error } = await admin.rpc("reserve_anicode_llm_request_v2", {
    p_user_id: userId,
    p_device_subject: deviceSubject,
    p_request_id: requestId,
    p_reserved_tokens: tokens,
    p_model: model,
  });
  if (!error) return { state: "reserved" };
  const rejection = quotaRejection(error);
  return rejection
    ? { state: "rejected", rejection }
    : { state: "unavailable" };
}

async function reserve(
  admin: AdminClient,
  userId: string,
  deviceSubject: string,
  requestId: string,
  tokens: number,
  model: string,
): Promise<ReservationOutcome> {
  try {
    // This must be a separate RPC so cleanup commits even when the following reservation is
    // rejected. Keeping it here also makes DB-before-Edge rolling deployment fail closed.
    if ((await reclaimStale(admin)) === undefined) {
      return { state: "unavailable" };
    }
    const first = await reserveOnce(
      admin,
      userId,
      deviceSubject,
      requestId,
      tokens,
      model,
    );
    if (first.state !== "rejected") return first;
    // If a reservation crossed the legacy five-minute cutoff between the two RPCs, the rejected
    // transaction rolled that internal cleanup back. Commit a final reaper pass and retry this
    // never-inserted request ID once so a false daily-quota classification does not reach clients.
    const reclaimed = await reclaimStale(admin);
    if (reclaimed === undefined) return { state: "unavailable" };
    if (reclaimed === 0) return first;
    return await reserveOnce(
      admin,
      userId,
      deviceSubject,
      requestId,
      tokens,
      model,
    );
  } catch {
    return { state: "unavailable" };
  }
}

async function settle(
  admin: AdminClient,
  requestId: string,
  chargedTokens: number,
  status: GatewaySettlementStatus,
  usage?: GatewayUsage,
): Promise<void> {
  try {
    const { error } = await admin.rpc("settle_anicode_llm_request_v2", {
      p_request_id: requestId,
      p_charged_tokens: chargedTokens,
      p_status: status,
      p_prompt_tokens: usage?.promptTokens ?? null,
      p_completion_tokens: usage?.completionTokens ?? null,
      p_prompt_cache_hit_tokens: usage?.promptCacheHitTokens ?? null,
      p_prompt_cache_miss_tokens: usage?.promptCacheMissTokens ?? null,
      p_reasoning_tokens: usage?.reasoningTokens ?? null,
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
  const token = installationToken(request);
  if (!token) {
    return safeJsonError(
      400,
      "a protected installation credential is required",
      "installation_credential_required",
      { "x-anicode-retryable": "false" },
    );
  }

  let deviceSubject: string;
  let upstreamUserId: string;
  let upstreamApiKey: string;
  try {
    ({ deviceSubject, upstreamUserId } = await quotaSubjects(
      requiredEnv("ANICODE_DEVICE_PSEUDONYM_KEY"),
      token,
      userId,
    ));
    upstreamApiKey = requiredEnv("DEEPSEEK_API_KEY");
  } catch {
    return safeJsonError(
      503,
      "model gateway is not configured",
      "gateway_unavailable",
    );
  }

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

  // DeepSeek uses this pseudonym for cache/scheduling/safety isolation. It is deliberately scoped
  // to the authenticated account and installation and contains no email, hardware ID, or raw token.
  normalized.body["user_id"] = upstreamUserId;

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
  const reservation = await reserve(
    admin,
    userId,
    deviceSubject,
    requestId,
    reservedTokens,
    normalized.model,
  );
  if (reservation.state !== "reserved") {
    if (reservation.state === "rejected") {
      const disabled = reservation.rejection.code === "gateway_disabled";
      return safeJsonError(
        disabled ? 503 : 429,
        disabled
          ? "model gateway is temporarily unavailable"
          : reservation.rejection.retryable
          ? "request limit reached; retry later"
          : "daily free usage limit reached",
        reservation.rejection.code,
        quotaResponseHeaders(reservation.rejection),
      );
    }
    return safeJsonError(
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
        authorization: `Bearer ${upstreamApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(normalized.body),
    });
  } catch {
    await settle(
      admin,
      requestId,
      // Once fetch has started, a disconnect/timeout cannot prove that DeepSeek produced no
      // billable output. Charge the reservation conservatively instead of opening a cost leak.
      reservedTokens,
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
    // A malformed 2xx may still represent billable generation. Non-success responses are known
    // not to contain a completion, but an unexpected success protocol is charged conservatively.
    await settle(admin, requestId, upstream.ok ? reservedTokens : 0, "failed");
    const failure = upstreamFailure(upstream);
    console.warn(
      "anicode gateway upstream failure",
      requestId,
      upstream.status,
      failure.code,
    );
    return safeJsonError(
      failure.status,
      failure.message,
      failure.code,
      failure.headers,
    );
  }

  const { readable, completion } = meteredSseStream(upstream.body, {
    signal: request.signal,
    reservedTokens,
    settle: async (chargedTokens, status, usage) => {
      if (chargedTokens > reservedTokens) {
        console.warn(
          "anicode gateway reservation overrun",
          requestId,
          reservedTokens,
          chargedTokens,
        );
      }
      await settle(admin, requestId, chargedTokens, status, usage);
    },
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
