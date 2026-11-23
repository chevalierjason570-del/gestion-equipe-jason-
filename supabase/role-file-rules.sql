-- Règles d'accès par rôle aux dossiers et fichiers.
create table if not exists public.role_file_rules (
  id uuid primary key default gen_random_uuid(),
  role_key text not null references public.roles(role_key) on delete cascade,
  path text not null,
  entry_type text not null check (entry_type in ('folder','file')),
  access text not null check (access in ('allow','deny')),
  created_at timestamptz not null default now(),
  unique(role_key, path)
);
alter table public.role_file_rules enable row level security;
revoke all on public.role_file_rules from anon, authenticated;
grant all on public.role_file_rules to service_role;
