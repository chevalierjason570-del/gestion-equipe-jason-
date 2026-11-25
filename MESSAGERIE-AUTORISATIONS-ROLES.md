Autorisations de messagerie par rôle
Dans Gestion des rôles, le bouton Messagerie ouvre la liste des comptes de l'application. Les cases cochées sont les contacts avec lesquels tous les membres du rôle peuvent démarrer une conversation.
Les choix sont enregistrés dans `role_messaging_users` par `role_key`. Lorsqu'une conversation est autorisée par l'un des deux rôles, les deux participants peuvent échanger des réponses.
Installation Supabase
Dans Supabase > SQL Editor, exécuter une seule fois `supabase/role-messaging-users.sql`. Le script `supabase/role-messaging-flexible-conversations.sql` ne crée pas de table supplémentaire : il documente le fonctionnement et recharge le schéma API.
À vérifier après déploiement
Ouvrir Gestion des rôles en administrateur et cliquer sur Messagerie pour le rôle concerné.
Cocher les utilisateurs autorisés puis enregistrer.
Se connecter avec un compte membre de ce rôle : seuls les contacts sélectionnés doivent apparaître.
Tester l'envoi et la réponse avec les deux comptes.
