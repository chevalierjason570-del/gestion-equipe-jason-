import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
async function isAdmin(request: Request) {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const { data } = await db.auth.getUser(auth.slice(7));
  if (!data.user) return false;
  const { data: profile } = await db.from("profiles").select("role").eq("id", data.user.id).single();
  return profile?.role === "admin";
}
function validPath(value: unknown) {
  const path = String(value || "").normalize("NFC").trim().replace(/^\/+|\/+$/g, "");
  if (!path || path.length > 1024 || path.split("/").some(part => !part || part === "." || part === "..")) return null;
  return path;
}
export async function GET(request: Request) {
  if (!await isAdmin(request)) return NextResponse.json({ error: "Accès administrateur refusé." }, { status: 403 });
  const roleKey = new URL(request.url).searchParams.get("roleKey") || "";
  if (!roleKey) return NextResponse.json({ error: "Rôle manquant." }, { status: 400 });
  const { data, error } = await db.from("role_file_rules").select("id, role_key, path, entry_type, access").eq("role_key", roleKey).order("path");
  if (error) return NextResponse.json({ error: "Impossible de lire les règles. Vérifie le script SQL file-access-rules.sql." }, { status: 500 });
  return NextResponse.json({ rules: data || [] }, { headers: { "Cache-Control": "no-store" } });
}
export async function PUT(request: Request) {
  if (!await isAdmin(request)) return NextResponse.json({ error: "Accès administrateur refusé." }, { status: 403 });
  try {
    const body = await request.json();
    const roleKey = String(body.roleKey || "");
    if (!roleKey || roleKey === "admin" || !Array.isArray(body.rules) || body.rules.length > 500) return NextResponse.json({ error: "Rôle ou règles invalides." }, { status: 400 });
    const { data: role } = await db.from("roles").select("role_key").eq("role_key", roleKey).maybeSingle();
    if (!role) return NextResponse.json({ error: "Rôle introuvable." }, { status: 404 });
    const rules = body.rules.map((r: any) => ({ role_key: roleKey, path: validPath(r.path), entry_type: r.entry_type, access: r.access }));
    if (rules.some((r: any) => !r.path || !["folder", "file"].includes(r.entry_type) || !["allow", "deny"].includes(r.access))) return NextResponse.json({ error: "Chaque règle doit avoir un chemin, un type dossier/fichier et un accès autoriser/refuser." }, { status: 400 });
    if (new Set(rules.map((r: any) => r.path)).size !== rules.length) return NextResponse.json({ error: "Un chemin ne peut apparaître qu'une fois pour ce rôle." }, { status: 400 });
    const { error: deleteError } = await db.from("role_file_rules").delete().eq("role_key", roleKey);
    if (deleteError) throw deleteError;
    if (rules.length) {
      const { error } = await db.from("role_file_rules").insert(rules);
      if (error) throw error;
    }
    return NextResponse.json({ success: true, count: rules.length });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Enregistrement impossible." }, { status: 500 });
  }
}
