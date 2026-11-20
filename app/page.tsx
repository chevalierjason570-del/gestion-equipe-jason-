
"use client";

import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import * as tus from "tus-js-client";

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

const FILES_BUCKET = "fichiers-equipe";
const MAX_UPLOAD_BYTES = 10_000_000_000; // 10 Go (10 GB en base décimale)
const SUPABASE_PROJECT_REF = new URL(
  process.env.NEXT_PUBLIC_SUPABASE_URL!
).hostname.split(".")[0];
const TUS_ENDPOINT = `https://${SUPABASE_PROJECT_REF}.storage.supabase.co/storage/v1/upload/resumable`;
const SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

// Supabase Storage n'accepte qu'un jeu précis de caractères ASCII dans les clés.
// On retire les accents ("lycée" devient "lycee"), on garde les espaces et la
// ponctuation prise en charge, et on remplace les autres symboles par "_".
function sanitizeStorageSegment(segment: string) {
  const transliterated = segment
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[œŒæÆßøØłŁ]/g, character => {
      const replacements: Record<string, string> = {
        œ: "oe", Œ: "OE", æ: "ae", Æ: "AE", ß: "ss",
        ø: "o", Ø: "O", ł: "l", Ł: "L",
      };
      return replacements[character] || "_";
    });

  const safe = transliterated
    .replace(/[^A-Za-z0-9 _.'!,*&$@=;:+?(),-]/g, "_")
    .trim();

  if (!safe || safe === "." || safe === ".." || safe === ".folder") {
    throw new Error(
      "Nom de fichier ou de dossier invalide après conversion pour Supabase Storage."
    );
  }

  return safe;
}

function buildSafeStoragePath(folder: string, relativePath: string) {
  const folderParts = folder ? folder.split("/") : [];
  const fileParts = relativePath.split("/");

  if (fileParts.length === 0 || fileParts.some(part => !part.trim())) {
    throw new Error("Le chemin du fichier est vide ou invalide.");
  }

  // Chaque segment est converti séparément : les slashs restent des séparateurs
  // de dossiers, tandis que les espaces et signes autorisés restent inchangés.
  return [...folderParts, ...fileParts]
    .map(part => sanitizeStorageSegment(part))
    .join("/");
}

function uploadWithTus(
  file: File,
  objectName: string,
  accessToken: string,
  onProgress: (bytesUploaded: number) => void,
  upsert = false
): Promise<void> {
  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: TUS_ENDPOINT,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${accessToken}`,
        apikey: SUPABASE_PUBLISHABLE_KEY,
        "x-upsert": upsert ? "true" : "false",
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: 6 * 1024 * 1024,
      metadata: {
        bucketName: FILES_BUCKET,
        objectName,
        contentType: file.type || "application/octet-stream",
        cacheControl: "3600",
      },
      onError: error => reject(error),
      onProgress: bytesUploaded => onProgress(bytesUploaded),
      onSuccess: () => resolve(),
    });

    upload.findPreviousUploads()
      .then(previousUploads => {
        if (previousUploads.length > 0) {
          upload.resumeFromPreviousUpload(previousUploads[0]);
        }
        upload.start();
      })
      .catch(reject);
  });
}

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
// Gestion des fichiers partagés
type FileEntry = {
  name: string;
  path: string;
  type: "folder" | "file";
  size?: number;
  created_at?: string;
  downloadUrl?: string | null;
};
const [selectedFolderFiles, setSelectedFolderFiles] = useState<File[]>([]);
const [files, setFiles] = useState<FileEntry[]>([]);
const [currentFolder, setCurrentFolder] = useState("");
const [loadingFiles, setLoadingFiles] = useState(false);
const [filesError, setFilesError] = useState("");
const [filesSuccess, setFilesSuccess] = useState("");
const [newFolderName, setNewFolderName] = useState("");
const [selectedFile, setSelectedFile] = useState<File | null>(null);
const [fileActionLoading, setFileActionLoading] = useState(false);
const [uploadProgress, setUploadProgress] = useState<number | null>(null);
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
        headers: {
          "Content-Type": "application/json",
        },
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

 
async function deleteUser(item: UserProfile) {
  const confirmed = window.confirm(
    `Voulez-vous vraiment supprimer le compte ${item.username} ?`
  );

  if (!confirmed) return;

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
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ id: item.id }),
    });

    const result = await response.json();

    if (!response.ok) {
      setUserError(result.error || "Suppression impossible.");
      return;
    }

    setSuccess("Utilisateur supprimé avec succès !");
    await loadUsers();

  } catch {
    setUserError("Erreur lors de la suppression.");
  }
}

async function changeRole(item: UserProfile, role: string) {
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
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        id: item.id,
        role,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      setUserError(result.error || "Modification impossible.");
      return;
    }

    setSuccess("Rôle modifié avec succès !");
    await loadUsers();

  } catch {
    setUserError("Erreur lors de la modification.");
  }
}

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
      setUserError(result.error || "Impossible de créer l'utilisateur.");
      return;
    }

    setSuccess("Utilisateur créé avec succès !");

    setNewUsername("");
    setDisplayName("");
    setNewPassword("");
    setNewRole("standard");

    await loadUsers();

  } catch {
    setUserError("Erreur lors de la création de l'utilisateur.");
  } finally {
    setSaving(false);
  }
}
// Récupérer les fichiers et dossiers
async function loadFiles() {
  setLoadingFiles(true);
  setFilesError("");

  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (!token) {
      setFilesError("Session expirée. Reconnecte-toi.");
      return;
    }

    const response = await fetch(
      `/api/admin/files?folder=${encodeURIComponent(currentFolder)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    const result = await response.json();

    if (!response.ok) {
      setFilesError(result.error || "Impossible de charger les fichiers.");
      return;
    }

    setFiles(result.files || []);
  } catch {
    setFilesError("Erreur de communication avec le serveur.");
  } finally {
    setLoadingFiles(false);
  }
}

// Charger les fichiers quand on ouvre la rubrique
useEffect(() => {
  if (user && active === "fichiers") {
    loadFiles();
  }
}, [user, active, currentFolder]);

// Créer un dossier
async function createFolder(e: FormEvent) {
  e.preventDefault();

  if (!newFolderName.trim()) return;

  setFileActionLoading(true);
  setFilesError("");
  setFilesSuccess("");

  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (!token) {
      setFilesError("Session expirée.");
      return;
    }

    const formData = new FormData();
    formData.append("action", "create_folder");
    formData.append("folder", currentFolder);
    formData.append("name", newFolderName);

    const response = await fetch("/api/admin/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    });

    const result = await response.json();

    if (!response.ok) {
      setFilesError(result.error || "Création impossible.");
      return;
    }

    setNewFolderName("");
    setFilesSuccess("Dossier créé avec succès !");
    await loadFiles();
  } catch {
    setFilesError("Erreur lors de la création du dossier.");
  } finally {
    setFileActionLoading(false);
  }
}

// Envoyer un fichier volumineux directement vers Supabase avec TUS
async function uploadFile() {
  if (!selectedFile) {
    setFilesError("Sélectionne d'abord un fichier.");
    return;
  }

  if (selectedFile.size === 0 || selectedFile.size > MAX_UPLOAD_BYTES) {
    setFilesError("Le fichier doit être supérieur à 0 et ne pas dépasser 10 Go.");
    return;
  }

  setFileActionLoading(true);
  setUploadProgress(0);
  setFilesError("");
  setFilesSuccess("");

  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (!token) {
      setFilesError("Session expirée.");
      return;
    }

    const objectName = buildSafeStoragePath(currentFolder, selectedFile.name);

    await uploadWithTus(selectedFile, objectName, token, bytesUploaded => {
      setUploadProgress(
        Math.min(100, Math.round((bytesUploaded / selectedFile.size) * 100))
      );
    });

    setSelectedFile(null);
    setFilesSuccess("Fichier ajouté avec succès !");
    await loadFiles();
  } catch (error) {
    setFilesError(
      error instanceof Error
        ? `Erreur lors de l'envoi : ${error.message}`
        : "Erreur lors de l'envoi du fichier."
    );
  } finally {
    setFileActionLoading(false);
    setUploadProgress(null);
  }
}

// Supprimer un fichier
async function deleteFile(item: FileEntry) {
  if (item.type !== "file") return;

  if (!window.confirm(`Supprimer le fichier "${item.name}" ?`)) {
    return;
  }

  setFilesError("");
  setFilesSuccess("");

  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (!token) {
      setFilesError("Session expirée.");
      return;
    }

    const response = await fetch("/api/admin/files", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ path: item.path }),
    });

    const result = await response.json();

    if (!response.ok) {
      setFilesError(result.error || "Suppression impossible.");
      return;
    }

    setFilesSuccess("Fichier supprimé avec succès !");
    await loadFiles();
  } catch {
    setFilesError("Erreur lors de la suppression.");
  }
}

async function uploadFolder() {
  if (selectedFolderFiles.length === 0) {
    setFilesError("Sélectionne d'abord un dossier.");
    return;
  }

  if (!window.confirm(
    "Si certains fichiers existent déjà au même emplacement, ils seront remplacés. Continuer ?"
  )) {
    return;
  }

  const tooLargeFile = selectedFolderFiles.find(
    file => file.size === 0 || file.size > MAX_UPLOAD_BYTES
  );
  if (tooLargeFile) {
    setFilesError(`Le fichier "${tooLargeFile.name}" est vide ou dépasse 10 Go.`);
    return;
  }

  setFileActionLoading(true);
  setUploadProgress(0);
  setFilesError("");
  setFilesSuccess("");

  let uploadedCount = 0;
  const totalBytes = selectedFolderFiles.reduce((total, file) => total + file.size, 0);
  let completedBytes = 0;

  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (!token) {
      setFilesError("Session expirée. Reconnecte-toi.");
      return;
    }

    // Envoi séquentiel : chaque fichier peut reprendre après une interruption réseau.
    for (const file of selectedFolderFiles) {
      const relativePath =
        (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const objectName = buildSafeStoragePath(currentFolder, relativePath);

      await uploadWithTus(file, objectName, token, bytesUploaded => {
        const percentage = totalBytes > 0
          ? Math.round(((completedBytes + bytesUploaded) / totalBytes) * 100)
          : 100;
        setUploadProgress(Math.min(100, percentage));
      }, true);

      completedBytes += file.size;
      uploadedCount += 1;
    }

    setSelectedFolderFiles([]);
    setFilesSuccess(`${uploadedCount} fichier(s) envoyé(s) avec succès !`);
    await loadFiles();
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    setFilesError(
      `Envoi interrompu après ${uploadedCount} fichier(s) envoyé(s).${detail}`
    );
  } finally {
    setFileActionLoading(false);
    setUploadProgress(null);
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
                        {["Identifiant", "Nom affiché", "Rôle", "Actions"].map(title => (
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

<td style={{
  padding: 12,
  borderBottom: "1px solid #e2e8f0",
  whiteSpace: "nowrap"
}}>
  <button
    onClick={() =>
      changeRole(
        item,
        item.role === "admin" ? "standard" : "admin"
      )
    }
    style={{
      padding: 8,
      background: "#2563eb",
      color: "white",
      border: 0,
      borderRadius: 6,
      cursor: "pointer",
      marginRight: 8
    }}
  >
    {item.role === "admin" ? "Passer standard" : "Passer admin"}
  </button>

  <button
    onClick={() => deleteUser(item)}
    style={{
      padding: 8,
      background: "#dc2626",
      color: "white",
      border: 0,
      borderRadius: 6,
      cursor: "pointer"
    }}
  >
    Supprimer
  </button>
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
{active === "fichiers" && (
  <>
    <h2>📁 Gestion des fichiers partagés</h2>

    <p style={{ color: "#64748b" }}>
      Consulte et organise les documents de ton équipe.
    </p>

    {/* Navigation des dossiers */}
    <div style={{
      background: "white",
      padding: 18,
      borderRadius: 12,
      marginTop: 20,
      marginBottom: 20
    }}>
      <strong>📂 Emplacement : </strong>

      <button
        onClick={() => setCurrentFolder("")}
        style={{
          border: 0,
          background: "transparent",
          color: "#2563eb",
          cursor: "pointer"
        }}
      >
        Accueil
      </button>

      {currentFolder.split("/").filter(Boolean).map((part, index, parts) => {
        const path = parts.slice(0, index + 1).join("/");

        return (
          <span key={path}>
            {" / "}
            <button
              onClick={() => setCurrentFolder(path)}
              style={{
                border: 0,
                background: "transparent",
                color: "#2563eb",
                cursor: "pointer"
              }}
            >
              {part}
            </button>
          </span>
        );
      })}
    </div>

    {/* Création de dossier */}
    <div style={{
      background: "white",
      padding: 22,
      borderRadius: 12,
      marginBottom: 20
    }}>
      <h3>📁 Créer un dossier</h3>

      <form
        onSubmit={createFolder}
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap"
        }}
      >
        <input
          value={newFolderName}
          onChange={e => setNewFolderName(e.target.value)}
          placeholder="Nom du nouveau dossier"
          style={{
            ...inputStyle,
            flex: 1,
            minWidth: 180
          }}
        />

        <button
          disabled={fileActionLoading}
          style={{
            padding: 12,
            background: "#2563eb",
            color: "white",
            border: 0,
            borderRadius: 8,
            cursor: "pointer"
          }}
        >
          Créer
        </button>
      </form>
    </div>

    {/* Ajout de fichier */}
    <div style={{
      background: "white",
      padding: 22,
      borderRadius: 12,
      marginBottom: 20
    }}>
      <h3>📤 Ajouter un fichier</h3>

      <input
        type="file"
        onChange={e =>
          setSelectedFile(e.target.files?.[0] || null)
        }
        style={{
          display: "block",
          marginBottom: 15
        }}
      />

      <p style={{ color: "#64748b", fontSize: 13 }}>
        Taille maximale : 10 Go par fichier. Envoi direct et reprenable.
      </p>

      <button
        onClick={uploadFile}
        disabled={fileActionLoading || !selectedFile}
        style={{
          padding: 12,
          background: "#15803d",
          color: "white",
          border: 0,
          borderRadius: 8,
          cursor: "pointer"
        }}
      >
        {fileActionLoading ? "Traitement..." : "Envoyer le fichier"}
      </button>
    </div>

{/* Téléverser un dossier complet */}
<div style={{
  background: "white",
  padding: 22,
  borderRadius: 12,
  marginBottom: 20
}}>
  <h3>📁 Téléverser un dossier complet</h3>

  <p style={{ color: "#64748b" }}>
    Sélectionne un dossier depuis ton ordinateur.
  </p>

  <input
    type="file"
    multiple
    {...({ webkitdirectory: "", directory: "" } as any)}
    onChange={e =>
      setSelectedFolderFiles(
        Array.from(e.target.files || [])
      )
    }
    style={{ marginBottom: 15 }}
  />

  <p style={{ color: "#64748b", fontSize: 13 }}>
    {selectedFolderFiles.length > 0
      ? `${selectedFolderFiles.length} fichier(s) sélectionné(s)`
      : "Aucun dossier sélectionné"}
  </p>

  <button
    type="button"
    onClick={uploadFolder}
    disabled={fileActionLoading || selectedFolderFiles.length === 0}
    style={{
      padding: 12,
      background: "#7c3aed",
      color: "white",
      border: 0,
      borderRadius: 8,
      cursor: "pointer"
    }}
  >
    {fileActionLoading ? "Téléversement..." : "📁 Envoyer le dossier"}
  </button>
</div>

    {/* Messages */}
    {filesError && (
      <p style={{ color: "#dc2626" }}>{filesError}</p>
    )}

    {filesSuccess && (
      <p style={{ color: "#15803d" }}>{filesSuccess}</p>
    )}

    {uploadProgress !== null && (
      <div style={{ margin: "12px 0", maxWidth: 520 }}>
        <div
          role="progressbar"
          aria-label="Progression du téléversement"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={uploadProgress}
          style={{
            height: 12,
            background: "#e2e8f0",
            borderRadius: 999,
            overflow: "hidden",
          }}
        >
          <div style={{
            width: `${uploadProgress}%`,
            height: "100%",
            background: "#2563eb",
            transition: "width 150ms linear",
          }} />
        </div>
        <p style={{ color: "#475569", fontSize: 13 }}>
          Envoi en cours : {uploadProgress}%
        </p>
      </div>
    )}

    {/* Liste des fichiers */}
    <div style={{
      background: "white",
      padding: 22,
      borderRadius: 12
    }}>
      <h3>📂 Contenu du dossier</h3>

      {loadingFiles ? (
        <p>Chargement...</p>
      ) : files.length === 0 ? (
        <p style={{ color: "#64748b" }}>
          Ce dossier est vide.
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{
            width: "100%",
            borderCollapse: "collapse",
            textAlign: "left"
          }}>
            <thead>
              <tr>
                <th style={{ padding: 12 }}>Nom</th>
                <th style={{ padding: 12 }}>Type</th>
                <th style={{ padding: 12 }}>Taille</th>
                <th style={{ padding: 12 }}>Actions</th>
              </tr>
            </thead>

            <tbody>
              {files.map(item => (
                <tr key={item.path}>
                  <td style={{
                    padding: 12,
                    borderTop: "1px solid #e2e8f0"
                  }}>
                    {item.type === "folder" ? "📁" : "📄"}{" "}
                    {item.name}
                  </td>

                  <td style={{
                    padding: 12,
                    borderTop: "1px solid #e2e8f0"
                  }}>
                    {item.type === "folder" ? "Dossier" : "Fichier"}
                  </td>

                  <td style={{
                    padding: 12,
                    borderTop: "1px solid #e2e8f0"
                  }}>
                    {item.type === "file"
                      ? `${(item.size || 0) / 1024 / 1024 < 1
                          ? ((item.size || 0) / 1024).toFixed(1) + " Ko"
                          : ((item.size || 0) / 1024 / 1024).toFixed(2) + " Mo"}`
                      : "—"}
                  </td>

                  <td style={{
                    padding: 12,
                    borderTop: "1px solid #e2e8f0",
                    whiteSpace: "nowrap"
                  }}>
                    {item.type === "folder" ? (
                      <button
                        onClick={() => setCurrentFolder(item.path)}
                        style={{
                          padding: 8,
                          background: "#2563eb",
                          color: "white",
                          border: 0,
                          borderRadius: 6,
                          cursor: "pointer"
                        }}
                      >
                        Ouvrir
                      </button>
                    ) : (
                      <>
                        {item.downloadUrl && (
                          <a
                            href={item.downloadUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              display: "inline-block",
                              padding: 8,
                              background: "#15803d",
                              color: "white",
                              borderRadius: 6,
                              textDecoration: "none",
                              marginRight: 8
                            }}
                          >
                            Télécharger
                          </a>
                        )}

                        <button
                          onClick={() => deleteFile(item)}
                          style={{
                            padding: 8,
                            background: "#dc2626",
                            color: "white",
                            border: 0,
                            borderRadius: 6,
                            cursor: "pointer"
                          }}
                        >
                          Supprimer
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <button
        onClick={loadFiles}
        style={{
          marginTop: 18,
          padding: 10,
          background: "#e2e8f0",
          border: 0,
          borderRadius: 8,
          cursor: "pointer"
        }}
      >
        ↻ Actualiser
      </button>
    </div>
  </>
)}
        {active !== "accueil" &&
 active !== "utilisateurs" &&
 active !== "fichiers" && (
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
