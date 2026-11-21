import { createClient } from "@supabase/supabase-js";
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const B2_REGION = process.env.B2_REGION || "eu-central-003";
const B2_ENDPOINT = process.env.B2_ENDPOINT || `https://s3.${B2_REGION}.backblazeb2.com`;
const B2_ACCESS_KEY_ID = process.env.B2_ACCESS_KEY_ID;
const B2_SECRET_ACCESS_KEY = process.env.B2_SECRET_ACCESS_KEY;
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME || "gestion-equipe-jason-b2-10go";
const MAX_FREE_BYTES = 10_000_000_000;
const SOURCE_BUCKET = "fichiers-equipe";

for (const [name, value] of Object.entries({
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  B2_ENDPOINT,
  B2_ACCESS_KEY_ID,
  B2_SECRET_ACCESS_KEY,
})) {
  if (!value) {
    console.error(`Variable manquante : ${name}. Complète ton fichier .env.local.`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const s3 = new S3Client({
  region: B2_REGION,
  endpoint: B2_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: B2_ACCESS_KEY_ID,
    secretAccessKey: B2_SECRET_ACCESS_KEY,
  },
});

async function listSourceObjects() {
  const result = [];

  async function walk(prefix = "", depth = 0) {
    if (depth > 30) throw new Error(`Trop de niveaux de dossiers sous ${prefix}`);
    let offset = 0;

    while (true) {
      const { data, error } = await supabase.storage.from(SOURCE_BUCKET).list(prefix, {
        limit: 100,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`Lecture Supabase impossible (${prefix}): ${error.message}`);
      const items = data || [];

      for (const item of items) {
        const key = prefix ? `${prefix}/${item.name}` : item.name;
        if (!item.id) {
          await walk(key, depth + 1);
        } else {
          result.push({ key, size: Number(item.metadata?.size || 0), contentType: item.metadata?.mimetype || "application/octet-stream" });
        }
      }

      if (items.length < 100) break;
      offset += 100;
    }
  }

  await walk();
  return result;
}

async function getExistingB2Objects() {
  let total = 0;
  const keys = new Set();
  let continuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: B2_BUCKET_NAME,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));
    for (const item of page.Contents || []) {
      if (item.Key) keys.add(item.Key);
      total += item.Size || 0;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return { total, keys };
}

async function alreadyThere(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: B2_BUCKET_NAME, Key: key }));
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") return false;
    throw error;
  }
}

async function main() {
  console.log("Lecture de la liste des fichiers Supabase…");
  const sourceObjects = await listSourceObjects();
  const sourceBytes = sourceObjects.reduce((sum, item) => sum + item.size, 0);
  const existingB2 = await getExistingB2Objects();
  const bytesNotYetCopied = sourceObjects
    .filter(item => !existingB2.keys.has(item.key))
    .reduce((sum, item) => sum + item.size, 0);

  console.log(`Objets trouvés dans Supabase : ${sourceObjects.length}`);
  console.log(`Taille estimée à copier : ${(bytesNotYetCopied / 1e9).toFixed(2)} Go`);
  console.log(`Déjà présent dans B2 : ${(existingB2.total / 1e9).toFixed(2)} Go`);

  if (existingB2.total + bytesNotYetCopied > MAX_FREE_BYTES) {
    throw new Error(
      "La copie totale dépasserait le plafond de 10 Go fixé dans Gestion Équipe. Vérifie les fichiers et l'espace déjà utilisé dans B2 avant de migrer."
    );
  }

  let copied = 0;
  let skipped = 0;
  let copiedBytes = 0;

  for (const item of sourceObjects) {
    if (await alreadyThere(item.key)) {
      skipped += 1;
      console.log(`[${copied + skipped}/${sourceObjects.length}] Déjà présent : ${item.key}`);
      continue;
    }

    const { data: signed, error: signedError } = await supabase.storage
      .from(SOURCE_BUCKET)
      .createSignedUrl(item.key, 3600);
    if (signedError || !signed?.signedUrl) {
      throw new Error(`Impossible de lire ${item.key} depuis Supabase : ${signedError?.message || "URL absente"}`);
    }

    const response = await fetch(signed.signedUrl);
    if (!response.ok || !response.body) {
      throw new Error(`Téléchargement impossible pour ${item.key} (HTTP ${response.status}).`);
    }

    if (item.size === 0) {
      await s3.send(new PutObjectCommand({
        Bucket: B2_BUCKET_NAME,
        Key: item.key,
        Body: new Uint8Array(),
        ContentType: item.contentType,
      }));
    } else {
      const upload = new Upload({
        client: s3,
        params: {
          Bucket: B2_BUCKET_NAME,
          Key: item.key,
          Body: Readable.fromWeb(response.body),
          ContentType: response.headers.get("content-type") || item.contentType,
        },
        partSize: 64 * 1024 * 1024,
        queueSize: 2,
        leavePartsOnError: false,
      });
      await upload.done();
    }

    copied += 1;
    copiedBytes += item.size;
    console.log(`[${copied + skipped}/${sourceObjects.length}] Copié : ${item.key}`);
  }

  console.log("\nMigration terminée.");
  console.log(`Copiés : ${copied} · Déjà présents : ${skipped}`);
  console.log(`Données copiées : ${(copiedBytes / 1e9).toFixed(2)} Go`);
  console.log("Les fichiers d'origine Supabase n'ont pas été supprimés. Vérifie B2 avant tout nettoyage manuel.");
}

main().catch(error => {
  console.error("\nÉchec de la migration :", error?.message || error);
  process.exitCode = 1;
}).finally(() => s3.destroy());
