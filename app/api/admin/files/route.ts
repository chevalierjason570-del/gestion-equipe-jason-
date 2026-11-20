
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Buffer } from "node:buffer";

export const runtime = "nodejs";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BUCKET = "fichiers-equipe";
const MAX_SIZE = 20 * 1024 * 1024;

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

function validFolder(folder: string) {
  return (
    folder === "" ||
    folder.split("/").every(
      part =>
        /^[a-zA-Z0-9 _-]+$/.test(part) &&
        part !== "." &&
        part !== ".."
    )
  );
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

// AJOUTER UN FICHIER OU CRÉER UN DOSSIER
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
      { error: "Seuls les administrateurs peuvent ajouter des fichiers." },
      { status: 403 }
    );
  }

  try {
    const formData = await request.formData();
    const action = String(formData.get("action") || "upload");
    const folder = String(formData.get("folder") || "");

    if (!validFolder(folder)) {
      return NextResponse.json(
        { error: "Dossier invalide." },
        { status: 400 }
      );
    }

    // CRÉER UN DOSSIER
    if (action === "create_folder") {
      const name = String(formData.get("name") || "").trim();

      if (!/^[a-zA-Z0-9 _-]{1,60}$/.test(name)) {
        return NextResponse.json(
          { error: "Nom de dossier invalide." },
          { status: 400 }
        );
      }

      const path = folder ? `${folder}/${name}` : name;

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
    }

    // ENVOI D'UN DOSSIER COMPLET
    const uploadedFiles = formData.getAll("files");
    const relativePaths = formData.getAll("paths");

    if (uploadedFiles.length > 0) {
      if (uploadedFiles.length !== relativePaths.length) {
        return NextResponse.json(
          { error: "Informations des fichiers invalides." },
          { status: 400 }
        );
      }

      const uploaded: string[] = [];

      for (let i = 0; i < uploadedFiles.length; i++) {
        const file = uploadedFiles[i];
        const relativePath = relativePaths[i];

        if (
          !(file instanceof File) ||
          typeof relativePath !== "string"
        ) {
          return NextResponse.json(
            { error: "Fichier invalide." },
            { status: 400 }
          );
        }

        if (file.size === 0 || file.size > MAX_SIZE) {
          return NextResponse.json(
            { error: `Taille invalide : ${file.name}` },
            { status: 400 }
          );
        }

        const parts = relativePath.split("/");

        if (
          parts.some(part =>
            !part ||
            part === "." ||
            part === ".." ||
            !/^[a-zA-Z0-9 _.-]+$/.test(part)
          )
        ) {
          return NextResponse.json(
            { error: "Chemin de fichier invalide." },
            { status: 400 }
          );
        }

        const filename = parts.pop()!
          .replace(/[^a-zA-Z0-9._-]/g, "_")
          .slice(0, 150);

        if (!filename || filename === ".folder") {
          return NextResponse.json(
            { error: "Nom de fichier invalide." },
            { status: 400 }
          );
        }

        const destination = [
          folder,
          parts.join("/"),
          filename
        ].filter(Boolean).join("/");

        const { error } = await supabase.storage
          .from(BUCKET)
          .upload(
            destination,
            Buffer.from(await file.arrayBuffer()),
            {
              contentType: file.type || "application/octet-stream",
              upsert: false,
            }
          );

        if (error) {
          return NextResponse.json(
            {
              error: `Impossible d'envoyer ${filename}.`,
              uploaded,
            },
            { status: 400 }
          );
        }

        uploaded.push(destination);
      }

      return NextResponse.json({
        success: true,
        uploaded: uploaded.length,
      });
    }

    // ENVOI D'UN FICHIER INDIVIDUEL
    const file = formData.get("file");

    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json(
        { error: "Aucun fichier valide sélectionné." },
        { status: 400 }
      );
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { error: "Le fichier dépasse la limite de 20 Mo." },
        { status: 400 }
      );
    }

    const filename = file.name
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 150);

    if (!filename || filename === ".folder") {
      return NextResponse.json(
        { error: "Nom de fichier invalide." },
        { status: 400 }
      );
    }

    const path = folder
      ? `${folder}/${filename}`
      : filename;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, Buffer.from(await file.arrayBuffer()), {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });

    if (error) {
      return NextResponse.json(
        { error: "Impossible d'ajouter le fichier. Vérifie qu'il n'existe pas déjà." },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });

  } catch {
    return NextResponse.json(
      { error: "Erreur lors de l'ajout." },
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
      !validFolder(path.split("/").slice(0, -1).join("/")) ||
      path.split("/").some(
        part => !part || part === "." || part === ".."
      )
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
