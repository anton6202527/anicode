\set ON_ERROR_STOP on

-- Explicit local/development seed only. This file is intentionally outside supabase/seed.sql so a
-- reset or production deployment can never auto-entitle an account. Invoke with:
-- psql <local-db-url> --set anicode_cloud_dev_user_id=<uuid> \
--   --file supabase/seeds/anicode_cloud_entitlements.dev.sql
\if :{?anicode_cloud_dev_user_id}
select public.grant_anicode_cloud_entitlement(:'anicode_cloud_dev_user_id'::uuid);
\else
\warn 'Set --set anicode_cloud_dev_user_id=<existing-auth-user-uuid>'
\quit 3
\endif
