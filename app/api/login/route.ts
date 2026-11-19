
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(request: Request) {
  try {
    const { username, password } = await request.json();

    if (!username || !password) {
      return NextResponse.json(
        { error: "Identifiant et mot de passe obligatoires." },
        { status: 400 }
      );
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data: profile, error: profileError } = await supabase
      .from("profils")
      .select("id, username, display_name, role")
      .ilike("username", username.trim())
      .maybeSingle();

    if (profileError || !profile) {
      return NextResponse.json(
        { error: "Identifiant ou mot de passe incorrect." },
        { status: 401 }
      );
    }

    const { data: userData, error: userError } =
      await supabase.auth.admin.getUserById(profile.id);

    if (userError || !userData.user?.email) {
      return NextResponse.json(
        { error: "Compte introuvable." },
        { status: 401 }
      );
    }

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

    return NextResponse.json({
      session: data.session,
      user: {
        id: profile.id,
        username: profile.username,
        display_name: profile.display_name,
        role: profile.role,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Erreur du serveur." },
      { status: 500 }
    );
  }
}
