import { NextResponse } from "next/server";
import { Buffer } from "node:buffer";
import { PassThrough, Readable } from "node:stream";
import * as archiverNamespace from "archiver";
import { createClient } from "@supabase/supabase-js";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getB2Client, B2_BUCKET, B2_MAX_STORAGE_BYTES, validateB2Path, validateB2Segment } from "@/lib/b2";

export const runtime = "nodejs";
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

async function verifyUser(request: Request, submittedToken?: string) {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : submittedToken;
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, role")
    .eq("id", data.user.id)
    .single();
  if (profileError || !profile) return null;

  return { id: data.user.id, role: String(profile.role || "standard") };
}

function safeFolderPath(value: string, allowEmpty = false) {
  return validateB2Path(value, allowEmpty);
}

async function listAllObjects(prefix: string) {
  const s3 = getB2Client();
  const objects: Array<{ Key: string; Size: number; LastModified?: Date; ContentType?: string }> = [];
  let continuationToken: string | undefined;

  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: B2_BUCKET,
      Prefix: prefix || undefined,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));

    for (const item of page.Contents || []) {
      if (item.Key) {
        objects.push({
          Key: item.Key,
          Size: item.Size || 0,
          LastModified: item.LastModified,
        });
      }
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

async function listFolderEntries(folder: string) {
  const s3 = getB2Client();
  const prefix = folder ? `${folder}/` : "";
  const folders = new Set<string>();
  const files: Array<{ key: string; size: number; lastModified?: Date }> = [];
  let continuationToken: string | undefined;

  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: B2_BUCKET,
      Prefix: prefix || undefined,
      Delimiter: "/",
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));

    for (const common of page.CommonPrefixes || []) {
      if (!common.Prefix) continue;
      const withoutPrefix = common.Prefix.slice(prefix.length).replace(/\/$/, "");
      if (withoutPrefix && !withoutPrefix.includes("/")) folders.add(withoutPrefix);
    }

    for (const item of page.Contents || []) {
      if (!item.Key) continue;
      const relative = item.Key.slice(prefix.length);
      if (!relative || relative === ".folder" || relative.endsWith("/.folder")) continue;
      if (relative.includes("/")) continue;
      files.push({
        key: item.Key,
        size: item.Size || 0,
        lastModified: item.LastModified,
      });
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  const s3Client = getB2Client();
  const folderEntries = Array.from(folders).map(name => ({
    name,
    path: folder ? `${folder}/${name}` : name,
    type: "folder" as const,
  }));

  const fileEntries = await Promise.all(files.map(async file => {
    const name = file.key.slice(prefix.length);
    const dispositionName = encodeURIComponent(name).replace(/'/g, "%27");
    const [previewUrl, downloadUrl] = await Promise.all([
      getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: B2_BUCKET,
          Key: file.key,
          ResponseContentDisposition: `inline; filename*=UTF-8''${dispositionName}`,
        }),
        { expiresIn: 3600 }
      ),
      getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: B2_BUCKET,
          Key: file.key,
          ResponseContentDisposition: `attachment; filename*=UTF-8''${dispositionName}`,
        }),
        { expiresIn: 3600 }
      ),
    ]);

    return {
      name,
      path: file.key,
      type: "file" as const,
      size: file.size,
      created_at: file.lastModified?.toISOString() || null,
      previewUrl,
      downloadUrl,
    };
  }));

  return [...folderEntries, ...fileEntries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name, "fr", { sensitivity: "base" });
  });
}

async function getTotalStorageBytes() {
  const objects = await listAllObjects("");
  return objects.reduce((sum, item) => sum + item.Size, 0);
}

function encodeCopySource(bucket: string, key: string) {
  return `${bucket}/${key.split("/").map(part => encodeURIComponent(part)).join("/")}`;
}

async function entryExists(path: string, _type: "file" | "folder") {
  const s3 = getB2Client();
  let exactExists = false;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: B2_BUCKET, Key: path }));
    exactExists = true;
  } catch (error: any) {
    if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== "NotFound") throw error;
  }

  const page = await s3.send(new ListObjectsV2Command({
    Bucket: B2_BUCKET,
    Prefix: `${path}/`,
    MaxKeys: 1,
  }));
  return exactExists || (page.Contents || []).length > 0;
}

async function deleteKeys(keys: string[]) {
  const s3 = getB2Client();
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    if (batch.length === 1) {
      await s3.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: batch[0] }));
    } else if (batch.length > 1) {
      const result = await s3.send(new DeleteObjectsCommand({
        Bucket: B2_BUCKET,
        Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true },
      }));
      if (result.Errors?.length) {
        throw new Error(`Suppression partielle : ${result.Errors[0].Message || result.Errors[0].Key}`);
      }
    }
  }
}

async function copySingleObject(source: string, target: string) {
  const s3 = getB2Client();
  const head = await s3.send(new HeadObjectCommand({ Bucket: B2_BUCKET, Key: source }));
  const size = head.ContentLength || 0;
  const copySource = encodeCopySource(B2_BUCKET, source);
  const maxSingleCopyBytes = 5 * 1024 * 1024 * 1024;

  if (size <= maxSingleCopyBytes) {
    await s3.send(new CopyObjectCommand({
      Bucket: B2_BUCKET,
      Key: target,
      CopySource: copySource,
    }));
    return;
  }

  // Copy multipart côté B2 pour pouvoir renommer/déplacer aussi les objets > 5 GiB.
  const created = await s3.send(new CreateMultipartUploadCommand({
    Bucket: B2_BUCKET,
    Key: target,
    ContentType: head.ContentType || "application/octet-stream",
  }));
  if (!created.UploadId) throw new Error(`Impossible de démarrer la copie de ${source}.`);

  const uploadId = created.UploadId;
  const partSize = 5 * 1024 * 1024 * 1024;
  const partCount = Math.ceil(size / partSize);
  const parts: Array<{ PartNumber: number; ETag: string }> = [];

  try {
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const start = (partNumber - 1) * partSize;
      const end = Math.min(size - 1, start + partSize - 1);
      const copied = await s3.send(new UploadPartCopyCommand({
        Bucket: B2_BUCKET,
        Key: target,
        UploadId: uploadId,
        PartNumber: partNumber,
        CopySource: copySource,
        CopySourceRange: `bytes=${start}-${end}`,
      }));
      const etag = copied.CopyPartResult?.ETag;
      if (!etag) throw new Error(`B2 n'a pas confirmé la partie ${partNumber} de ${source}.`);
      parts.push({ PartNumber: partNumber, ETag: etag });
    }

    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: B2_BUCKET,
      Key: target,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }));
  } catch (error) {
    await s3.send(new AbortMultipartUploadCommand({
      Bucket: B2_BUCKET,
      Key: target,
      UploadId: uploadId,
    })).catch(() => undefined);
    throw error;
  }
}

async function copyEntry(sourcePath: string, targetPath: string, type: "file" | "folder") {
  const sourceObjects = type === "file"
    ? [{ Key: sourcePath }]
    : await listAllObjects(`${sourcePath}/`);

  if (sourceObjects.length === 0) {
    throw new Error("Cet élément est vide ou n'existe plus.");
  }

  if (type === "folder" && targetPath.startsWith(`${sourcePath}/`)) {
    throw new Error("Un dossier ne peut pas être déplacé à l'intérieur de lui-même.");
  }

  const targets = sourceObjects.map(item => ({
    source: item.Key,
    target: type === "file"
      ? targetPath
      : `${targetPath}${item.Key.slice(sourcePath.length)}`,
  }));

  for (const entry of targets) {
    if (await entryExists(entry.target, "file")) {
      throw new Error(`Un fichier ou dossier existe déjà à cet emplacement : ${entry.target}`);
    }
  }

  const copied: string[] = [];
  try {
    for (const item of targets) {
      await copySingleObject(item.source, item.target);
      copied.push(item.target);
    }
  } catch (error) {
    if (copied.length) await deleteKeys(copied).catch(() => undefined);
    throw error;
  }

  await deleteKeys(targets.map(item => item.source));
  return { moved: targets.length };
}

async function createFolderZipResponse(folderPath: string): Promise<Response> {
  const s3 = getB2Client();
  const prefix = `${folderPath}/`;
  const objects = await listAllObjects(prefix);
  if (objects.length === 0) {
    throw new Error("Ce dossier est vide ou n'existe plus.");
  }

  const rootName = folderPath.split("/").filter(Boolean).pop() || "fichiers";
  const archiveFactory = (archiverNamespace as unknown as { default?: (format: string, options: object) => any }).default
    || (archiverNamespace as unknown as (format: string, options: object) => any);
  const archive = archiveFactory("zip", { zlib: { level: 0 } });
  const output = new PassThrough();

  archive.on("warning", (error: Error) => output.destroy(error));
  archive.on("error", (error: Error) => output.destroy(error));
  archive.pipe(output);

  void (async () => {
    try {
      const explicitFolders = new Set<string>([`${rootName}/`]);
      for (const item of objects) {
        const relativePath = item.Key.slice(prefix.length);
        if (relativePath === ".folder" || relativePath.endsWith("/.folder")) {
          const folderRelative = relativePath === ".folder"
            ? ""
            : relativePath.slice(0, -"/.folder".length);
          explicitFolders.add(folderRelative ? `${rootName}/${folderRelative}/` : `${rootName}/`);
        }
      }
      for (const folderName of explicitFolders) {
        archive.append(Buffer.alloc(0), { name: folderName });
      }

      for (const item of objects) {
        const relativePath = item.Key.slice(prefix.length);
        if (!relativePath || relativePath === ".folder" || relativePath.endsWith("/.folder")) continue;

        const response = await s3.send(new GetObjectCommand({ Bucket: B2_BUCKET, Key: item.Key }));
        if (!response.Body) throw new Error(`Impossible de lire ${relativePath}.`);
        const source = response.Body as unknown as Readable;
        const consumed = new Promise<void>((resolve, reject) => {
          source.once("end", resolve);
          source.once("error", reject);
        });
        archive.append(source, { name: `${rootName}/${relativePath}` });
        await consumed;
      }
      await archive.finalize();
    } catch (error) {
      archive.abort();
      output.destroy(error instanceof Error ? error : new Error("Erreur pendant la création du ZIP."));
    }
  })();

  const asciiName = `${rootName.replace(/[^A-Za-z0-9_-]/g, "_") || "fichiers"}.zip`;
  const utf8Name = encodeURIComponent(`${rootName}.zip`);
  return new Response(Readable.toWeb(output) as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
      "Cache-Control": "no-store",
    },
  });
}

// LISTER LES FICHIERS, DOSSIERS ET L'UTILISATION DU QUOTA B2.
export async function GET(request: Request) {
  const user = await verifyUser(request);
  if (!user) {
    return NextResponse.json({ error: "Connexion obligatoire." }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    if (searchParams.has("downloadFolder")) {
      const folderPath = safeFolderPath(searchParams.get("downloadFolder") || "");
      return await createFolderZipResponse(folderPath);
    }

    const folder = safeFolderPath(searchParams.get("folder") || "", true);
    const [files, usedBytes] = await Promise.all([
      listFolderEntries(folder),
      getTotalStorageBytes(),
    ]);

    return NextResponse.json({
      files,
      role: user.role,
      storage: {
        usedBytes,
        limitBytes: B2_MAX_STORAGE_BYTES,
        remainingBytes: Math.max(0, B2_MAX_STORAGE_BYTES - usedBytes),
      },
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Impossible de charger les fichiers B2.",
    }, { status: 500 });
  }
}

// CRÉER UN DOSSIER OU PRÉPARER LE TÉLÉCHARGEMENT D'UN DOSSIER ZIP.
export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const action = String(formData.get("action") || "");
    const submittedToken = formData.get("accessToken");
    const user = await verifyUser(
      request,
      typeof submittedToken === "string" ? submittedToken : undefined
    );
    if (!user) {
      return NextResponse.json({ error: "Connexion obligatoire." }, { status: 401 });
    }

    const rawFolder = String(formData.get("folder") || "");
    const folder = safeFolderPath(rawFolder, true);

    if (action === "download_folder") {
      if (!folder) {
        return NextResponse.json({ error: "Dossier à télécharger invalide." }, { status: 400 });
      }
      return await createFolderZipResponse(folder);
    }

    if (user.role !== "admin") {
      return NextResponse.json({ error: "Seuls les administrateurs peuvent créer des dossiers." }, { status: 403 });
    }

    if (action !== "create_folder") {
      return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
    }

    const name = String(formData.get("name") || "").normalize("NFC").trim();
    if (!name || Array.from(name).length > 60) {
      return NextResponse.json({ error: "Le nom du dossier doit contenir entre 1 et 60 caractères." }, { status: 400 });
    }
    const safeName = validateB2Segment(name);
    const path = folder ? `${folder}/${safeName}` : safeName;
    const s3 = getB2Client();

    if (await entryExists(path, "folder")) {
      return NextResponse.json({ error: "Un fichier ou dossier porte déjà ce nom." }, { status: 409 });
    }

    await s3.send(new PutObjectCommand({
      Bucket: B2_BUCKET,
      Key: `${path}/.folder`,
      Body: new Uint8Array(),
      ContentType: "application/x-directory",
    }));
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Erreur lors du traitement du dossier.",
    }, { status: 500 });
  }
}

// SUPPRIMER UN FICHIER OU UN DOSSIER COMPLET.
export async function DELETE(request: Request) {
  const user = await verifyUser(request);
  if (!user) return NextResponse.json({ error: "Connexion obligatoire." }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Seuls les administrateurs peuvent supprimer des fichiers." }, { status: 403 });
  }

  try {
    const body = await request.json();
    const path = safeFolderPath(String(body?.path || ""));
    const type = body?.type;
    if (type !== "file" && type !== "folder") {
      return NextResponse.json({ error: "Type d'élément invalide." }, { status: 400 });
    }

    const objects = type === "folder"
      ? await listAllObjects(`${path}/`)
      : [{ Key: path, Size: 0 }];
    if (objects.length === 0) {
      return NextResponse.json({ error: "Cet élément n'existe plus." }, { status: 404 });
    }

    await deleteKeys(objects.map(item => item.Key));
    return NextResponse.json({ success: true, deleted: objects.length });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Erreur lors de la suppression.",
    }, { status: 500 });
  }
}

// RENOMMER OU DÉPLACER UN FICHIER / DOSSIER.
export async function PATCH(request: Request) {
  const user = await verifyUser(request);
  if (!user) return NextResponse.json({ error: "Connexion obligatoire." }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Seuls les administrateurs peuvent organiser les fichiers." }, { status: 403 });
  }

  try {
    const body = await request.json();
    const path = safeFolderPath(String(body?.path || ""));
    const type = body?.type;
    const action = body?.action;
    if (type !== "file" && type !== "folder") {
      return NextResponse.json({ error: "Type d'élément invalide." }, { status: 400 });
    }

    let targetPath: string;
    if (action === "rename") {
      const name = String(body?.name || "").normalize("NFC").trim();
      if (!name || name.length > 255) throw new Error("Nouveau nom invalide.");
      const safeName = validateB2Segment(name);
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      targetPath = parent ? `${parent}/${safeName}` : safeName;
    } else if (action === "move") {
      const destination = safeFolderPath(String(body?.destinationFolder || ""), true);
      const baseName = path.slice(path.lastIndexOf("/") + 1);
      targetPath = destination ? `${destination}/${baseName}` : baseName;
    } else {
      return NextResponse.json({ error: "Action inconnue. Utilise rename ou move." }, { status: 400 });
    }

    if (targetPath === path) return NextResponse.json({ success: true, unchanged: true });
    if (type === "folder" && targetPath.startsWith(`${path}/`)) {
      return NextResponse.json({ error: "Tu ne peux pas déplacer un dossier à l'intérieur de lui-même." }, { status: 400 });
    }
    if (await entryExists(targetPath, type)) {
      return NextResponse.json({ error: "Un fichier ou dossier porte déjà ce nom à cet emplacement." }, { status: 409 });
    }

    const result = await copyEntry(path, targetPath, type);
    return NextResponse.json({ success: true, targetPath, moved: result.moved });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Erreur lors du renommage ou du déplacement.",
    }, { status: 500 });
  }
}
