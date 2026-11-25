import { createClient } from "@supabase/supabase-js";

export const messagingSupabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

export type MessagingUser = {
  id: string;
  username: string;
  display_name: string;
  role: string;
};

export async function authenticateMessagingRequest(request: Request): Promise<MessagingUser | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;

  const token = authorization.slice(7);
  const { data: authData, error: authError } = await messagingSupabase.auth.getUser(token);
  if (authError || !authData.user) return null;

  const { data: profile, error: profileError } = await messagingSupabase
    .from("profiles")
    .select("id, username, display_name, role")
    .eq("id", authData.user.id)
    .single();

  if (profileError || !profile) return null;

  return {
    id: authData.user.id,
    username: String(profile.username || ""),
    display_name: String(profile.display_name || profile.username || "Utilisateur"),
    role: String(profile.role || ""),
  };
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function orderedUserPair(first: string, second: string): [string, string] {
  return first < second ? [first, second] : [second, first];
}

export async function getConversationForUser(conversationId: string, user: MessagingUser) {
  const { data, error } = await messagingSupabase
    .from("direct_conversations")
    .select("id, user_a, user_b, created_at, last_message_at")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw new Error("Impossible de vérifier la conversation.");
  if (!data || (data.user_a !== user.id && data.user_b !== user.id)) return null;

  const otherUserId = data.user_a === user.id ? data.user_b : data.user_a;
  const { data: otherProfile, error: otherError } = await messagingSupabase
    .from("profiles").select("id, role").eq("id", otherUserId).maybeSingle();
  if (otherError || !otherProfile) return null;

  // L'accès est autorisé si l'un des deux utilisateurs est membre d'un rôle
  // ayant explicitement sélectionné l'autre comme contact. Cela permet au
  // contact sélectionné de répondre, sans lui ouvrir d'autres conversations.
  const { data: currentProfile } = await messagingSupabase
    .from("profiles").select("id, role").eq("id", user.id).maybeSingle();
  if (!currentProfile) return null;
  const checks = await Promise.all([
    currentProfile.role !== "admin"
      ? messagingSupabase.from("role_messaging_users").select("user_id").eq("role_key", currentProfile.role).eq("user_id", otherUserId).maybeSingle()
      : Promise.resolve({ data: { user_id: otherUserId }, error: null }),
    otherProfile.role !== "admin"
      ? messagingSupabase.from("role_messaging_users").select("user_id").eq("role_key", otherProfile.role).eq("user_id", user.id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (checks.some(result => result.error) || !checks.some(result => result.data)) return null;
  return data;
}
