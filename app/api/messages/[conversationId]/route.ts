import { NextResponse } from "next/server";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getB2Client, B2_BUCKET, validateB2Path } from "@/lib/b2";
import {
  authenticateMessagingRequest,
  getConversationForUser,
  isUuid,
  messagingSupabase,
} from "@/lib/messaging-server";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ conversationId: string }> };

function safeDispositionName(name: string) {
  return encodeURIComponent(name).replace(/'/g, "%27");
}

export async function GET(request: Request, context: RouteContext) {
  const user = await authenticateMessagingRequest(request);
  if (!user) return NextResponse.json({ error: "Connexion obligatoire." }, { status: 401 });
  const { conversationId } = await context.params;
  if (!isUuid(conversationId)) return NextResponse.json({ error: "Conversation invalide." }, { status: 400 });

  const conversation = await getConversationForUser(conversationId, user);
  if (!conversation) return NextResponse.json({ error: "Conversation privée introuvable. Les échanges sont réservés aux conversations entre un administrateur et un membre." }, { status: 404 });
  const viewerIsParticipant = true;

  const { data: messages, error } = await messagingSupabase
    .from("direct_messages")
    .select("id, conversation_id, sender_id, body, attachment_key, attachment_name, attachment_mime, attachment_size, message_type, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(300);

  if (error) return NextResponse.json({ error: "Impossible de charger les messages." }, { status: 500 });

  const senderIds = Array.from(new Set((messages || []).map(message => message.sender_id)));
  const { data: senderProfiles } = senderIds.length
    ? await messagingSupabase.from("profiles").select("id, username, display_name").in("id", senderIds)
    : { data: [] as Array<{ id: string; username: string; display_name: string }> };
  const senderNames = new Map((senderProfiles || []).map(profile => [profile.id, profile.display_name || profile.username || "Membre"]));

  const s3 = getB2Client();
  const result = await Promise.all((messages || []).map(async message => {
    const senderDisplayName = senderNames.get(message.sender_id) || "Membre";
    if (!message.attachment_key) return { ...message, senderDisplayName, previewUrl: null, downloadUrl: null };
    const key = validateB2Path(message.attachment_key);
    const name = safeDispositionName(message.attachment_name || "piece-jointe");
    const [previewUrl, downloadUrl] = await Promise.all([
      getSignedUrl(s3, new GetObjectCommand({
        Bucket: B2_BUCKET,
        Key: key,
        ResponseContentType: message.attachment_mime || "application/octet-stream",
        ResponseContentDisposition: `inline; filename*=UTF-8''${name}`,
      }), { expiresIn: 900 }),
      getSignedUrl(s3, new GetObjectCommand({
        Bucket: B2_BUCKET,
        Key: key,
        ResponseContentType: message.attachment_mime || "application/octet-stream",
        ResponseContentDisposition: `attachment; filename*=UTF-8''${name}`,
      }), { expiresIn: 900 }),
    ]);
    return { ...message, senderDisplayName, previewUrl, downloadUrl };
  }));

  return NextResponse.json({ messages: result, currentUserId: user.id, currentUserRole: user.role, canSend: viewerIsParticipant });
}

export async function POST(request: Request, context: RouteContext) {
  const user = await authenticateMessagingRequest(request);
  if (!user) return NextResponse.json({ error: "Connexion obligatoire." }, { status: 401 });
  const { conversationId } = await context.params;
  if (!isUuid(conversationId)) return NextResponse.json({ error: "Conversation invalide." }, { status: 400 });

  const conversation = await getConversationForUser(conversationId, user);
  if (!conversation) return NextResponse.json({ error: "Conversation privée introuvable." }, { status: 404 });

  try {
    const body = await request.json();
    const text = typeof body?.body === "string" ? body.body.trim() : "";
    const attachmentKey = body?.attachmentKey ? validateB2Path(String(body.attachmentKey)) : null;
    const attachmentName = body?.attachmentName ? String(body.attachmentName).slice(0, 255) : null;
    const attachmentMime = body?.attachmentMime ? String(body.attachmentMime).slice(0, 200) : null;
    const attachmentSize = Number(body?.attachmentSize || 0);
    const messageType = String(body?.messageType || (attachmentKey ? "file" : "text"));

    if (!text && !attachmentKey) return NextResponse.json({ error: "Écris un message ou ajoute une pièce jointe." }, { status: 400 });
    if (text.length > 5000) return NextResponse.json({ error: "Le message ne peut pas dépasser 5 000 caractères." }, { status: 400 });
    if (attachmentKey) {
      if (!attachmentKey.startsWith(`messages/${conversationId}/`) || !attachmentName || !attachmentMime || !Number.isSafeInteger(attachmentSize) || attachmentSize < 0) {
        return NextResponse.json({ error: "Pièce jointe invalide." }, { status: 400 });
      }
      const head = await getB2Client().send(new HeadObjectCommand({ Bucket: B2_BUCKET, Key: attachmentKey }));
      if ((head.ContentLength ?? -1) !== attachmentSize) {
        return NextResponse.json({ error: "La pièce jointe n'est pas complète dans le stockage." }, { status: 409 });
      }
    }
    if (!["text", "image", "audio", "file"].includes(messageType)) {
      return NextResponse.json({ error: "Type de message invalide." }, { status: 400 });
    }

    const { data: created, error } = await messagingSupabase
      .from("direct_messages")
      .insert({
        conversation_id: conversationId,
        sender_id: user.id,
        body: text,
        attachment_key: attachmentKey,
        attachment_name: attachmentName,
        attachment_mime: attachmentMime,
        attachment_size: attachmentSize,
        message_type: messageType,
      })
      .select("id, conversation_id, sender_id, body, attachment_key, attachment_name, attachment_mime, attachment_size, message_type, created_at")
      .single();

    if (error || !created) throw new Error("Impossible d'enregistrer le message.");

    await messagingSupabase
      .from("direct_conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", conversationId);

    return NextResponse.json({ message: created });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur pendant l'envoi du message." }, { status: 400 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await authenticateMessagingRequest(request);
  if (!user) return NextResponse.json({ error: "Connexion obligatoire." }, { status: 401 });
  const { conversationId } = await context.params;
  if (!isUuid(conversationId)) return NextResponse.json({ error: "Conversation invalide." }, { status: 400 });

  const conversation = await getConversationForUser(conversationId, user);
  if (!conversation) return NextResponse.json({ error: "Conversation privée introuvable." }, { status: 404 });

  try {
    const body = await request.json();
    const messageId = String(body?.messageId || "");
    if (!isUuid(messageId)) return NextResponse.json({ error: "Message invalide." }, { status: 400 });

    const { data: message, error: messageError } = await messagingSupabase
      .from("direct_messages")
      .select("id, sender_id, attachment_key")
      .eq("id", messageId)
      .eq("conversation_id", conversationId)
      .maybeSingle();

    if (messageError || !message) return NextResponse.json({ error: "Message introuvable." }, { status: 404 });
    if (user.role !== "admin" && message.sender_id !== user.id) {
      return NextResponse.json({ error: "Tu ne peux supprimer que tes propres messages." }, { status: 403 });
    }

    if (message.attachment_key) {
      await getB2Client().send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: message.attachment_key }));
    }

    const { error: deleteError } = await messagingSupabase
      .from("direct_messages")
      .delete()
      .eq("id", messageId)
      .eq("conversation_id", conversationId);
    if (deleteError) throw new Error("Impossible de supprimer le message.");

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur de suppression." }, { status: 400 });
  }
}
