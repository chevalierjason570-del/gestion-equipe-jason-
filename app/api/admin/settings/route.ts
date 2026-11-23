import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { B2_BUCKET, B2_MAX_STORAGE_BYTES } from "@/lib/b2";

export const runtime = "nodejs";
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const defaults = {
  accounts: { allowCreation: true, defaultRole: "", minimumPasswordLength: 8 },
  security: { requirePasswordChangeOnReset: true, notifyOnNewAccount: true },
  notifications: { newMessages: true, newUsers: true, storageWarnings: true },
  appearance: { appName: "Gestion Équipe Jason", accentColor: "#2563eb" },
};

async function adminFromRequest(request: Request) {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const { data, error } = await supabase.auth.getUser(auth.slice(7));
  if (error || !data.user) return null;
  const { data: profile } = await supabase.from("profiles").select("id, username, display_name, role").eq("id", data.user.id).maybeSingle();
  return profile?.role === "admin" ? { authUser: data.user, profile } : null;
}

export async function GET(request: Request) {
  const admin = await adminFromRequest(request);
  if (!admin) return NextResponse.json({ error: "Accès administrateur refusé." }, { status: 403 });
  const { data, error } = await supabase.from("app_settings").select("settings").eq("id", "global").maybeSingle();
  if (error) return NextResponse.json({ error: "Impossible de lire les paramètres. Vérifie la migration SQL." }, { status: 500 });
  const stored = (data?.settings || {}) as Record<string, any>;
  const settings = {
    accounts: { ...defaults.accounts, ...(stored.accounts || {}) },
    security: { ...defaults.security, ...(stored.security || {}) },
    notifications: { ...defaults.notifications, ...(stored.notifications || {}) },
    appearance: { ...defaults.appearance, ...(stored.appearance || {}) },
  };
  const { count } = await supabase.from("profiles").select("id", { count: "exact", head: true });
  const { count: admins } = await supabase.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin");
  const { data: roles } = await supabase.from("roles").select("role_key, name").order("name");
  return NextResponse.json({
    settings,
    profile: { username: admin.profile.username || "", displayName: admin.profile.display_name || "" },
    stats: { users: count || 0, admins: admins || 0, bucket: B2_BUCKET || "Non configuré", storageLimitBytes: B2_MAX_STORAGE_BYTES || 0 },
    roles: roles || [],
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  const admin = await adminFromRequest(request);
  if (!admin) return NextResponse.json({ error: "Accès administrateur refusé." }, { status: 403 });
  try {
    const body = await request.json();
    const { section, values } = body || {};
    if (!values || typeof values !== "object" || Array.isArray(values)) return NextResponse.json({ error: "Paramètres invalides." }, { status: 400 });

    if (section === "profile") {
      const username = String(values.username || "").trim();
      const displayName = String(values.displayName || "").trim();
      const password = typeof values.password === "string" ? values.password : "";
      if (!username || username.length > 60 || !displayName || displayName.length > 80) return NextResponse.json({ error: "Identifiant et nom affiché obligatoires (60 et 80 caractères maximum)." }, { status: 400 });
      const { data: duplicate } = await supabase.from("profiles").select("id").eq("username", username).neq("id", admin.profile.id).maybeSingle();
      if (duplicate) return NextResponse.json({ error: "Cet identifiant est déjà utilisé." }, { status: 409 });
      if (password && password.length < 8) return NextResponse.json({ error: "Le nouveau mot de passe doit contenir au moins 8 caractères." }, { status: 400 });
      const { error: profileError } = await supabase.from("profiles").update({ username, display_name: displayName }).eq("id", admin.profile.id);
      if (profileError) return NextResponse.json({ error: "Modification du profil impossible." }, { status: 500 });
      if (password) {
        const { error: passwordError } = await supabase.auth.admin.updateUserById(admin.profile.id, { password });
        if (passwordError) return NextResponse.json({ error: "Profil modifié, mais changement de mot de passe impossible : " + passwordError.message }, { status: 400 });
      }
      return NextResponse.json({ success: true, message: "Profil administrateur enregistré." });
    }

    const allowed: Record<string, string[]> = {
      accounts: ["allowCreation", "defaultRole", "minimumPasswordLength"],
      security: ["requirePasswordChangeOnReset", "notifyOnNewAccount"],
      notifications: ["newMessages", "newUsers", "storageWarnings"],
      appearance: ["appName", "accentColor"],
    };
    if (!allowed[section] || Object.keys(values).some(key => !allowed[section].includes(key))) return NextResponse.json({ error: "Rubrique de paramètres inconnue." }, { status: 400 });
    if (section === "accounts") {
      const min = Number(values.minimumPasswordLength);
      if (!Number.isInteger(min) || min < 8 || min > 64) return NextResponse.json({ error: "La longueur minimale doit être comprise entre 8 et 64." }, { status: 400 });
      if (values.defaultRole) {
        const { data: role } = await supabase.from("roles").select("role_key").eq("role_key", values.defaultRole).maybeSingle();
        if (!role) return NextResponse.json({ error: "Le rôle par défaut sélectionné n'existe plus." }, { status: 400 });
      }
      if (typeof values.allowCreation !== "boolean") return NextResponse.json({ error: "Valeur d'autorisation invalide." }, { status: 400 });
    }
    if (section === "appearance") {
      if (typeof values.appName !== "string" || !values.appName.trim() || values.appName.length > 60 || !/^#[0-9a-fA-F]{6}$/.test(values.accentColor)) return NextResponse.json({ error: "Nom d'application ou couleur invalide." }, { status: 400 });
    }
    const { data: current, error: readError } = await supabase.from("app_settings").select("settings").eq("id", "global").maybeSingle();
    if (readError) return NextResponse.json({ error: "Lecture des paramètres impossible." }, { status: 500 });
    const merged = { ...(current?.settings || {}), [section]: values };
    const { error } = await supabase.from("app_settings").upsert({ id: "global", settings: merged, updated_by: admin.profile.id, updated_at: new Date().toISOString() });
    if (error) return NextResponse.json({ error: "Enregistrement impossible : " + error.message }, { status: 500 });
    return NextResponse.json({ success: true, message: "Paramètres enregistrés." });
  } catch {
    return NextResponse.json({ error: "Requête de paramètres invalide." }, { status: 400 });
  }
}
