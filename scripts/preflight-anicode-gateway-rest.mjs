const projectUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/u, "");
const secretKey = (
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
)?.trim();

if (!projectUrl || !secretKey || !projectUrl.startsWith("https://")) {
  throw new Error("Set HTTPS SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)");
}

const rpcChecks = [
  {
    name: "reclaim_anicode_llm_stale_requests_v2",
    body: {},
    valid(status, value) {
      return status === 200 && Number.isSafeInteger(value) && value >= 0;
    },
  },
  {
    name: "has_anicode_cloud_entitlement",
    body: { p_user_id: null },
    valid(status, value) {
      return status === 200 && value === false;
    },
  },
  {
    name: "reserve_anicode_llm_entitled_request_v2",
    body: {
      p_user_id: null,
      p_device_subject: null,
      p_request_id: null,
      p_reserved_tokens: null,
      p_model: null,
    },
    valid(status, value) {
      return (
        status === 400 && value?.code === "P0001" && value?.message === "cloud_entitlement_required"
      );
    },
  },
];
const deadline = Date.now() + 30_000;
let lastStatus = 0;
let lastRpc = rpcChecks[0].name;

while (Date.now() < deadline) {
  let ready = true;
  for (const check of rpcChecks) {
    lastRpc = check.name;
    const response = await fetch(`${projectUrl}/rest/v1/rpc/${check.name}`, {
      method: "POST",
      redirect: "error",
      headers: {
        apikey: secretKey,
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(check.body),
    });
    lastStatus = response.status;
    let value;
    try {
      value = JSON.parse(await response.text());
    } catch {
      throw new Error(
        `AniCode gateway RPC ${check.name} returned non-JSON status ${response.status}`,
      );
    }
    if (check.valid(response.status, value)) continue;
    if (!response.ok) {
      ready = false;
      break;
    }
    if (!check.valid(response.status, value)) {
      throw new Error(`AniCode gateway RPC ${check.name} returned an invalid contract response`);
    }
  }
  if (ready) {
    console.log("AniCode gateway PostgREST RPC contract is ready");
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

throw new Error(
  `AniCode gateway PostgREST RPC ${lastRpc} was not ready (HTTP ${lastStatus || "network"})`,
);
