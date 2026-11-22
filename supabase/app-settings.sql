-- Paramètres généraux de Gestion Équipe (à exécuter une seule fois dans Supabase SQL Editor).
create table if not exists public.app_settings (
  id text primary key check (id = 'global'),
  settings jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
grant all on public.app_settings to service_role;
insert into public.app_settings (id, settings)
values ('global', '{
  "accounts": {"allowCreation": true, "defaultRole": "", "minimumPasswordLength": 8},
  "security": {"requirePasswordChangeOnReset": true, "notifyOnNewAccount": true},
  "notifications": {"newMessages": true, "newUsers": true, "storageWarnings": true},
  "appearance": {"appName": "Gestion Équipe Jason", "accentColor": "#2563eb"}
}'::jsonb)
on conflict (id) do nothing;
