-- Run after schema.sql and managed_billing_byok_migration.sql.
begin;

insert into public.plan_catalog (plan_id, monthly_credits, requests_per_minute, max_concurrent_requests, allowed_models)
values ('premium', 500, 60, 4, '{}'::jsonb)
on conflict (plan_id) do update set active = true;
update public.plan_catalog set active = false where plan_id in ('basic', 'plus');
update public.user_billing set billing_mode = 'managed';
alter table public.user_billing drop constraint if exists user_billing_billing_mode_check;
alter table public.user_billing add constraint user_billing_billing_mode_check check (billing_mode = 'managed');

-- Retire direct mode switching, including calls from stale browser tabs.
create or replace function public.set_billing_mode(p_mode text)
returns void language plpgsql security definer set search_path = public as $$
begin
  raise exception 'BILLING_MODE_RETIRED';
end;
$$;
revoke all on function public.set_billing_mode(text) from public, anon, authenticated;

-- App-owned credentials only. Old credential storage is no longer client-accessible.
drop policy if exists "Users can manage their own encrypted provider credentials" on public.user_provider_credentials;
revoke all on public.user_provider_credentials from anon, authenticated;
grant select, insert, update, delete on public.chat_sessions, public.api_profiles to authenticated;

create or replace function public.reserve_consensus_credit(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
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

  select * into v_existing from public.consensus_requests
   where id = p_request_id and user_id = v_user_id for update;
  if found then
    if v_existing.response is not null then
      return jsonb_build_object(
        'status', v_existing.status,
        'cachedResponse', v_existing.response,
        'creditsRemaining', greatest(v_billing.included_credits - v_billing.credits_used, 0),
        'billingMode', v_existing.billing_mode
      );
    end if;
    if v_existing.status = 'processing' then
      raise exception 'REQUEST_IN_PROGRESS' using errcode = 'P0001';
    end if;
    raise exception 'REQUEST_ALREADY_PROCESSED' using errcode = 'P0001';
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

  if v_billing.billing_mode = 'managed' and v_billing.credits_used >= v_billing.included_credits then
    raise exception 'NO_CREDITS' using errcode = 'P0001';
  end if;

  insert into public.consensus_requests (id, user_id, billing_mode, credit_cost, status)
  values (
    p_request_id,
    v_user_id,
    v_billing.billing_mode,
    case when v_billing.billing_mode = 'managed' then 1 else 0 end,
    'processing'
  );

  if v_billing.billing_mode = 'managed' then
    update public.user_billing
       set credits_used = credits_used + 1, updated_at = now()
     where user_id = v_user_id
     returning * into v_billing;
  end if;

  return jsonb_build_object(
    'status', 'reserved',
    'billingMode', v_billing.billing_mode,
    'creditsRemaining', greatest(v_billing.included_credits - v_billing.credits_used, 0),
    'planId', v_billing.plan_id
  );
end;
$$;


commit;
notify pgrst, 'reload schema';
