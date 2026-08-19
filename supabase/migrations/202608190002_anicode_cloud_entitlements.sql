-- The Supabase project may contain accounts for products other than AniCode. Authentication alone
-- must therefore never authorize use of the purchased DeepSeek key. Absence from this table is the
-- default-deny state; only a database owner or the service-role-only grant/revoke RPCs may change it.
create table if not exists private.anicode_cloud_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default true,
  granted_at timestamptz not null default statement_timestamp(),
  revoked_at timestamptz,
  updated_at timestamptz not null default statement_timestamp(),
  check (
    (enabled and revoked_at is null)
    or (not enabled and revoked_at is not null)
  )
);

alter table private.anicode_cloud_entitlements enable row level security;

revoke all on table private.anicode_cloud_entitlements
  from public, anon, authenticated, service_role;

create or replace function public.has_anicode_cloud_entitlement(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1
    from private.anicode_cloud_entitlements as entitlement
    where entitlement.user_id = p_user_id
      and entitlement.enabled
  )
$$;

create or replace function public.grant_anicode_cloud_entitlement(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'invalid AniCode Cloud entitlement user';
  end if;

  insert into private.anicode_cloud_entitlements(
    user_id,
    enabled,
    granted_at,
    revoked_at,
    updated_at
  )
  values (
    p_user_id,
    true,
    statement_timestamp(),
    null,
    statement_timestamp()
  )
  on conflict (user_id) do update
  set enabled = true,
      granted_at = statement_timestamp(),
      revoked_at = null,
      updated_at = statement_timestamp();
end;
$$;

create or replace function public.revoke_anicode_cloud_entitlement(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'invalid AniCode Cloud entitlement user';
  end if;

  update private.anicode_cloud_entitlements
  set enabled = false,
      revoked_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where user_id = p_user_id;
end;
$$;

-- Keep the product authorization check and quota reservation in one database transaction. The
-- row share lock gives revocation a precise boundary: after revoke commits, no later reservation
-- can pass using an older Edge-side entitlement result.
create or replace function public.reserve_anicode_llm_entitled_request_v2(
  p_user_id uuid,
  p_device_subject text,
  p_request_id uuid,
  p_reserved_tokens integer,
  p_model text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1
  from private.anicode_cloud_entitlements as entitlement
  where entitlement.user_id = p_user_id
    and entitlement.enabled
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'cloud_entitlement_required';
  end if;

  perform public.reserve_anicode_llm_request_v2(
    p_user_id,
    p_device_subject,
    p_request_id,
    p_reserved_tokens,
    p_model
  );
end;
$$;

revoke all on function public.has_anicode_cloud_entitlement(uuid)
  from public, anon, authenticated;
revoke all on function public.grant_anicode_cloud_entitlement(uuid)
  from public, anon, authenticated;
revoke all on function public.revoke_anicode_cloud_entitlement(uuid)
  from public, anon, authenticated;
revoke all on function public.reserve_anicode_llm_entitled_request_v2(uuid,text,uuid,integer,text)
  from public, anon, authenticated;

-- Database owners remain the break-glass administration boundary. Runtime service-role callers
-- must use the entitlement-aware wrapper and cannot bypass it via either historical reserve RPC.
revoke execute on function public.reserve_anicode_llm_request(uuid,uuid,integer)
  from service_role;
revoke execute on function public.reserve_anicode_llm_request_v2(uuid,text,uuid,integer,text)
  from service_role;

grant execute on function public.has_anicode_cloud_entitlement(uuid) to service_role;
grant execute on function public.grant_anicode_cloud_entitlement(uuid) to service_role;
grant execute on function public.revoke_anicode_cloud_entitlement(uuid) to service_role;
grant execute on function public.reserve_anicode_llm_entitled_request_v2(uuid,text,uuid,integer,text)
  to service_role;

notify pgrst, 'reload schema';
