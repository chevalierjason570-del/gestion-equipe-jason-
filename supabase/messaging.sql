-- Messagerie privée Gestion Équipe
-- À exécuter dans Supabase > SQL Editor > New Query.
-- Un échange relie exactement un administrateur et un membre.
-- Script ré-exécutable : il crée les tables manquantes et complète les colonnes absentes.

create table if not exists public.direct_conversations (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references auth.users(id) on delete cascade,
  user_b uuid not null references auth.users(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  constraint direct_conversations_distinct_users check (user_a <> user_b),
  constraint direct_conversations_ordered_users check (user_a < user_b),
  constraint direct_conversations_unique_pair unique (user_a, user_b)
);

alter table public.direct_conversations
  add column if not exists user_a uuid references auth.users(id) on delete cascade,
  add column if not exists user_b uuid references auth.users(id) on delete cascade,
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists last_message_at timestamptz not null default now();

create table if not exists public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.direct_conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null default '',
  attachment_key text,
  attachment_name text,
  attachment_mime text,
  attachment_size bigint not null default 0,
  message_type text not null default 'text'
    check (message_type in ('text', 'image', 'audio', 'file')),
  created_at timestamptz not null default now(),
  constraint direct_messages_has_content check (
    length(trim(body)) > 0 or attachment_key is not null
  ),
  constraint direct_messages_attachment_metadata check (
    (attachment_key is null and attachment_name is null and attachment_mime is null and attachment_size = 0)
    or
    (attachment_key is not null and attachment_name is not null and attachment_mime is not null and attachment_size >= 0)
  )
);

alter table public.direct_messages
  add column if not exists conversation_id uuid references public.direct_conversations(id) on delete cascade,
  add column if not exists sender_id uuid references auth.users(id) on delete cascade,
  add column if not exists body text not null default '',
  add column if not exists attachment_key text,
  add column if not exists attachment_name text,
  add column if not exists attachment_mime text,
  add column if not exists attachment_size bigint not null default 0,
  add column if not exists message_type text not null default 'text',
  add column if not exists created_at timestamptz not null default now();

create index if not exists direct_conversations_user_a_idx
  on public.direct_conversations(user_a, last_message_at desc);
create index if not exists direct_conversations_user_b_idx
  on public.direct_conversations(user_b, last_message_at desc);
create index if not exists direct_messages_conversation_created_idx
  on public.direct_messages(conversation_id, created_at desc);

alter table public.direct_conversations enable row level security;
alter table public.direct_messages enable row level security;
revoke all on public.direct_conversations from public, anon, authenticated;
revoke all on public.direct_messages from public, anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on public.direct_conversations to service_role;
grant select, insert, update, delete on public.direct_messages to service_role;

-- Les conversations privées peuvent relier deux utilisateurs quelconques.
-- Les autorisations par rôle sont vérifiées par les API serveur avant chaque accès.
drop trigger if exists direct_conversations_require_admin_member
  on public.direct_conversations;
notify pgrst, 'reload schema';
