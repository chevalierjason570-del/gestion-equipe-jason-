"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { supabase } from "@/lib/supabase";

type Settings = {
  accounts: { allowCreation: boolean; defaultRole: string; minimumPasswordLength: number };
  security: { requirePasswordChangeOnReset: boolean; notifyOnNewAccount: boolean };
  notifications: { newMessages: boolean; newUsers: boolean; storageWarnings: boolean };
  appearance: { appName: string; accentColor: string };
};
type Role = { role_key: string; name: string };
type Data = { settings: Settings; profile: { username: string; displayName: string }; stats: { users: number; admins: number; bucket: string; storageLimitBytes: number }; roles: Role[] };

const defaults: Settings = {
  accounts: { allowCreation: true, defaultRole: "", minimumPasswordLength: 8 },
  security: { requirePasswordChangeOnReset: true, notifyOnNewAccount: true },
  notifications: { newMessages: true, newUsers: true, storageWarnings: true },
  appearance: { appName: "Gestion Équipe Jason", accentColor: "#2563eb" },
};

const sections = [
  ["profile", "Profil administrateur", "👤"],
  ["accounts", "Comptes utilisateurs", "👥"],
  ["security", "Sécurité", "🛡️"],
  ["notifications", "Notifications", "🔔"],
  ["storage", "Stockage", "💾"],
  ["appearance", "Apparence", "🎨"],
] as const;

export default function AdminSettings() {
  const [data, setData] = useState<Data | null>(null);
  const [section, setSection] = useState<string>("profile");
  const [settings, setSettings] = useState<Settings>(defaults);
  const [profile, setProfile] = useState({ username: "", displayName: "", password: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [storageUsedBytes, setStorageUsedBytes] = useState<number | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);

  async function token() {
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session?.access_token) throw new Error("Session expirée. Reconnecte-toi.");
    return sessionData.session.access_token;
  }

  async function load() {
    setLoading(true); setError("");
    try {
      const accessToken = await token();
      const response = await fetch("/api/admin/settings", { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Chargement des paramètres impossible.");
      setData(result);
      setSettings(result.settings);
      setProfile({ username: result.profile.username, displayName: result.profile.displayName, password: "" });
      window.dispatchEvent(new CustomEvent("gestion-equipe-brand", { detail: result.settings.appearance }));
    } catch (e) { setError(e instanceof Error ? e.message : "Erreur de chargement."); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (section !== "storage") return;
    let cancelled = false;
    setStorageLoading(true);
    void (async () => {
      try {
        const accessToken = await token();
        const response = await fetch("/api/admin/files", { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
        const result = await response.json();
        if (response.ok && !cancelled) setStorageUsedBytes(Number(result.storage?.usedBytes || 0));
      } catch { if (!cancelled) setStorageUsedBytes(null); }
      finally { if (!cancelled) setStorageLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [section]);

  async function save(sectionName: string, values: Record<string, unknown>) {
    setSaving(true); setError(""); setSuccess("");
    try {
      const accessToken = await token();
      const response = await fetch("/api/admin/settings", {
        method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ section: sectionName, values }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Enregistrement impossible.");
      setSuccess(result.message || "Paramètres enregistrés.");
      if (sectionName === "profile") {
        setProfile(current => ({ ...current, password: "" }));
        window.dispatchEvent(new CustomEvent("gestion-equipe-brand", { detail: { displayName: values.displayName } }));
      }
      if (sectionName === "appearance") window.dispatchEvent(new CustomEvent("gestion-equipe-brand", { detail: values }));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Erreur d'enregistrement."); }
    finally { setSaving(false); }
  }

  const currentTitle = useMemo(() => sections.find(item => item[0] === section)?.[1] || "Paramètres", [section]);
  const field: CSSProperties = { width: "100%", boxSizing: "border-box", padding: 11, border: "1px solid #cbd5e1", borderRadius: 8, marginTop: 6, background: "white", color: "#172033" };
  const button: CSSProperties = { padding: "10px 16px", border: 0, borderRadius: 8, color: "white", background: settings.appearance.accentColor, cursor: saving ? "wait" : "pointer", fontWeight: 600 };
  const label: CSSProperties = { display: "block", fontWeight: 600, color: "#334155", marginTop: 14, fontSize: 14 };
  const toggle = (title: string, checked: boolean, onChange: (value: boolean) => void, detail?: string) => (
    <label key={title} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "13px 0", borderBottom: "1px solid #edf2f7", cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ marginTop: 3 }} />
      <span><strong style={{ display: "block", color: "#263449", fontSize: 14 }}>{title}</strong>{detail && <small style={{ color: "#64748b" }}>{detail}</small>}</span>
    </label>
  );

  if (loading) return <div style={{ background: "white", borderRadius: 12, padding: 30, color: "#64748b" }}>Chargement des paramètres…</div>;
  if (!data) return <div style={{ background: "white", borderRadius: 12, padding: 24 }}><p style={{ color: "#b91c1c" }}>{error || "Paramètres indisponibles."}</p><button style={button} onClick={() => void load()}>Réessayer</button></div>;

  return <div style={{ background: "white", borderRadius: 12, padding: 24 }}>
    <h2 style={{ margin: "4px 0 8px", color: "#172033" }}>⚙️ Paramètres</h2>
    <p style={{ color: "#64748b", marginTop: 0 }}>Configuration générale de l'application — accès réservé à l'administrateur.</p>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: 22, marginTop: 22 }}>
      <nav aria-label="Catégories des paramètres" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {sections.map(([id, title, icon]) => <button key={id} onClick={() => { setSection(id); setError(""); setSuccess(""); }} style={{ textAlign: "left", border: 0, borderRadius: 8, padding: "12px 13px", cursor: "pointer", background: section === id ? "#eff6ff" : "white", color: section === id ? settings.appearance.accentColor : "#334155", fontWeight: section === id ? 700 : 500 }}>{icon}　{title}</button>)}
      </nav>
      <section style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 22, minWidth: 0 }}>
        <h3 style={{ margin: "0 0 6px", color: "#172033" }}>{currentTitle}</h3>
        {error && <p role="alert" style={{ background: "#fef2f2", color: "#b91c1c", padding: 10, borderRadius: 7 }}>{error}</p>}
        {success && <p role="status" style={{ background: "#f0fdf4", color: "#166534", padding: 10, borderRadius: 7 }}>{success}</p>}

        {section === "profile" && <form onSubmit={e => { e.preventDefault(); void save("profile", profile); }}>
          <p style={{ color: "#64748b", fontSize: 14 }}>Modifier les informations du compte administrateur actuellement connecté.</p>
          <label style={label}>Identifiant<input style={field} value={profile.username} maxLength={60} onChange={e => setProfile({ ...profile, username: e.target.value })} required /></label>
          <label style={label}>Nom affiché<input style={field} value={profile.displayName} maxLength={80} onChange={e => setProfile({ ...profile, displayName: e.target.value })} required /></label>
          <label style={label}>Nouveau mot de passe (facultatif)<input style={field} type="password" autoComplete="new-password" minLength={8} placeholder="Laisser vide pour ne pas le changer" value={profile.password} onChange={e => setProfile({ ...profile, password: e.target.value })} /></label>
          <button style={{ ...button, marginTop: 20 }} disabled={saving}>{saving ? "Enregistrement…" : "Enregistrer le profil"}</button>
        </form>}

        {section === "accounts" && <div>
          <p style={{ color: "#64748b", fontSize: 14 }}>Définir les règles appliquées lors de la création des prochains comptes.</p>
          {toggle("Autoriser la création de comptes", settings.accounts.allowCreation, v => setSettings(s => ({ ...s, accounts: { ...s.accounts, allowCreation: v } })), "Désactiver cette option bloque la création de nouveaux utilisateurs via l'interface administrateur.")}
          <label style={label}>Rôle attribué par défaut<select style={field} value={settings.accounts.defaultRole} onChange={e => setSettings(s => ({ ...s, accounts: { ...s.accounts, defaultRole: e.target.value } }))}><option value="">Aucun rôle par défaut (choix obligatoire)</option>{data.roles.filter(r => r.role_key !== "admin").map(r => <option key={r.role_key} value={r.role_key}>{r.name}</option>)}</select></label>
          <label style={label}>Longueur minimale du mot de passe<input style={field} type="number" min={8} max={64} value={settings.accounts.minimumPasswordLength} onChange={e => setSettings(s => ({ ...s, accounts: { ...s.accounts, minimumPasswordLength: Number(e.target.value) } }))} /></label>
          <button style={{ ...button, marginTop: 20 }} disabled={saving} onClick={() => void save("accounts", settings.accounts)}>Enregistrer les comptes</button>
        </div>}

        {section === "security" && <div>
          <p style={{ color: "#64748b", fontSize: 14 }}>État des protections actuellement actives dans l'application.</p>
          <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
            <div style={{ padding: 14, border: "1px solid #bbf7d0", background: "#f0fdf4", borderRadius: 8 }}><strong style={{ color: "#166534" }}>✓ Accès administrateur vérifié côté serveur</strong><p style={{ margin: "5px 0 0", color: "#475569", fontSize: 13 }}>Les API de gestion des paramètres vérifient le rôle admin à chaque requête.</p></div>
            <div style={{ padding: 14, border: "1px solid #e2e8f0", borderRadius: 8 }}><strong>Longueur minimale des mots de passe</strong><p style={{ margin: "5px 0 0", color: "#475569", fontSize: 13 }}>Actuellement : {settings.accounts.minimumPasswordLength} caractères pour les nouveaux comptes. Modifiable dans « Comptes utilisateurs ».</p></div>
            <div style={{ padding: 14, border: "1px solid #e2e8f0", borderRadius: 8 }}><strong>Modification du mot de passe administrateur</strong><p style={{ margin: "5px 0 0", color: "#475569", fontSize: 13 }}>Disponible dans « Profil administrateur ».</p></div>
          </div>
          <p style={{ color: "#64748b", fontSize: 12, marginTop: 14 }}>L'application ne possède pas encore de procédure de réinitialisation de mot de passe ni de déconnexion automatique après inactivité.</p>
        </div>}

        {section === "notifications" && <div>
          <p style={{ color: "#64748b", fontSize: 14 }}>Choisir les préférences de notification de l'application.</p>
          {toggle("Nouveaux messages", settings.notifications.newMessages, v => setSettings(s => ({ ...s, notifications: { ...s.notifications, newMessages: v } })), "Contrôle l’e-mail envoyé à l’administrateur lorsqu’un membre lui écrit (si Resend est configuré).")}
          {toggle("Nouveaux utilisateurs", settings.notifications.newUsers, v => setSettings(s => ({ ...s, notifications: { ...s.notifications, newUsers: v } })), "Préférence enregistrée ; aucun e-mail de création de compte n’est encore envoyé par l’application.")}
          {toggle("Avertissements de stockage", settings.notifications.storageWarnings, v => setSettings(s => ({ ...s, notifications: { ...s.notifications, storageWarnings: v } })), "Préférence enregistrée ; les alertes automatiques de quota ne sont pas encore activées.")}
          <button style={{ ...button, marginTop: 20 }} disabled={saving} onClick={() => void save("notifications", settings.notifications)}>Enregistrer les notifications</button>
        </div>}

        {section === "storage" && <div>
          <p style={{ color: "#64748b", fontSize: 14 }}>Informations de configuration du stockage distant Backblaze B2.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginTop: 18 }}>
            <div style={{ background: "#f8fafc", padding: 16, borderRadius: 8 }}><small style={{ color: "#64748b" }}>Comptes utilisateurs</small><h2 style={{ margin: "5px 0" }}>{data.stats.users}</h2></div>
            <div style={{ background: "#f8fafc", padding: 16, borderRadius: 8 }}><small style={{ color: "#64748b" }}>Administrateurs</small><h2 style={{ margin: "5px 0" }}>{data.stats.admins}</h2></div>
          </div>
          <label style={label}>Bucket configuré</label><div style={{ ...field, background: "#f8fafc" }}>{data.stats.bucket}</div>
          <label style={label}>Espace utilisé</label><div style={{ ...field, background: "#f8fafc" }}>{storageLoading ? "Calcul en cours…" : storageUsedBytes === null ? "Indisponible — vérifie la configuration B2" : `${(storageUsedBytes / 1_000_000_000).toFixed(2)} Go`}</div>
          <label style={label}>Limite de stockage configurée</label><div style={{ ...field, background: "#f8fafc" }}>{data.stats.storageLimitBytes ? `${(data.stats.storageLimitBytes / 1_000_000_000).toFixed(2)} Go` : "Non renseignée"}</div>
          {storageUsedBytes !== null && data.stats.storageLimitBytes > 0 && <div style={{ height: 9, borderRadius: 99, background: "#e2e8f0", overflow: "hidden", marginTop: 12 }}><div style={{ height: "100%", width: `${Math.min(100, storageUsedBytes / data.stats.storageLimitBytes * 100)}%`, background: settings.appearance.accentColor }} /></div>}
          <p style={{ color: "#64748b", fontSize: 12 }}>Les identifiants et clés B2 restent dans les variables d'environnement du serveur et ne sont jamais affichés ici.</p>
          <button style={{ ...button, marginTop: 12 }} onClick={() => void load()}>Actualiser les informations</button>
        </div>}

        {section === "appearance" && <div>
          <p style={{ color: "#64748b", fontSize: 14 }}>Personnaliser le nom affiché dans l'onglet du navigateur et la couleur principale de l'interface.</p>
          <label style={label}>Nom de l'application<input style={field} maxLength={60} value={settings.appearance.appName} onChange={e => setSettings(s => ({ ...s, appearance: { ...s.appearance, appName: e.target.value } }))} /></label>
          <label style={label}>Couleur principale<div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}><input type="color" value={settings.appearance.accentColor} onChange={e => setSettings(s => ({ ...s, appearance: { ...s.appearance, accentColor: e.target.value } }))} style={{ width: 54, height: 42, border: 0, background: "transparent" }} /><code>{settings.appearance.accentColor}</code></div></label>
          <div style={{ padding: 14, background: "#f8fafc", borderRadius: 8, marginTop: 16 }}><span style={{ color: "#64748b", fontSize: 12 }}>APERÇU</span><div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}><strong>{settings.appearance.appName}</strong><span style={{ background: settings.appearance.accentColor, color: "white", borderRadius: 7, padding: "7px 12px" }}>Bouton</span></div></div>
          <button style={{ ...button, marginTop: 20 }} disabled={saving} onClick={() => void save("appearance", settings.appearance)}>Enregistrer l'apparence</button>
        </div>}
      </section>
    </div>
  </div>;
}
