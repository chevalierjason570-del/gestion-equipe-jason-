
import { NextResponse } from "next/server";
import { Buffer } from "node:buffer";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BUCKET = "fichiers-equipe";

async function verifyUser(request: Request) {
  const authorization = request.headers.get("authorization");

  if (!authorization?.startsWith("Bearer ")) return null;

  const token = authorization.slice(7);
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

        const { data: signed } = await supabase.storage
          .from(BUCKET)
          .createSignedUrl(path, 3600);

        return {
          name: item.name,
          path,
          type: "file",
          size: item.metadata?.size || 0,
          created_at: item.created_at,
          downloadUrl: signed?.signedUrl || null,
        };
      })
  );

  return NextResponse.json({ files: entries });
}

// CRÉER UN DOSSIER. Les fichiers volumineux sont envoyés directement à Storage avec TUS.
export async function POST(request: Request) {
  const user = await verifyUser(request);

  if (!user) {
    return NextResponse.json(
      { error: "Connexion obligatoire." },
      { status: 401 }
    );
  }

  if (user.role !== "admin") {
    return NextResponse.json(
      { error: "Seuls les administrateurs peuvent créer des dossiers." },
      { status: 403 }
    );
  }

  try {
    const formData = await request.formData();
    const action = String(formData.get("action") || "");
    const folder = String(formData.get("folder") || "");

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
  } catch {
    return NextResponse.json(
      { error: "Erreur lors de la création du dossier." },
      { status: 500 }
    );
  }
}

// SUPPRIMER UN FICHIER
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
    const { path } = await request.json();

    if (
      typeof path !== "string" ||
      !path ||
      !validStoragePath(path)
    ) {
      return NextResponse.json(
        { error: "Chemin invalide." },
        { status: 400 }
      );
    }

    const { error } = await supabase.storage
      .from(BUCKET)
      .remove([path]);

    if (error) {
      return NextResponse.json(
        { error: "Impossible de supprimer le fichier." },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });

  } catch {
    return NextResponse.json(
      { error: "Erreur lors de la suppression." },
      { status: 500 }
    );
  }
}
