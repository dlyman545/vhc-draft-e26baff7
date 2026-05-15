create table if not exists public.draft_state (
  id int primary key default 1,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint draft_state_singleton check (id = 1)
);

insert into public.draft_state (id, state) values (1, '{}'::jsonb)
on conflict (id) do nothing;

alter table public.draft_state enable row level security;

create policy "draft_state public read"
  on public.draft_state for select
  using (true);

create policy "draft_state public update"
  on public.draft_state for update
  using (true) with check (true);

create policy "draft_state public insert"
  on public.draft_state for insert
  with check (id = 1);

alter publication supabase_realtime add table public.draft_state;
alter table public.draft_state replica identity full;