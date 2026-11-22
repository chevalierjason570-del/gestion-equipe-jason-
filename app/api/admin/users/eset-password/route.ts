import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function verifyAdmin(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;

  const token = authorization.slice(7);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) return null;

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, role")
    .eq("id", authData.user.id)
    .single();

  if (error || profile?.role !== "admin") return null;
  return authData.user;
}

export async function POST(request: Request) {
  const admin = await verifyAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: "Accès administrateur refusé." }, { status: 403 });
  }

  try {
    const body = await request.json();
    const userId = typeof body?.userId === "string" ? body.userId : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
      return NextResponse.json({ error: "Identifiant utilisateur invalide." }, { status: 400 });
    }
    if (password.length < 8 || password.length > 72) {
      return NextResponse.json({ error: "Le mot de passe doit contenir entre 8 et 72 caractères." }, { status: 400 });
    }

    const { data: target, error: targetError } = await supabase
      .from("profiles")
      .select("id, username")
      .eq("id", userId)
      .maybeSingle();

    if (targetError || !target) {
      return NextResponse.json({ error: "Utilisateur introuvable." }, { status: 404 });
    }

    const { error: updateError } = await supabase.auth.admin.updateUserById(userId, { password });
    if (updateError) {
      return NextResponse.json({ error: "Supabase n'a pas pu mettre à jour ce mot de passe." }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      message: `Mot de passe de ${target.username} réinitialisé avec succès.`,
    });
  } catch {
    return NextResponse.json({ error: "Erreur lors de la réinitialisation du mot de passe." }, { status: 500 });
  }
}
