-- Les autorisations de contacts sont stockées dans role_messaging_users.
-- Une ligne (role_key, user_id) signifie que tous les membres du rôle
-- role_key peuvent démarrer une conversation avec cet utilisateur.
-- L'API vérifie cette règle avant de créer/ouvrir une conversation et autorise
-- ensuite les deux participants à répondre.
-- Exécuter d'abord supabase/role-messaging-users.sql.
select pg_notify('pgrst', 'reload schema');
