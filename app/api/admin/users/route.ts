
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(url, key);

// Vérification administrateur
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

// Compter les administrateurs
async function countAdmins() {
  const { count, error } = await supabase
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "admin");

  if (error) {
    throw new Error("Impossible de vérifier les administrateurs.");
  }

  return count ?? 0;
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
    const body = await request.json();
    const { username, display_name, password } = body;
    let role = body.role;
    const { data: settingsRow } = await supabase.from("app_settings").select("settings").eq("id", "global").maybeSingle();
    const accountSettings = (settingsRow?.settings as any)?.accounts || {};
    if (accountSettings.allowCreation === false) {
      return NextResponse.json({ error: "La création de nouveaux comptes est désactivée dans les paramètres." }, { status: 403 });
    }
    const minimumPasswordLength = Number.isInteger(accountSettings.minimumPasswordLength)
      ? Math.min(64, Math.max(8, accountSettings.minimumPasswordLength)) : 8;
    if (!role) role = accountSettings.defaultRole || "";
    const cleanUsername = String(username || "").trim();

    if (
      !cleanUsername ||
      typeof password !== "string" ||
      password.length < minimumPasswordLength
    ) {
      return NextResponse.json(
        {
          error:
            `Identifiant obligatoire et mot de passe de ${minimumPasswordLength} caractères minimum.`,
        },
        { status: 400 }
      );
    }

    const { data: selectedRole } = await supabase
      .from("roles")
      .select("role_key")
      .eq("role_key", role)
      .maybeSingle();
    if (!selectedRole) {
      return NextResponse.json({ error: "Rôle invalide. Choisis un rôle existant." }, { status: 400 });
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
        {
          error:
            createError?.message ||
            "Création du compte impossible.",
        },
        { status: 400 }
      );
    }

    const { error: profileError } = await supabase
      .from("profiles")
      .insert({
        id: newUser.user.id,
        username: cleanUsername,
        display_name: String(
          display_name || cleanUsername
        ).trim(),
        role,
      });

    if (profileError) {
      await supabase.auth.admin.deleteUser(newUser.user.id);

      return NextResponse.json(
        {
          error:
            "Impossible de créer le profil : " +
            profileError.message,
        },
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

// Modifier le rôle d'un utilisateur
export async function PATCH(request: Request) {
  const admin = await verifyAdmin(request);

  if (!admin) {
    return NextResponse.json(
      { error: "Accès administrateur refusé." },
      { status: 403 }
    );
  }

  try {
    const { id, role } = await request.json();

    if (!id || typeof role !== "string") {
      return NextResponse.json({ error: "Informations invalides." }, { status: 400 });
    }
    const { data: selectedRole } = await supabase.from("roles").select("role_key").eq("role_key", role).maybeSingle();
    if (!selectedRole) return NextResponse.json({ error: "Ce rôle n'existe pas." }, { status: 400 });

    const { data: target, error: targetError } = await supabase
      .from("profiles")
      .select("id, role")
      .eq("id", id)
      .maybeSingle();

    if (targetError || !target) {
      return NextResponse.json(
        { error: "Utilisateur introuvable." },
        { status: 404 }
      );
    }
    if (id === admin.id && role !== "admin") {
      return NextResponse.json({ error: "Tu ne peux pas retirer toi-même tes droits administrateur." }, { status: 403 });
    }

    // Empêcher la rétrogradation du dernier administrateur
    if (target.role === "admin" && role !== "admin") {
      const totalAdmins = await countAdmins();

      if (totalAdmins <= 1) {
        return NextResponse.json(
          {
            error:
              "Impossible : vous devez conserver au moins un administrateur.",
          },
          { status: 403 }
        );
      }
    }

    const { error } = await supabase
      .from("profiles")
      .update({ role })
      .eq("id", id);

    if (error) {
      return NextResponse.json(
        { error: "Impossible de modifier le rôle." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Rôle modifié avec succès.",
    });
  } catch {
    return NextResponse.json(
      { error: "Erreur lors de la modification du rôle." },
      { status: 500 }
    );
  }
}

// Supprimer un utilisateur
export async function DELETE(request: Request) {
  const admin = await verifyAdmin(request);

  if (!admin) {
    return NextResponse.json(
      { error: "Accès administrateur refusé." },
      { status: 403 }
    );
  }

  try {
    const { id } = await request.json();

    if (!id) {
      return NextResponse.json(
        { error: "Identifiant utilisateur manquant." },
        { status: 400 }
      );
    }

    // Empêcher l'administrateur de supprimer son propre compte
    if (id === admin.id) {
      return NextResponse.json(
        {
          error:
            "Vous ne pouvez pas supprimer votre propre compte administrateur.",
        },
        { status: 403 }
      );
    }

    const { data: target, error: targetError } = await supabase
      .from("profiles")
      .select("id, role")
      .eq("id", id)
      .maybeSingle();

    if (targetError || !target) {
      return NextResponse.json(
        { error: "Utilisateur introuvable." },
        { status: 404 }
      );
    }

    // Protéger le dernier administrateur
    if (target.role === "admin") {
      const totalAdmins = await countAdmins();

      if (totalAdmins <= 1) {
        return NextResponse.json(
          {
            error:
              "Impossible de supprimer le dernier administrateur.",
          },
          { status: 403 }
        );
      }
    }

    const { error: deleteError } =
      await supabase.auth.admin.deleteUser(id);

    if (deleteError) {
      return NextResponse.json(
        { error: "Impossible de supprimer cet utilisateur." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Utilisateur supprimé avec succès.",
    });
  } catch {
    return NextResponse.json(
      { error: "Erreur lors de la suppression du compte." },
      { status: 500 }
    );
  }
}
