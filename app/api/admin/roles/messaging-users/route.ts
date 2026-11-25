import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function isAdmin(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const { data, error } = await db.auth.getUser(authorization.slice(7));
  if (error || !data.user) return false;
  const { data: profile } = await db.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
  return profile?.role === "admin";
}

export async function GET(request: Request) {
  if (!await isAdmin(request)) return NextResponse.json({ error: "Accès administrateur refusé." }, { status: 403 });
  const roleKey = new URL(request.url).searchParams.get("roleKey")?.trim() || "";
  if (!roleKey) return NextResponse.json({ error: "Rôle invalide." }, { status: 400 });
  const { data: role, error: roleError } = await db.from("roles").select("role_key").eq("role_key", roleKey).maybeSingle();
  if (roleError || !role) return NextResponse.json({ error: "Rôle introuvable." }, { status: 404 });
  const [{ data: users, error: usersError }, { data: allowed, error: allowedError }] = await Promise.all([
    db.from("profiles").select("id, username, display_name, role").order("display_name", { ascending: true }),
    db.from("role_messaging_users").select("user_id").eq("role_key", roleKey),
  ]);
  if (usersError || allowedError) return NextResponse.json({ error: "Impossible de charger les utilisateurs. Vérifie que supabase/role-messaging-users.sql a été exécuté." }, { status: 500 });
  return NextResponse.json({ users: users || [], allowedUserIds: (allowed || []).map(row => row.user_id) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  if (!await isAdmin(request)) return NextResponse.json({ error: "Accès administrateur refusé." }, { status: 403 });
  try {
    const body = await request.json();
    const roleKey = typeof body.roleKey === "string" ? body.roleKey.trim() : "";
    if (!roleKey || !Array.isArray(body.userIds) || body.userIds.length > 5000 || body.userIds.some((id: unknown) => typeof id !== "string")) {
      return NextResponse.json({ error: "Rôle ou liste d'utilisateurs invalide." }, { status: 400 });
    }
    const { data: role } = await db.from("roles").select("role_key").eq("role_key", roleKey).maybeSingle();
    if (!role) return NextResponse.json({ error: "Rôle introuvable." }, { status: 404 });
    const userIds = [...new Set(body.userIds as string[])];
    if (userIds.length) {
      const { data: existing, error } = await db.from("profiles").select("id").in("id", userIds);
      if (error || (existing || []).length !== userIds.length) return NextResponse.json({ error: "Un ou plusieurs utilisateurs sélectionnés sont introuvables." }, { status: 400 });
    }
    const { error: deleteError } = await db.from("role_messaging_users").delete().eq("role_key", roleKey);
    if (deleteError) throw deleteError;
    if (userIds.length) {
      const { error } = await db.from("role_messaging_users").insert(userIds.map(user_id => ({ role_key: roleKey, user_id })));
      if (error) throw error;
    }
    return NextResponse.json({ success: true, count: userIds.length });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Enregistrement des autorisations impossible." }, { status: 500 });
  }
}
