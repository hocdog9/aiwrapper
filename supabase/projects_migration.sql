-- Run after chat_sessions_migration.sql. Existing chats remain outside projects.
begin;
create table if not exists public.projects (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  files jsonb not null default '[]'::jsonb check (jsonb_typeof(files) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.projects enable row level security;
revoke all on public.projects from anon;
grant select, insert, update, delete on public.projects to authenticated;
drop policy if exists "Users manage their own projects" on public.projects;
create policy "Users manage their own projects" on public.projects
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index if not exists projects_user_id_idx on public.projects(user_id);
alter table public.chat_sessions add column if not exists project_id uuid references public.projects(id) on delete set null;
create index if not exists chat_sessions_project_id_idx on public.chat_sessions(project_id);
-- Restrictive policy also prevents linking a user's chat to somebody else's project.
drop policy if exists "Chat project must belong to user" on public.chat_sessions;
create policy "Chat project must belong to user" on public.chat_sessions as restrictive
  for all to authenticated using (true)
  with check (project_id is null or exists (
    select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()
  ));
commit;
notify pgrst, 'reload schema';
