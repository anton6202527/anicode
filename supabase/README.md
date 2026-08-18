# AniCode Supabase gateway

The `anicode-chat` Edge Function is an authenticated OpenAI-compatible proxy. The trusted CLI/app
host sends a Supabase access token plus a 256-bit installation credential held in the OS Keychain.
The function stores only an HMAC pseudonym of that credential. `DEEPSEEK_API_KEY` remains a project
secret and is injected into the fixed HTTPS upstream request inside the function.

`verify_jwt` is intentionally disabled at the legacy Edge gateway layer so modern asymmetric
Supabase signing keys are accepted. This does **not** make the function public: every route calls
this project's `auth.getUser(accessToken)` before model discovery, quota reservation, or upstream
access. Do not remove that function-level check.

Remote project: `anime-armory-dev` (`wnisfghxewadqhseschj`). Never commit a personal access token,
service-role key, or DeepSeek key.

Do not enable Supabase anonymous sign-in in this shared project for the free-model rollout.
Anonymous users receive the PostgreSQL `authenticated` role too; a no-account trial requires a
dedicated project and a complete RLS/risk-control audit. The supported free route requires an
ordinary AniCode account but never asks the user for a DeepSeek key.

Deployment requires an authenticated Supabase CLI:

```bash
supabase link --project-ref wnisfghxewadqhseschj
supabase db query --linked --file supabase/migrations/202608110001_anicode_llm_gateway.sql
supabase db query --linked --file supabase/migrations/202608170001_anicode_device_quota.sql
supabase db query --linked --file supabase/checks/anicode_llm_gateway_preflight.sql
supabase migration repair --linked --status applied 202608110001
supabase migration repair --linked --status applied 202608170001
supabase secrets set --env-file <gateway-private-env-file>
node --env-file=<supabase-admin-private-env-file> scripts/preflight-anicode-gateway-rest.mjs
supabase functions deploy anicode-chat --no-verify-jwt
```

Run each migration file as one transaction and deploy the database before the Edge Function. Do
not split the SQL into individually autocommitted statements: the function definitions and their
`REVOKE`/`GRANT` contract are intended to become visible atomically. A new Edge deployment calls
the v2 stale-reclamation RPC and therefore fails closed until the database migration is present.
Treat a failed preflight query as a hard deployment stop; the migration also requests a PostgREST
schema-cache reload. The Node preflight then polls the real PostgREST RPC with a server-only key;
do not deploy the Edge bundle until it succeeds. The private admin env file contains
`SUPABASE_URL` plus `SUPABASE_SECRET_KEY` (or the legacy service-role key) and must never be
committed.

The shared project already has older `anime-armory` migrations which are intentionally not copied
into this repository, so use the scoped `db query` command above instead of repairing or reverting
those existing migration records. A new aligned project may use `supabase db push` normally.

The production secret set must include `DEEPSEEK_API_KEY` and an independently generated,
high-entropy `ANICODE_DEVICE_PSEUDONYM_KEY` of at least 32 UTF-8 bytes. Supabase automatically
injects the named `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_SECRET_KEYS` maps; local/legacy
single-key variables remain supported. Optional controls are `ANICODE_DEEPSEEK_MODELS` and
`ANICODE_GATEWAY_MAX_OUTPUT_TOKENS`. The free default allowlist contains only
`deepseek-v4-flash`; do not add Pro unless a separate paid entitlement/cost policy is implemented.

Stale reservations are reclaimed in a separately committed RPC before quota reservation, so a
rejected new request cannot roll the cleanup back. A late provider usage report can correct the
conservative stale estimate exactly once. Quota is then reserved atomically before the upstream
call and settled when the SSE pipe completes, fails, or is aborted. PostgreSQL is the only quota
authority. The installation defaults
are 200,000 tokens/day, 100 starts/day, 8 starts/minute and 2 concurrent requests, resetting at
midnight in `Asia/Shanghai`. Existing user/global caps remain defense-in-depth. The request ledger
records model, prompt/completion/cache/reasoning usage and reservation overruns; actual provider
usage is never silently clamped to the reservation.

An installation credential is a privacy-preserving, best-effort installation identity, not an
unforgeable physical-hardware fingerprint. Deleting the OS Keychain or using a custom client can
rotate it, so per-user and global budgets remain mandatory. Redis may be added as an early IP/minute
filter or policy cache, but must never independently authorize a request when PostgreSQL rejects it.

Adjust the product limit without redeploying the Edge Function:

```sql
update private.anicode_llm_policy
set gateway_enabled = true,
    policy_version = policy_version + 1,
    device_day_token_limit = 200000,
    device_day_request_limit = 100,
    device_minute_request_limit = 8,
    device_active_request_limit = 2,
    updated_at = statement_timestamp()
where singleton = true;
```

Set `gateway_enabled = false` in the same row for an immediate fail-closed kill switch. Existing
streams still settle; new reservations stop without an Edge redeploy.

The gateway calls the current official DeepSeek endpoint
`https://api.deepseek.com/chat/completions`, forces streaming `include_usage`, and passes a
non-PII HMAC `user_id` for upstream isolation. See the full rollout and observability design in
[`docs/architecture/2026-08-17-free-deepseek-device-quota.md`](../docs/architecture/2026-08-17-free-deepseek-device-quota.md).

Local checks (no remote project or secrets required):

```bash
deno fmt --check supabase/functions
deno check --config supabase/functions/anicode-chat/deno.json supabase/functions/anicode-chat/index.ts
deno test --config supabase/functions/anicode-chat/deno.json supabase/functions/anicode-chat
psql --set ON_ERROR_STOP=on --file supabase/tests/anicode_llm_gateway.test.sql <disposable-db>
```
