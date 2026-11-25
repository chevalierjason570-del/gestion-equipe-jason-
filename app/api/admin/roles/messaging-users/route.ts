import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function verifyAdmin(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const { data: authData, error: authError } = await db.auth.getUser(authorization.slice(7));
  if (authError || !authData.user) return false;
  const { data: profile, error } = await db.from("profiles").select("role").eq("id", authData.user.id).single();
  return !error && profile?.role === "admin";
}

function databaseError(error: { message?: string; code?: string }) {
  if (error.code === "42P01" || error.code === "PGRST205") {
    return "La table des autorisations de messagerie n'existe pas. Exécute supabase/role-messaging-users.sql dans Supabase > SQL Editor.";
  }
  return error.message || "Erreur de base de données.";
}

export async function GET(request: Request) {
  if (!await verifyAdmin(request)) return NextResponse.json({ error: "Accès administrateur refusé." }, { status: 403 });
  const roleKey = new URL(request.url).searchParams.get("roleKey") || "";
  if (!roleKey) return NextResponse.json({ error: "Rôle manquant." }, { status: 400 });

  const { data: role, error: roleError } = await db.from("roles").select("role_key").eq("role_key", roleKey).maybeSingle();
  if (roleError) return NextResponse.json({ error: databaseError(roleError) }, { status: 500 });
  if (!role) return NextResponse.json({ error: "Rôle introuvable." }, { status: 404 });

  const [{ data: users, error: usersError }, { data: rules, error: rulesError }] = await Promise.all([
    db.from("profiles").select("id, username, display_name, role").order("display_name", { ascending: true }),
    db.from("role_messaging_users").select("user_id").eq("role_key", roleKey),
  ]);
  if (usersError) return NextResponse.json({ error: databaseError(usersError) }, { status: 500 });
  if (rulesError) return NextResponse.json({ error: databaseError(rulesError) }, { status: 503 });

  return NextResponse.json({
    users: users || [],
    allowedUserIds: (rules || []).map((rule: { user_id: string }) => rule.user_id),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  if (!await verifyAdmin(request)) return NextResponse.json({ error: "Accès administrateur refusé." }, { status: 403 });
  try {
    const body = await request.json();
    const roleKey = typeof body.roleKey === "string" ? body.roleKey : "";
    const userIds: string[] | null = Array.isArray(body.userIds)
      ? [...new Set<string>(body.userIds.filter((id: unknown): id is string => typeof id === "string"))]
      : null;
    if (!roleKey || !userIds || userIds.length > 5000) {
      return NextResponse.json({ error: "Rôle ou liste d'utilisateurs invalide." }, { status: 400 });
    }
    const { data: role, error: roleError } = await db.from("roles").select("role_key").eq("role_key", roleKey).maybeSingle();
    if (roleError) return NextResponse.json({ error: databaseError(roleError) }, { status: 500 });
    if (!role) return NextResponse.json({ error: "Rôle introuvable." }, { status: 404 });

    if (userIds.length) {
      const { data: validUsers, error: usersError } = await db.from("profiles").select("id").in("id", userIds);
      if (usersError) return NextResponse.json({ error: databaseError(usersError) }, { status: 500 });
      if ((validUsers || []).length !== userIds.length) {
        return NextResponse.json({ error: "Un ou plusieurs utilisateurs sélectionnés n'existent plus." }, { status: 400 });
      }
    }

    const { error: deleteError } = await db.from("role_messaging_users").delete().eq("role_key", roleKey);
    if (deleteError) return NextResponse.json({ error: databaseError(deleteError) }, { status: 503 });
    if (userIds.length) {
      const rows = userIds.map((user_id: string) => ({ role_key: roleKey, user_id }));
      const { error: insertError } = await db.from("role_messaging_users").insert(rows);
      if (insertError) return NextResponse.json({ error: databaseError(insertError) }, { status: 500 });
    }
    return NextResponse.json({ success: true, count: userIds.length });
  } catch {
    return NextResponse.json({ error: "Données invalides." }, { status: 400 });
  }
}
