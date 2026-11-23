# Gestion Équipe — stockage Backblaze B2 (quota gratuit 10 Go)

Cette adaptation conserve Supabase pour les comptes et les rôles et déplace les fichiers vers le bucket privé Backblaze B2 via l'API S3-compatible. Les clés B2 restent uniquement côté serveur.

## Important : quota et coûts

Backblaze indique que les premiers 10 Go de stockage sont gratuits. Le quota est partagé sur le compte, et les opérations/transferts suivent aussi les conditions tarifaires Backblaze. Le site bloque les nouveaux envois au-delà de 10 000 000 000 octets dans ce bucket, mais ne peut pas empêcher d'autres usages du compte ni garantir l'absence de frais liés aux opérations. Fais vérifier le compte et les éventuelles facturations par le responsable adulte du compte.

Le plafond par fichier dans ce projet est également de 10 000 000 000 octets. Les transferts multipart servent aux gros fichiers.

## 1. Bucket déjà créé

Le bucket de ton compte est `gestion-equipe-jason-b2-10go`, en accès **Private**. L'endpoint montré dans ta capture est `s3.eu-central-003.backblazeb2.com`, donc la région est `eu-central-003`.

Garde le bucket privé et ne change pas son nom.

## 2. Application Key déjà créée

Utilise une Application Key standard (pas la Master Application Key), limitée à ce bucket, avec lecture/écriture des fichiers et `Allow List All Bucket Names` activé. Le code nécessite les capacités de liste, lecture, écriture et suppression des fichiers. Ne partage jamais la valeur `applicationKey` secrète et ne l'ajoute jamais au code ou à GitHub.

## 3. Lifecycle : éviter de garder des anciennes versions

La capture du bucket indiquait `Keep all versions`. Pour un espace limité à 10 Go, ouvre **Buckets → gestion-equipe-jason-b2-10go → Lifecycle Settings** et choisis **Keep only the last version**, puis enregistre. Backblaze conserve l'ancienne version cachée environ un jour avant de la supprimer. L'espace peut donc ne pas être libéré immédiatement après suppression/remplacement.

## 4. CORS obligatoire pour les envois navigateur

Les envois utilisent des URL S3 signées directement depuis le navigateur. Le bucket doit autoriser le domaine exact du site Vercel pour `PUT`, `GET`, `HEAD`, autoriser les en-têtes de requête et exposer `ETag`. Le bucket reste privé : CORS ne rend pas les objets publics.

Un modèle est fourni dans `B2-S3-CORS-EXAMPLE.json`. Remplace `https://REMPLACER-PAR-LE-DOMAINE-VERCEL-EXACT` par l'origine exacte du site (sans chemin, par exemple `https://mon-site.vercel.app`). Ajoute `http://localhost:3000` uniquement pour le développement local.

La configuration CORS du bucket est une opération de gestion du bucket. Une Application Key limitée à un bucket ne peut pas modifier ces réglages. Fais appliquer le CORS par le propriétaire/administrateur Backblaze via l'interface disponible pour son compte ou le CLI/API officiel avec des droits de gestion de bucket. Ne crée pas une clé générale d'accès à tous les buckets pour contourner cela. La documentation Backblaze décrit CORS et ses permissions dans les liens ci-dessous.

## 5. Variables Vercel

Dans Vercel → projet → Settings → Environment Variables, conserve les trois variables Supabase déjà présentes et ajoute les cinq variables B2 suivantes pour Production (et Preview/Development si nécessaire) :

```env
B2_REGION=eu-central-003
B2_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
B2_ACCESS_KEY_ID=TON_APPLICATION_KEY_ID
B2_SECRET_ACCESS_KEY=TON_APPLICATION_KEY_SECRET
B2_BUCKET_NAME=gestion-equipe-jason-b2-10go
```

`B2_ACCESS_KEY_ID` reçoit le `keyID` affiché par Backblaze. `B2_SECRET_ACCESS_KEY` reçoit la valeur `applicationKey` affichée une seule fois.

Les variables Supabase restent nécessaires :
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Ne mets jamais `SUPABASE_SERVICE_ROLE_KEY` ou les clés B2 sous un nom qui commence par `NEXT_PUBLIC_`.

`.env.local` est uniquement utile pour le développement local. Pour la production hébergée sur Vercel, configure les variables dans Vercel → Settings → Environment Variables. Ne mets jamais de vraies clés dans GitHub ni dans `.env.local.example`.

## 6. Migration des fichiers Supabase déjà présents

Le script `npm run migrate:b2` copie les objets du bucket Supabase `fichiers-equipe` vers le bucket B2. Il ne supprime jamais les originaux. Il ignore les chemins déjà copiés, donc il peut être relancé après une interruption.

Sur le PC, installe Node.js 22 si nécessaire, ouvre un terminal dans le dossier du projet, puis lance :

```powershell
npm install
npm run migrate:b2
```

Le fichier `.env.local` doit contenir les variables Supabase existantes et les cinq variables B2 ci-dessus. Assure-toi que le total des données à migrer tient dans le quota restant. Ne commence pas la migration de plusieurs Go avant d'avoir testé les accès B2 et les CORS avec un petit fichier.

## 7. Déploiement et test

1. Remplace les fichiers du projet par cette version B2 et envoie-les sur GitHub.
2. Ajoute les cinq variables B2 dans Vercel.
3. Configure CORS pour l'origine exacte Vercel.
4. Redéploie le site.
5. Connecte-toi avec un compte administrateur.
6. Teste un fichier de quelques Ko, puis un petit dossier.
7. Vérifie l'aperçu, le téléchargement, la création de dossier, le renommage, le déplacement et la suppression.
8. Lance la migration des anciens documents Supabase uniquement après ces tests.

Ne supprime aucun fichier Supabase tant que tu n'as pas vérifié les copies dans B2 et téléchargé plusieurs fichiers de contrôle.

## Fonctionnement

- Supabase Auth et `profiles` continuent à gérer la connexion et les rôles.
- Les fichiers sont stockés dans le bucket privé B2.
- Les fichiers jusqu'à 64 MiB utilisent un PUT signé. Les fichiers plus gros sont envoyés en multipart par blocs de 32 MiB.
- Les URL signées d'aperçu et de téléchargement expirent au bout d'une heure.
- La reprise d'un multipart est possible en re-sélectionnant le même fichier dans le même navigateur.
- L'API de l'application calcule l'espace utilisé et bloque les envois dépassant le plafond du projet.

## Limites

- Le quota Backblaze de 10 Go gratuit est partagé sur le compte, pas réservé à l'application.
- Keep only the last version supprime les anciennes versions après environ un jour ; l'espace peut être libéré avec délai.
- Les téléchargements ZIP de gros dossiers sont servis par l'API du site et peuvent rencontrer les limites d'exécution de l'hébergeur. Pour les dossiers très volumineux, les téléchargements fichier par fichier sont plus fiables.
- Les clés B2 ne doivent jamais être envoyées dans une conversation, ajoutées à GitHub ou exposées au navigateur.


## Reprise d'un gros envoi interrompu (HTTP 503)

La version actuelle envoie les parties multipart une par une et applique jusqu'à huit tentatives avec délai exponentiel en cas de HTTP 408, 429, 500, 502, 503 ou 504. Backblaze recommande un backoff exponentiel pour les réponses 503/SlowDown. Lors d'un nouvel envoi du même dossier, les objets déjà présents dans B2 avec le même chemin et la même taille sont ignorés. Un fichier modifié mais conservant exactement la même taille sera également ignoré par cette règle ; pour forcer son remplacement, supprimez-le d'abord dans Gestion Équipe ou donnez-lui un autre nom.


## Correctif des 503 sur les parties multipart

La version de correctif renouvelle l'URL S3 pré-signée de la partie après chaque tentative temporairement refusée, réessaie jusqu'à 10 fois avec un délai exponentiel pouvant atteindre 120 secondes et tient compte de `Retry-After` si l'en-tête est exposé par CORS. La concurrence des parties reste à 1. Cela améliore la reprise côté client, mais ne peut pas corriger une indisponibilité persistante du service Backblaze.

Pour exposer `Retry-After` au navigateur, exécute `METTRE-A-JOUR-CORS.ps1` dans PowerShell après avoir confirmé que le profil AWS CLI `backblaze` fonctionne. Le bucket reste privé.

Si des réponses HTTP 503 persistent après ce correctif, conserve le request ID retourné par B2 et contacte le support Backblaze. Ne partage jamais une URL pré-signée complète (`X-Amz-Signature`, `uploadId`) : elle autorise temporairement l'envoi d'une partie précise.
