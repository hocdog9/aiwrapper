-- Run after model_retry_migration.sql. Top-ups expire with the current billing period.
begin;
create table if not exists public.billing_topups (
  checkout_session_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  credits integer not null check (credits > 0 and credits <= 10000),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.billing_topups enable row level security;
revoke all on public.billing_topups from anon, authenticated;
grant select on public.billing_topups to authenticated;
grant all on public.billing_topups to service_role;
create index if not exists billing_topups_user_expiry on public.billing_topups(user_id, expires_at);
drop policy if exists "Read own topups" on public.billing_topups;
create policy "Read own topups" on public.billing_topups for select to authenticated using (auth.uid() = user_id);

create or replace function public.apply_billing_topup(p_user_id uuid, p_session_id text, p_credits integer)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_billing public.user_billing%rowtype;
begin
  select * into v_billing from public.user_billing where user_id = p_user_id for update;
  if not found then raise exception 'BILLING_NOT_FOUND'; end if;
  if exists(select 1 from public.billing_topups where checkout_session_id = p_session_id) then return; end if;
  if p_session_id is null or p_session_id = '' or p_credits is null or p_credits < 1 or p_credits > 10000 then raise exception 'INVALID_TOPUP'; end if;
  -- A payment delivered after renewal belongs to the current period, never an already expired one.
  if v_billing.current_period_end <= now() and v_billing.plan_id = 'free' then
    update public.user_billing set current_period_start = now(), current_period_end = now() + interval '1 month',
      credits_used = 0, updated_at = now() where user_id = p_user_id returning * into v_billing;
  end if;
  if v_billing.current_period_end <= now() then raise exception 'AWAITING_RENEWAL'; end if;
  insert into public.billing_topups(checkout_session_id, user_id, credits, expires_at)
    values (p_session_id, p_user_id, p_credits, v_billing.current_period_end);
end;
$$;
revoke all on function public.apply_billing_topup(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.apply_billing_topup(uuid, text, integer) to service_role;

create or replace function public.reserve_chat_request(p_user_id uuid, p_request_id uuid, p_fingerprint text, p_retry_of uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_extra integer := 0;
  v_user_id uuid := p_user_id;
  v_parent public.consensus_requests%rowtype;
  v_cost integer := 1;
  v_billing public.user_billing%rowtype;
  v_plan public.plan_catalog%rowtype;
  v_existing public.consensus_requests%rowtype;
  v_window public.user_rate_windows%rowtype;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  insert into public.user_billing (user_id, plan_id, billing_mode, included_credits)
  values (v_user_id, 'free', 'managed', 10)
  on conflict (user_id) do nothing;

  select * into v_billing from public.user_billing where user_id = v_user_id for update;
  if v_billing.plan_id = 'free' and v_billing.current_period_end <= now() then
    update public.user_billing
       set current_period_start = now(),
           current_period_end = now() + interval '1 month',
           credits_used = 0,
           updated_at = now()
     where user_id = v_user_id
     returning * into v_billing;
  end if;

  select coalesce(sum(credits), 0)::integer into v_extra from public.billing_topups where user_id = v_user_id and expires_at > now();
  select * into v_existing from public.consensus_requests
   where id = p_request_id and user_id = v_user_id for update;
  if found then
    if v_existing.response is not null then
      return jsonb_build_object(
        'status', v_existing.status,
        'cachedResponse', v_existing.response,
        'creditsRemaining', greatest((v_billing.included_credits + v_extra) - v_billing.credits_used, 0),
        'billingMode', v_existing.billing_mode
      );
    end if;
    if v_existing.status = 'processing' then
      raise exception 'REQUEST_IN_PROGRESS' using errcode = 'P0001';
    end if;
    raise exception 'REQUEST_ALREADY_PROCESSED' using errcode = 'P0001';
  end if;

  if p_fingerprint !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_RETRY'; end if;
  if p_retry_of is not null then
    select * into v_parent from public.consensus_requests
      where id = p_retry_of and user_id = v_user_id for update;
    if not found or v_parent.status = 'processing' or not v_parent.retryable
      or v_parent.request_fingerprint is distinct from p_fingerprint then
      raise exception 'INVALID_RETRY';
    end if;
    if exists(select 1 from public.consensus_requests where retry_of = p_retry_of) then
      raise exception 'RETRY_ALREADY_USED';
    end if;
    v_cost := 0;
  end if;

  select * into v_plan from public.plan_catalog where plan_id = v_billing.plan_id and active;
  if not found then
    raise exception 'PLAN_UNAVAILABLE' using errcode = 'P0001';
  end if;
  if v_billing.plan_id <> 'free' and (v_billing.subscription_status not in ('active', 'trialing') or v_billing.current_period_end <= now()) then
    raise exception 'PLAN_LIMIT' using errcode = 'P0001';
  end if;

  if (select count(*) from public.consensus_requests
      where user_id = v_user_id and status = 'processing') >= v_plan.max_concurrent_requests then
    raise exception 'CONCURRENCY_LIMIT' using errcode = 'P0001';
  end if;

  insert into public.user_rate_windows (user_id, window_started_at, request_count)
  values (v_user_id, now(), 1)
  on conflict (user_id) do update
    set window_started_at = case
          when public.user_rate_windows.window_started_at < now() - interval '1 minute' then now()
          else public.user_rate_windows.window_started_at
        end,
        request_count = case
          when public.user_rate_windows.window_started_at < now() - interval '1 minute' then 1
          else public.user_rate_windows.request_count + 1
        end
  returning * into v_window;
  if v_window.request_count > v_plan.requests_per_minute then
    raise exception 'RATE_LIMITED' using errcode = 'P0001';
  end if;

  if v_cost > 0 and v_billing.credits_used >= (v_billing.included_credits + v_extra) then
    raise exception 'NO_CREDITS' using errcode = 'P0001';
  end if;

  insert into public.consensus_requests (id, user_id, billing_mode, credit_cost, status, request_fingerprint, retry_of)
  values (
    p_request_id,
    v_user_id,
    v_billing.billing_mode,
    v_cost,
    'processing', p_fingerprint, p_retry_of
  );

  if v_cost > 0 then
    update public.user_billing
       set credits_used = credits_used + 1, updated_at = now()
     where user_id = v_user_id
     returning * into v_billing;
  end if;

  return jsonb_build_object(
    'status', 'reserved',
    'creditCost', v_cost,
    'billingMode', v_billing.billing_mode,
    'creditsRemaining', greatest((v_billing.included_credits + v_extra) - v_billing.credits_used, 0),
    'planId', v_billing.plan_id
  );
end;
$$;

create or replace function public.finish_chat_request(p_user_id uuid, p_request_id uuid, p_response jsonb, p_had_errors boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_extra integer := 0;
  v_request public.consensus_requests%rowtype;
  v_billing public.user_billing%rowtype;
  v_response jsonb := p_response;
begin
  -- Match reservation's lock order to avoid deadlocks.
  select * into v_billing from public.user_billing where user_id = p_user_id for update;
  select * into v_request from public.consensus_requests where id = p_request_id and user_id = p_user_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  select coalesce(sum(credits), 0)::integer into v_extra from public.billing_topups where user_id = p_user_id and expires_at > now();
  if v_request.status <> 'processing' then return v_request.response; end if;
  if (p_had_errors or p_response is null) and v_request.credit_cost > 0 then
    -- Never refund an old reservation into a newly renewed billing period.
    if v_request.created_at >= v_billing.current_period_start then
      update public.user_billing set credits_used = greatest(credits_used - v_request.credit_cost, 0), updated_at = now()
        where user_id = p_user_id returning * into v_billing;
    end if;
    v_request.credit_cost := 0;
  end if;
  if v_response is not null then
    v_response := jsonb_set(v_response, '{usage}', jsonb_build_object('creditCharged', v_request.credit_cost,
      'creditsRemaining', greatest((v_billing.included_credits + v_extra) - v_billing.credits_used, 0)));
    v_response := jsonb_set(v_response, '{retryable}', to_jsonb(p_had_errors));
  end if;
  update public.consensus_requests set
    status = case when v_response is null then 'failed' else 'succeeded' end,
    response = v_response, credit_cost = v_request.credit_cost,
    retryable = p_had_errors or p_response is null, updated_at = now()
    where id = p_request_id;
  return v_response;
end;
$$;
revoke all on function public.reserve_chat_request(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.finish_chat_request(uuid, uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.reserve_chat_request(uuid, uuid, text, uuid) to service_role;
grant execute on function public.finish_chat_request(uuid, uuid, jsonb, boolean) to service_role;
commit;
notify pgrst, 'reload schema';
