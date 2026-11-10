-- Run after free_premium_migration.sql. Limits count attempts, including failures.
begin;
create table if not exists public.guest_rate_limits (
  bucket text primary key,
  window_start timestamptz not null,
  attempts integer not null default 0
);
alter table public.guest_rate_limits enable row level security;
revoke all on public.guest_rate_limits from public, anon, authenticated;
grant all on public.guest_rate_limits to service_role;

create or replace function public.consume_guest_attempt(p_network text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_bucket text;
  v_start timestamptz;
  v_limit integer;
  v_count integer;
  i integer;
begin
  if p_network !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_NETWORK'; end if;
  -- Consistent lock order makes simultaneous requests share atomic limits.
  -- 100 guest attempts/day across the app; 30/network/month; 5/network/minute.
  for i in 1..3 loop
    v_bucket := case i when 1 then 'global' when 2 then 'month:' || p_network else 'minute:' || p_network end;
    v_start := case i when 1 then date_trunc('day', now(), 'UTC') when 2 then date_trunc('month', now(), 'UTC') else date_trunc('minute', now(), 'UTC') end;
    v_limit := case i when 1 then 100 when 2 then 30 else 5 end;
    insert into public.guest_rate_limits(bucket, window_start, attempts)
      values(v_bucket, v_start, 1)
    on conflict(bucket) do update
      set window_start = v_start,
          attempts = case when guest_rate_limits.window_start = v_start then guest_rate_limits.attempts + 1 else 1 end
    returning attempts into v_count;
    if v_count > v_limit then raise exception 'GUEST_LIMIT'; end if;
  end loop;
end;
$$;
revoke all on function public.consume_guest_attempt(text) from public, anon, authenticated;
grant execute on function public.consume_guest_attempt(text) to service_role;
commit;
notify pgrst, 'reload schema';
