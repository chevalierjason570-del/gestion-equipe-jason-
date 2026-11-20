
import { NextResponse } from "next/server";
import { Buffer } from "node:buffer";
import { PassThrough, Readable } from "node:stream";
import archiver from "archiver";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BUCKET = "fichiers-equipe";

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

  return {
    id: data.user.id,
    role: profile.role,
  };
}

// Autorise les noms en Unicode, chiffres, espaces et ponctuation imprimable.
// Refuse les caractères de contrôle, les séparateurs ambigus et les traversées.
function validStorageSegment(segment: string) {
  const normalized = segment.normalize("NFC");

  return (
    normalized.length > 0 &&
    normalized.trim().length > 0 &&
    normalized !== "." &&
    normalized !== ".." &&
    normalized !== ".folder" &&
    !/[\u0000-\u001F\u007F-\u009F/\\]/u.test(normalized)
  );
}

function validFolder(folder: string) {
  return (
    folder === "" ||
    folder.split("/").every(part => validStorageSegment(part))
  );
}

function validStoragePath(path: string) {
  const parts = path.split("/");
  return parts.length > 0 && parts.every(part => validStorageSegment(part));
}

function parentStoragePath(path: string) {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}

function joinStoragePath(...parts: string[]) {
  return parts.filter(Boolean).join("/");
}

async function storageEntryExists(path: string): Promise<boolean> {
  const parent = parentStoragePath(path);
  const name = path.slice(parent ? parent.length + 1 : 0);
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(parent, { search: name, limit: 100 });

  if (error) throw new Error(`Impossible de vérifier la destination : ${error.message}`);
  return (data || []).some(item => item.name === name);
}

async function storageFolderExists(path: string): Promise<boolean> {
  if (!path) return true;
  const parts = path.split("/");
  let current = "";

  for (const part of parts) {
    current = joinStoragePath(current, part);
    if (!(await storageEntryExists(current))) return false;
  }

  return true;
}

// Récupère récursivement tous les objets d'un dossier, y compris les marqueurs .folder.
async function collectStorageObjects(folderPath: string): Promise<string[]> {
  const objects: string[] = [];
  const pageSize = 100;

  async function walk(prefix: string, depth: number): Promise<void> {
    if (depth > 30) throw new Error("Le dossier contient trop de niveaux imbriqués.");

    let offset = 0;
    while (true) {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .list(prefix, {
          limit: pageSize,
          offset,
          sortBy: { column: "name", order: "asc" },
        });

      if (error) throw new Error(`Impossible de lire le dossier ${prefix} : ${error.message}`);
      const items = data || [];

      for (const item of items) {
        const objectPath = joinStoragePath(prefix, item.name);
        if (!item.id) {
          await walk(objectPath, depth + 1);
        } else {
          objects.push(objectPath);
        }
      }

      if (items.length < pageSize) break;
      offset += pageSize;
    }
  }

  await walk(folderPath, 0);
  return objects;
}

// Fabrique un ZIP en flux continu : les fichiers ne sont pas chargés tous ensemble
// en mémoire. Le téléchargement est disponible à tout membre authentifié.
async function createFolderZipResponse(folderPath: string): Promise<Response> {
  const objectPaths = await collectStorageObjects(folderPath);
  const rootName = folderPath.split("/").filter(Boolean).pop() || "fichiers";
  const archive = archiver("zip", { zlib: { level: 0 } });
  const output = new PassThrough();

  archive.on("warning", error => output.destroy(error));
  archive.on("error", error => output.destroy(error));
  archive.pipe(output);

  void (async () => {
    try {
      archive.append(Buffer.alloc(0), { name: `${rootName}/` });

      // Recréer aussi les sous-dossiers vides représentés par le marqueur .folder.
      const emptyFolderNames = new Set<string>();
      for (const objectPath of objectPaths) {
        const relativePath = objectPath.slice(folderPath.length).replace(/^\/+/, "");
        if (relativePath === ".folder" || relativePath.endsWith("/.folder")) {
          const relativeFolder = relativePath === ".folder"
            ? ""
            : relativePath.slice(0, -"/.folder".length);
          const zipFolderName = relativeFolder
            ? `${rootName}/${relativeFolder}/`
            : `${rootName}/`;
          emptyFolderNames.add(zipFolderName);
        }
      }

      for (const folderName of emptyFolderNames) {
        if (folderName !== `${rootName}/`) {
          archive.append(Buffer.alloc(0), { name: folderName });
        }
      }

      for (const objectPath of objectPaths) {
        const relativePath = objectPath.slice(folderPath.length).replace(/^\/+/, "");
        if (!relativePath || relativePath === ".folder" || relativePath.endsWith("/.folder")) {
          continue;
        }

        const { data: signed, error: signedError } = await supabase.storage
          .from(BUCKET)
          .createSignedUrl(objectPath, 120);

        if (signedError || !signed?.signedUrl) {
          throw new Error(`Impossible de préparer le téléchargement de ${relativePath}.`);
        }

        const fileResponse = await fetch(signed.signedUrl);
        if (!fileResponse.ok || !fileResponse.body) {
          throw new Error(`Impossible de lire le fichier ${relativePath} (${fileResponse.status}).`);
        }

        const source = Readable.fromWeb(fileResponse.body as any);
        const consumed = new Promise<void>((resolve, reject) => {
          source.once("end", resolve);
          source.once("error", reject);
        });

        archive.append(source, { name: `${rootName}/${relativePath}` });
        await consumed;
      }

      archive.finalize();
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

async function moveStorageEntry(sourcePath: string, targetPath: string, type: "file" | "folder") {
  if (sourcePath === targetPath) return { moved: 0 };

  if (type === "file") {
    const { error } = await supabase.storage.from(BUCKET).move(sourcePath, targetPath);
    if (error) throw new Error(`Déplacement impossible : ${error.message}`);
    return { moved: 1 };
  }

  if (targetPath.startsWith(`${sourcePath}/`)) {
    throw new Error("Tu ne peux pas déplacer un dossier à l'intérieur de lui-même.");
  }

  const sourceObjects = await collectStorageObjects(sourcePath);
  if (sourceObjects.length === 0) {
    throw new Error("Ce dossier ne contient aucun objet à déplacer.");
  }

  const destinations = sourceObjects.map(sourceObject =>
    `${targetPath}${sourceObject.slice(sourcePath.length)}`
  );

  // Vérifier toutes les destinations avant de commencer afin d'éviter les écrasements.
  for (const destination of destinations) {
    if (await storageEntryExists(destination)) {
      throw new Error(`Un élément existe déjà à cet emplacement : ${destination}`);
    }
  }

  const moved: Array<{ source: string; destination: string }> = [];
  for (let index = 0; index < sourceObjects.length; index++) {
    const source = sourceObjects[index];
    const destination = destinations[index];
    const { error } = await supabase.storage.from(BUCKET).move(source, destination);

    if (error) {
      // Tenter de remettre à leur emplacement d'origine les objets déjà déplacés.
      for (const item of moved.reverse()) {
        await supabase.storage.from(BUCKET).move(item.destination, item.source);
      }
      throw new Error(`Déplacement interrompu (${moved.length} élément(s) déplacé(s) avant l'erreur) : ${error.message}`);
    }

    moved.push({ source, destination });
  }

  return { moved: moved.length };
}

// Normalise les noms de nouveaux dossiers pour respecter les caractères
// acceptés par Supabase Storage : accents retirés, espaces et ponctuation
// autorisée conservés, autres caractères remplacés par "_".
function sanitizeStorageSegment(segment: string) {
  const transliterated = segment
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[œŒæÆßøØłŁ]/g, character => {
      const replacements: Record<string, string> = {
        œ: "oe", Œ: "OE", æ: "ae", Æ: "AE", ß: "ss",
        ø: "o", Ø: "O", ł: "l", Ł: "L",
      };
      return replacements[character] || "_";
    });

  const safe = transliterated
    .replace(/[^A-Za-z0-9 _.'!,*&$@=;:+?(),-]/g, "_")
    .trim();

  if (!safe || safe === "." || safe === ".." || safe === ".folder") {
    throw new Error("Nom de dossier invalide après conversion.");
  }

  return safe;
}

// LISTER LES FICHIERS
export async function GET(request: Request) {
  const user = await verifyUser(request);

  if (!user) {
    return NextResponse.json(
      { error: "Connexion obligatoire." },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(request.url);

  // Téléchargement d'un dossier complet en une archive ZIP.
  if (searchParams.has("downloadFolder")) {
    const folderToDownload = searchParams.get("downloadFolder") || "";

    if (!folderToDownload || !validFolder(folderToDownload)) {
      return NextResponse.json(
        { error: "Dossier à télécharger invalide." },
        { status: 400 }
      );
    }

    try {
      return await createFolderZipResponse(folderToDownload);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Impossible de préparer le dossier." },
        { status: 500 }
      );
    }
  }

  const folder = searchParams.get("folder") || "";

  if (!validFolder(folder)) {
    return NextResponse.json(
      { error: "Dossier invalide." },
      { status: 400 }
    );
  }

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(folder, {
      limit: 100,
      sortBy: { column: "name", order: "asc" },
    });

  if (error) {
    return NextResponse.json(
      { error: "Impossible de charger les fichiers." },
      { status: 500 }
    );
  }

  const entries = await Promise.all(
    (data || [])
      .filter(item => item.name !== ".folder")
      .map(async item => {
        const path = folder
          ? `${folder}/${item.name}`
          : item.name;

        if (!item.id) {
          return {
            name: item.name,
            path,
            type: "folder",
          };
        }

        const [{ data: preview }, { data: download }] = await Promise.all([
          supabase.storage.from(BUCKET).createSignedUrl(path, 3600),
          supabase.storage.from(BUCKET).createSignedUrl(path, 3600, { download: item.name }),
        ]);

        return {
          name: item.name,
          path,
          type: "file",
          size: item.metadata?.size || 0,
          created_at: item.created_at,
          previewUrl: preview?.signedUrl || null,
          downloadUrl: download?.signedUrl || null,
        };
      })
  );

  return NextResponse.json({ files: entries, role: user.role });
}

// CRÉER UN DOSSIER. Les fichiers volumineux sont envoyés directement à Storage avec TUS.
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
      return NextResponse.json(
        { error: "Connexion obligatoire." },
        { status: 401 }
      );
    }

    const folder = String(formData.get("folder") || "");

    // Cette action est accessible aux membres connectés, sans droit admin.
    if (action === "download_folder") {
      if (!folder || !validFolder(folder)) {
        return NextResponse.json(
          { error: "Dossier à télécharger invalide." },
          { status: 400 }
        );
      }
      return await createFolderZipResponse(folder);
    }

    // La création et l'organisation restent réservées aux administrateurs.
    if (user.role !== "admin") {
      return NextResponse.json(
        { error: "Seuls les administrateurs peuvent créer des dossiers." },
        { status: 403 }
      );
    }

    if (action !== "create_folder") {
      return NextResponse.json(
        { error: "Les fichiers doivent être envoyés avec le téléversement direct TUS." },
        { status: 400 }
      );
    }

    if (!validFolder(folder)) {
      return NextResponse.json(
        { error: "Dossier invalide." },
        { status: 400 }
      );
    }

    const requestedName = String(formData.get("name") || "").normalize("NFC").trim();

    if (Array.from(requestedName).length < 1 || Array.from(requestedName).length > 60) {
      return NextResponse.json(
        { error: "Le nom du dossier doit contenir entre 1 et 60 caractères." },
        { status: 400 }
      );
    }

    const name = sanitizeStorageSegment(requestedName);
    const safeFolder = folder
      ? folder.split("/").map(sanitizeStorageSegment).join("/")
      : "";
    const path = safeFolder ? `${safeFolder}/${name}` : name;
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(`${path}/.folder`, Buffer.from(""), {
        contentType: "text/plain",
        upsert: false,
      });

    if (error) {
      return NextResponse.json(
        { error: "Impossible de créer le dossier." },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur lors du traitement du dossier." },
      { status: 500 }
    );
  }
}

// SUPPRIMER UN FICHIER OU UN DOSSIER (avec tout son contenu)
export async function DELETE(request: Request) {
  const user = await verifyUser(request);

  if (!user) {
    return NextResponse.json(
      { error: "Connexion obligatoire." },
      { status: 401 }
    );
  }

  if (user.role !== "admin") {
    return NextResponse.json(
      { error: "Seuls les administrateurs peuvent supprimer des fichiers." },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const path = body?.path;
    const type = body?.type;

    if (
      typeof path !== "string" ||
      !path ||
      !validStoragePath(path) ||
      (type !== "file" && type !== "folder")
    ) {
      return NextResponse.json(
        { error: "Chemin ou type d'élément invalide." },
        { status: 400 }
      );
    }

    const objectPaths = type === "folder"
      ? await collectStorageObjects(path)
      : [path];

    if (objectPaths.length === 0) {
      return NextResponse.json(
        { error: "Ce dossier est déjà vide ou n'existe plus." },
        { status: 404 }
      );
    }

    // Storage remove accepte des lots limités ; on supprime par groupes de 100.
    for (let index = 0; index < objectPaths.length; index += 100) {
      const batch = objectPaths.slice(index, index + 100);
      const { error } = await supabase.storage.from(BUCKET).remove(batch);
      if (error) {
        return NextResponse.json(
          { error: `Suppression partielle après ${index} élément(s) : ${error.message}` },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ success: true, deleted: objectPaths.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur lors de la suppression." },
      { status: 500 }
    );
  }
}

// RENOMMER OU DÉPLACER UN FICHIER / DOSSIER
export async function PATCH(request: Request) {
  const user = await verifyUser(request);

  if (!user) {
    return NextResponse.json(
      { error: "Connexion obligatoire." },
      { status: 401 }
    );
  }

  if (user.role !== "admin") {
    return NextResponse.json(
      { error: "Seuls les administrateurs peuvent organiser les fichiers." },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const action = body?.action;
    const path = body?.path;
    const type = body?.type;

    if (
      typeof path !== "string" ||
      !path ||
      !validStoragePath(path) ||
      (type !== "file" && type !== "folder")
    ) {
      return NextResponse.json(
        { error: "Chemin ou type d'élément invalide." },
        { status: 400 }
      );
    }

    let targetPath = "";

    if (action === "rename") {
      if (typeof body?.name !== "string") {
        return NextResponse.json(
          { error: "Nouveau nom manquant." },
          { status: 400 }
        );
      }

      const safeName = sanitizeStorageSegment(body.name.normalize("NFC").trim());
      targetPath = joinStoragePath(parentStoragePath(path), safeName);
    } else if (action === "move") {
      if (typeof body?.destinationFolder !== "string") {
        return NextResponse.json(
          { error: "Dossier de destination manquant." },
          { status: 400 }
        );
      }

      const rawDestination = body.destinationFolder.normalize("NFC").trim();
      const destinationParts = rawDestination ? rawDestination.split("/") : [];
      if (destinationParts.some((part: string) => !part.trim() || part === "." || part === "..")) {
        return NextResponse.json(
          { error: "Chemin du dossier de destination invalide." },
          { status: 400 }
        );
      }

      const destinationFolder = destinationParts.map((part: string) => sanitizeStorageSegment(part)).join("/");
      if (!(await storageFolderExists(destinationFolder))) {
        return NextResponse.json(
          { error: "Le dossier de destination n'existe pas." },
          { status: 400 }
        );
      }

      targetPath = joinStoragePath(destinationFolder, path.split("/").pop()!);
    } else {
      return NextResponse.json(
        { error: "Action inconnue. Utilise rename ou move." },
        { status: 400 }
      );
    }

    if (targetPath === path) {
      return NextResponse.json({ success: true, unchanged: true });
    }

    if (type === "folder" && targetPath.startsWith(`${path}/`)) {
      return NextResponse.json(
        { error: "Tu ne peux pas déplacer un dossier à l'intérieur de lui-même." },
        { status: 400 }
      );
    }

    if (await storageEntryExists(targetPath)) {
      return NextResponse.json(
        { error: "Un fichier ou dossier porte déjà ce nom à cet emplacement." },
        { status: 409 }
      );
    }

    const result = await moveStorageEntry(path, targetPath, type);
    return NextResponse.json({ success: true, targetPath, moved: result.moved });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur lors du renommage ou du déplacement." },
      { status: 500 }
    );
  }
}
