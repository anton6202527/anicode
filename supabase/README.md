# AniCode Supabase gateway

The `anicode-chat` Edge Function is an authenticated OpenAI-compatible proxy. The desktop app sends
only a Supabase user access token; `DEEPSEEK_API_KEY` remains a project secret and is injected into
the fixed HTTPS upstream request inside the function.

`verify_jwt` is intentionally disabled at the legacy Edge gateway layer so modern asymmetric
Supabase signing keys are accepted. This does **not** make the function public: every route calls
this project's `auth.getUser(accessToken)` before model discovery, quota reservation, or upstream
access. Do not remove that function-level check.

Remote project: `anime-armory-dev` (`wnisfghxewadqhseschj`). Never commit a personal access token,
service-role key, or DeepSeek key.

Deployment requires an authenticated Supabase CLI:

```bash
supabase link --project-ref wnisfghxewadqhseschj
supabase db query --linked --file supabase/migrations/202608110001_anicode_llm_gateway.sql
supabase migration repair --linked --status applied 202608110001
supabase secrets set --env-file <deepseek-only-private-env-file>
supabase functions deploy anicode-chat --no-verify-jwt
```

The shared project already has older `anime-armory` migrations which are intentionally not copied
into this repository, so use the scoped `db query` command above instead of repairing or reverting
those existing migration records. A new aligned project may use `supabase db push` normally.

The production secret set must include `DEEPSEEK_API_KEY`. Supabase automatically injects the
named `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_SECRET_KEYS` maps; local/legacy single-key variables
remain supported. Optional controls are `ANICODE_DEEPSEEK_MODELS` and
`ANICODE_GATEWAY_MAX_OUTPUT_TOKENS`. The default model allowlist is only `deepseek-v4-flash` and
`deepseek-v4-pro`.

Quota is reserved atomically before the upstream call and settled exactly once when the SSE pipe
completes, fails, or is aborted. In addition to per-user limits, the migration enforces shared-key
caps of 120 starts/minute, 2,000 starts/day, 10,000,000 reserved-or-charged tokens/day, and 30
concurrent requests. The global row is locked before user/request rows in every mutation, so bulk
account signup cannot race around the shared budget.

Local checks (no remote project or secrets required):

```bash
deno fmt --check supabase/functions
deno check --config supabase/functions/anicode-chat/deno.json supabase/functions/anicode-chat/index.ts
deno test --config supabase/functions/anicode-chat/deno.json supabase/functions/anicode-chat
psql --set ON_ERROR_STOP=on --file supabase/tests/anicode_llm_gateway.test.sql <disposable-db>
```
