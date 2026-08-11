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

rollback;
