
"use client";

import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";

const menu = [
  { id: "accueil", label: "Accueil", icon: "🏠" },
  { id: "utilisateurs", label: "Utilisateurs", icon: "👥" },
  { id: "fichiers", label: "Fichiers partagés", icon: "📁" },
  { id: "messages", label: "Messagerie", icon: "💬" },
  { id: "roles", label: "Rôles", icon: "🛡️" },
  { id: "parametres", label: "Paramètres", icon: "⚙️" },
];

export default function Home() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState("accueil");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
    });

    const { data: listener } =
      supabase.auth.onAuthStateChange((_event, session) => {
        setUser(session?.user ?? null);
      });

    return () => listener.subscription.unsubscribe();
  }, []);

  async function login(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: email,
          password,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        setError(result.error || "Identifiant ou mot de passe incorrect.");
        return;
      }

      const { error: sessionError } = await supabase.auth.setSession({
        access_token: result.session.access_token,
        refresh_token: result.session.refresh_token,
      });

      if (sessionError) {
        setError("Erreur lors de la connexion.");
      }
    } catch {
      setError("Impossible de contacter le serveur.");
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    await supabase.auth.signOut();
    setUser(null);
    setActive("accueil");
  }

  const current = menu.find(item => item.id === active);

  if (!user) {
    return (
      <main style={{
        minHeight: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        background: "#eef2f7",
        fontFamily: "Arial",
        padding: 20
      }}>
        <form onSubmit={login} style={{
          background: "white",
          padding: 35,
          borderRadius: 15,
          width: "100%",
          maxWidth: 380,
          boxShadow: "0 5px 25px #0002"
        }}>
          <h1 style={{ color: "#172554" }}>Gestion Équipe Jason</h1>
          <p style={{ color: "#64748b" }}>Connexion à votre compte</p>

          <label>Identifiant</label>
          <input
            type="text"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: 12,
              margin: "8px 0 18px",
              border: "1px solid #cbd5e1",
              borderRadius: 8
            }}
          />

          <label>Mot de passe</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: 12,
              margin: "8px 0 18px",
              border: "1px solid #cbd5e1",
              borderRadius: 8
            }}
          />

          {error && (
            <p style={{ color: "#dc2626" }}>{error}</p>
          )}

          <button type="submit" disabled={loading} style={{
            width: "100%",
            padding: 13,
            background: "#2563eb",
            color: "white",
            border: 0,
            borderRadius: 8,
            cursor: "pointer"
          }}>
            {loading ? "Connexion..." : "Se connecter"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main style={{
      minHeight: "100vh",
      display: "flex",
      background: "#f1f5f9",
      fontFamily: "Arial",
      color: "#1e293b"
    }}>
      <aside style={{
        width: 245,
        minWidth: 200,
        background: "#172554",
        color: "white",
        padding: 20,
        boxSizing: "border-box"
      }}>
        <h2 style={{ fontSize: 20, marginBottom: 35 }}>
          Gestion Équipe
        </h2>

        <p style={{
          fontSize: 11,
          color: "#94a3b8",
          marginBottom: 15
        }}>
          MENU PRINCIPAL
        </p>

        {menu.map(item => (
          <button
            key={item.id}
            onClick={() => setActive(item.id)}
            style={{
              display: "block",
              width: "100%",
              padding: 13,
              marginBottom: 7,
              textAlign: "left",
              color: "white",
              background: active === item.id ? "#2563eb" : "transparent",
              border: 0,
              borderRadius: 8,
              cursor: "pointer",
              fontSize: 14
            }}
          >
            {item.icon}　{item.label}
          </button>
        ))}

        <button onClick={logout} style={{
          display: "block",
          width: "100%",
          padding: 13,
          marginTop: 45,
          background: "#991b1b",
          color: "white",
          border: 0,
          borderRadius: 8,
          cursor: "pointer"
        }}>
          🚪 Déconnexion
        </button>
      </aside>

      <section style={{
        flex: 1,
        minWidth: 0,
        padding: 30
      }}>
        <header style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 15,
          background: "white",
          padding: 20,
          borderRadius: 12,
          marginBottom: 25
        }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 23 }}>
              {current?.label}
            </h1>
            <p style={{ color: "#64748b", marginBottom: 0 }}>
              Espace de gestion de votre équipe
            </p>
          </div>

          <div style={{
            background: "#eff6ff",
            padding: 12,
            borderRadius: 8,
            color: "#1d4ed8"
          }}>
            👤 {user.email}
          </div>
        </header>

        {active === "accueil" && (
          <>
            <h2>Bienvenue sur Gestion Équipe Jason</h2>
            <p style={{ color: "#64748b" }}>
              Votre espace de travail centralisé.
            </p>

            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 18,
              marginTop: 25
            }}>
              {menu.slice(1, 5).map(item => (
                <button
                  key={item.id}
                  onClick={() => setActive(item.id)}
                  style={{
                    background: "white",
                    padding: 25,
                    border: "1px solid #e2e8f0",
                    borderRadius: 12,
                    textAlign: "left",
                    cursor: "pointer"
                  }}
                >
                  <div style={{ fontSize: 30 }}>{item.icon}</div>
                  <h3>{item.label}</h3>
                  <p style={{ color: "#64748b" }}>
                    Accéder à la rubrique
                  </p>
                </button>
              ))}
            </div>
          </>
        )}

        {active !== "accueil" && (
          <div style={{
            background: "white",
            padding: 30,
            borderRadius: 12,
            minHeight: 220
          }}>
            <h2>{current?.icon} {current?.label}</h2>
            <p style={{ color: "#64748b" }}>
              Cette rubrique sera développée dans la prochaine étape.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
