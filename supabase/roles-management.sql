-- Gestion des rôles personnalisés pour Gestion Équipe.
-- À exécuter une seule fois dans Supabase > SQL Editor.
create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  role_key text not null unique,
  name text not null,
  permissions jsonb not null default '[]'::jsonb,
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

-- Le rôle Administrateur est le seul rôle système intégré.
insert into public.roles (role_key, name, permissions, is_system)
values
  ('admin', 'Administrateur', '["accueil","utilisateurs","fichiers","messages","parametres"]'::jsonb, true)
on conflict (role_key) do update set
  name = excluded.name,
  is_system = true;

-- Le rôle est un identifiant texte : cette migration retire uniquement les
-- éventuelles contraintes CHECK qui empêcheraient les rôles personnalisés.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.profiles'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.profiles alter column role type text using role::text;
alter table public.profiles alter column role drop default;

-- Supprimer définitivement l'ancien rôle Standard.
-- Les profils concernés sont laissés sans rôle (aucune permission par défaut).
update public.profiles set role = null where role = 'standard';
-- Les règles associées sont supprimées automatiquement (ON DELETE CASCADE).
delete from public.roles where role_key = 'standard';

alter table public.roles enable row level security;
revoke all on public.roles from anon, authenticated;
grant all on public.roles to service_role;
