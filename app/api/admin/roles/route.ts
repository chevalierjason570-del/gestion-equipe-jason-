import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const allowedPermissions = ["accueil", "fichiers", "fichiers_gestion", "messages", "parametres"] as const;
type Permission = typeof allowedPermissions[number];

async function verifyAdmin(request: Request) {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const { data } = await db.auth.getUser(auth.slice(7));
  if (!data.user) return null;
  const { data: profile } = await db.from("profiles").select("role").eq("id", data.user.id).single();
  return profile?.role === "admin" ? data.user : null;
}
function cleanPermissions(value: unknown): Permission[] {
  if (!Array.isArray(value)) return [];
  const permissions = [...new Set(value.filter((item): item is Permission => allowedPermissions.includes(item as Permission)))];
  if (permissions.includes("fichiers_gestion") && !permissions.includes("fichiers")) permissions.push("fichiers");
  return permissions;
}
function slugify(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

export async function GET(request: Request) {
  if (!await verifyAdmin(request)) return NextResponse.json({ error: "Accès administrateur refusé." }, { status: 403 });
  const { data, error } = await db.from("roles").select("id, role_key, name, permissions, is_system").order("name");
  if (error) return NextResponse.json({ error: "Impossible de charger les rôles. Exécute d'abord le script SQL de configuration." }, { status: 500 });
  return NextResponse.json({ roles: data || [] }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!await verifyAdmin(request)) return NextResponse.json({ error: "Accès administrateur refusé." }, { status: 403 });
  try {
    const body = await request.json();
    const name = String(body.name || "").trim();
    if (!name || name.length > 60) return NextResponse.json({ error: "Le nom doit contenir entre 1 et 60 caractères." }, { status: 400 });
    const base = slugify(name);
    if (!base || ["admin", "standard"].includes(base)) return NextResponse.json({ error: "Ce nom est réservé ou invalide." }, { status: 400 });
    const role_key = `${base}_${crypto.randomUUID().slice(0, 6)}`;
    const { data, error } = await db.from("roles").insert({ role_key, name, permissions: cleanPermissions(body.permissions), is_system: false }).select("id, role_key, name, permissions, is_system").single();
    if (error) return NextResponse.json({ error: "Création du rôle impossible : " + error.message }, { status: 500 });
    return NextResponse.json({ role: data });
  } catch { return NextResponse.json({ error: "Données invalides." }, { status: 400 }); }
}

export async function PATCH(request: Request) {
  if (!await verifyAdmin(request)) return NextResponse.json({ error: "Accès administrateur refusé." }, { status: 403 });
  try {
    const body = await request.json();
    if (!body.id) return NextResponse.json({ error: "Rôle introuvable." }, { status: 400 });
    const { data: existing } = await db.from("roles").select("id, is_system, role_key").eq("id", body.id).maybeSingle();
    if (!existing) return NextResponse.json({ error: "Rôle introuvable." }, { status: 404 });
    if (existing.role_key === "admin") return NextResponse.json({ error: "Le rôle Administrateur est protégé." }, { status: 403 });
    const name = String(body.name || "").trim();
    if (!name || name.length > 60) return NextResponse.json({ error: "Le nom doit contenir entre 1 et 60 caractères." }, { status: 400 });
    const { data, error } = await db.from("roles").update({ name, permissions: cleanPermissions(body.permissions) }).eq("id", body.id).select("id, role_key, name, permissions, is_system").single();
    if (error) return NextResponse.json({ error: "Modification impossible : " + error.message }, { status: 500 });
    return NextResponse.json({ role: data });
  } catch { return NextResponse.json({ error: "Données invalides." }, { status: 400 }); }
}

export async function DELETE(request: Request) {
  if (!await verifyAdmin(request)) return NextResponse.json({ error: "Accès administrateur refusé." }, { status: 403 });
  try {
    const { id } = await request.json();
    const { data: role } = await db.from("roles").select("id, role_key, is_system").eq("id", id).maybeSingle();
    if (!role) return NextResponse.json({ error: "Rôle introuvable." }, { status: 404 });
    if (role.role_key === "admin") return NextResponse.json({ error: "Le rôle Administrateur est protégé." }, { status: 403 });
    // Standard est un ancien rôle intégré : on peut le supprimer et retirer
    // son attribution des profils afin qu'il ne réapparaisse plus.
    if (role.role_key === "standard") {
      const { error: profileError } = await db.from("profiles").update({ role: null }).eq("role", "standard");
      if (profileError) return NextResponse.json({ error: "Impossible de retirer l'ancien rôle Standard des utilisateurs." }, { status: 500 });
    } else {
      if (role.is_system) return NextResponse.json({ error: "Un rôle système ne peut pas être supprimé." }, { status: 403 });
      const { count, error: countError } = await db.from("profiles").select("id", { count: "exact", head: true }).eq("role", role.role_key);
      if (countError) return NextResponse.json({ error: "Impossible de vérifier les utilisateurs affectés." }, { status: 500 });
      if ((count || 0) > 0) return NextResponse.json({ error: "Ce rôle est encore attribué à un ou plusieurs utilisateurs. Change d'abord leur rôle." }, { status: 409 });
    }
    const { error } = await db.from("roles").delete().eq("id", id);
    if (error) return NextResponse.json({ error: "Suppression impossible." }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch { return NextResponse.json({ error: "Données invalides." }, { status: 400 }); }
}
