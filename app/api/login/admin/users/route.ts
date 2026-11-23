
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(url, key);

async function verifyAdmin(request: Request) {
  const authorization = request.headers.get("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice(7);

  const { data: authData, error: authError } =
    await supabase.auth.getUser(token);

  if (authError || !authData.user) return null;

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, role")
    .eq("id", authData.user.id)
    .single();

  if (error || profile?.role !== "admin") return null;

  return authData.user;
}

// Voir tous les utilisateurs
export async function GET(request: Request) {
  const admin = await verifyAdmin(request);

  if (!admin) {
    return NextResponse.json(
      { error: "Accès administrateur refusé." },
      { status: 403 }
    );
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id, username, display_name, role")
    .order("display_name");

  if (error) {
    return NextResponse.json(
      { error: "Impossible de charger les utilisateurs." },
      { status: 500 }
    );
  }

  return NextResponse.json({ users: data });
}

// Créer un utilisateur
export async function POST(request: Request) {
  const admin = await verifyAdmin(request);

  if (!admin) {
    return NextResponse.json(
      { error: "Accès administrateur refusé." },
      { status: 403 }
    );
  }

  try {
    const { username, display_name, password, role } =
      await request.json();

    const cleanUsername = String(username || "").trim();

    if (!cleanUsername || !password || password.length < 8) {
      return NextResponse.json(
        { error: "Identifiant obligatoire et mot de passe de 8 caractères minimum." },
        { status: 400 }
      );
    }

    const cleanRole = String(role || "").trim();
    if (!cleanRole) {
      return NextResponse.json(
        { error: "Un rôle valide doit être sélectionné." },
        { status: 400 }
      );
    }
    const { data: roleDefinition } = await supabase
      .from("roles")
      .select("role_key")
      .eq("role_key", cleanRole)
      .maybeSingle();
    if (!roleDefinition) {
      return NextResponse.json(
        { error: "Rôle invalide." },
        { status: 400 }
      );
    }

    const { data: existing } = await supabase
      .from("profiles")
      .select("id")
      .eq("username", cleanUsername)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { error: "Cet identifiant existe déjà." },
        { status: 409 }
      );
    }

    // Adresse technique invisible pour l'utilisateur
    const internalEmail =
      `account-${crypto.randomUUID()}@example.com`;

    const { data: newUser, error: createError } =
      await supabase.auth.admin.createUser({
        email: internalEmail,
        password,
        email_confirm: true,
      });

    if (createError || !newUser.user) {
      return NextResponse.json(
        { error: createError?.message || "Création du compte impossible." },
        { status: 400 }
      );
    }

    const { error: profileError } = await supabase
      .from("profiles")
      .insert({
        id: newUser.user.id,
        username: cleanUsername,
        display_name: String(display_name || cleanUsername).trim(),
        role,
      });

    if (profileError) {
      await supabase.auth.admin.deleteUser(newUser.user.id);

      return NextResponse.json(
        { error: "Impossible de créer le profil : " + profileError.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Utilisateur créé avec succès.",
    });

  } catch {
    return NextResponse.json(
      { error: "Erreur lors de la création du compte." },
      { status: 500 }
    );
  }
}
