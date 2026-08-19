import { assertEquals } from "jsr:@std/assert@1";
import {
  cloudEntitlement,
  type EntitlementRpcClient,
  isCloudEntitlementDenial,
  requireCloudEntitlement,
} from "./entitlement.ts";

function client(
  result: { data?: unknown; error: { message: string } | null },
  observe?: (name: string, parameters: Record<string, unknown>) => void,
): EntitlementRpcClient {
  return {
    rpc(name, parameters) {
      observe?.(name, parameters);
      return Promise.resolve(result);
    },
  };
}

Deno.test("cloud entitlement allows only an explicit true RPC result", async () => {
  let observed:
    | { name: string; parameters: Record<string, unknown> }
    | undefined;
  const outcome = await cloudEntitlement(
    client({ data: true, error: null }, (name, parameters) => {
      observed = { name, parameters };
    }),
    "10000000-0000-4000-8000-000000000001",
  );
  assertEquals(outcome, "allowed");
  assertEquals(observed, {
    name: "has_anicode_cloud_entitlement",
    parameters: { p_user_id: "10000000-0000-4000-8000-000000000001" },
  });
});

Deno.test("cloud entitlement defaults to deny and fails closed on RPC faults", async () => {
  assertEquals(
    await cloudEntitlement(client({ data: false, error: null }), "user"),
    "denied",
  );
  assertEquals(
    await cloudEntitlement(
      client({ data: true, error: { message: "database unavailable" } }),
      "user",
    ),
    "unavailable",
  );
  assertEquals(
    await cloudEntitlement(client({ data: "true", error: null }), "user"),
    "unavailable",
  );
  assertEquals(
    await cloudEntitlement(
      {
        rpc() {
          return Promise.reject(new Error("network unavailable"));
        },
      },
      "user",
    ),
    "unavailable",
  );
});

Deno.test("cloud entitlement gate emits stable hard-deny and transient-fault contracts", async () => {
  assertEquals(
    await requireCloudEntitlement(
      client({ data: true, error: null }),
      "user",
    ),
    undefined,
  );

  const denied = await requireCloudEntitlement(
    client({ data: false, error: null }),
    "user",
  );
  assertEquals(denied?.status, 403);
  assertEquals(denied?.headers.get("x-anicode-retryable"), "false");
  assertEquals(await denied?.json(), {
    error: {
      message: "AniCode Cloud access is not enabled for this account",
      type: "anicode_gateway_error",
      code: "cloud_entitlement_required",
    },
  });

  const unavailable = await requireCloudEntitlement(
    client({ error: { message: "database unavailable" } }),
    "user",
  );
  assertEquals(unavailable?.status, 503);
  assertEquals(unavailable?.headers.get("x-anicode-retryable"), "true");
  assertEquals(
    (await unavailable?.json()).error.code,
    "entitlement_unavailable",
  );
});

Deno.test("recognizes only the database reservation entitlement fence", () => {
  assertEquals(
    isCloudEntitlementDenial({
      code: "P0001",
      message: "cloud_entitlement_required",
    }),
    true,
  );
  assertEquals(
    isCloudEntitlementDenial({
      code: "P0001",
      message: "device_daily_token_limit",
    }),
    false,
  );
  assertEquals(
    isCloudEntitlementDenial({
      code: "42501",
      message: "cloud_entitlement_required",
    }),
    false,
  );
});
