Autorisations de messagerie par rôle
Mise à jour
Déployer le projet corrigé.
Dans Supabase > SQL Editor, exécuter `supabase/role-messaging-users.sql` si la table `role_messaging_users` n'existe pas encore.
Exécuter `supabase/role-messaging-flexible-conversations.sql` pour retirer l'ancienne contrainte qui limitait les conversations aux échanges administrateur/membre.
Fonctionnement
Dans Gestion des rôles, le bouton « Messagerie » ouvre la liste de tous les profils.
Les utilisateurs cochés sont les contacts que les membres de ce rôle peuvent joindre.
La liste des contacts d'un membre est limitée aux personnes cochées pour son rôle.
L'administrateur conserve l'accès à tous les profils.
Une personne contactée peut répondre dans cette conversation.
Les API vérifient les autorisations côté serveur lors de la création et de l'accès à une conversation. Les envois de messages et les pièces jointes réutilisent cette vérification.
Les autorisations sont communes à tous les membres du même rôle.
