
"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export default function Home() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user ?? null);
      }
    );

    return () => listener.subscription.unsubscribe();
  }, []);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError("Identifiant ou mot de passe incorrect.");
    }

    setLoading(false);
  }

  async function logout() {
    await supabase.auth.signOut();
    setUser(null);
  }

  if (user) {
    return (
      <main style={{ padding: 40, fontFamily: "Arial" }}>
        <h1>Gestion Équipe Jason</h1>
        <h2>Bienvenue !</h2>
        <p>Connecté avec : {user.email}</p>
        <button onClick={logout}>Déconnexion</button>
      </main>
    );
  }

  return (
    <main style={{
      minHeight: "100vh",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      background: "#eef2f7",
      fontFamily: "Arial"
    }}>
      <form onSubmit={login} style={{
        background: "white",
        padding: 35,
        borderRadius: 15,
        width: 320,
        boxShadow: "0 5px 25px #0002"
      }}>
        <h1>Gestion Équipe Jason</h1>
        <p>Connexion à votre compte</p>

        <label>Adresse e-mail</label>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          style={{ width: "100%", padding: 10, margin: "8px 0 18px" }}
        />

        <label>Mot de passe</label>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
          style={{ width: "100%", padding: 10, margin: "8px 0 18px" }}
        />

        {error && <p style={{ color: "red" }}>{error}</p>}

        <button type="submit" disabled={loading} style={{
          width: "100%",
          padding: 12,
          background: "#2563eb",
          color: "white",
          border: 0,
          borderRadius: 8
        }}>
          {loading ? "Connexion..." : "Se connecter"}
        </button>
      </form>
    </main>
  );
}
