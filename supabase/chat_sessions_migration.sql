create table if not exists public.chat_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  chat jsonb not null default '[]'::jsonb,
  result jsonb,
  updated_at timestamptz not null default now()
);

alter table public.chat_sessions enable row level security;

drop policy if exists "Users can view their own chat sessions" on public.chat_sessions;
create policy "Users can view their own chat sessions"
  on public.chat_sessions for select
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own chat sessions" on public.chat_sessions;
create policy "Users can create their own chat sessions"
  on public.chat_sessions for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own chat sessions" on public.chat_sessions;
create policy "Users can update their own chat sessions"
  on public.chat_sessions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own chat sessions" on public.chat_sessions;
create policy "Users can delete their own chat sessions"
  on public.chat_sessions for delete
  using (auth.uid() = user_id);

create index if not exists chat_sessions_user_id_idx on public.chat_sessions(user_id);
create index if not exists chat_sessions_updated_at_idx on public.chat_sessions(updated_at desc);

notify pgrst, 'reload schema';
