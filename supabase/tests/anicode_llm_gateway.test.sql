\set ON_ERROR_STOP on

-- Run only against a disposable PostgreSQL database. The surrounding transaction rolls back the
-- complete Supabase/auth fixture, migration, roles, and quota data.
begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end;
$$;

create schema auth;
create table auth.users(id uuid primary key);

-- Simulate another feature that already owns objects and authenticated access in the project's
-- shared private schema. The AniCode migration must not revoke those existing privileges.
create schema private;
grant usage on schema private to authenticated;
create table private.existing_auth_policy_fixture(id integer primary key);
grant select on table private.existing_auth_policy_fixture to authenticated;
create function private.existing_auth_policy_fixture_can_access()
returns boolean
language sql
immutable
as $$ select true $$;
revoke all on function private.existing_auth_policy_fixture_can_access() from public;
grant execute on function private.existing_auth_policy_fixture_can_access() to authenticated;

\ir ../migrations/202608110001_anicode_llm_gateway.sql
-- The initial migration must remain safe for repeated local bootstrap runs.
\ir ../migrations/202608110001_anicode_llm_gateway.sql
\ir ../migrations/202608170001_anicode_device_quota.sql
-- Device quota migration is also safe to reapply during a scoped shared-project bootstrap.
\ir ../migrations/202608170001_anicode_device_quota.sql

do $$
declare
  user_one constant uuid := '10000000-0000-4000-8000-000000000001';
  request_one constant uuid := '20000000-0000-4000-8000-000000000001';
  blocked boolean := false;
  row_count integer;
  value bigint;
  current_status text;
  generated_user uuid;
begin
  if has_schema_privilege('anon', 'private', 'usage') then
    raise exception 'AniCode exposed the private schema to anon';
  end if;
  if not has_schema_privilege('authenticated', 'private', 'usage')
     or not has_table_privilege(
       'authenticated',
       'private.existing_auth_policy_fixture',
       'select'
     )
     or not has_function_privilege(
       'authenticated',
       'private.existing_auth_policy_fixture_can_access()',
       'execute'
     ) then
    raise exception 'AniCode revoked an existing private-schema integration privilege';
  end if;
  if has_function_privilege(
       'anon',
       'public.reserve_anicode_llm_request(uuid,uuid,integer)',
       'execute'
     )
     or has_function_privilege(
       'authenticated',
       'public.settle_anicode_llm_request(uuid,integer,text)',
       'execute'
     ) then
    raise exception 'quota functions are exposed to callers';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.reserve_anicode_llm_request(uuid,uuid,integer)',
    'execute'
  ) then
    raise exception 'service role cannot reserve quota';
  end if;

  insert into auth.users(id) values (user_one);
  perform public.reserve_anicode_llm_request(user_one, request_one, 100);

  select active_requests, day_reserved_tokens
  into row_count, value
  from private.anicode_llm_accounts
  where user_id = user_one;
  if row_count <> 1 or value <> 100 then raise exception 'user reservation was not recorded'; end if;

  select active_requests, day_reserved_tokens
  into row_count, value
  from private.anicode_llm_global_account
  where singleton;
  if row_count <> 1 or value <> 100 then raise exception 'global reservation was not recorded'; end if;

  perform public.settle_anicode_llm_request(request_one, 40, 'completed');
  -- Settlement is idempotent; a duplicate cannot change usage or status.
  perform public.settle_anicode_llm_request(request_one, 0, 'failed');
  select status into current_status
  from private.anicode_llm_requests
  where request_id = request_one;
  if current_status <> 'completed' then raise exception 'duplicate settlement changed status'; end if;
  select day_charged_tokens into value
  from private.anicode_llm_global_account
  where singleton;
  if value <> 40 then raise exception 'global charged usage is not idempotent'; end if;

  -- Three active requests are allowed for one user; the fourth is rejected atomically.
  for row_count in 1..3 loop
    perform public.reserve_anicode_llm_request(user_one, gen_random_uuid(), 1);
  end loop;
  begin
    perform public.reserve_anicode_llm_request(user_one, gen_random_uuid(), 1);
  exception when sqlstate 'P0001' then
    blocked := true;
  end;
  if not blocked then raise exception 'per-user active limit was bypassed'; end if;

  update private.anicode_llm_requests
  set created_at = statement_timestamp() - interval '6 minutes'
  where user_id = user_one and status = 'reserved';
  -- A later reservation reclaims stale slots but charges their full reservation.
  perform public.reserve_anicode_llm_request(user_one, gen_random_uuid(), 1);
  select count(*) into row_count
  from private.anicode_llm_requests
  where user_id = user_one and status = 'aborted';
  if row_count <> 3 then raise exception 'stale reservations were not reclaimed'; end if;

  -- Clear the new active request before exercising signup fan-out against the shared-key limit.
  for current_status in
    select request_id::text
    from private.anicode_llm_requests
    where user_id = user_one and status = 'reserved'
  loop
    perform public.settle_anicode_llm_request(current_status::uuid, 0, 'failed');
  end loop;

  for row_count in 1..30 loop
    generated_user := gen_random_uuid();
    insert into auth.users(id) values (generated_user);
    perform public.reserve_anicode_llm_request(generated_user, gen_random_uuid(), 1);
  end loop;
  generated_user := gen_random_uuid();
  insert into auth.users(id) values (generated_user);
  blocked := false;
  begin
    perform public.reserve_anicode_llm_request(generated_user, gen_random_uuid(), 1);
  exception when sqlstate 'P0001' then
    blocked := true;
  end;
  if not blocked then raise exception 'global active limit was bypassed by signup fan-out'; end if;
  select active_requests into row_count
  from private.anicode_llm_global_account
  where singleton;
  if row_count <> 30 then raise exception 'global active counter drifted'; end if;

  -- A signup fan-out that abandons all streams cannot pin the shared key forever. Any later
  -- reservation reclaims every globally stale slot while preserving full conservative charge.
  update private.anicode_llm_requests
  set created_at = statement_timestamp() - interval '6 minutes'
  where status = 'reserved';
  generated_user := gen_random_uuid();
  insert into auth.users(id) values (generated_user);
  perform public.reserve_anicode_llm_request(generated_user, gen_random_uuid(), 1);
  select active_requests into row_count
  from private.anicode_llm_global_account
  where singleton;
  if row_count <> 1 then raise exception 'global stale slots were not reclaimed'; end if;
  select coalesce(sum(active_requests), 0)::integer into row_count
  from private.anicode_llm_accounts
  where user_id <> generated_user;
  if row_count <> 0 then raise exception 'reclaimed user counters drifted'; end if;
end;
$$;

do $$
declare
  user_one constant uuid := '30000000-0000-4000-8000-000000000001';
  user_two constant uuid := '30000000-0000-4000-8000-000000000002';
  user_three constant uuid := '30000000-0000-4000-8000-000000000003';
  user_four constant uuid := '30000000-0000-4000-8000-000000000004';
  request_one constant uuid := '40000000-0000-4000-8000-000000000001';
  request_two constant uuid := '40000000-0000-4000-8000-000000000002';
  request_three constant uuid := '40000000-0000-4000-8000-000000000003';
  request_four constant uuid := '40000000-0000-4000-8000-000000000004';
  request_five constant uuid := '40000000-0000-4000-8000-000000000005';
  request_six constant uuid := '40000000-0000-4000-8000-000000000006';
  request_seven constant uuid := '40000000-0000-4000-8000-000000000007';
  request_eight constant uuid := '40000000-0000-4000-8000-000000000008';
  request_nine constant uuid := '40000000-0000-4000-8000-000000000009';
  device_one text := 'd_' || repeat('a', 43);
  device_two text := 'd_' || repeat('b', 43);
  device_three text := 'd_' || repeat('c', 43);
  device_four text := 'd_' || repeat('d', 43);
  device_five text := 'd_' || repeat('e', 43);
  device_six text := 'd_' || repeat('f', 43);
  blocked boolean;
  current_status text;
  error_detail text;
  value bigint;
  before_user_charge bigint;
  before_global_charge bigint;
  row_count integer;
begin
  if has_table_privilege('authenticated', 'private.anicode_llm_policy', 'select')
     or has_function_privilege(
       'authenticated',
       'public.reserve_anicode_llm_request_v2(uuid,text,uuid,integer,text)',
       'execute'
     )
     or has_function_privilege(
       'anon',
       'public.settle_anicode_llm_request_v2(uuid,integer,text,integer,integer,integer,integer,integer)',
       'execute'
     )
     or has_function_privilege(
       'anon',
       'public.reclaim_anicode_llm_stale_requests_v2()',
       'execute'
     ) then
    raise exception 'device quota objects are exposed to callers';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.reserve_anicode_llm_request_v2(uuid,text,uuid,integer,text)',
    'execute'
  ) or not has_function_privilege(
    'service_role',
    'public.reclaim_anicode_llm_stale_requests_v2()',
    'execute'
  ) then
    raise exception 'service role cannot reserve device quota';
  end if;

  -- Leave the legacy contract test's global/user counters in a neutral state.
  for current_status in
    select request_id::text
    from private.anicode_llm_requests
    where status = 'reserved'
  loop
    perform public.settle_anicode_llm_request(current_status::uuid, 0, 'failed');
  end loop;

  insert into auth.users(id) values (user_one), (user_two), (user_three), (user_four);
  update private.anicode_llm_policy
  set gateway_enabled = false,
      policy_version = policy_version + 1,
      updated_at = statement_timestamp()
  where singleton = true;
  blocked := false;
  begin
    perform public.reserve_anicode_llm_request_v2(
      user_one, device_one, gen_random_uuid(), 1, 'deepseek-v4-flash'
    );
  exception when sqlstate 'P0001' then
    get stacked diagnostics current_status = message_text;
    blocked := current_status = 'gateway_disabled';
  end;
  if not blocked then raise exception 'gateway kill switch was bypassed'; end if;
  update private.anicode_llm_policy
  set gateway_enabled = true,
      policy_version = policy_version + 1,
      quota_timezone = 'Asia/Shanghai',
      device_minute_request_limit = 20,
      device_day_request_limit = 20,
      device_day_token_limit = 100,
      device_active_request_limit = 2,
      updated_at = statement_timestamp()
  where singleton = true;

  perform public.reserve_anicode_llm_request_v2(
    user_one, device_one, request_one, 60, 'deepseek-v4-flash'
  );
  perform public.settle_anicode_llm_request_v2(
    request_one, 80, 'completed', 50, 30, 20, 30, 5
  );
  -- Settlement stays idempotent even if a stale worker later reports another outcome.
  perform public.settle_anicode_llm_request_v2(
    request_one, 0, 'failed', null, null, null, null, null
  );
  select charged_tokens, status
  into value, current_status
  from private.anicode_llm_requests
  where request_id = request_one;
  if value <> 80 or current_status <> 'completed' then
    raise exception 'authoritative overrun settlement was clamped or was not idempotent';
  end if;
  select count(*) into row_count
  from private.anicode_llm_requests
  where request_id = request_one
    and reservation_overrun
    and prompt_tokens = 50
    and completion_tokens = 30
    and prompt_cache_hit_tokens = 20
    and prompt_cache_miss_tokens = 30
    and reasoning_tokens = 5;
  if row_count <> 1 then raise exception 'usage dimensions or overrun audit were not stored'; end if;

  blocked := false;
  begin
    perform public.reserve_anicode_llm_request_v2(
      user_one, device_one, gen_random_uuid(), 21, 'deepseek-v4-flash'
    );
  exception when sqlstate 'P0001' then
    get stacked diagnostics current_status = message_text, error_detail = pg_exception_detail;
    blocked := current_status = 'device_daily_token_limit'
      and error_detail ~ '^retry_after_seconds=[1-9][0-9]*$';
  end;
  if not blocked then raise exception 'device daily token limit or reset metadata was bypassed'; end if;

  -- The installation identity is shared across accounts instead of being bound permanently to
  -- the first login. Its quota is still aggregated globally by device_subject.
  update private.anicode_llm_policy
  set policy_version = policy_version + 1,
      device_day_token_limit = 1000,
      updated_at = statement_timestamp()
  where singleton = true;
  perform public.reserve_anicode_llm_request_v2(
    user_two, device_one, request_two, 10, 'deepseek-v4-flash'
  );
  perform public.reserve_anicode_llm_request_v2(
    user_one, device_one, request_three, 10, 'deepseek-v4-flash'
  );
  blocked := false;
  begin
    perform public.reserve_anicode_llm_request_v2(
      user_two, device_one, gen_random_uuid(), 1, 'deepseek-v4-flash'
    );
  exception when sqlstate 'P0001' then
    get stacked diagnostics current_status = message_text;
    blocked := current_status = 'device_concurrency_limit';
  end;
  if not blocked then raise exception 'cross-account device concurrency limit was bypassed'; end if;
  perform public.settle_anicode_llm_request_v2(
    request_two, 10, 'completed', 6, 4, 2, 4, 0
  );
  perform public.settle_anicode_llm_request_v2(
    request_three, 10, 'completed', 7, 3, 3, 4, 0
  );

  -- A process killed after reservation cannot pin a device slot forever. Cleanup commits in its
  -- own RPC, and a cross-day stale reservation is attributed to its original quota day.
  update private.anicode_llm_policy
  set policy_version = policy_version + 1,
      device_day_token_limit = 7,
      updated_at = statement_timestamp()
  where singleton = true;
  perform public.reserve_anicode_llm_request_v2(
    user_two, device_four, request_five, 7, 'deepseek-v4-flash'
  );
  update private.anicode_llm_requests
  set created_at = statement_timestamp() - interval '1 day 6 minutes',
      quota_day = (statement_timestamp() at time zone 'Asia/Shanghai')::date - 1
  where request_id = request_five;
  if public.reclaim_anicode_llm_stale_requests_v2() <> 1 then
    raise exception 'dedicated stale reaper did not reclaim exactly one request';
  end if;
  perform public.reserve_anicode_llm_request_v2(
    user_two, device_four, request_six, 1, 'deepseek-v4-flash'
  );
  select count(*) into row_count
  from private.anicode_llm_requests
  where request_id = request_five
    and status = 'aborted'
    and charged_tokens = 7
    and settlement_source = 'stale_reaper'
    and stale_reclaimed_at is not null
    and not provider_usage_recorded;
  if row_count <> 1 then raise exception 'stale device reservation was not charged/reclaimed'; end if;

  -- A late final usage report replaces the conservative estimate once, including an overrun.
  perform public.settle_anicode_llm_request_v2(
    request_five, 9, 'completed', 5, 4, 2, 3, 1
  );
  perform public.settle_anicode_llm_request_v2(
    request_five, 0, 'failed', null, null, null, null, null
  );
  select count(*) into row_count
  from private.anicode_llm_requests
  where request_id = request_five
    and status = 'completed'
    and charged_tokens = 9
    and settlement_source = 'provider'
    and provider_usage_recorded
    and reservation_overrun
    and stale_reclaimed_at is not null;
  if row_count <> 1 then raise exception 'late provider usage did not correct stale estimate once'; end if;
  perform public.settle_anicode_llm_request_v2(
    request_six, 1, 'completed', 1, 0, 0, 1, 0
  );

  -- Exercise the narrow rolling race directly: skip the dedicated reaper, let legacy reserve
  -- reclaim a cross-day row, and verify v2 reverses the legacy "charge it today" counter drift.
  select day_charged_tokens into before_user_charge
  from private.anicode_llm_accounts where user_id = user_two;
  select day_charged_tokens into before_global_charge
  from private.anicode_llm_global_account where singleton = true;
  perform public.reserve_anicode_llm_request_v2(
    user_two, device_six, request_seven, 7, 'deepseek-v4-flash'
  );
  update private.anicode_llm_requests
  set created_at = statement_timestamp() - interval '1 day 6 minutes',
      quota_day = (statement_timestamp() at time zone 'Asia/Shanghai')::date - 1
  where request_id = request_seven;
  perform public.reserve_anicode_llm_request_v2(
    user_two, device_six, request_eight, 1, 'deepseek-v4-flash'
  );
  select count(*) into row_count
  from private.anicode_llm_requests
  where request_id = request_seven
    and status = 'aborted'
    and settlement_source = 'stale_reaper'
    and accounting_day < current_date;
  if row_count <> 1 then raise exception 'legacy-race stale row was not lifecycle-marked'; end if;
  select day_charged_tokens into value
  from private.anicode_llm_accounts where user_id = user_two;
  if value <> before_user_charge then raise exception 'legacy race drifted user daily charge'; end if;
  select day_charged_tokens into value
  from private.anicode_llm_global_account where singleton = true;
  if value <> before_global_charge then raise exception 'legacy race drifted global daily charge'; end if;
  perform public.settle_anicode_llm_request_v2(
    request_eight, 0, 'failed', null, null, null, null, null
  );
  select day_charged_tokens into before_user_charge
  from private.anicode_llm_accounts where user_id = user_two;
  select day_charged_tokens into before_global_charge
  from private.anicode_llm_global_account where singleton = true;
  perform public.reserve_anicode_llm_request_v2(
    user_two, device_six, request_nine, 1, 'deepseek-v4-flash'
  );
  perform public.settle_anicode_llm_request_v2(
    request_nine, 1, 'completed', 1, 0, 0, 1, 0
  );
  select day_charged_tokens into value
  from private.anicode_llm_accounts where user_id = user_two;
  if value <> before_user_charge + 1 then
    raise exception 'a later reserve re-applied the user stale-race correction';
  end if;
  select day_charged_tokens into value
  from private.anicode_llm_global_account where singleton = true;
  if value <> before_global_charge + 1 then
    raise exception 'a later reserve re-applied the global stale-race correction';
  end if;

  -- Minute and daily request failures have distinct stable codes for client retry policy.
  update private.anicode_llm_policy
  set policy_version = policy_version + 1,
      device_minute_request_limit = 1,
      device_day_request_limit = 20,
      device_active_request_limit = 10,
      updated_at = statement_timestamp()
  where singleton = true;
  perform public.reserve_anicode_llm_request_v2(
    user_three, device_two, request_four, 1, 'deepseek-v4-flash'
  );
  blocked := false;
  begin
    perform public.reserve_anicode_llm_request_v2(
      user_three, device_two, gen_random_uuid(), 1, 'deepseek-v4-flash'
    );
  exception when sqlstate 'P0001' then
    get stacked diagnostics current_status = message_text;
    blocked := current_status = 'device_minute_rate_limit';
  end;
  if not blocked then raise exception 'device minute request limit was bypassed'; end if;
  perform public.settle_anicode_llm_request_v2(
    request_four, 1, 'completed', 1, 0, 0, 1, 0
  );

  update private.anicode_llm_policy
  set policy_version = policy_version + 1,
      device_minute_request_limit = 10,
      device_day_request_limit = 1,
      updated_at = statement_timestamp()
  where singleton = true;
  perform public.reserve_anicode_llm_request_v2(
    user_three, device_three, gen_random_uuid(), 1, 'deepseek-v4-flash'
  );
  -- Settle the single request without depending on its generated UUID; old settle is sufficient
  -- for this request-count-only assertion and remains part of the rolling-deploy contract.
  for current_status in
    select request_id::text
    from private.anicode_llm_requests
    where user_id = user_three and device_subject = device_three and status = 'reserved'
  loop
    perform public.settle_anicode_llm_request_v2(
      current_status::uuid, 1, 'completed', 1, 0, 0, 1, 0
    );
  end loop;
  blocked := false;
  begin
    perform public.reserve_anicode_llm_request_v2(
      user_three, device_three, gen_random_uuid(), 1, 'deepseek-v4-flash'
    );
  exception when sqlstate 'P0001' then
    get stacked diagnostics current_status = message_text;
    blocked := current_status = 'device_daily_request_limit';
  end;
  if not blocked then raise exception 'device daily request limit was bypassed'; end if;

  -- Legacy user/global policy failures are reclassified precisely so only short-lived limits retry.
  update private.anicode_llm_policy
  set policy_version = policy_version + 1,
      device_minute_request_limit = 20,
      device_day_request_limit = 20,
      device_day_token_limit = 1000,
      device_active_request_limit = 10,
      updated_at = statement_timestamp()
  where singleton = true;
  for row_count in 1..3 loop
    perform public.reserve_anicode_llm_request_v2(
      user_four, device_five, gen_random_uuid(), 1, 'deepseek-v4-flash'
    );
  end loop;
  blocked := false;
  begin
    perform public.reserve_anicode_llm_request_v2(
      user_four, device_five, gen_random_uuid(), 1, 'deepseek-v4-flash'
    );
  exception when sqlstate 'P0001' then
    get stacked diagnostics current_status = message_text;
    blocked := current_status = 'user_concurrency_limit';
  end;
  if not blocked then raise exception 'user concurrency was not given a transient stable code'; end if;
  for current_status in
    select request_id::text
    from private.anicode_llm_requests
    where user_id = user_four and status = 'reserved'
  loop
    perform public.settle_anicode_llm_request_v2(
      current_status::uuid, 0, 'failed', null, null, null, null, null
    );
  end loop;
end;
$$;

rollback;
