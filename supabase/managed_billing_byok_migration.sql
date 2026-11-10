create table if not exists public.plan_catalog (
  plan_id text primary key,
  monthly_credits integer not null check (monthly_credits >= 0),
  requests_per_minute integer not null check (requests_per_minute > 0),
  max_concurrent_requests integer not null check (max_concurrent_requests > 0),
  allowed_models jsonb not null default '[]'::jsonb,
  active boolean not null default true
);

insert into public.plan_catalog (plan_id, monthly_credits, requests_per_minute, max_concurrent_requests, allowed_models)
values
  ('free', 10, 5, 1, '[]'::jsonb),
  ('basic', 100, 20, 2, '[]'::jsonb),
  ('plus', 500, 60, 4, '[]'::jsonb)
on conflict (plan_id) do nothing;

create table if not exists public.user_billing (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan_id text not null references public.plan_catalog(plan_id) default 'free',
  billing_mode text not null default 'managed' check (billing_mode in ('managed', 'byok')),
  subscription_status text not null default 'active',
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz not null default (now() + interval '1 month'),
  included_credits integer not null default 10 check (included_credits >= 0),
  credits_used integer not null default 0 check (credits_used >= 0),
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.consensus_requests (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  billing_mode text not null check (billing_mode in ('managed', 'byok')),
  credit_cost integer not null default 1 check (credit_cost >= 0),
  status text not null check (status in ('processing', 'succeeded', 'failed')),
  response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null references public.consensus_requests(id) on delete cascade,
  conversation_id uuid,
  provider text not null check (provider in ('GPT', 'Gemini', 'Claude')),
  model text not null,
  billing_mode text not null check (billing_mode in ('managed', 'byok')),
  call_kind text not null default 'response' check (call_kind in ('response', 'synthesis')),
  input_tokens bigint,
  output_tokens bigint,
  cached_input_tokens bigint,
  estimated_provider_cost_micros bigint,
  credits_charged integer not null default 0,
  status text not null check (status in ('success', 'failed', 'partial')),
  latency_ms integer,
  provider_request_id text,
  created_at timestamptz not null default now(),
  unique (request_id, provider, call_kind)
);

create table if not exists public.user_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('GPT', 'Gemini', 'Claude')),
  encrypted_secret text not null,
  encryption_metadata jsonb not null,
  masked_suffix text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_validated_at timestamptz,
  unique (user_id, provider)
);

create table if not exists public.user_rate_windows (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0 check (request_count >= 0)
);

create table if not exists public.billing_webhook_events (
  event_id text primary key,
  event_type text not null,
  status text not null default 'processing' check (status in ('processing', 'processed', 'pending')),
  lease_until timestamptz,
  processed_at timestamptz not null default now()
);

alter table public.billing_webhook_events
  add column if not exists status text not null default 'processed';
alter table public.billing_webhook_events
  add column if not exists lease_until timestamptz;

alter table public.plan_catalog enable row level security;
alter table public.user_billing enable row level security;
alter table public.consensus_requests enable row level security;
alter table public.usage_events enable row level security;
alter table public.user_provider_credentials enable row level security;
alter table public.user_rate_windows enable row level security;
alter table public.billing_webhook_events enable row level security;

drop policy if exists "Authenticated users can view active plans" on public.plan_catalog;
create policy "Authenticated users can view active plans"
  on public.plan_catalog for select to authenticated using (active);

do $$
declare
  profile_row record;
  candidate text;
  suffix integer;
begin
  for profile_row in select id, user_id, name from public.api_profiles order by user_id, created_at, id loop
    candidate := coalesce(nullif(trim(profile_row.name), ''), 'Profile');
    suffix := 2;
    while exists (
      select 1 from public.api_profiles other_profile
      where other_profile.user_id = profile_row.user_id
        and other_profile.id <> profile_row.id
        and lower(other_profile.name) = lower(candidate)
    ) loop
      candidate := coalesce(nullif(trim(profile_row.name), ''), 'Profile') || ' (' || suffix || ')';
      suffix := suffix + 1;
    end loop;
    update public.api_profiles set name = candidate where id = profile_row.id;
  end loop;
end;
$$;

create unique index if not exists api_profiles_user_name_unique_idx
  on public.api_profiles(user_id, lower(name));

drop policy if exists "Users can view their own billing" on public.user_billing;
create policy "Users can view their own billing"
  on public.user_billing for select using (auth.uid() = user_id);
drop policy if exists "Users can view their own consensus requests" on public.consensus_requests;
create policy "Users can view their own consensus requests"
  on public.consensus_requests for select using (auth.uid() = user_id);
drop policy if exists "Users can view their own usage events" on public.usage_events;
drop policy if exists "Users can manage their own encrypted provider credentials" on public.user_provider_credentials;
create policy "Users can manage their own encrypted provider credentials"
  on public.user_provider_credentials for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists usage_events_user_created_idx on public.usage_events(user_id, created_at desc);
create index if not exists usage_events_request_idx on public.usage_events(request_id);
create index if not exists consensus_requests_user_created_idx on public.consensus_requests(user_id, created_at desc);

-- Existing profile JSON stored provider keys in plaintext. Require re-entry in BYOK Settings.
update public.api_profiles
set settings = jsonb_set(
  jsonb_set(
    jsonb_set(
      coalesce(settings, '{}'::jsonb),
      '{GPT}', coalesce(settings->'GPT', '{}'::jsonb) - 'apiKey', true
    ),
    '{Gemini}', coalesce(settings->'Gemini', '{}'::jsonb) - 'apiKey', true
  ),
  '{Claude}', coalesce(settings->'Claude', '{}'::jsonb) - 'apiKey', true
)
where settings ?| array['GPT', 'Gemini', 'Claude'];

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'api_profiles_settings_no_plaintext_keys'
      and conrelid = 'public.api_profiles'::regclass
  ) then
    alter table public.api_profiles
      add constraint api_profiles_settings_no_plaintext_keys check (
        not (
          coalesce(settings->'GPT', '{}'::jsonb) ? 'apiKey'
          or coalesce(settings->'Gemini', '{}'::jsonb) ? 'apiKey'
          or coalesce(settings->'Claude', '{}'::jsonb) ? 'apiKey'
        )
      );
  end if;
end;
$$;

insert into public.user_billing (user_id, plan_id, billing_mode, included_credits)
select id, 'free', 'managed', 10 from auth.users
on conflict (user_id) do nothing;

create or replace function public.initialize_user_billing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_billing (user_id, plan_id, billing_mode, included_credits)
  values (new.id, 'free', 'managed', 10)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists initialize_user_billing_after_signup on auth.users;
create trigger initialize_user_billing_after_signup
after insert on auth.users
for each row execute function public.initialize_user_billing();

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
  if v_billing.current_period_end <= now() then
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
  if v_billing.plan_id <> 'free' and v_billing.subscription_status not in ('active', 'trialing') then
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

create or replace function public.complete_consensus_request(p_request_id uuid, p_response jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  update public.consensus_requests
     set status = 'succeeded', response = p_response, updated_at = now()
   where id = p_request_id and user_id = auth.uid() and status = 'processing';
  if not found then raise exception 'REQUEST_NOT_FOUND' using errcode = 'P0001'; end if;
end;
$$;

create or replace function public.fail_consensus_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.consensus_requests%rowtype;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  update public.consensus_requests
     set status = 'failed', updated_at = now()
   where id = p_request_id and user_id = auth.uid() and status = 'processing'
   returning * into v_request;
  if found and v_request.credit_cost > 0 then
    update public.user_billing
       set credits_used = greatest(credits_used - v_request.credit_cost, 0), updated_at = now()
     where user_id = auth.uid();
  end if;
end;
$$;

create or replace function public.set_billing_mode(p_mode text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if p_mode not in ('managed', 'byok') then raise exception 'INVALID_BILLING_MODE' using errcode = '22023'; end if;
  if p_mode = 'byok' and (
    select count(*) from public.user_provider_credentials where user_id = auth.uid()
  ) < 3 then
    raise exception 'BYOK_KEY_MISSING' using errcode = 'P0001';
  end if;
  update public.user_billing set billing_mode = p_mode, updated_at = now() where user_id = auth.uid();
end;
$$;

create or replace function public.claim_billing_webhook(p_event_id text, p_event_type text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.billing_webhook_events%rowtype;
begin
  insert into public.billing_webhook_events (event_id, event_type, status, lease_until)
  values (p_event_id, p_event_type, 'pending', null)
  on conflict (event_id) do nothing;

  select * into v_event from public.billing_webhook_events where event_id = p_event_id for update;
  if v_event.status = 'processed' then return 'processed'; end if;
  if v_event.status = 'processing' and v_event.lease_until > now() then return 'busy'; end if;

  update public.billing_webhook_events
     set status = 'processing', lease_until = now() + interval '5 minutes', event_type = p_event_type
   where event_id = p_event_id;
  return 'claimed';
end;
$$;

create or replace function public.finish_billing_webhook(p_event_id text, p_processed boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.billing_webhook_events
     set status = case when p_processed then 'processed' else 'pending' end,
         lease_until = null,
         processed_at = case when p_processed then now() else processed_at end
   where event_id = p_event_id;
end;
$$;

revoke all on function public.reserve_consensus_credit(uuid) from public, anon;
revoke all on function public.complete_consensus_request(uuid, jsonb) from public, anon;
revoke all on function public.fail_consensus_request(uuid) from public, anon;
revoke all on function public.set_billing_mode(text) from public, anon;
revoke all on function public.claim_billing_webhook(text, text) from public, anon, authenticated;
revoke all on function public.finish_billing_webhook(text, boolean) from public, anon, authenticated;
grant execute on function public.reserve_consensus_credit(uuid) to authenticated;
grant execute on function public.complete_consensus_request(uuid, jsonb) to authenticated;
grant execute on function public.fail_consensus_request(uuid) to authenticated;
grant execute on function public.set_billing_mode(text) to authenticated;
grant execute on function public.claim_billing_webhook(text, text) to service_role;
grant execute on function public.finish_billing_webhook(text, boolean) to service_role;

revoke insert, update, delete on public.plan_catalog from anon, authenticated;
grant select on public.plan_catalog to authenticated;
revoke insert, update, delete on public.user_billing from anon, authenticated;
revoke insert, update, delete on public.consensus_requests from anon, authenticated;
revoke all on public.usage_events from anon, authenticated;
revoke all on public.user_rate_windows from anon, authenticated;
revoke select, insert, update, delete on public.user_provider_credentials from anon, authenticated;
revoke all on public.billing_webhook_events from anon, authenticated;
grant all on public.plan_catalog, public.user_billing, public.consensus_requests,
  public.usage_events, public.user_provider_credentials, public.user_rate_windows,
  public.billing_webhook_events to service_role;
grant select on public.user_billing, public.consensus_requests to authenticated;

notify pgrst, 'reload schema';
