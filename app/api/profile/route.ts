import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Connexion obligatoire." },
      { status: 401, headers: noStore }
    );
  }

  const token = authorization.slice(7);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) {
    console.error("PROFILE_AUTH_ERROR:", authError?.message || "Utilisateur Auth absent");
    return NextResponse.json(
      { error: "Session invalide ou expirée." },
      { status: 401, headers: noStore }
    );
  }

  // Charger d'abord les colonnes essentielles. La photo est chargée séparément
  // pour qu'une colonne avatar_url absente n'empêche pas le profil de fonctionner.
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, username, display_name, role")
    .eq("id", authData.user.id)
    .maybeSingle();

  if (profileError) {
    console.error("PROFILE_DATABASE_ERROR:", {
      code: profileError.code,
      message: profileError.message,
      details: profileError.details,
      hint: profileError.hint,
      authUserId: authData.user.id,
    });
    return NextResponse.json(
      { error: "Impossible de lire le profil utilisateur." },
      { status: 500, headers: noStore }
    );
  }

  if (!profile) {
    console.error("PROFILE_ROW_NOT_FOUND:", { authUserId: authData.user.id });
    return NextResponse.json(
      { error: "Aucun profil ne correspond au compte connecté." },
      { status: 404, headers: noStore }
    );
  }

  const { data: avatarData, error: avatarError } = await supabase
    .from("profiles")
    .select("avatar_url")
    .eq("id", authData.user.id)
    .maybeSingle();

  if (avatarError) {
    // La photo est facultative : son absence ne doit pas masquer le nom ni les menus.
    console.warn("PROFILE_AVATAR_UNAVAILABLE:", avatarError.message);
  }

  const roleKey = String(profile.role || "");
  const { data: roleDefinition, error: roleError } = await supabase
    .from("roles")
    .select("permissions")
    .eq("role_key", roleKey)
    .maybeSingle();

  if (roleError) {
    console.error("PROFILE_ROLE_LOOKUP_ERROR:", roleError.message);
  }

  const permissions = roleKey === "admin"
    ? ["accueil", "utilisateurs", "fichiers", "fichiers_gestion", "messages", "roles", "parametres"]
    : Array.isArray(roleDefinition?.permissions)
      ? roleDefinition.permissions.filter((value): value is string => typeof value === "string")
      : [];

  const metadata = authData.user.user_metadata || {};
  const displayName =
    (typeof profile.display_name === "string" ? profile.display_name.trim() : "") ||
    (typeof profile.username === "string" ? profile.username.trim() : "") ||
    (typeof metadata.display_name === "string" ? metadata.display_name.trim() : "") ||
    (typeof metadata.full_name === "string" ? metadata.full_name.trim() : "") ||
    (typeof metadata.name === "string" ? metadata.name.trim() : "") ||
    "Utilisateur";

  return NextResponse.json(
    {
      id: authData.user.id,
      username: profile.username || "",
      display_name: displayName,
      role: roleKey,
      avatar_url: avatarData?.avatar_url || "",
      permissions,
    },
    { headers: noStore }
  );
}
