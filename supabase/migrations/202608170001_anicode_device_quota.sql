create table if not exists private.anicode_llm_policy (
  singleton boolean primary key default true check (singleton),
  gateway_enabled boolean not null default true,
  policy_version integer not null default 1 check (policy_version > 0),
  quota_timezone text not null default 'Asia/Shanghai' check (
    length(quota_timezone) between 1 and 128
  ),
  device_minute_request_limit integer not null default 8 check (
    device_minute_request_limit > 0
  ),
  device_day_request_limit integer not null default 100 check (
    device_day_request_limit > 0
  ),
  device_day_token_limit bigint not null default 200000 check (
    device_day_token_limit > 0
  ),
  device_active_request_limit integer not null default 2 check (
    device_active_request_limit > 0
  ),
  updated_at timestamptz not null default now()
);

alter table private.anicode_llm_policy
  add column if not exists gateway_enabled boolean not null default true;

insert into private.anicode_llm_policy(singleton)
values (true)
on conflict (singleton) do nothing;

revoke all on table private.anicode_llm_policy from public, anon, authenticated;

-- Keep one request ledger so rolling deployments, stale-reservation reclamation and accounting
-- cannot diverge between a legacy and a device-aware table.
alter table private.anicode_llm_requests
  add column if not exists device_subject text,
  add column if not exists model text,
  add column if not exists policy_version integer,
  add column if not exists prompt_tokens integer,
  add column if not exists completion_tokens integer,
  add column if not exists prompt_cache_hit_tokens integer,
  add column if not exists prompt_cache_miss_tokens integer,
  add column if not exists reasoning_tokens integer,
  add column if not exists reservation_overrun boolean not null default false,
  add column if not exists quota_day date,
  add column if not exists settlement_source text,
  add column if not exists accounting_day date,
  add column if not exists stale_reclaimed_at timestamptz,
  add column if not exists provider_usage_recorded boolean not null default false;

-- The provider's final usage is authoritative and may legitimately exceed an estimate. Remove
-- every earlier constraint which silently forced charged_tokens <= reserved_tokens, then replace
-- it with a non-negative invariant. This is written generically so draft constraint names do not
-- make the migration brittle.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_catalog.pg_constraint
    where conrelid = 'private.anicode_llm_requests'::regclass
      and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) like '%charged_tokens <= reserved_tokens%'
  loop
    execute format(
      'alter table private.anicode_llm_requests drop constraint %I',
      constraint_name
    );
  end loop;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'private.anicode_llm_requests'::regclass
      and conname = 'anicode_llm_requests_charged_nonnegative'
  ) then
    alter table private.anicode_llm_requests
      add constraint anicode_llm_requests_charged_nonnegative check (
        charged_tokens is null or charged_tokens >= 0
      );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'private.anicode_llm_requests'::regclass
      and conname = 'anicode_llm_requests_device_subject_format'
  ) then
    alter table private.anicode_llm_requests
      add constraint anicode_llm_requests_device_subject_format check (
        device_subject is null or device_subject ~ '^d_[A-Za-z0-9_-]{43}$'
      );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'private.anicode_llm_requests'::regclass
      and conname = 'anicode_llm_requests_model_format'
  ) then
    alter table private.anicode_llm_requests
      add constraint anicode_llm_requests_model_format check (
        model is null or model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'private.anicode_llm_requests'::regclass
      and conname = 'anicode_llm_requests_policy_version_positive'
  ) then
    alter table private.anicode_llm_requests
      add constraint anicode_llm_requests_policy_version_positive check (
        policy_version is null or policy_version > 0
      );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'private.anicode_llm_requests'::regclass
      and conname = 'anicode_llm_requests_usage_consistent'
  ) then
    alter table private.anicode_llm_requests
      add constraint anicode_llm_requests_usage_consistent check (
        (
          prompt_tokens is null
          and completion_tokens is null
          and prompt_cache_hit_tokens is null
          and prompt_cache_miss_tokens is null
          and reasoning_tokens is null
        )
        or (
          prompt_tokens >= 0
          and completion_tokens >= 0
          and prompt_cache_hit_tokens >= 0
          and prompt_cache_miss_tokens >= 0
          and reasoning_tokens >= 0
          and prompt_cache_hit_tokens + prompt_cache_miss_tokens <= prompt_tokens
          and reasoning_tokens <= completion_tokens
          and prompt_tokens + completion_tokens <= charged_tokens
        )
      );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'private.anicode_llm_requests'::regclass
      and conname = 'anicode_llm_requests_settlement_lifecycle'
  ) then
    alter table private.anicode_llm_requests
      add constraint anicode_llm_requests_settlement_lifecycle check (
        settlement_source is null
        or settlement_source in ('provider', 'stale_reaper')
      ),
      add constraint anicode_llm_requests_provider_usage_lifecycle check (
        not provider_usage_recorded or settlement_source = 'provider'
      ),
      add constraint anicode_llm_requests_stale_lifecycle check (
        stale_reclaimed_at is null or status <> 'reserved'
      );
  end if;
end;
$$;

create index if not exists anicode_llm_requests_device_created_idx
  on private.anicode_llm_requests(device_subject, created_at desc)
  include (status, reserved_tokens, charged_tokens, settled_at)
  where device_subject is not null;

create index if not exists anicode_llm_requests_device_quota_day_idx
  on private.anicode_llm_requests(device_subject, quota_day)
  include (status, reserved_tokens, charged_tokens)
  where device_subject is not null;

create index if not exists anicode_llm_requests_device_active_idx
  on private.anicode_llm_requests(device_subject, created_at)
  include (reserved_tokens)
  where device_subject is not null and status = 'reserved';

create index if not exists anicode_llm_requests_device_settled_idx
  on private.anicode_llm_requests(device_subject, settled_at)
  include (charged_tokens)
  where device_subject is not null and status <> 'reserved';

-- Reclamation is deliberately its own RPC/transaction. If it ran inside reserve and the new
-- request were rejected by a daily limit, PostgreSQL would roll the cleanup back as well and a
-- crashed worker could pin quota indefinitely. The Edge function commits this RPC before reserve.
create or replace function public.reclaim_anicode_llm_stale_requests_v2()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  global_account private.anicode_llm_global_account%rowtype;
  stale_count integer := 0;
  stale_tokens bigint := 0;
  stale_tokens_today bigint := 0;
  outstanding_tokens bigint := 0;
  recomputed_day_requests integer := 0;
  recomputed_day_charged_tokens bigint := 0;
  today date := current_date;
  stale_cutoff timestamptz := statement_timestamp() - interval '5 minutes';
begin
  -- The common path is intentionally read-only: do not serialize and rewrite the global singleton
  -- twice for every healthy request when there is nothing to reclaim.
  if not exists (
    select 1
    from private.anicode_llm_requests
    where status = 'reserved' and created_at < stale_cutoff
  ) then
    return 0;
  end if;

  select * into global_account
  from private.anicode_llm_global_account
  where singleton = true
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'global quota account is missing';
  end if;

  -- Match the legacy lock order: global -> affected users in UUID order -> request rows.
  perform 1
  from private.anicode_llm_accounts as candidate
  where exists (
    select 1
    from private.anicode_llm_requests as pending
    where pending.user_id = candidate.user_id
      and pending.status = 'reserved'
      and pending.created_at < stale_cutoff
  )
  order by candidate.user_id
  for update;

  with reclaimed as (
    update private.anicode_llm_requests
    set charged_tokens = reserved_tokens,
        status = 'aborted',
        settled_at = statement_timestamp(),
        settlement_source = 'stale_reaper',
        accounting_day = created_at::date,
        stale_reclaimed_at = statement_timestamp(),
        provider_usage_recorded = false,
        reservation_overrun = false
    where status = 'reserved'
      and created_at < stale_cutoff
    returning user_id, reserved_tokens, created_at
  ), reclaimed_by_user as (
    select user_id,
           count(*)::integer as stale_count,
           sum(reserved_tokens)::bigint as stale_tokens,
           coalesce(
             sum(reserved_tokens) filter (where created_at::date = today),
             0
           )::bigint as stale_tokens_today
    from reclaimed
    group by user_id
  ), updated_accounts as (
    update private.anicode_llm_accounts as target
    set day_started_at = today,
        day_requests = case
          when target.day_started_at = today then target.day_requests
          else (
            select count(*)::integer
            from private.anicode_llm_requests as daily
            where daily.user_id = target.user_id and daily.created_at::date = today
          )
        end,
        day_reserved_tokens = case
          when target.day_started_at = today then greatest(
            0,
            target.day_reserved_tokens - reclaimed_by_user.stale_tokens
          )
          else (
            select coalesce(sum(active.reserved_tokens), 0)
            from private.anicode_llm_requests as active
            where active.user_id = target.user_id and active.status = 'reserved'
          )
        end,
        day_charged_tokens = case
          when target.day_started_at = today then
            target.day_charged_tokens + reclaimed_by_user.stale_tokens_today
          else (
            select coalesce(sum(settled.charged_tokens), 0)
            from private.anicode_llm_requests as settled
            where settled.user_id = target.user_id
              and settled.status <> 'reserved'
              and settled.accounting_day = today
          )
        end,
        active_requests = greatest(
          0,
          target.active_requests - reclaimed_by_user.stale_count
        ),
        updated_at = statement_timestamp()
    from reclaimed_by_user
    where target.user_id = reclaimed_by_user.user_id
    returning reclaimed_by_user.stale_count,
              reclaimed_by_user.stale_tokens,
              reclaimed_by_user.stale_tokens_today
  )
  select coalesce(sum(updated_accounts.stale_count), 0)::integer,
         coalesce(sum(updated_accounts.stale_tokens), 0),
         coalesce(sum(updated_accounts.stale_tokens_today), 0)
  into stale_count, stale_tokens, stale_tokens_today
  from updated_accounts;

  -- Another reaper may have won while this transaction waited for the global lock.
  if stale_count = 0 then
    return 0;
  end if;

  if global_account.day_started_at <> today then
    select coalesce(sum(reserved_tokens), 0)
    into outstanding_tokens
    from private.anicode_llm_requests
    where status = 'reserved';
    select count(*)::integer
    into recomputed_day_requests
    from private.anicode_llm_requests
    where created_at::date = today;
    select coalesce(sum(charged_tokens), 0)
    into recomputed_day_charged_tokens
    from private.anicode_llm_requests
    where status <> 'reserved' and accounting_day = today;
    global_account.day_started_at := today;
    global_account.day_requests := recomputed_day_requests;
    global_account.day_charged_tokens := recomputed_day_charged_tokens;
    global_account.day_reserved_tokens := outstanding_tokens;
  else
    global_account.day_reserved_tokens := greatest(
      0,
      global_account.day_reserved_tokens - stale_tokens
    );
    -- A stale request is charged to its reservation day. Cross-midnight reservations fence the
    -- new day only while outstanding; reclaiming one must not consume every future daily window.
    global_account.day_charged_tokens :=
      global_account.day_charged_tokens + stale_tokens_today;
  end if;
  global_account.active_requests := greatest(
    0,
    global_account.active_requests - stale_count
  );

  update private.anicode_llm_global_account
  set day_started_at = global_account.day_started_at,
      day_requests = global_account.day_requests,
      day_charged_tokens = global_account.day_charged_tokens,
      day_reserved_tokens = global_account.day_reserved_tokens,
      active_requests = global_account.active_requests,
      updated_at = statement_timestamp()
  where singleton = true;

  return stale_count;
end;
$$;

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
  request_time timestamptz := statement_timestamp();
  minute_window timestamptz := date_trunc('minute', statement_timestamp());
  local_today date;
  day_ends_at timestamptz;
  retry_after integer;
  minute_requests integer := 0;
  day_requests integer := 0;
  active_requests integer := 0;
  active_reserved_tokens bigint := 0;
  settled_today_tokens bigint := 0;
  day_tokens bigint := 0;
  legacy_message text;
  legacy_minute_requests integer := 0;
  legacy_day_requests integer := 0;
  legacy_active_requests integer := 0;
  legacy_day_tokens bigint := 0;
  legacy_retry_after integer := 0;
  legacy_crossday_stale_tokens bigint := 0;
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

  select * into quota_policy
  from private.anicode_llm_policy
  where singleton = true;
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

  local_today := (request_time at time zone quota_policy.quota_timezone)::date;
  day_ends_at := ((local_today + 1)::timestamp at time zone quota_policy.quota_timezone);

  -- Serialize the same opaque installation before taking the legacy global -> user -> request
  -- lock chain. Different devices may wait on the global budget but never acquire these locks in
  -- the opposite order, so settlement cannot form a cycle with this advisory lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_device_subject, 0)
  );

  -- Reuse the deployed user/global implementation inside this transaction. A later device-policy
  -- exception rolls back its reservation and all counters atomically.
  begin
    perform public.reserve_anicode_llm_request(
      p_user_id,
      p_request_id,
      p_reserved_tokens
    );
  exception when sqlstate 'P0001' then
    get stacked diagnostics legacy_message = message_text;
    -- The deployed v1 RPC folded minute, concurrency and daily limits into two generic messages.
    -- Reconstruct the exact reason under the same global -> user lock order so clients do not
    -- retry daily exhaustion or permanently suppress a short-lived capacity limit.
    perform 1
    from private.anicode_llm_global_account
    where singleton = true
    for update;
    if legacy_message = 'anicode gateway user quota exceeded' then
      perform 1
      from private.anicode_llm_accounts
      where user_id = p_user_id
      for update;
      select count(*) filter (where created_at >= minute_window)::integer,
             count(*) filter (where created_at::date = current_date)::integer,
             count(*) filter (
               where status = 'reserved'
                 and created_at >= request_time - interval '5 minutes'
             )::integer,
             coalesce(sum(
               case
                 when status = 'reserved' then reserved_tokens
                 when coalesce(accounting_day, settled_at::date) = current_date
                   then charged_tokens
                 else 0
               end
             ), 0)::bigint
      into legacy_minute_requests,
           legacy_day_requests,
           legacy_active_requests,
           legacy_day_tokens
      from private.anicode_llm_requests
      where user_id = p_user_id;
      if legacy_minute_requests >= 12 then
        legacy_retry_after := greatest(
          1,
          ceil(extract(epoch from (minute_window + interval '1 minute' - request_time)))::integer
        );
        raise exception using
          errcode = 'P0001',
          message = 'user_minute_rate_limit',
          detail = 'retry_after_seconds=' || legacy_retry_after;
      elsif legacy_day_requests >= 200 then
        legacy_retry_after := greatest(
          1,
          ceil(extract(epoch from (date_trunc('day', request_time) + interval '1 day' - request_time)))::integer
        );
        raise exception using
          errcode = 'P0001',
          message = 'user_daily_request_limit',
          detail = 'retry_after_seconds=' || legacy_retry_after;
      elsif legacy_active_requests >= 3 then
        raise exception using
          errcode = 'P0001',
          message = 'user_concurrency_limit',
          detail = 'retry_after_seconds=1';
      elsif legacy_day_tokens + p_reserved_tokens > 1000000 then
        legacy_retry_after := greatest(
          1,
          ceil(extract(epoch from (date_trunc('day', request_time) + interval '1 day' - request_time)))::integer
        );
        raise exception using
          errcode = 'P0001',
          message = 'user_daily_token_limit',
          detail = 'retry_after_seconds=' || legacy_retry_after;
      end if;
    elsif legacy_message = 'anicode gateway global quota exceeded' then
      select count(*) filter (where created_at >= minute_window)::integer,
             count(*) filter (where created_at::date = current_date)::integer,
             count(*) filter (
               where status = 'reserved'
                 and created_at >= request_time - interval '5 minutes'
             )::integer,
             coalesce(sum(
               case
                 when status = 'reserved' then reserved_tokens
                 when coalesce(accounting_day, settled_at::date) = current_date
                   then charged_tokens
                 else 0
               end
             ), 0)::bigint
      into legacy_minute_requests,
           legacy_day_requests,
           legacy_active_requests,
           legacy_day_tokens
      from private.anicode_llm_requests;
      if legacy_minute_requests >= 120 then
        legacy_retry_after := greatest(
          1,
          ceil(extract(epoch from (minute_window + interval '1 minute' - request_time)))::integer
        );
        raise exception using
          errcode = 'P0001',
          message = 'global_minute_rate_limit',
          detail = 'retry_after_seconds=' || legacy_retry_after;
      elsif legacy_day_requests >= 2000 then
        legacy_retry_after := greatest(
          1,
          ceil(extract(epoch from (date_trunc('day', request_time) + interval '1 day' - request_time)))::integer
        );
        raise exception using
          errcode = 'P0001',
          message = 'global_daily_request_limit',
          detail = 'retry_after_seconds=' || legacy_retry_after;
      elsif legacy_active_requests >= 30 then
        raise exception using
          errcode = 'P0001',
          message = 'global_concurrency_limit',
          detail = 'retry_after_seconds=1';
      elsif legacy_day_tokens + p_reserved_tokens > 10000000 then
        legacy_retry_after := greatest(
          1,
          ceil(extract(epoch from (date_trunc('day', request_time) + interval '1 day' - request_time)))::integer
        );
        raise exception using
          errcode = 'P0001',
          message = 'global_daily_token_limit',
          detail = 'retry_after_seconds=' || legacy_retry_after;
      end if;
    end if;
    raise;
  end;

  update private.anicode_llm_requests
  set device_subject = p_device_subject,
      model = p_model,
      policy_version = quota_policy.policy_version,
      quota_day = local_today
  where request_id = p_request_id;

  -- Normally the separately committed reaper has already handled stale work. This marks the
  -- narrow rolling-deploy race where the legacy reserve function reclaimed a row itself, so a
  -- late provider usage report can still correct the estimate exactly once.
  -- If a row crossed the five-minute boundary in the tiny gap after the separately committed
  -- reaper, legacy reserve may have attributed a cross-day stale charge to today's compact
  -- counters. Correct only rows changed by this UPDATE; timestamps are not batch identifiers.
  with marked as (
    update private.anicode_llm_requests
    set settlement_source = 'stale_reaper',
        accounting_day = created_at::date,
        stale_reclaimed_at = settled_at,
        provider_usage_recorded = false
    where status = 'aborted'
      and settlement_source is null
      and charged_tokens = reserved_tokens
      and settled_at = request_time
      and created_at < request_time - interval '5 minutes'
    returning user_id, reserved_tokens, accounting_day
  ), correction as (
    select user_id, sum(reserved_tokens)::bigint as crossday_tokens
    from marked
    where accounting_day <> current_date
    group by user_id
  ), corrected_users as (
    update private.anicode_llm_accounts as target
    set day_charged_tokens = greatest(
          0,
          target.day_charged_tokens - correction.crossday_tokens
        ),
        updated_at = statement_timestamp()
    from correction
    where target.user_id = correction.user_id
      and target.day_started_at = current_date
    returning target.user_id
  ), applied as (
    select count(*) from corrected_users
  )
  select coalesce(
           sum(marked.reserved_tokens) filter (
             where marked.accounting_day <> current_date
           ),
           0
         )
  into legacy_crossday_stale_tokens
  from marked cross join applied;
  if legacy_crossday_stale_tokens > 0 then
    update private.anicode_llm_global_account
    set day_charged_tokens = greatest(
          0,
          day_charged_tokens - legacy_crossday_stale_tokens
        ),
        updated_at = statement_timestamp()
    where singleton = true and day_started_at = current_date;
  end if;

  -- Bound history reads to a minute/day index range (plus the tiny partial active set), so device
  -- checks remain O(the current window) instead of degrading with account age.
  select count(*)::integer
  into minute_requests
  from private.anicode_llm_requests
  where device_subject = p_device_subject
    and created_at >= minute_window;

  select count(*)::integer
  into day_requests
  from private.anicode_llm_requests
  where device_subject = p_device_subject
    and quota_day = local_today;

  select count(*)::integer,
         coalesce(sum(reserved_tokens), 0)::bigint
  into active_requests, active_reserved_tokens
  from private.anicode_llm_requests
  where device_subject = p_device_subject
    and status = 'reserved';

  select coalesce(sum(charged_tokens), 0)::bigint
  into settled_today_tokens
  from private.anicode_llm_requests
  where device_subject = p_device_subject
    and status <> 'reserved'
    and quota_day = local_today;
  -- Outstanding reservations cross the reset boundary and remain fenced until settlement.
  day_tokens := active_reserved_tokens + settled_today_tokens;

  if minute_requests > quota_policy.device_minute_request_limit then
    retry_after := greatest(
      1,
      ceil(extract(epoch from (minute_window + interval '1 minute' - request_time)))::integer
    );
    raise exception using
      errcode = 'P0001',
      message = 'device_minute_rate_limit',
      detail = 'retry_after_seconds=' || retry_after;
  end if;

  if active_requests > quota_policy.device_active_request_limit then
    raise exception using
      errcode = 'P0001',
      message = 'device_concurrency_limit',
      detail = 'retry_after_seconds=1';
  end if;

  retry_after := greatest(
    1,
    ceil(extract(epoch from (day_ends_at - request_time)))::integer
  );
  if day_requests > quota_policy.device_day_request_limit then
    raise exception using
      errcode = 'P0001',
      message = 'device_daily_request_limit',
      detail = 'retry_after_seconds=' || retry_after;
  end if;

  if day_tokens > quota_policy.device_day_token_limit then
    raise exception using
      errcode = 'P0001',
      message = 'device_daily_token_limit',
      detail = 'retry_after_seconds=' || retry_after;
  end if;
end;
$$;

create or replace function public.settle_anicode_llm_request_v2(
  p_request_id uuid,
  p_charged_tokens integer,
  p_status text,
  p_prompt_tokens integer,
  p_completion_tokens integer,
  p_prompt_cache_hit_tokens integer,
  p_prompt_cache_miss_tokens integer,
  p_reasoning_tokens integer
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
  today date := current_date;
  usage_is_missing boolean;
  late_provider_settlement boolean := false;
  charged_delta bigint := 0;
begin
  usage_is_missing := p_prompt_tokens is null
    and p_completion_tokens is null
    and p_prompt_cache_hit_tokens is null
    and p_prompt_cache_miss_tokens is null
    and p_reasoning_tokens is null;

  if p_request_id is null
     or p_charged_tokens is null
     or p_charged_tokens < 0
     or p_status is null
     or p_status not in ('completed', 'failed', 'aborted')
     or (
       not usage_is_missing
       and (
         p_prompt_tokens is null
         or p_completion_tokens is null
         or p_prompt_cache_hit_tokens is null
         or p_prompt_cache_miss_tokens is null
         or p_reasoning_tokens is null
         or p_prompt_tokens < 0
         or p_completion_tokens < 0
         or p_prompt_cache_hit_tokens < 0
         or p_prompt_cache_miss_tokens < 0
         or p_reasoning_tokens < 0
         or p_prompt_cache_hit_tokens + p_prompt_cache_miss_tokens > p_prompt_tokens
         or p_reasoning_tokens > p_completion_tokens
         or p_prompt_tokens + p_completion_tokens > p_charged_tokens
       )
     ) then
    raise exception using errcode = '22023', message = 'invalid device quota settlement';
  end if;

  select user_id into item_user_id
  from private.anicode_llm_requests
  where request_id = p_request_id;
  if not found then
    return;
  end if;

  -- Preserve the deployed lock order: global -> user -> request.
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
  if not found then
    return;
  end if;

  late_provider_settlement := item.status <> 'reserved'
    and item.settlement_source = 'stale_reaper'
    and not item.provider_usage_recorded;
  if item.status <> 'reserved' and not late_provider_settlement then
    return;
  end if;
  charged_delta := p_charged_tokens - coalesce(item.charged_tokens, 0);

  update private.anicode_llm_requests
  set charged_tokens = p_charged_tokens,
      status = p_status,
      settled_at = statement_timestamp(),
      prompt_tokens = p_prompt_tokens,
      completion_tokens = p_completion_tokens,
      prompt_cache_hit_tokens = p_prompt_cache_hit_tokens,
      prompt_cache_miss_tokens = p_prompt_cache_miss_tokens,
      reasoning_tokens = p_reasoning_tokens,
      reservation_overrun = p_charged_tokens > item.reserved_tokens,
      settlement_source = 'provider',
      accounting_day = case
        when late_provider_settlement then item.accounting_day
        else today
      end,
      provider_usage_recorded = true
  where request_id = p_request_id;

  if late_provider_settlement then
    -- Reclamation already released the reservation and active slot. Apply only the authoritative
    -- delta, and only while that accounting day is still represented by the compact counters.
    if item.accounting_day = today then
      update private.anicode_llm_accounts
      set day_started_at = account.day_started_at,
          day_requests = account.day_requests,
          day_reserved_tokens = account.day_reserved_tokens,
          day_charged_tokens = greatest(
            0,
            account.day_charged_tokens + charged_delta
          ),
          active_requests = account.active_requests,
          updated_at = statement_timestamp()
      where user_id = item.user_id;

      update private.anicode_llm_global_account
      set day_started_at = global_account.day_started_at,
          day_requests = global_account.day_requests,
          day_reserved_tokens = global_account.day_reserved_tokens,
          day_charged_tokens = greatest(
            0,
            global_account.day_charged_tokens + charged_delta
          ),
          active_requests = global_account.active_requests,
          updated_at = statement_timestamp()
      where singleton = true;
    end if;
  else
    update private.anicode_llm_accounts
    set day_started_at = account.day_started_at,
        day_requests = account.day_requests,
        day_reserved_tokens = greatest(0, account.day_reserved_tokens - item.reserved_tokens),
        day_charged_tokens = account.day_charged_tokens + p_charged_tokens,
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
        day_charged_tokens = global_account.day_charged_tokens + p_charged_tokens,
        active_requests = greatest(0, global_account.active_requests - 1),
        updated_at = statement_timestamp()
    where singleton = true;
  end if;
end;
$$;

revoke all on function public.reclaim_anicode_llm_stale_requests_v2()
  from public, anon, authenticated;
revoke all on function public.reserve_anicode_llm_request_v2(uuid, text, uuid, integer, text)
  from public, anon, authenticated;
revoke all on function public.settle_anicode_llm_request_v2(
  uuid, integer, text, integer, integer, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.reserve_anicode_llm_request_v2(
  uuid, text, uuid, integer, text
) to service_role;
grant execute on function public.reclaim_anicode_llm_stale_requests_v2() to service_role;
grant execute on function public.settle_anicode_llm_request_v2(
  uuid, integer, text, integer, integer, integer, integer, integer
) to service_role;

-- Ask the hosted PostgREST layer to discover the new RPC signatures before the Edge rollout.
notify pgrst, 'reload schema';
