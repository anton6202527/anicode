-- Linearize policy hot updates with quota reservation. The deployed v2 implementation reads the
-- policy before waiting for the global quota row, so a request queued behind that row could retain
-- an obsolete enabled flag, limit set, timezone and policy version. Keep that implementation as a
-- private worker and put the authoritative locks in a small compatibility wrapper.
do $$
begin
  if pg_catalog.to_regprocedure(
    'private.reserve_anicode_llm_request_v2_policy_locked(uuid,text,uuid,integer,text)'
  ) is null then
    if pg_catalog.to_regprocedure(
      'public.reserve_anicode_llm_request_v2(uuid,text,uuid,integer,text)'
    ) is null then
      raise exception using
        errcode = '42883',
        message = 'deployed device quota reservation RPC is missing';
    end if;

    alter function public.reserve_anicode_llm_request_v2(
      uuid, text, uuid, integer, text
    ) set schema private;
    alter function private.reserve_anicode_llm_request_v2(
      uuid, text, uuid, integer, text
    ) rename to reserve_anicode_llm_request_v2_policy_locked;
  end if;
end;
$$;

revoke all on function private.reserve_anicode_llm_request_v2_policy_locked(
  uuid, text, uuid, integer, text
) from public, anon, authenticated, service_role;

create or replace function public.reserve_anicode_llm_request_v2(
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
declare
  quota_policy private.anicode_llm_policy%rowtype;
begin
  if p_user_id is null
     or p_request_id is null
     or p_device_subject is null
     or p_device_subject !~ '^d_[A-Za-z0-9_-]{43}$'
     or p_model is null
     or p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or p_reserved_tokens is null
     or p_reserved_tokens < 1
     or p_reserved_tokens > 1000000 then
    raise exception using errcode = '22023', message = 'invalid device quota reservation';
  end if;

  -- Preserve the cheap disabled fast path. This read is only an optimization; the locked read
  -- below remains authoritative if an update races this one.
  select * into quota_policy
  from private.anicode_llm_policy
  where singleton = true;
  if not found then
    raise exception using errcode = '55000', message = 'device quota policy is missing';
  end if;
  if not quota_policy.gateway_enabled then
    raise exception using errcode = 'P0001', message = 'gateway_disabled';
  end if;

  -- Keep the established device -> global -> users -> requests order. Taking the global singleton
  -- before the policy row means a request that waited behind another reservation must refresh its
  -- policy after that wait. FOR SHARE then fixes enabled/limits/version/timezone until commit, so
  -- an administrative UPDATE has a clear before-or-after order relative to this reservation.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_device_subject, 0)
  );

  perform 1
  from private.anicode_llm_global_account
  where singleton = true
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'global quota account is missing';
  end if;

  select * into quota_policy
  from private.anicode_llm_policy
  where singleton = true
  for share;
  if not found then
    raise exception using errcode = '55000', message = 'device quota policy is missing';
  end if;
  if not quota_policy.gateway_enabled then
    raise exception using errcode = 'P0001', message = 'gateway_disabled';
  end if;
  perform 1
  from pg_catalog.pg_timezone_names
  where name = quota_policy.quota_timezone;
  if not found then
    raise exception using errcode = '22023', message = 'device quota timezone is invalid';
  end if;

  -- The private worker reuses these transaction locks and reads the now-locked policy row, so all
  -- policy-derived values and the ledger's policy_version come from this authoritative snapshot.
  perform private.reserve_anicode_llm_request_v2_policy_locked(
    p_user_id,
    p_device_subject,
    p_request_id,
    p_reserved_tokens,
    p_model
  );
end;
$$;

revoke all on function public.reserve_anicode_llm_request_v2(
  uuid, text, uuid, integer, text
) from public, anon, authenticated;
grant execute on function public.reserve_anicode_llm_request_v2(
  uuid, text, uuid, integer, text
) to service_role;

notify pgrst, 'reload schema';
