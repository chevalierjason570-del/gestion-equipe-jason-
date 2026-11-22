import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  getB2Client,
  B2_BUCKET,
  B2_MAX_FILE_BYTES,
  B2_MAX_STORAGE_BYTES,
  B2_MULTIPART_PART_SIZE,
  B2_SINGLE_PUT_MAX_BYTES,
  validateB2Path,
} from "@/lib/b2";

export const runtime = "nodejs";
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

async function verifyAdmin(request: Request) {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, role")
    .eq("id", data.user.id)
    .single();

  if (profileError || !profile) return null;
  if (profile.role === "admin") return { id: data.user.id, role: "admin", fileRules: [] as any[] };
  const { data: definition } = await supabase.from("roles").select("permissions").eq("role_key", String(profile.role || "")).maybeSingle();
  if (!Array.isArray(definition?.permissions) || !definition.permissions.includes("fichiers_gestion")) return null;
  const { data: fileRules } = await supabase.from("role_file_rules").select("path, entry_type, access").eq("role_key", String(profile.role || ""));
  return { id: data.user.id, role: String(profile.role || ""), fileRules: fileRules || [] };
}

async function getStoredBytes(s3: ReturnType<typeof getB2Client>): Promise<number> {
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

function jsonError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  return NextResponse.json({ error: message }, { status: 400 });
}

function canUploadPath(user: { role: string; fileRules: Array<{path:string;entry_type:string;access:string}> }, path: string) {
  if (user.role === "admin") return true;
  return !user.fileRules.some(rule => rule.access === "deny" &&
    ((rule.entry_type === "folder" && (path === rule.path || path.startsWith(`${rule.path}/`))) ||
     (rule.entry_type === "file" && path === rule.path)));
}

export async function POST(request: Request) {
  const admin = await verifyAdmin(request);
  if (!admin) {
    return NextResponse.json(
      { error: "Connexion administrateur obligatoire." },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const action = String(body?.action || "");
    const s3 = getB2Client();
    const requestedKey = typeof body?.key === "string" ? validateB2Path(body.key) : "";
    const requestedPrefix = typeof body?.prefix === "string" ? body.prefix : "";
    if (requestedKey && !canUploadPath(admin, requestedKey)) return NextResponse.json({ error: "Accès interdit à cet emplacement." }, { status: 403 });
    if (requestedPrefix && !canUploadPath(admin, validateB2Path(requestedPrefix))) return NextResponse.json({ error: "Accès interdit à cet emplacement." }, { status: 403 });

    if (action === "listExisting") {
      const requestedPrefix = String(body?.prefix || "");
      const prefix = requestedPrefix ? `${validateB2Path(requestedPrefix)}/` : "";
      const objects: Array<{ key: string; size: number }> = [];
      let continuationToken: string | undefined;

      do {
        const page = await s3.send(new ListObjectsV2Command({
          Bucket: B2_BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }));
        for (const item of page.Contents || []) {
          if (item.Key) objects.push({ key: item.Key, size: item.Size || 0 });
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);

      return NextResponse.json({ objects });
    }

    if (action === "usage") {
      const usedBytes = await getStoredBytes(s3);
      return NextResponse.json({
        usedBytes,
        limitBytes: B2_MAX_STORAGE_BYTES,
        remainingBytes: Math.max(0, B2_MAX_STORAGE_BYTES - usedBytes),
      });
    }

    if (action === "init") {
      const key = validateB2Path(String(body?.key || ""));
      const size = Number(body?.size);
      const contentType = typeof body?.contentType === "string"
        ? body.contentType.slice(0, 200)
        : "application/octet-stream";
      const overwrite = body?.overwrite === true;

      if (!Number.isSafeInteger(size) || size < 0 || size > B2_MAX_FILE_BYTES) {
        return NextResponse.json(
          { error: "Le fichier doit être compris entre 0 et 10 Go." },
          { status: 400 }
        );
      }

      const folderConflict = await s3.send(new ListObjectsV2Command({
        Bucket: B2_BUCKET,
        Prefix: `${key}/`,
        MaxKeys: 1,
      }));
      if ((folderConflict.Contents || []).length > 0) {
        return NextResponse.json(
          { error: "Un dossier porte déjà ce nom. Choisis un autre nom de fichier." },
          { status: 409 }
        );
      }

      let previousSize = 0;
      let alreadyExists = false;
      try {
        const existing = await s3.send(new HeadObjectCommand({ Bucket: B2_BUCKET, Key: key }));
        alreadyExists = true;
        previousSize = existing.ContentLength || 0;
      } catch (error: any) {
        if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== "NotFound") {
          throw error;
        }
      }

      if (alreadyExists && !overwrite) {
        return NextResponse.json(
          { error: "Un fichier portant déjà ce nom existe. Renomme-le ou choisis le remplacement." },
          { status: 409 }
        );
      }

      const usedBytes = await getStoredBytes(s3);
      const projectedBytes = usedBytes - previousSize + size;
      if (projectedBytes > B2_MAX_STORAGE_BYTES) {
        return NextResponse.json({
          error: `Quota gratuit de 10 Go atteint. Utilisé : ${(usedBytes / 1e9).toFixed(2)} Go. Libère de l'espace avant d'ajouter ce fichier.`,
          usedBytes,
          limitBytes: B2_MAX_STORAGE_BYTES,
        }, { status: 413 });
      }

      if (size <= B2_SINGLE_PUT_MAX_BYTES) {
        const url = await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: B2_BUCKET,
            Key: key,
            ContentType: contentType,
          }),
          { expiresIn: 900 }
        );
        return NextResponse.json({ mode: "single", url, key, contentType });
      }

      const created = await s3.send(new CreateMultipartUploadCommand({
        Bucket: B2_BUCKET,
        Key: key,
        ContentType: contentType,
      }));

      if (!created.UploadId) {
        throw new Error("B2 n'a pas retourné d'identifiant de transfert.");
      }

      return NextResponse.json({
        mode: "multipart",
        key,
        uploadId: created.UploadId,
        partSize: B2_MULTIPART_PART_SIZE,
      });
    }

    if (action === "listParts") {
      const key = validateB2Path(String(body?.key || ""));
      const uploadId = String(body?.uploadId || "");
      if (!uploadId) throw new Error("Identifiant de transfert manquant.");
      const result = await s3.send(new ListPartsCommand({
        Bucket: B2_BUCKET,
        Key: key,
        UploadId: uploadId,
      }));
      return NextResponse.json({
        parts: (result.Parts || []).map(part => ({
          PartNumber: part.PartNumber,
          ETag: part.ETag,
        })),
      });
    }

    if (action === "signParts") {
      const key = validateB2Path(String(body?.key || ""));
      const uploadId = String(body?.uploadId || "");
      const partNumbers = body?.partNumbers;
      if (!uploadId || !Array.isArray(partNumbers) || partNumbers.length < 1 || partNumbers.length > 5) {
        throw new Error("Demande de signature des parties invalide.");
      }
      const urls = await Promise.all(partNumbers.map(async (partNumber: number) => {
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
          throw new Error("Numéro de partie invalide.");
        }
        return {
          partNumber,
          url: await getSignedUrl(
            s3,
            new UploadPartCommand({
              Bucket: B2_BUCKET,
              Key: key,
              UploadId: uploadId,
              PartNumber: partNumber,
            }),
            { expiresIn: 3600 }
          ),
        };
      }));
      return NextResponse.json({ urls });
    }

    if (action === "complete") {
      const key = validateB2Path(String(body?.key || ""));
      const uploadId = String(body?.uploadId || "");
      const parts = body?.parts;
      if (!uploadId || !Array.isArray(parts) || parts.length < 1 || parts.length > 10000) {
        throw new Error("Liste des parties terminées invalide.");
      }
      const normalizedParts = parts.map((part: any) => ({
        PartNumber: Number(part.PartNumber),
        ETag: String(part.ETag || ""),
      })).sort((a: any, b: any) => a.PartNumber - b.PartNumber);
      if (normalizedParts.some((part: any) =>
        !Number.isInteger(part.PartNumber) || part.PartNumber < 1 || !part.ETag
      )) {
        throw new Error("Une partie du fichier n'a pas été confirmée.");
      }

      const result = await s3.send(new CompleteMultipartUploadCommand({
        Bucket: B2_BUCKET,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: normalizedParts },
      }));
      return NextResponse.json({ success: true, etag: result.ETag });
    }

    if (action === "abort") {
      const key = validateB2Path(String(body?.key || ""));
      const uploadId = String(body?.uploadId || "");
      if (!uploadId) throw new Error("Identifiant de transfert manquant.");
      await s3.send(new AbortMultipartUploadCommand({
        Bucket: B2_BUCKET,
        Key: key,
        UploadId: uploadId,
      }));
      return NextResponse.json({ success: true });
    }

    throw new Error("Action de téléversement inconnue.");
  } catch (error) {
    return jsonError(error, "Erreur pendant le téléversement B2.");
  }
}
