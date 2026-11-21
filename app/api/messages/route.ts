import { NextResponse } from "next/server";
import {
  authenticateMessagingRequest,
  messagingSupabase,
  orderedUserPair,
  isUuid,
} from "@/lib/messaging-server";

export const runtime = "nodejs";

/**
 * Règle de messagerie :
 * - un membre standard peut uniquement démarrer une conversation avec un admin ;
 * - un admin peut uniquement démarrer une conversation avec un membre non-admin ;
 * - aucune conversation membre ↔ membre ou admin ↔ admin n'est autorisée.
 */
export async function GET(request: Request) {
  const user = await authenticateMessagingRequest(request);
  if (!user) return NextResponse.json({ error: "Connexion obligatoire." }, { status: 401 });

  let contactsQuery = messagingSupabase
    .from("profiles")
    .select("id, username, display_name, role")
    .neq("id", user.id)
    .order("display_name", { ascending: true });

  // L'admin voit les membres à contacter ; un membre ne voit que les admins.
  contactsQuery = user.role === "admin"
    ? contactsQuery.neq("role", "admin")
    : contactsQuery.eq("role", "admin");

  const { data: contacts, error: contactsError } = await contactsQuery;
  if (contactsError) {
    return NextResponse.json({ error: "Impossible de charger les contacts autorisés." }, { status: 500 });
  }

  // Une conversation doit toujours contenir le compte connecté.
  const { data: candidateConversations, error: conversationsError } = await messagingSupabase
    .from("direct_conversations")
    .select("id, user_a, user_b, created_at, last_message_at")
    .or(`user_a.eq.${user.id},user_b.eq.${user.id}`)
    .order("last_message_at", { ascending: false });

  if (conversationsError) {
    return NextResponse.json({ error: "Impossible de charger les conversations. Vérifie que supabase/messaging.sql a été exécuté." }, { status: 500 });
  }

  // Filtre aussi les anciennes conversations qui auraient été créées avant
  // l'application de la règle admin ↔ membre.
  const allowedContactIds = new Set((contacts || []).map(contact => contact.id));
  const conversations = (candidateConversations || []).filter(conversation => {
    const otherId = conversation.user_a === user.id ? conversation.user_b : conversation.user_a;
    return allowedContactIds.has(otherId);
  });

  const conversationIds = conversations.map(item => item.id);
  let lastMessages: any[] = [];
  if (conversationIds.length) {
    const { data, error } = await messagingSupabase
      .from("direct_messages")
      .select("id, conversation_id, sender_id, body, attachment_name, message_type, created_at")
      .in("conversation_id", conversationIds)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return NextResponse.json({ error: "Impossible de charger les derniers messages." }, { status: 500 });
    lastMessages = data || [];
  }

  const lastByConversation = new Map<string, any>();
  for (const message of lastMessages) {
    if (!lastByConversation.has(message.conversation_id)) lastByConversation.set(message.conversation_id, message);
  }

  const profileMap = new Map((contacts || []).map(contact => [contact.id, contact]));
  const conversationSummaries = conversations.map(conversation => {
    const otherId = conversation.user_a === user.id ? conversation.user_b : conversation.user_a;
    const other = profileMap.get(otherId)!;
    const lastMessage = lastByConversation.get(conversation.id);
    return {
      id: conversation.id,
      title: other.display_name || other.username || (other.role === "admin" ? "Administrateur" : "Membre"),
      otherUser: other,
      canSend: true,
      lastMessage: lastMessage
        ? (lastMessage.body || (lastMessage.message_type === "image" ? "Photo" : lastMessage.message_type === "audio" ? "Message vocal" : lastMessage.attachment_name || "Fichier"))
        : "Aucun message pour le moment",
      lastMessageAt: lastMessage?.created_at || conversation.last_message_at,
    };
  });

  return NextResponse.json({
    currentUser: { id: user.id, role: user.role, display_name: user.display_name },
    contacts: contacts || [],
    conversations: conversationSummaries,
  });
}

export async function POST(request: Request) {
  const user = await authenticateMessagingRequest(request);
  if (!user) return NextResponse.json({ error: "Connexion obligatoire." }, { status: 401 });

  try {
    const body = await request.json();
    const targetUserId = String(body?.targetUserId || "");
    if (!isUuid(targetUserId) || targetUserId === user.id) {
      return NextResponse.json({ error: "Contact invalide." }, { status: 400 });
    }

    const { data: target, error: targetError } = await messagingSupabase
      .from("profiles")
      .select("id, role")
      .eq("id", targetUserId)
      .maybeSingle();
    if (targetError || !target) return NextResponse.json({ error: "Utilisateur introuvable." }, { status: 404 });

    const userIsAdmin = user.role === "admin";
    const targetIsAdmin = target.role === "admin";
    if (userIsAdmin === targetIsAdmin) {
      return NextResponse.json({
        error: userIsAdmin
          ? "Un administrateur peut démarrer une conversation uniquement avec un membre."
          : "Tu peux uniquement démarrer une conversation privée avec l'administrateur.",
      }, { status: 403 });
    }

    const [userA, userB] = orderedUserPair(user.id, targetUserId);
    const { data: existing, error: existingError } = await messagingSupabase
      .from("direct_conversations")
      .select("id, user_a, user_b, created_at, last_message_at")
      .eq("user_a", userA)
      .eq("user_b", userB)
      .maybeSingle();

    if (existingError) throw new Error("Impossible de vérifier la conversation.");
    if (existing) return NextResponse.json({ conversation: existing, existing: true });

    const { data: created, error: createError } = await messagingSupabase
      .from("direct_conversations")
      .insert({ user_a: userA, user_b: userB, created_by: user.id })
      .select("id, user_a, user_b, created_at, last_message_at")
      .single();

    if (createError) {
      const { data: raced } = await messagingSupabase
        .from("direct_conversations")
        .select("id, user_a, user_b, created_at, last_message_at")
        .eq("user_a", userA)
        .eq("user_b", userB)
        .maybeSingle();
      if (raced) return NextResponse.json({ conversation: raced, existing: true });
      throw new Error("Impossible de créer la conversation.");
    }

    return NextResponse.json({ conversation: created, existing: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur de création." }, { status: 400 });
  }
}
