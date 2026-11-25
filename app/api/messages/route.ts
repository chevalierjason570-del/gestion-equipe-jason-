import { NextResponse } from "next/server";
import {
  authenticateMessagingRequest,
  messagingSupabase,
  orderedUserPair,
  isUuid,
} from "@/lib/messaging-server";

export const runtime = "nodejs";

type DbError = { code?: string; message?: string; details?: string; hint?: string };

function describeDatabaseError(context: string, error: DbError) {
  const code = error.code || "DB_ERROR";
  const message = error.message || "Erreur inconnue de la base de données.";

  if (code === "42P01" || code === "PGRST205") {
    return `${context} : table de messagerie introuvable. Ouvre Supabase > SQL Editor et exécute entièrement supabase/messaging.sql, puis actualise la page.`;
  }
  if (code === "42703" || code === "PGRST204") {
    return `${context} : une colonne de la messagerie manque (${message}). Réexécute le script de mise à jour supabase/messaging.sql fourni avec le projet.`;
  }
  if (code === "42501") {
    return `${context} : permission refusée. Vérifie que SUPABASE_SERVICE_ROLE_KEY est définie dans Vercel et que le site a été redéployé.`;
  }
  return `${context} (${code}) : ${message}`;
}

/**
 * GET renvoie toujours la liste de contacts autorisés.
 * Pour un administrateur, contacts contient TOUS les comptes non-admin,
 * avec un indicateur de présence d'une conversation individuelle.
 * Pour un membre, contacts contient uniquement les comptes administrateur.
 */
export async function GET(request: Request) {
  const user = await authenticateMessagingRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Connexion obligatoire. Reconnecte-toi à Gestion Équipe." }, { status: 401 });
  }

  const isAdmin = user.role === "admin";

  // Administrateur : afficher tous les membres. Membre : afficher uniquement l'administrateur.
  let contactsQuery = messagingSupabase
    .from("profiles")
    .select("id, username, display_name, role")
    .neq("id", user.id)
    .order("display_name", { ascending: true });

  contactsQuery = isAdmin
    ? contactsQuery.neq("role", "admin")
    : contactsQuery.eq("role", "admin");

  const { data: initialContacts, error: contactsError } = await contactsQuery;
  let contacts = initialContacts || [];
  if (contactsError) {
    return NextResponse.json({
      error: describeDatabaseError("Impossible de charger la liste des utilisateurs", contactsError),
      databaseCode: contactsError.code || null,
    }, { status: 500 });
  }

  // Filtrage des contacts selon les autorisations individuelles configurées pour chaque rôle.
  const contactRows = contacts || [];
  if (isAdmin && contactRows.length) {
    const roleKeys = [...new Set(contactRows.map(contact => contact.role).filter(Boolean))];
    const { data: rules, error: rulesError } = await messagingSupabase.from("role_messaging_users").select("role_key, user_id").in("role_key", roleKeys);
    if (rulesError) return NextResponse.json({ error: "Les règles de messagerie par rôle ne sont pas installées. Exécute supabase/role-messaging-users.sql." }, { status: 503 });
    const allowed = new Set((rules || []).map(row => `${row.role_key}:${row.user_id}`));
    contacts = contactRows.filter(contact => allowed.has(`${contact.role}:${contact.id}`));
  } else if (!isAdmin) {
    const { data: rules, error: rulesError } = await messagingSupabase.from("role_messaging_users").select("user_id").eq("role_key", user.role).eq("user_id", user.id).maybeSingle();
    if (rulesError) return NextResponse.json({ error: "Les règles de messagerie par rôle ne sont pas installées. Exécute supabase/role-messaging-users.sql." }, { status: 503 });
    if (!rules) contacts = [];
  }

  const { data: candidateConversations, error: conversationsError } = await messagingSupabase
    .from("direct_conversations")
    .select("id, user_a, user_b, created_at, last_message_at")
    .or(`user_a.eq.${user.id},user_b.eq.${user.id}`)
    .order("last_message_at", { ascending: false });

  // Si les tables ne sont pas encore créées, on laisse malgré tout l'admin voir
  // la liste complète des membres, avec un avertissement explicite.
  if (conversationsError) {
    const warning = describeDatabaseError("La liste des utilisateurs est chargée, mais les conversations ne sont pas disponibles", conversationsError);
    if (conversationsError.code === "42P01" || conversationsError.code === "PGRST205" || conversationsError.code === "42703" || conversationsError.code === "PGRST204") {
      return NextResponse.json({
        currentUser: { id: user.id, role: user.role, display_name: user.display_name },
        contacts: (contacts || []).map(contact => ({ ...contact, hasConversation: false, conversationId: null, lastMessage: "Conversation à créer", lastMessageAt: null })),
        conversations: [],
        setupWarning: warning,
      });
    }
    return NextResponse.json({ error: warning, databaseCode: conversationsError.code || null }, { status: 500 });
  }

  const allowedContactIds = new Set((contacts || []).map(contact => contact.id));
  const conversations = (candidateConversations || []).filter(conversation => {
    const otherId = conversation.user_a === user.id ? conversation.user_b : conversation.user_a;
    return allowedContactIds.has(otherId);
  });

  const conversationIds = conversations.map(item => item.id);
  let lastMessages: any[] = [];
  let setupWarning = "";
  if (conversationIds.length) {
    const { data, error } = await messagingSupabase
      .from("direct_messages")
      .select("id, conversation_id, sender_id, body, attachment_name, message_type, created_at")
      .in("conversation_id", conversationIds)
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) {
      setupWarning = describeDatabaseError("Les conversations sont chargées, mais les messages ne peuvent pas être lus", error);
    } else {
      lastMessages = data || [];
    }
  }

  const lastByConversation = new Map<string, any>();
  for (const message of lastMessages) {
    if (!lastByConversation.has(message.conversation_id)) {
      lastByConversation.set(message.conversation_id, message);
    }
  }

  const profileMap = new Map((contacts || []).map(contact => [contact.id, contact]));
  const conversationByUser = new Map<string, (typeof conversations)[number]>();
  for (const conversation of conversations) {
    const otherId = conversation.user_a === user.id ? conversation.user_b : conversation.user_a;
    conversationByUser.set(otherId, conversation);
  }

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

  // Pour l'administrateur, chaque utilisateur apparaît dans la liste, même
  // s'il n'a pas encore de conversation. Cliquer dessus créera son échange privé.
  const contactsWithConversation = (contacts || []).map(contact => {
    const conversation = conversationByUser.get(contact.id);
    const lastMessage = conversation ? lastByConversation.get(conversation.id) : null;
    return {
      ...contact,
      hasConversation: Boolean(conversation),
      conversationId: conversation?.id || null,
      lastMessage: lastMessage
        ? (lastMessage.body || (lastMessage.message_type === "image" ? "Photo" : lastMessage.message_type === "audio" ? "Message vocal" : lastMessage.attachment_name || "Fichier"))
        : conversation ? "Conversation ouverte · aucun message" : "Aucune conversation · cliquer pour démarrer",
      lastMessageAt: lastMessage?.created_at || conversation?.last_message_at || null,
    };
  });

  return NextResponse.json({
    currentUser: { id: user.id, role: user.role, display_name: user.display_name },
    contacts: contactsWithConversation,
    // Alias explicite pour le panneau administrateur.
    ...(isAdmin ? { users: contactsWithConversation } : {}),
    conversations: conversationSummaries,
    setupWarning: setupWarning || null,
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
    const permissionRole = userIsAdmin ? target.role : user.role;
    const permissionUserId = userIsAdmin ? targetUserId : user.id;
    const { data: permission, error: permissionError } = await messagingSupabase.from("role_messaging_users").select("user_id").eq("role_key", permissionRole).eq("user_id", permissionUserId).maybeSingle();
    if (permissionError) return NextResponse.json({ error: "Les règles de messagerie par rôle ne sont pas installées." }, { status: 503 });
    if (!permission) return NextResponse.json({ error: "La messagerie avec cet utilisateur n'est pas autorisée pour ce rôle." }, { status: 403 });
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

    if (existingError) {
      return NextResponse.json({
        error: describeDatabaseError("Impossible de vérifier la conversation", existingError),
        databaseCode: existingError.code || null,
      }, { status: 500 });
    }
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
      return NextResponse.json({
        error: describeDatabaseError("Impossible de créer la conversation", createError),
        databaseCode: createError.code || null,
      }, { status: 500 });
    }

    return NextResponse.json({ conversation: created, existing: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur de création." }, { status: 400 });
  }
}
