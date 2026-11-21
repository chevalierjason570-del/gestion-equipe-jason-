-- Vérification après exécution de messaging.sql.
select
  to_regclass('public.direct_conversations') is not null as direct_conversations_existe,
  to_regclass('public.direct_messages') is not null as direct_messages_existe;

select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and table_name in ('direct_conversations', 'direct_messages')
order by table_name, ordinal_position;
