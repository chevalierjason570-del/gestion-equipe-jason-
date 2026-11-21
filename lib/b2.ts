import { S3Client } from "@aws-sdk/client-s3";

export const B2_BUCKET = process.env.B2_BUCKET_NAME || "gestion-equipe-jason-b2-10go";
export const B2_MAX_STORAGE_BYTES = 10_000_000_000; // 10 GB décimaux, plafond de l'application
export const B2_MAX_FILE_BYTES = 10_000_000_000;
export const B2_MULTIPART_PART_SIZE = 32 * 1024 * 1024; // 32 MiB
export const B2_SINGLE_PUT_MAX_BYTES = 64 * 1024 * 1024; // petits fichiers : un seul PUT

let cachedClient: S3Client | null = null;

export function getB2Client(): S3Client {
  if (cachedClient) return cachedClient;

  const region = process.env.B2_REGION || "eu-central-003";
  const endpoint = process.env.B2_ENDPOINT || `https://s3.${region}.backblazeb2.com`;
  const accessKeyId = process.env.B2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.B2_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "Configuration Backblaze B2 incomplète. Vérifie B2_ACCESS_KEY_ID et B2_SECRET_ACCESS_KEY dans les variables d'environnement."
    );
  }

  cachedClient = new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  return cachedClient;
}

export function validateB2Segment(segment: string): string {
  const value = segment.normalize("NFC");
  if (
    !value ||
    !value.trim() ||
    value === "." ||
    value === ".." ||
    value === ".folder" ||
    /[\u0000-\u001F\u007F-\u009F/\\]/u.test(value)
  ) {
    throw new Error(`Nom de fichier ou de dossier invalide : ${segment}`);
  }
  if (Buffer.byteLength(value, "utf8") > 255) {
    throw new Error("Un nom ne peut pas dépasser 255 octets.");
  }
  return value;
}

export function validateB2Path(path: string, allowEmpty = false): string {
  if (!path && allowEmpty) return "";
  const normalized = path.normalize("NFC");
  const parts = normalized.split("/");
  if (!normalized || parts.some(part => !part)) {
    throw new Error("Chemin invalide.");
  }
  const safe = parts.map(validateB2Segment).join("/");
  if (Buffer.byteLength(safe, "utf8") > 1024) {
    throw new Error("Le chemin du fichier est trop long.");
  }
  return safe;
}

export function getB2FolderPrefix(folder: string): string {
  return folder ? `${validateB2Path(folder)}/` : "";
}
