# Activation de l'envoi de fichiers jusqu'à 10 Go

Le code utilise maintenant les envois TUS de Supabase Storage. Les fichiers sont envoyés directement depuis le navigateur, en blocs de 6 Mo, avec suivi de progression et reprise d'un transfert interrompu.

## 1. Installer la dépendance

À la racine du projet, exécuter :

```bash
npm install
```

La dépendance `tus-js-client` est déjà déclarée dans `package.json`.

## 2. Appliquer la règle de sécurité Supabase

Dans le tableau de bord Supabase :

1. Ouvrir **SQL Editor**.
2. Créer une nouvelle requête.
3. Copier le contenu de `supabase/storage-admin-upload-policy.sql`.
4. Exécuter la requête.

Cette règle autorise l'envoi dans le bucket `fichiers-equipe` uniquement lorsque le profil de l'utilisateur connecté a `role = 'admin'`. Elle n'expose pas la clé `service_role` dans le navigateur.

## 3. Régler la taille maximale Supabase

Dans **Storage > Settings**, régler **Global file size limit** à au moins 10 Go. Puis ouvrir le bucket **fichiers-equipe** et vérifier que sa limite propre est également au moins 10 Go.

À la date de préparation de ce fichier, Supabase indique une limite maximale de 50 Mo sur Free et jusqu'à 500 Go sur Pro et les offres supérieures. Un fichier de 10 Go exige donc une offre qui autorise cette taille et suffisamment d'espace/quotas disponibles.

## 4. Déployer

Après l'installation et l'exécution du SQL :

```bash
npm run build
```

Puis envoyer les modifications sur le dépôt et redéployer le site. Les variables d'environnement Supabase existantes doivent rester configurées :

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (utilisée uniquement côté serveur, ne jamais la mettre dans le navigateur)

## Notes

- La limite de 10 Go est appliquée à chaque fichier, pas au total d'un dossier.
- Le téléversement d'un dossier se fait fichier par fichier, séquentiellement.
- La reprise dépend de la conservation des données de reprise du navigateur. Ne vide pas les données du site tant qu'un transfert doit être repris.
- Supabase documente TUS jusqu'à 50 Go par transfert ; le plafond global de ton projet et celui du bucket restent prioritaires.
- Le code n'a pas pu être compilé dans l'environnement de préparation, car l'installation npm a expiré et les dépendances du projet ne sont pas incluses dans le ZIP reçu. Il faut lancer les commandes ci-dessus dans ton environnement de développement.
