import { safeJsonError } from "./policy.ts";

export interface EntitlementRpcError {
  code?: string;
  message: string;
}

export interface EntitlementRpcClient {
  rpc(
    name: string,
    parameters: Record<string, unknown>,
  ): Promise<{ data?: unknown; error: EntitlementRpcError | null }>;
}

export type CloudEntitlementOutcome = "allowed" | "denied" | "unavailable";
const CLOUD_ENTITLEMENT_REQUIRED = "cloud_entitlement_required";

export function isCloudEntitlementDenial(
  error: EntitlementRpcError,
): boolean {
  return error.code === "P0001" &&
    error.message.trim().toLowerCase() === CLOUD_ENTITLEMENT_REQUIRED;
}

export function cloudEntitlementDeniedResponse(): Response {
  return safeJsonError(
    403,
    "AniCode Cloud access is not enabled for this account",
    CLOUD_ENTITLEMENT_REQUIRED,
    { "x-anicode-retryable": "false" },
  );
}

/**
 * Authentication and product authorization are deliberately separate. The shared Supabase project
 * can contain users from other products, so only an explicit server-owned entitlement may reach
 * model discovery or the purchased provider key. An RPC/contract failure always fails closed.
 */
export async function cloudEntitlement(
  admin: EntitlementRpcClient,
  userId: string,
): Promise<CloudEntitlementOutcome> {
  try {
    const { data, error } = await admin.rpc("has_anicode_cloud_entitlement", {
      p_user_id: userId,
    });
    if (error || typeof data !== "boolean") return "unavailable";
    return data ? "allowed" : "denied";
  } catch {
    return "unavailable";
  }
}

/** Return no response only when the request may proceed to a model route. */
export async function requireCloudEntitlement(
  admin: EntitlementRpcClient,
  userId: string,
): Promise<Response | undefined> {
  const outcome = await cloudEntitlement(admin, userId);
  if (outcome === "allowed") return undefined;
  if (outcome === "denied") return cloudEntitlementDeniedResponse();
  return safeJsonError(
    503,
    "cloud authorization is temporarily unavailable",
    "entitlement_unavailable",
    { "x-anicode-retryable": "true" },
  );
}
