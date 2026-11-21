import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getB2Client, B2_BUCKET, B2_MAX_STORAGE_BYTES, validateB2Path, validateB2Segment } from "@/lib/b2";
import { authenticateMessagingRequest, getConversationForUser, isUuid } from "@/lib/messaging-server";

export const runtime = "nodejs";
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

async function getUsedStorageBytes() {
  const s3 = getB2Client();
  let total = 0;
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: B2_BUCKET,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));
    for (const item of page.Contents || []) total += item.Size || 0;
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return total;
}

function typeForMime(mime: string): "image" | "audio" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

export async function POST(request: Request) {
  const user = await authenticateMessagingRequest(request);
  if (!user) return NextResponse.json({ error: "Connexion obligatoire." }, { status: 401 });

  try {
    const body = await request.json();
    const conversationId = String(body?.conversationId || "");
    const originalName = String(body?.fileName || "");
    const size = Number(body?.size);
    const mime = String(body?.contentType || "application/octet-stream").slice(0, 200);

    if (!isUuid(conversationId) || !await getConversationForUser(conversationId, user)) {
      return NextResponse.json({ error: "Conversation privée introuvable." }, { status: 404 });
    }
    if (!originalName || !Number.isSafeInteger(size) || size < 1 || size > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json({ error: "Une pièce jointe doit faire entre 1 octet et 100 Mo." }, { status: 400 });
    }
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+)*$/i.test(mime)) {
      return NextResponse.json({ error: "Type de fichier invalide." }, { status: 400 });
    }

    const used = await getUsedStorageBytes();
    if (used + size > B2_MAX_STORAGE_BYTES) {
      return NextResponse.json({ error: "Le quota global de stockage de 10 Go est atteint." }, { status: 413 });
    }

    const cleanName = validateB2Segment(originalName);
    const key = validateB2Path(`messages/${conversationId}/${randomUUID()}/${cleanName}`);
    const url = await getSignedUrl(
      getB2Client(),
      new PutObjectCommand({ Bucket: B2_BUCKET, Key: key, ContentType: mime }),
      { expiresIn: 900 }
    );

    return NextResponse.json({ key, url, contentType: mime, messageType: typeForMime(mime), maxBytes: MAX_ATTACHMENT_BYTES });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Impossible de préparer la pièce jointe." }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const user = await authenticateMessagingRequest(request);
  if (!user) return NextResponse.json({ error: "Connexion obligatoire." }, { status: 401 });

  try {
    const body = await request.json();
    const conversationId = String(body?.conversationId || "");
    const key = validateB2Path(String(body?.key || ""));
    if (!isUuid(conversationId) || !await getConversationForUser(conversationId, user)) {
      return NextResponse.json({ error: "Conversation privée introuvable." }, { status: 404 });
    }
    if (!key.startsWith(`messages/${conversationId}/`)) {
      return NextResponse.json({ error: "Chemin de pièce jointe invalide." }, { status: 400 });
    }
    await getB2Client().send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: key }));
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Impossible de supprimer la pièce jointe temporaire." }, { status: 400 });
  }
}
