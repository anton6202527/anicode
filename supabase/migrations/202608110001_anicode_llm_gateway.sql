create schema if not exists private;

create table if not exists private.anicode_llm_global_account (
  singleton boolean primary key default true check (singleton),
  minute_started_at timestamptz not null default date_trunc('minute', now()),
  minute_requests integer not null default 0 check (minute_requests >= 0),
  day_started_at date not null default current_date,
  day_requests integer not null default 0 check (day_requests >= 0),
  day_charged_tokens bigint not null default 0 check (day_charged_tokens >= 0),
  day_reserved_tokens bigint not null default 0 check (day_reserved_tokens >= 0),
  active_requests integer not null default 0 check (active_requests >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists private.anicode_llm_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  minute_started_at timestamptz not null default date_trunc('minute', now()),
  minute_requests integer not null default 0 check (minute_requests >= 0),
  day_started_at date not null default current_date,
  day_requests integer not null default 0 check (day_requests >= 0),
  day_charged_tokens bigint not null default 0 check (day_charged_tokens >= 0),
  day_reserved_tokens bigint not null default 0 check (day_reserved_tokens >= 0),
  active_requests integer not null default 0 check (active_requests >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists private.anicode_llm_requests (
  request_id uuid primary key,
  user_id uuid not null references private.anicode_llm_accounts(user_id) on delete cascade,
  reserved_tokens integer not null check (reserved_tokens > 0 and reserved_tokens <= 1000000),
  charged_tokens integer check (
    charged_tokens is null or (charged_tokens >= 0 and charged_tokens <= reserved_tokens)
  ),
  status text not null default 'reserved' check (
    status in ('reserved', 'completed', 'failed', 'aborted')
  ),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  check (
    (status = 'reserved' and charged_tokens is null and settled_at is null)
    or (status <> 'reserved' and charged_tokens is not null and settled_at is not null)
  )
);

create index if not exists anicode_llm_requests_user_created_idx
  on private.anicode_llm_requests(user_id, created_at desc);

create index if not exists anicode_llm_requests_active_idx
  on private.anicode_llm_requests(user_id, created_at)
  include (reserved_tokens)
  where status = 'reserved';

create index if not exists anicode_llm_requests_global_active_idx
  on private.anicode_llm_requests(created_at)
  include (user_id, reserved_tokens)
  where status = 'reserved';

-- A project that applied an earlier per-user-only draft must not open a global-budget window when
-- this singleton is introduced. Bootstrap it conservatively from all existing request rows.
insert into private.anicode_llm_global_account(
  singleton,
  minute_started_at,
  minute_requests,
  day_started_at,
  day_requests,
  day_charged_tokens,
  day_reserved_tokens,
  active_requests,
  updated_at
)
select true,
       date_trunc('minute', statement_timestamp()),
       count(*) filter (
         where created_at >= date_trunc('minute', statement_timestamp())
       )::integer,
       current_date,
       count(*) filter (where created_at::date = current_date)::integer,
       coalesce(sum(charged_tokens) filter (
         where status <> 'reserved' and settled_at::date = current_date
       ), 0),
       coalesce(sum(reserved_tokens) filter (where status = 'reserved'), 0),
       count(*) filter (where status = 'reserved')::integer,
       statement_timestamp()
from private.anicode_llm_requests
on conflict (singleton) do nothing;

-- `private` is shared with the rest of the Supabase project. Do not revoke schema-level
-- privileges here: existing RLS helper functions (for example anime-armory policies) may rely on
-- authenticated having USAGE. Restrict only the objects introduced by this migration.
revoke all on table private.anicode_llm_global_account from public, anon, authenticated;
revoke all on table private.anicode_llm_accounts from public, anon, authenticated;
revoke all on table private.anicode_llm_requests from public, anon, authenticated;

create or replace function public.reserve_anicode_llm_request(
  p_user_id uuid,
  p_request_id uuid,
  p_reserved_tokens integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  global_account private.anicode_llm_global_account%rowtype;
  account private.anicode_llm_accounts%rowtype;
  stale_count integer := 0;
  stale_tokens bigint := 0;
  outstanding_tokens bigint := 0;
  minute_window timestamptz := date_trunc('minute', statement_timestamp());
  today date := current_date;
  user_minute_limit constant integer := 12;
  user_day_request_limit constant integer := 200;
  user_day_token_limit constant bigint := 1000000;
  user_active_limit constant integer := 3;
  global_minute_limit constant integer := 120;
  global_day_request_limit constant integer := 2000;
  global_day_token_limit constant bigint := 10000000;
  global_active_limit constant integer := 30;
begin
  if p_user_id is null
     or p_request_id is null
     or p_reserved_tokens is null
     or p_reserved_tokens < 1
     or p_reserved_tokens > 1000000 then
    raise exception using errcode = '22023', message = 'invalid quota reservation';
  end if;

  -- Every quota mutation takes locks in this order: global -> users (UUID order) -> requests.
  -- Besides making the shared-key budget atomic, the single global row prevents signup fan-out
  -- from racing the cap.
  select * into global_account
  from private.anicode_llm_global_account
  where singleton = true
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'global quota account is missing';
  end if;

  insert into private.anicode_llm_accounts(user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  -- Lock the caller and every account with a stale reservation before touching request rows. The
  -- global lock means there can be at most 30 such accounts, and UUID ordering stays deterministic.
  perform 1
  from private.anicode_llm_accounts as candidate
  where candidate.user_id = p_user_id
     or exists (
       select 1
       from private.anicode_llm_requests as pending
       where pending.user_id = candidate.user_id
         and pending.status = 'reserved'
         and pending.created_at < statement_timestamp() - interval '5 minutes'
     )
  order by candidate.user_id
  for update;

  select * into account
  from private.anicode_llm_accounts
  where user_id = p_user_id;

  if global_account.minute_started_at <> minute_window then
    global_account.minute_started_at := minute_window;
    global_account.minute_requests := 0;
  end if;

  -- Outstanding requests that cross midnight remain reserved against the new day until settlement.
  -- This deliberately over-counts rather than opening a reset-time overspend window.
  if global_account.day_started_at <> today then
    select coalesce(sum(reserved_tokens), 0)
    into outstanding_tokens
    from private.anicode_llm_requests
    where status = 'reserved';
    global_account.day_started_at := today;
    global_account.day_requests := 0;
    global_account.day_charged_tokens := 0;
    global_account.day_reserved_tokens := outstanding_tokens;
  end if;
  with reclaimed as (
    update private.anicode_llm_requests
    set charged_tokens = reserved_tokens, status = 'aborted', settled_at = statement_timestamp()
    where status = 'reserved'
      and created_at < statement_timestamp() - interval '5 minutes'
    returning user_id, reserved_tokens
  ), reclaimed_by_user as (
    select user_id,
           count(*)::integer as stale_count,
           sum(reserved_tokens)::bigint as stale_tokens
    from reclaimed
    group by user_id
  ), updated_accounts as (
    update private.anicode_llm_accounts as target
    set active_requests = greatest(0, target.active_requests - reclaimed_by_user.stale_count),
        day_reserved_tokens = case
          when target.day_started_at = today then greatest(
            0,
            target.day_reserved_tokens - reclaimed_by_user.stale_tokens
          )
          else target.day_reserved_tokens
        end,
        day_charged_tokens = case
          when target.day_started_at = today
            then target.day_charged_tokens + reclaimed_by_user.stale_tokens
          else target.day_charged_tokens
        end,
        updated_at = statement_timestamp()
    from reclaimed_by_user
    where target.user_id = reclaimed_by_user.user_id
    returning reclaimed_by_user.stale_count, reclaimed_by_user.stale_tokens
  )
  select coalesce(sum(updated_accounts.stale_count), 0)::integer,
         coalesce(sum(updated_accounts.stale_tokens), 0)
  into stale_count, stale_tokens
  from updated_accounts;

  global_account.active_requests := greatest(0, global_account.active_requests - stale_count);
  global_account.day_reserved_tokens := greatest(
    0,
    global_account.day_reserved_tokens - stale_tokens
  );
  global_account.day_charged_tokens := global_account.day_charged_tokens + stale_tokens;

  -- Re-read the already-locked caller after global stale reclamation updated account counters.
  select * into account
  from private.anicode_llm_accounts
  where user_id = p_user_id;

  if account.minute_started_at <> minute_window then
    account.minute_started_at := minute_window;
    account.minute_requests := 0;
  end if;
  if account.day_started_at <> today then
    select coalesce(sum(reserved_tokens), 0)
    into outstanding_tokens
    from private.anicode_llm_requests
    where user_id = p_user_id and status = 'reserved';
    account.day_started_at := today;
    account.day_requests := 0;
    account.day_charged_tokens := 0;
    account.day_reserved_tokens := outstanding_tokens;
  end if;

  if account.minute_requests >= user_minute_limit
     or account.day_requests >= user_day_request_limit
     or account.active_requests >= user_active_limit
     or account.day_charged_tokens + account.day_reserved_tokens + p_reserved_tokens
       > user_day_token_limit then
    raise exception using errcode = 'P0001', message = 'anicode gateway user quota exceeded';
  end if;

  if global_account.minute_requests >= global_minute_limit
     or global_account.day_requests >= global_day_request_limit
     or global_account.active_requests >= global_active_limit
     or global_account.day_charged_tokens + global_account.day_reserved_tokens + p_reserved_tokens
       > global_day_token_limit then
    raise exception using errcode = 'P0001', message = 'anicode gateway global quota exceeded';
  end if;

  insert into private.anicode_llm_requests(request_id, user_id, reserved_tokens)
  values (p_request_id, p_user_id, p_reserved_tokens);

  update private.anicode_llm_accounts
  set minute_started_at = account.minute_started_at,
      minute_requests = account.minute_requests + 1,
      day_started_at = account.day_started_at,
      day_requests = account.day_requests + 1,
      day_charged_tokens = account.day_charged_tokens,
      day_reserved_tokens = account.day_reserved_tokens + p_reserved_tokens,
      active_requests = account.active_requests + 1,
      updated_at = statement_timestamp()
  where user_id = p_user_id;

  update private.anicode_llm_global_account
  set minute_started_at = global_account.minute_started_at,
      minute_requests = global_account.minute_requests + 1,
      day_started_at = global_account.day_started_at,
      day_requests = global_account.day_requests + 1,
      day_charged_tokens = global_account.day_charged_tokens,
      day_reserved_tokens = global_account.day_reserved_tokens + p_reserved_tokens,
      active_requests = global_account.active_requests + 1,
      updated_at = statement_timestamp()
  where singleton = true;
end;
$$;

create or replace function public.settle_anicode_llm_request(
  p_request_id uuid,
  p_charged_tokens integer,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  item private.anicode_llm_requests%rowtype;
  account private.anicode_llm_accounts%rowtype;
  global_account private.anicode_llm_global_account%rowtype;
  item_user_id uuid;
  outstanding_tokens bigint := 0;
  charged integer;
  today date := current_date;
begin
  if p_request_id is null
     or p_charged_tokens is null
     or p_charged_tokens < 0
     or p_status is null
     or p_status not in ('completed', 'failed', 'aborted') then
    raise exception using errcode = '22023', message = 'invalid quota settlement';
  end if;

  -- Discover the immutable owner without taking a lock, then acquire the same ordered lock chain
  -- as reserve. The request is re-read under lock before any mutation, preserving idempotence.
  select user_id into item_user_id
  from private.anicode_llm_requests
  where request_id = p_request_id;
  if not found then
    return;
  end if;

  select * into global_account
  from private.anicode_llm_global_account
  where singleton = true
  for update;
  if not found then
    return;
  end if;

  select * into account
  from private.anicode_llm_accounts
  where user_id = item_user_id
  for update;
  if not found then
    return;
  end if;

  if global_account.day_started_at <> today then
    select coalesce(sum(reserved_tokens), 0)
    into outstanding_tokens
    from private.anicode_llm_requests
    where status = 'reserved';
    global_account.day_started_at := today;
    global_account.day_requests := 0;
    global_account.day_charged_tokens := 0;
    global_account.day_reserved_tokens := outstanding_tokens;
  end if;
  if account.day_started_at <> today then
    select coalesce(sum(reserved_tokens), 0)
    into outstanding_tokens
    from private.anicode_llm_requests
    where user_id = item_user_id and status = 'reserved';
    account.day_started_at := today;
    account.day_requests := 0;
    account.day_charged_tokens := 0;
    account.day_reserved_tokens := outstanding_tokens;
  end if;

  select * into item
  from private.anicode_llm_requests
  where request_id = p_request_id
  for update;

  if not found or item.status <> 'reserved' then
    return;
  end if;

  charged := least(p_charged_tokens, item.reserved_tokens);
  update private.anicode_llm_requests
  set charged_tokens = charged, status = p_status, settled_at = statement_timestamp()
  where request_id = p_request_id;

  update private.anicode_llm_accounts
  set day_started_at = account.day_started_at,
      day_requests = account.day_requests,
      day_reserved_tokens = greatest(0, account.day_reserved_tokens - item.reserved_tokens),
      day_charged_tokens = account.day_charged_tokens + charged,
      active_requests = greatest(0, account.active_requests - 1),
      updated_at = statement_timestamp()
  where user_id = item.user_id;

  update private.anicode_llm_global_account
  set day_started_at = global_account.day_started_at,
      day_requests = global_account.day_requests,
      day_reserved_tokens = greatest(
        0,
        global_account.day_reserved_tokens - item.reserved_tokens
      ),
      day_charged_tokens = global_account.day_charged_tokens + charged,
      active_requests = greatest(0, global_account.active_requests - 1),
      updated_at = statement_timestamp()
  where singleton = true;
end;
$$;

revoke all on function public.reserve_anicode_llm_request(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.settle_anicode_llm_request(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.reserve_anicode_llm_request(uuid, uuid, integer) to service_role;
grant execute on function public.settle_anicode_llm_request(uuid, integer, text) to service_role;
