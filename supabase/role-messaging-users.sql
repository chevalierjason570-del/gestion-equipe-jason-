-- Autorisations de conversation par rôle et par utilisateur.
-- Exécuter dans Supabase > SQL Editor.
create table if not exists public.role_messaging_users (
  role_key text not null references public.roles(role_key) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_key, user_id)
);
alter table public.role_messaging_users enable row level security;
revoke all on public.role_messaging_users from public, anon, authenticated;
grant select, insert, update, delete on public.role_messaging_users to service_role;
notify pgrst, 'reload schema';
