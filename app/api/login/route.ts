
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let stage = "initialisation";

  try {
    const { username, password } = await request.json();

    if (!username || !password) {
      return NextResponse.json(
        { error: "Identifiant et mot de passe obligatoires." },
        { status: 400 }
      );
    }

    stage = "verification_variables";

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
      throw new Error("Variables Supabase manquantes");
    }

    const supabase = createClient(url, key);

    stage = "recherche_profil";

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, username, display_name, role")
      .eq("username", username.trim())
      .maybeSingle();

    if (profileError) {
  console.error("SUPABASE_PROFILE_ERROR:", {
  code: profileError.code,
  message: profileError.message,
  details: profileError.details,
  hint: profileError.hint,
  status: profileError.status,
});

  throw new Error("Erreur recherche profil");
}
    if (!profile) {
      return NextResponse.json(
        { error: "Identifiant ou mot de passe incorrect." },
        { status: 401 }
      );
    }

    stage = "recherche_compte";

    const { data: userData, error: userError } =
      await supabase.auth.admin.getUserById(profile.id);

    if (userError || !userData.user?.email) {
      throw new Error("Compte Auth introuvable");
    }

    stage = "verification_mot_de_passe";

    const { data, error } = await supabase.auth.signInWithPassword({
      email: userData.user.email,
      password,
    });

    if (error || !data.session) {
      return NextResponse.json(
        { error: "Identifiant ou mot de passe incorrect." },
        { status: 401 }
      );
    }

    console.log("LOGIN_SUCCESS");

    return NextResponse.json({
      session: data.session,
      user: {
        id: profile.id,
        username: profile.username,
        display_name: profile.display_name,
        role: profile.role,
      },
    });

  } catch (error) {
    console.error("LOGIN_ERROR_STAGE:", stage);
    console.error(
      "LOGIN_ERROR:",
      error instanceof Error ? error.message : "Erreur inconnue"
    );

    return NextResponse.json(
      { error: "Erreur du serveur. Vérifie les logs Vercel." },
      { status: 500 }
    );
  }
}
