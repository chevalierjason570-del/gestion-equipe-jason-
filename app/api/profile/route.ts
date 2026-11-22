import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Connexion obligatoire." },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const token = authorization.slice(7);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) {
    return NextResponse.json(
      { error: "Session invalide ou expirée." },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, username, display_name, role")
    .eq("id", authData.user.id)
    .single();

  if (error || !profile) {
    return NextResponse.json(
      { error: "Profil utilisateur introuvable." },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }

  const roleKey = String(profile.role || "");
  const { data: roleDefinition } = await supabase
    .from("roles")
    .select("permissions")
    .eq("role_key", roleKey)
    .maybeSingle();
  const permissions = roleKey === "admin"
    ? ["accueil", "utilisateurs", "fichiers", "fichiers_gestion", "messages", "roles", "parametres"]
    : Array.isArray(roleDefinition?.permissions)
      ? roleDefinition.permissions.filter((value): value is string => typeof value === "string")
      : [];

  return NextResponse.json(
    {
      id: authData.user.id,
      username: profile.username || "",
      display_name: profile.display_name || profile.username || "Utilisateur",
      role: roleKey,
      permissions,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
