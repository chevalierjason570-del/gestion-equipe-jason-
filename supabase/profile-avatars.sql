-- Ajoute une photo de profil par compte.
-- Seule l'API serveur admin écrit dans cette colonne.
alter table public.profiles add column if not exists avatar_url text;
