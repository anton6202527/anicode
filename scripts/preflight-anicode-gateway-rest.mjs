const projectUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/u, "");
const secretKey = (
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
)?.trim();

if (!projectUrl || !secretKey || !projectUrl.startsWith("https://")) {
  throw new Error("Set HTTPS SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)");
}

const endpoint = `${projectUrl}/rest/v1/rpc/reclaim_anicode_llm_stale_requests_v2`;
const deadline = Date.now() + 30_000;
let lastStatus = 0;

while (Date.now() < deadline) {
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      apikey: secretKey,
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  lastStatus = response.status;
  if (response.ok) {
    const body = await response.text();
    const reclaimed = Number(JSON.parse(body));
    if (!Number.isSafeInteger(reclaimed) || reclaimed < 0) {
      throw new Error("AniCode gateway RPC returned an invalid contract response");
    }
    console.log("AniCode gateway PostgREST RPC contract is ready");
    process.exit(0);
  }
  await response.body?.cancel().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 500));
}

throw new Error(`AniCode gateway PostgREST RPC was not ready (HTTP ${lastStatus || "network"})`);
