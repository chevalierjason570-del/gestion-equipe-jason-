# Messagerie privée — Gestion Équipe

Cette version ajoute une messagerie directe à deux participants à Gestion Équipe. Tous les échanges doivent passer par un administrateur.

## Fonctionnalités

- Conversations privées entre exactement deux comptes (pas de groupes).
- Un membre non-administrateur peut uniquement démarrer une conversation privée avec un administrateur.
- L'administrateur peut démarrer une conversation privée individuelle avec chaque membre.
- Les conversations membre ↔ membre et administrateur ↔ administrateur sont interdites côté API et par un déclencheur SQL.
- L'administrateur participe aux conversations et peut supprimer n'importe quel message dans ses échanges avec les membres.
- Un membre peut supprimer ses propres messages.
- Messages texte jusqu'à 5 000 caractères.
- Envoi de photos, documents et fichiers audio jusqu'à 100 Mo par pièce jointe.
- Enregistrement d'un message vocal depuis le navigateur si le microphone est autorisé.
- Aperçu des photos, lecture des messages audio, aperçu des PDF et téléchargement des autres documents.
- Les pièces jointes sont stockées dans le même bucket Backblaze B2, sous `messages/`, et comptent dans le plafond global de 10 Go de l'application.
- Les URL de lecture sont signées et temporaires (15 minutes). Le bucket reste privé.
- Actualisation automatique de la conversation toutes les 5 secondes (sans service realtime payant).

## Installation / mise à jour obligatoire de la base de données

- Si les tables de messagerie n'existent pas encore : exécuter tout le fichier `supabase/messaging.sql`.
- Si l'ancienne messagerie a déjà été installée : exécuter le fichier `supabase/messaging-admin-only.sql` pour ajouter la règle qui interdit les conversations membre ↔ membre et admin ↔ admin.

Pour exécuter le fichier choisi : ouvrir le projet Supabase de Gestion Équipe, aller dans **SQL Editor** puis **New Query**, copier le contenu du fichier et cliquer sur **Run**.

Après activation de cette règle, les anciennes conversations membre ↔ membre n'apparaîtront plus dans l'application et ne pourront plus être ouvertes depuis ses API. Elles ne sont pas supprimées automatiquement de la base.

Les tables ont RLS activé et n'accordent pas d'accès direct aux rôles `anon` ou `authenticated`. Toutes les opérations passent par les routes serveur qui valident le jeton, l'appartenance à la conversation et le rôle de chaque participant. Un déclencheur SQL vérifie également chaque nouvelle conversation : elle doit relier exactement un profil `admin` à un profil non-admin. La clé `SUPABASE_SERVICE_ROLE_KEY` reste uniquement dans les variables serveur de Vercel.

## Fichiers ajoutés

- `app/components/Messenger.tsx`
- `app/api/messages/route.ts`
- `app/api/messages/[conversationId]/route.ts`
- `app/api/messages/upload/route.ts`
- `lib/messaging-server.ts`
- `supabase/messaging.sql`
- `supabase/messaging-admin-only.sql` (migration de restriction si la messagerie précédente était déjà installée)

`app/page.tsx` est modifié pour afficher la messagerie dans le menu existant.

## Configuration nécessaire

Le projet utilise les variables déjà présentes dans Vercel :

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `B2_REGION`
- `B2_ENDPOINT`
- `B2_ACCESS_KEY_ID`
- `B2_SECRET_ACCESS_KEY`
- `B2_BUCKET_NAME`

Aucune nouvelle clé secrète ne doit être placée dans GitHub ou dans le code client.

## CORS Backblaze

Le bucket doit autoriser l'origine exacte du domaine de production du site, les méthodes `GET`, `HEAD`, `PUT`, et les en-têtes nécessaires (`Content-Type`). Les objets restent privés ; l'application utilise des URL pré-signées.

## Limites et vérifications

- Taille maximale d'une pièce jointe de messagerie : 100 Mo.
- Plafond global vérifié par l'application : 10 Go décimaux dans le bucket entier, fichiers partagés et messages compris.
- Le contrôle du quota est une vérification à chaque initialisation d'upload ; comme avec tout upload distribué, deux envois simultanés peuvent atteindre le quota de très près. Contrôler également le quota dans le compte Backblaze.
- Les messages sont actualisés par polling toutes les 5 secondes.
- L'enregistrement vocal nécessite HTTPS et l'autorisation du microphone.
- Chaque conversation valide relie exactement un administrateur et un membre. Les membres ne voient que leur conversation avec un administrateur ; l'administrateur voit ses conversations individuelles avec les membres. L'administrateur peut supprimer tous les messages de ses conversations ; un membre peut supprimer ses propres messages.
- Une suppression de message supprime aussi l'objet joint dans B2.

## Vérification avant mise en production

1. Exécuter `npm install`.
2. Exécuter `npm run build`.
3. Appliquer `supabase/messaging.sql` avant de déployer.
4. Déployer sur Vercel avec les variables serveur existantes.
5. Tester avec un compte administrateur et deux comptes membres : chaque membre doit uniquement voir les administrateurs dans ses contacts ; l'administrateur doit pouvoir ouvrir deux conversations distinctes, une avec chaque membre ; vérifier qu'un membre ne peut ni trouver ni ouvrir la conversation de l'autre membre.
6. Tenter de créer une conversation membre ↔ membre par requête API : elle doit être refusée (HTTP 403). Le déclencheur SQL doit aussi refuser toute paire non conforme.
7. Tester la suppression par l'auteur et la suppression par l'administrateur.

Les fichiers Supabase de stockage existants ne sont ni déplacés ni supprimés par cette messagerie. Les pièces jointes de chat sont stockées dans B2.
