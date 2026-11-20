
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

type UserProfile = {
  id: string;
  username: string;
  display_name: string;
  role: string;
};

export default function Home() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState("accueil");

  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [saving, setSaving] = useState(false);
  const [userError, setUserError] = useState("");
  const [success, setSuccess] = useState("");

  const [newUsername, setNewUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState("standard");

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
        body: JSON.stringify({ username, password }),
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

      if (sessionError) setError("Erreur lors de la connexion.");
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

  async function loadUsers() {
    setLoadingUsers(true);
    setUserError("");

    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;

      if (!token) {
        setUserError("Session expirée. Reconnecte-toi.");
        return;
      }

      const response = await fetch("/api/admin/users", {
        headers: { Authorization: `Bearer ${token}` },
      });

      const result = await response.json();

      if (!response.ok) {
        setUserError(result.error || "Impossible de charger les utilisateurs.");
        return;
      }

      setUsers(result.users || []);
    } catch {
      setUserError("Erreur de communication avec le serveur.");
    } finally {
      setLoadingUsers(false);
    }
  }

  useEffect(() => {
    if (user && active === "utilisateurs") {
      loadUsers();
    }
  }, [user, active]);

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setUserError("");
    setSuccess("");

    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;

      if (!token) {
        setUserError("Session expirée. Reconnecte-toi.");
        return;
      }

      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          username: newUsername,
          display_name: displayName,
          password: newPassword,
          role: newRole,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        setUserError(result.error || "Création impossible.");
        return;
      }

      setSuccess("Utilisateur créé avec succès !");
      setNewUsername("");
      setDisplayName("");
      setNewPassword("");
      setNewRole("standard");

      await loadUsers();
    } catch {
      setUserError("Erreur lors de la création.");
    } finally {
      setSaving(false);
    }
  }

  const current = menu.find(item => item.id === active);

  const inputStyle = {
    width: "100%",
    boxSizing: "border-box" as const,
    padding: 12,
    border: "1px solid #cbd5e1",
    borderRadius: 8,
    marginTop: 7,
    marginBottom: 15,
  };

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
          maxWidth: 380
        }}>
          <h1 style={{ color: "#172554" }}>Gestion Équipe Jason</h1>
          <p>Connexion à votre compte</p>

          <label>Identifiant</label>
          <input
            value={username}
            onChange={e => setUsername(e.target.value)}
            required
            style={inputStyle}
          />

          <label>Mot de passe</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            style={inputStyle}
          />

          {error && <p style={{ color: "red" }}>{error}</p>}

          <button disabled={loading} style={{
            width: "100%",
            padding: 13,
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
        <h2>Gestion Équipe</h2>
        <p style={{ color: "#94a3b8", fontSize: 11 }}>MENU PRINCIPAL</p>

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
              cursor: "pointer"
            }}
          >
            {item.icon}　{item.label}
          </button>
        ))}

        <button onClick={logout} style={{
          width: "100%",
          padding: 13,
          marginTop: 40,
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
            <h1 style={{ margin: 0 }}>{current?.label}</h1>
            <p style={{ color: "#64748b" }}>
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
            <p>Votre espace de travail centralisé.</p>

            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 18,
              marginTop: 25
            }}>
              {menu.slice(1, 5).map(item => (
                <button key={item.id}
                  onClick={() => setActive(item.id)}
                  style={{
                    background: "white",
                    padding: 25,
                    border: "1px solid #e2e8f0",
                    borderRadius: 12,
                    textAlign: "left",
                    cursor: "pointer"
                  }}>
                  <div style={{ fontSize: 30 }}>{item.icon}</div>
                  <h3>{item.label}</h3>
                  <p>Accéder à la rubrique</p>
                </button>
              ))}
            </div>
          </>
        )}

        {active === "utilisateurs" && (
          <>
            <h2>Gestion des utilisateurs</h2>
            <p style={{ color: "#64748b" }}>
              Crée et consulte les comptes de ton équipe.
            </p>

            <div style={{
              background: "white",
              padding: 25,
              borderRadius: 12,
              marginTop: 20,
              maxWidth: 650
            }}>
              <h3>➕ Créer un utilisateur</h3>

              <form onSubmit={createUser}>
                <label>Identifiant</label>
                <input
                  value={newUsername}
                  onChange={e => setNewUsername(e.target.value)}
                  required
                  style={inputStyle}
                  placeholder="Exemple : jean123"
                />

                <label>Nom affiché</label>
                <input
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  required
                  style={inputStyle}
                  placeholder="Exemple : Jean Dupont"
                />

                <label>Mot de passe (8 caractères minimum)</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  style={inputStyle}
                />

                <label>Rôle</label>
                <select
                  value={newRole}
                  onChange={e => setNewRole(e.target.value)}
                  style={inputStyle}
                >
                  <option value="standard">Standard</option>
                  <option value="admin">Administrateur</option>
                </select>

                <button disabled={saving} style={{
                  width: "100%",
                  padding: 13,
                  background: "#2563eb",
                  color: "white",
                  border: 0,
                  borderRadius: 8,
                  cursor: "pointer"
                }}>
                  {saving ? "Création..." : "Créer l'utilisateur"}
                </button>
              </form>

              {userError && (
                <p style={{ color: "#dc2626" }}>{userError}</p>
              )}
              {success && (
                <p style={{ color: "#15803d" }}>{success}</p>
              )}
            </div>

            <div style={{
              background: "white",
              padding: 25,
              borderRadius: 12,
              marginTop: 20
            }}>
              <h3>👥 Liste des utilisateurs</h3>

              {loadingUsers ? (
                <p>Chargement des utilisateurs...</p>
              ) : users.length === 0 ? (
                <p>Aucun utilisateur à afficher.</p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    textAlign: "left"
                  }}>
                    <thead>
                      <tr>
                        {["Identifiant", "Nom affiché", "Rôle"].map(title => (
                          <th key={title} style={{
                            padding: 12,
                            borderBottom: "1px solid #e2e8f0"
                          }}>{title}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {users.map(item => (
                        <tr key={item.id}>
                          <td style={{ padding: 12, borderBottom: "1px solid #e2e8f0" }}>
                            {item.username}
                          </td>
                          <td style={{ padding: 12, borderBottom: "1px solid #e2e8f0" }}>
                            {item.display_name}
                          </td>
                          <td style={{ padding: 12, borderBottom: "1px solid #e2e8f0" }}>
                            {item.role === "admin" ? "Administrateur" : "Standard"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <button onClick={loadUsers} style={{
                marginTop: 15,
                padding: 10,
                background: "#e2e8f0",
                border: 0,
                borderRadius: 8,
                cursor: "pointer"
              }}>
                ↻ Actualiser la liste
              </button>
            </div>
          </>
        )}

        {active !== "accueil" && active !== "utilisateurs" && (
          <div style={{
            background: "white",
            padding: 30,
            borderRadius: 12
          }}>
            <h2>{current?.icon} {current?.label}</h2>
            <p>Cette rubrique sera développée dans la prochaine étape.</p>
          </div>
        )}
      </section>
    </main>
  );
}
