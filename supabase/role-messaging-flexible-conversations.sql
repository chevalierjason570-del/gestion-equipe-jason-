-- Autoriser les conversations privées entre les contacts sélectionnés
-- pour un rôle, même lorsque les deux utilisateurs ne sont pas admin/membre.
-- Les contrôles d'accès sont réalisés par les API serveur.
drop trigger if exists direct_conversations_require_admin_member
  on public.direct_conversations;
notify pgrst, 'reload schema';
