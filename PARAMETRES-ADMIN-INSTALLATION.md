Paramètres administrateur — installation
Cette version ajoute une vraie page de paramètres réservée à l'administrateur.
Migration Supabase obligatoire
Avant de déployer le code, ouvrir Supabase > SQL Editor, puis exécuter le contenu de :
`supabase/app-settings.sql`
Cette migration crée `public.app_settings`, active RLS et réserve les accès à `service_role`. Les paramètres sont stockés dans une seule ligne globale.
Fonctions disponibles
Profil administrateur : modifier l'identifiant, le nom affiché et (facultativement) le mot de passe du compte connecté.
Comptes utilisateurs : autoriser/interdire la création de comptes, choisir le rôle par défaut pour le formulaire de création et définir la longueur minimale du mot de passe (8 à 64 caractères). La règle de création est appliquée côté API.
Sécurité : affiche les protections réellement actives et leurs limites. Il n'y a pas encore de réinitialisation de mot de passe ni de déconnexion automatique après inactivité.
Notifications : l'option « Nouveaux messages » active/désactive l'e-mail envoyé à l'administrateur pour les messages entrants (si Resend est configuré). Les options nouveaux utilisateurs et avertissements de stockage sont enregistrées comme préférences, mais leurs alertes automatiques ne sont pas encore implémentées.
Stockage : affiche le bucket B2, le quota configuré, l'espace utilisé, ainsi que le nombre de comptes et d'administrateurs. Les clés B2 ne sont jamais exposées au navigateur.
Apparence : change le nom affiché dans l'application et la couleur de sélection du menu. Le nom est également appliqué au titre de l'onglet du navigateur.
Sécurité
La route `/api/admin/settings` vérifie le jeton Supabase et le rôle `admin` côté serveur pour chaque lecture et modification. La création de comptes consulte les réglages enregistrés et applique les limites de création et de mot de passe.
Déploiement
Exécuter `supabase/app-settings.sql`.
Déployer le projet complet.
Vérifier que les variables Supabase (`NEXT_PUBLIC_SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY`) sont définies sur l'hébergement.
Vérifier la configuration B2 pour que les informations de stockage soient disponibles.
Se connecter avec le compte administrateur et ouvrir Paramètres.
Le build n'a pas pu être vérifié dans l'environnement de préparation car les dépendances npm n'ont pas pu être installées ici. Exécuter `npm install`, puis `npm run build` dans l'environnement du projet avant la mise en production.
