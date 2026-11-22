
"use client";

import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import Messenger from "@/app/components/Messenger";
import AdminSettings from "@/app/components/AdminSettings";

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
type RoleDefinition = { id: string; role_key: string; name: string; permissions: string[]; is_system: boolean };
type RoleFileEntry = { path: string; type: "folder" | "file" };
const permissionOptions = [
  { id: "accueil", label: "Accueil" },
  { id: "fichiers", label: "Consulter les fichiers" },
  { id: "fichiers_gestion", label: "Ajouter, modifier et supprimer des fichiers" },
  { id: "messages", label: "Messagerie" },
  { id: "parametres", label: "Paramètres" },
];

const MAX_UPLOAD_BYTES = 10_000_000_000;
const MAX_STORAGE_BYTES = 10_000_000_000;
const B2_PART_CONCURRENCY = 1; // Limite les pics de requêtes vers Backblaze.

// B2 accepte les clés UTF-8 : accents, espaces, chiffres et ponctuation sont conservés.
// Les séparateurs et caractères de contrôle restent interdits dans chaque segment.
function sanitizeB2Segment(segment: string) {
  const value = segment.normalize("NFC");
  if (
    !value ||
    !value.trim() ||
    value === "." ||
    value === ".." ||
    value === ".folder" ||
    /[\u0000-\u001F\u007F-\u009F/\\]/u.test(value)
  ) {
    throw new Error(`Nom de fichier ou de dossier invalide : ${segment}`);
  }
  return value;
}

function buildB2ObjectKey(folder: string, relativePath: string) {
  const folderParts = folder ? folder.split("/") : [];
  const fileParts = relativePath.split("/");
  if (!fileParts.length || fileParts.some(part => !part.trim())) {
    throw new Error("Le chemin du fichier est vide ou invalide.");
  }
  const key = [...folderParts, ...fileParts].map(sanitizeB2Segment).join("/");
  if (new TextEncoder().encode(key).length > 1024) {
    throw new Error("Le chemin du fichier dépasse la limite de 1 024 octets.");
  }
  return key;
}

async function b2UploadApi(accessToken: string, body: Record<string, unknown>) {
  const response = await fetch("/api/admin/files/upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Erreur du serveur (${response.status}).`);
  }
  return result;
}

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

function getRetryAfterMilliseconds(response: Response | null): number | null {
  const value = response?.headers.get("Retry-After");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function putPartWithRetry(
  initialUrl: string,
  body: Blob,
  partNumber: number,
  accessToken: string,
  objectKey: string,
  uploadId: string
) {
  // B2 may return a transient 503 for UploadPart. Keep the same multipart
  // upload and part number, but request a fresh presigned URL before retrying.
  const maxAttempts = 10;
  let activeUrl = initialUrl;
  let lastMessage = "Erreur réseau inconnue.";
  let lastRequestId = "";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let response: Response | null = null;

    try {
      response = await fetch(activeUrl, { method: "PUT", body });
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : "Erreur réseau.";
    }

    if (response?.ok) {
      const etag = response.headers.get("ETag") || response.headers.get("etag");
      if (!etag) {
        throw new Error("B2 n'a pas renvoyé l'ETag. Vérifie la règle CORS du bucket (ExposeHeaders : ETag).");
      }
      return etag;
    }

    if (response) {
      const responseText = await response.text().catch(() => "");
      lastMessage = `HTTP ${response.status}${responseText ? ` : ${responseText.slice(0, 300)}` : ""}`;
      lastRequestId = response.headers.get("x-amz-request-id") || response.headers.get("x-bz-request-id") || "";
      const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
      if (!retryable) {
        throw new Error(`B2 a refusé la partie ${partNumber} (${lastMessage}).`);
      }
    }

    if (attempt === maxAttempts - 1) break;

    // Exponential backoff with jitter. Respect Retry-After when CORS exposes it.
    const exponentialDelay = Math.min(120_000, 2_000 * (2 ** attempt));
    const jitteredDelay = Math.round(exponentialDelay * (0.8 + Math.random() * 0.4));
    const retryAfter = getRetryAfterMilliseconds(response);
    await sleep(Math.max(jitteredDelay, retryAfter || 0));

    // Refresh the URL for this same multipart upload and part. Re-uploading
    // the same part number is safe: it replaces that part in the open upload.
    try {
      const refreshed = await b2UploadApi(accessToken, {
        action: "signParts",
        key: objectKey,
        uploadId,
        partNumbers: [partNumber],
      });
      const freshPart = Array.isArray(refreshed.urls)
        ? refreshed.urls.find((item: { partNumber: number; url: string }) => item.partNumber === partNumber)
        : null;
      if (!freshPart?.url) {
        throw new Error("B2 n'a pas fourni de nouvelle URL de téléversement.");
      }
      activeUrl = freshPart.url;
    } catch (refreshError) {
      const refreshMessage = refreshError instanceof Error ? refreshError.message : "Erreur de renouvellement de l'URL.";
      lastMessage = `${lastMessage} ; renouvellement URL : ${refreshMessage}`;
      // Keep the previous URL as a fallback; it may still be valid.
    }
  }

  const requestInfo = lastRequestId ? ` ; request ID ${lastRequestId}` : "";
  throw new Error(
    `Backblaze refuse toujours la partie ${partNumber} après ${maxAttempts} tentatives (${lastMessage}${requestInfo}). Le transfert multipart reste en attente : relance le même fichier dans le même navigateur pour reprendre les parties confirmées. Si le 503 persiste, consulte le statut Backblaze ou contacte leur support avec le request ID.`
  );
}

// Envoi multipart B2 : les blocs sont envoyés directement du navigateur vers B2.
// L'identifiant est conservé dans localStorage pour reprendre le même fichier après une coupure.
async function uploadFileToB2(
  file: File,
  objectKey: string,
  accessToken: string,
  onProgress: (bytesUploaded: number) => void,
  overwrite = false
) {
  const contentType = file.type || "application/octet-stream";
  const resumeStorageKey = `gestion-equipe-b2-upload:${objectKey}:${file.size}:${file.lastModified}`;

  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("Le fichier dépasse la limite de 10 Go.");
  }

  if (file.size <= 64 * 1024 * 1024) {
    const init = await b2UploadApi(accessToken, {
      action: "init", key: objectKey, size: file.size, contentType, overwrite,
    });
    if (init.mode !== "single" || !init.url) {
      throw new Error("B2 n'a pas pu préparer le téléversement direct.");
    }
    const response = await fetch(init.url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: file,
    });
    if (!response.ok) throw new Error(`B2 a refusé le fichier (HTTP ${response.status}).`);
    onProgress(file.size);
    return;
  }

  let state: { key: string; uploadId: string; partSize: number } | null = null;
  try {
    const saved = localStorage.getItem(resumeStorageKey);
    if (saved) state = JSON.parse(saved);
  } catch {
    localStorage.removeItem(resumeStorageKey);
  }

  let completedParts: Array<{ PartNumber: number; ETag: string }> = [];
  if (state?.uploadId && state.key === objectKey) {
    try {
      const listed = await b2UploadApi(accessToken, {
        action: "listParts", key: objectKey, uploadId: state.uploadId,
      });
      completedParts = listed.parts || [];
    } catch {
      state = null;
      localStorage.removeItem(resumeStorageKey);
    }
  }

  if (!state) {
    const init = await b2UploadApi(accessToken, {
      action: "init", key: objectKey, size: file.size, contentType, overwrite,
    });
    if (init.mode !== "multipart" || !init.uploadId || !init.partSize) {
      throw new Error("B2 n'a pas pu initialiser le transfert multipart.");
    }
    state = { key: objectKey, uploadId: init.uploadId, partSize: init.partSize };
    localStorage.setItem(resumeStorageKey, JSON.stringify(state));
  }

  const partSize = state.partSize;
  const totalParts = Math.ceil(file.size / partSize);
  const completedMap = new Map<number, string>(
    completedParts.map(part => [part.PartNumber, part.ETag])
  );
  const bytesForParts = () => Array.from(completedMap.keys()).reduce((total, partNumber) => {
    const start = (partNumber - 1) * partSize;
    return total + Math.max(0, Math.min(partSize, file.size - start));
  }, 0);
  onProgress(bytesForParts());

  for (let first = 1; first <= totalParts; first += B2_PART_CONCURRENCY) {
    const batch = Array.from(
      { length: Math.min(B2_PART_CONCURRENCY, totalParts - first + 1) },
      (_, index) => first + index
    ).filter(partNumber => !completedMap.has(partNumber));
    if (!batch.length) continue;

    const signed = await b2UploadApi(accessToken, {
      action: "signParts",
      key: objectKey,
      uploadId: state.uploadId,
      partNumbers: batch,
    });

    await Promise.all((signed.urls || []).map(async (item: { partNumber: number; url: string }) => {
      const start = (item.partNumber - 1) * partSize;
      const end = Math.min(file.size, start + partSize);
      const etag = await putPartWithRetry(
        item.url,
        file.slice(start, end),
        item.partNumber,
        accessToken,
        objectKey,
        state.uploadId
      );
      completedMap.set(item.partNumber, etag);
      onProgress(bytesForParts());
    }));
  }

  const parts = Array.from(completedMap.entries())
    .map(([PartNumber, ETag]) => ({ PartNumber, ETag }))
    .sort((a, b) => a.PartNumber - b.PartNumber);
  if (parts.length !== totalParts) {
    throw new Error("Le transfert est incomplet. Relance le même fichier pour reprendre l'envoi.");
  }

  await b2UploadApi(accessToken, {
    action: "complete", key: objectKey, uploadId: state.uploadId, parts,
  });
  localStorage.removeItem(resumeStorageKey);
  onProgress(file.size);
}

export default function Home() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState<any>(null);
  const [currentUserRole, setCurrentUserRole] = useState<string>("");
  const [currentUserPermissions, setCurrentUserPermissions] = useState<string[]>(["accueil", "fichiers", "messages"]);
  const [currentDisplayName, setCurrentDisplayName] = useState<string>("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState("accueil");
  const [appBrandName, setAppBrandName] = useState("Gestion Équipe Jason");
  const [appAccentColor, setAppAccentColor] = useState("#2563eb");

  useEffect(() => {
    const applyBrand = (event: Event) => {
      const detail = (event as CustomEvent<{ appName?: string; accentColor?: string; displayName?: string }>).detail;
      if (detail?.appName) { setAppBrandName(detail.appName); document.title = detail.appName; }
      if (detail?.accentColor) setAppAccentColor(detail.accentColor);
      if (detail?.displayName) setCurrentDisplayName(detail.displayName);
    };
    window.addEventListener("gestion-equipe-brand", applyBrand);
    return () => window.removeEventListener("gestion-equipe-brand", applyBrand);
  }, []);

  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [saving, setSaving] = useState(false);
  const [userError, setUserError] = useState("");
  const [success, setSuccess] = useState("");

  const [newUsername, setNewUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState("");
  const [roles, setRoles] = useState<RoleDefinition[]>([]);
  const [loadingRoles, setLoadingRoles] = useState(false);
  const [roleName, setRoleName] = useState("");
  const [rolePermissions, setRolePermissions] = useState<string[]>(["accueil"]);
  const [editingRoleId, setEditingRoleId] = useState("");
  const [roleError, setRoleError] = useState("");
  const [roleSuccess, setRoleSuccess] = useState("");
  const [roleFileRulesText, setRoleFileRulesText] = useState("");
  const [roleFileEntries, setRoleFileEntries] = useState<RoleFileEntry[]>([]);
  const [roleFileDenied, setRoleFileDenied] = useState<Record<string, boolean>>({});
  const [loadingRoleFileEntries, setLoadingRoleFileEntries] = useState(false);
  const [savingRole, setSavingRole] = useState(false);
// Gestion des fichiers partagés
type FileEntry = {
  name: string;
  path: string;
  type: "folder" | "file";
  size?: number;
  created_at?: string;
  previewUrl?: string | null;
  downloadUrl?: string | null;
};
const [fileUserCanManage, setFileUserCanManage] = useState(false);
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
const [storageUsageBytes, setStorageUsageBytes] = useState(0);
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

  // Le rôle est vérifié côté serveur : seuls les droits du rôle attribué
  // déterminent les rubriques visibles dans le menu.
  useEffect(() => {
    let cancelled = false;

    if (!user?.id) {
      setCurrentUserRole("");
      setCurrentUserPermissions(["accueil", "fichiers", "messages"]);
      setCurrentDisplayName("");
      return;
    }

    setCurrentUserRole("");
    setCurrentDisplayName("");
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) throw new Error("Session absente.");

        const response = await fetch("/api/profile", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "Rôle introuvable.");

        if (!cancelled) {
          setCurrentUserRole(result.role || "");
          setCurrentUserPermissions(Array.isArray(result.permissions) ? result.permissions : ["accueil", "fichiers", "messages"]);
          setCurrentDisplayName(
            typeof result.display_name === "string" && result.display_name.trim()
              ? result.display_name.trim()
              : typeof result.username === "string" && result.username.trim()
                ? result.username.trim()
                : "Utilisateur"
          );
        }
      } catch {
        // En cas d'échec, appliquer le principe du moindre privilège.
        // Ne jamais afficher l'adresse e-mail comme solution de repli.
        if (!cancelled) {
          setCurrentUserRole("");
          setCurrentUserPermissions(["accueil"]);
          setCurrentDisplayName("Utilisateur");
        }
      }
    })();

    return () => { cancelled = true; };
  }, [user?.id]);

  useEffect(() => {
    if (currentUserRole && currentUserRole !== "admin" &&
        (active === "utilisateurs" || active === "roles" || active === "parametres")) {
      setActive("accueil");
    }
  }, [currentUserRole, active]);


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
    setCurrentUserRole("");
    setCurrentUserPermissions(["accueil"]);
    setActive("accueil");
  }

  async function loadRoles() {
    setLoadingRoles(true);
    setRoleError("");
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Session expirée. Reconnecte-toi.");
      const response = await fetch("/api/admin/roles", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Chargement des rôles impossible.");
      const loadedRoles: RoleDefinition[] = result.roles || [];
      setRoles(loadedRoles);
      let configuredDefaultRole = "";
      try {
        const settingsResponse = await fetch("/api/admin/settings", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (settingsResponse.ok) {
          const settingsResult = await settingsResponse.json();
          configuredDefaultRole = settingsResult.settings?.accounts?.defaultRole || "";
        }
      } catch { /* Le choix manuel reste disponible si les paramètres sont indisponibles. */ }
      setNewRole(current => configuredDefaultRole && loadedRoles.some(role => role.role_key === configuredDefaultRole)
        ? configuredDefaultRole
        : loadedRoles.some(role => role.role_key === current)
          ? current
          : (loadedRoles.find(role => role.role_key !== "admin")?.role_key || "admin"));
    } catch (err) {
      setRoleError(err instanceof Error ? err.message : "Erreur de chargement des rôles.");
    } finally { setLoadingRoles(false); }
  }

  useEffect(() => {
    if (user && (active === "roles" || active === "utilisateurs")) loadRoles();
    if (user && active === "roles") {
      void (async () => {
        try {
          const { data } = await supabase.auth.getSession();
          const token = data.session?.access_token;
          if (!token) return;
          const response = await fetch("/api/admin/files?tree=1", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
          const result = await response.json();
          if (response.ok && Array.isArray(result.entries)) setRoleFileEntries(result.entries);
        } catch { /* La liste sera rechargée lors de l'édition du rôle. */ }
      })();
    }
  }, [user, active]);

  function startEditRole(role: RoleDefinition) {
    if (role.role_key === "admin") return;
    setEditingRoleId(role.id);
    setRoleName(role.name);
    setRolePermissions(role.permissions || []);
    setRoleFileRulesText("");
    setRoleError(""); setRoleSuccess("");
    setLoadingRoleFileEntries(true);
    void (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) return;
        const response = await fetch(`/api/admin/roles/file-rules?roleKey=${encodeURIComponent(role.role_key)}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Chargement des droits fichiers impossible.");
        setRoleFileRulesText((result.rules || []).map((rule: any) => `${rule.access}|${rule.entry_type}|${rule.path}`).join("\n"));
        const treeResponse = await fetch("/api/admin/files?tree=1", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        const treeResult = await treeResponse.json();
        if (!treeResponse.ok) throw new Error(treeResult.error || "Chargement de l'arborescence impossible.");
        const entries: RoleFileEntry[] = Array.isArray(treeResult.entries) ? treeResult.entries : [];
        setRoleFileEntries(entries);
        const denied: Record<string, boolean> = {};
        for (const rule of result.rules || []) if (rule.access === "deny") denied[`${rule.entry_type}:${rule.path}`] = true;
        setRoleFileDenied(denied);
      } catch (err) { setRoleError(err instanceof Error ? err.message : "Erreur de chargement des droits fichiers."); }
      finally { setLoadingRoleFileEntries(false); }
    })();
  }

  async function saveRole(e: FormEvent) {
    e.preventDefault(); setSavingRole(true); setRoleError(""); setRoleSuccess("");
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Session expirée. Reconnecte-toi.");
      const response = await fetch("/api/admin/roles", {
        method: editingRoleId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: editingRoleId || undefined, name: roleName, permissions: rolePermissions }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Enregistrement impossible.");
      const savedRole = result.role;
      if (!savedRole?.role_key) throw new Error("Le rôle a été enregistré, mais sa clé est manquante.");
      const rules: Array<{access:"deny"|"allow";entry_type:"folder"|"file";path:string}> = [];
      for (const entry of roleFileEntries) {
        const key = `${entry.type}:${entry.path}`;
        if (roleFileDenied[key]) {
          rules.push({ access: "deny", entry_type: entry.type, path: entry.path });
          continue;
        }
        const parts = entry.path.split("/");
        const hasDeniedParent = entry.type === "file" && parts.slice(0, -1).some((_, index) =>
          !!roleFileDenied[`folder:${parts.slice(0, index + 1).join("/")}`]
        );
        if (hasDeniedParent) rules.push({ access: "allow", entry_type: "file", path: entry.path });
      }
      const rulesResponse = await fetch("/api/admin/roles/file-rules", {
        method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ roleKey: savedRole.role_key, rules }),
      });
      const rulesResult = await rulesResponse.json();
      if (!rulesResponse.ok) throw new Error(rulesResult.error || "Le rôle est enregistré, mais ses règles de fichiers ne le sont pas.");
      setRoleSuccess(editingRoleId ? "Rôle modifié avec ses droits fichiers." : "Rôle créé avec ses droits fichiers.");
      setRoleName(""); setRolePermissions(["accueil"]); setEditingRoleId(""); setRoleFileRulesText(""); setRoleFileDenied({});
      await loadRoles();
    } catch (err) { setRoleError(err instanceof Error ? err.message : "Erreur d'enregistrement."); }
    finally { setSavingRole(false); }
  }

  async function deleteRole(role: RoleDefinition) {
    if (!window.confirm(`Supprimer le rôle « ${role.name} » ?`)) return;
    setRoleError(""); setRoleSuccess("");
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Session expirée. Reconnecte-toi.");
      const response = await fetch("/api/admin/roles", { method: "DELETE", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ id: role.id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Suppression impossible.");
      setRoleSuccess("Rôle supprimé."); await loadRoles();
    } catch (err) { setRoleError(err instanceof Error ? err.message : "Erreur de suppression."); }
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
    setNewRole(roles.find(role => role.role_key !== "admin")?.role_key || "admin");

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
    setFileUserCanManage(result.role === "admin" || result.permissions?.includes("fichiers_gestion") === true);
    setStorageUsageBytes(Number(result.storage?.usedBytes || 0));
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

// Envoyer un fichier directement vers Backblaze B2 avec transfert multipart
async function uploadFile() {
  if (!selectedFile) {
    setFilesError("Sélectionne d'abord un fichier.");
    return;
  }

  if (selectedFile.size > MAX_UPLOAD_BYTES) {
    setFilesError("Le fichier ne doit pas dépasser 10 Go.");
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

    const objectName = buildB2ObjectKey(currentFolder, selectedFile.name);

    await uploadFileToB2(selectedFile, objectName, token, bytesUploaded => {
      const percentage = selectedFile.size > 0
        ? Math.round((bytesUploaded / selectedFile.size) * 100)
        : 100;
      setUploadProgress(Math.min(100, percentage));
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

// Télécharger un dossier entier sous forme de ZIP sans charger l'archive
// dans la mémoire du navigateur : le navigateur reçoit directement la réponse.
async function downloadFolder(item: FileEntry) {
  const targetName = `download-folder-${Date.now()}`;
  const popup = window.open("about:blank", targetName);
  setFilesError("");

  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (!token) {
      popup?.close();
      setFilesError("Session expirée. Reconnecte-toi.");
      return;
    }

    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/admin/files";
    form.target = popup ? targetName : "_self";
    form.style.display = "none";

    const fields: Record<string, string> = {
      action: "download_folder",
      folder: item.path,
      accessToken: token,
    };

    for (const [name, value] of Object.entries(fields)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }

    document.body.appendChild(form);
    form.submit();
    form.remove();
  } catch {
    popup?.close();
    setFilesError("Impossible de télécharger ce dossier.");
  }
}

// Supprimer un fichier ou un dossier complet
async function deleteFile(item: FileEntry) {
  const message = item.type === "folder"
    ? `Supprimer le dossier "${item.name}" et TOUS les fichiers qu'il contient ? Cette action est définitive.`
    : `Supprimer le fichier "${item.name}" ?`;

  if (!window.confirm(message)) return;

  setFileActionLoading(true);
  setFilesError("");
  setFilesSuccess("");

  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (!token) {
      setFilesError("Session expirée. Reconnecte-toi.");
      return;
    }

    const response = await fetch("/api/admin/files", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ path: item.path, type: item.type }),
    });

    const result = await response.json();
    if (!response.ok) {
      setFilesError(result.error || "Suppression impossible.");
      return;
    }

    setFilesSuccess(
      item.type === "folder"
        ? `Dossier supprimé (${result.deleted || 0} élément(s)).`
        : "Fichier supprimé avec succès !"
    );
    await loadFiles();
  } catch {
    setFilesError("Erreur lors de la suppression.");
  } finally {
    setFileActionLoading(false);
  }
}

// Renommer un fichier ou un dossier
async function renameEntry(item: FileEntry) {
  const name = window.prompt("Nouveau nom :", item.name);
  if (name === null || !name.trim() || name.trim() === item.name) return;

  await updateEntry(item, {
    action: "rename",
    name: name.trim(),
  });
}

// Déplacer un fichier ou un dossier vers un autre dossier existant.
// Laisser le champ vide pour déplacer à la racine du stockage.
async function moveEntry(item: FileEntry) {
  const defaultDestination = currentFolder === item.path
    ? ""
    : currentFolder;
  const destinationFolder = window.prompt(
    "Chemin du dossier de destination (vide = accueil). Exemple : Documents/Equipe",
    defaultDestination
  );
  if (destinationFolder === null) return;

  await updateEntry(item, {
    action: "move",
    destinationFolder: destinationFolder.trim(),
  });
}

async function updateEntry(
  item: FileEntry,
  changes: { action: "rename"; name: string } | { action: "move"; destinationFolder: string }
) {
  setFileActionLoading(true);
  setFilesError("");
  setFilesSuccess("");

  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (!token) {
      setFilesError("Session expirée. Reconnecte-toi.");
      return;
    }

    const response = await fetch("/api/admin/files", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        path: item.path,
        type: item.type,
        ...changes,
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      setFilesError(result.error || "Opération impossible.");
      return;
    }

    setFilesSuccess(
      changes.action === "rename"
        ? "Renommage effectué avec succès !"
        : "Déplacement effectué avec succès !"
    );
    await loadFiles();
  } catch {
    setFilesError("Erreur lors de l'organisation du fichier ou dossier.");
  } finally {
    setFileActionLoading(false);
  }
}

async function uploadFolder() {
  if (selectedFolderFiles.length === 0) {
    setFilesError("Sélectionne d'abord un dossier.");
    return;
  }

  if (!window.confirm(
    "Pour reprendre un envoi interrompu, les fichiers déjà présents avec le même chemin et la même taille seront ignorés. Si un fichier a changé sans changer de taille, il ne sera pas renvoyé automatiquement. Les fichiers de taille différente seront remplacés. Continuer ?"
  )) {
    return;
  }

  const tooLargeFile = selectedFolderFiles.find(
    file => file.size > MAX_UPLOAD_BYTES
  );
  if (tooLargeFile) {
    setFilesError(`Le fichier "${tooLargeFile.name}" dépasse la limite de 10 Go.`);
    return;
  }

  setFileActionLoading(true);
  setUploadProgress(0);
  setFilesError("");
  setFilesSuccess("");

  let uploadedCount = 0;
  let skippedCount = 0;
  const totalBytes = selectedFolderFiles.reduce((total, file) => total + file.size, 0);
  let completedBytes = 0;

  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (!token) {
      setFilesError("Session expirée. Reconnecte-toi.");
      return;
    }

    // Cherche d'abord les objets déjà présents dans le sous-dossier sélectionné.
    // Cela évite de renvoyer les centaines de fichiers déjà reçus lors d'une tentative précédente.
    const relativePaths = selectedFolderFiles.map(file =>
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    );
    const directoryParts = relativePaths.map(path => path.split("/").slice(0, -1));
    let commonParts = directoryParts.length ? [...directoryParts[0]] : [];
    for (const parts of directoryParts.slice(1)) {
      let shared = 0;
      while (shared < commonParts.length && shared < parts.length && commonParts[shared] === parts[shared]) {
        shared++;
      }
      commonParts = commonParts.slice(0, shared);
    }
    const commonPrefix = [currentFolder, ...commonParts].filter(Boolean).join("/");
    const existingResult = await b2UploadApi(token, {
      action: "listExisting",
      prefix: commonPrefix,
    });
    const existingSizes = new Map<string, number>(
      (existingResult.objects || []).map((item: { key: string; size: number }) => [item.key, item.size])
    );

    // Envoi séquentiel : chaque fichier reprend ses parties déjà validées par B2 en cas de coupure.
    for (const file of selectedFolderFiles) {
      const relativePath =
        (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const objectName = buildB2ObjectKey(currentFolder, relativePath);

      // Les fichiers déjà finalisés dans B2 avec la même taille sont conservés.
      if (existingSizes.get(objectName) === file.size) {
        completedBytes += file.size;
        uploadedCount += 1;
        skippedCount += 1;
        const percentage = totalBytes > 0
          ? Math.round((completedBytes / totalBytes) * 100)
          : 100;
        setUploadProgress(Math.min(100, percentage));
        continue;
      }

      await uploadFileToB2(file, objectName, token, bytesUploaded => {
        const percentage = totalBytes > 0
          ? Math.round(((completedBytes + bytesUploaded) / totalBytes) * 100)
          : 100;
        setUploadProgress(Math.min(100, percentage));
      }, true);

      completedBytes += file.size;
      uploadedCount += 1;
      existingSizes.set(objectName, file.size);
    }

    setSelectedFolderFiles([]);
    setFilesSuccess(
      `${uploadedCount - skippedCount} fichier(s) envoyé(s), ${skippedCount} déjà présent(s) conservé(s).`
    );
    await loadFiles();
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    setFilesError(
      `Envoi interrompu après ${uploadedCount} fichier(s) envoyé(s) ou déjà présents (${skippedCount} conservé(s)). Relance le même dossier pour reprendre.${detail}`
    );
  } finally {
    setFileActionLoading(false);
    setUploadProgress(null);
  }
}

  const isAdmin = currentUserRole === "admin";
  const profilePhotoUrl =
    typeof user?.user_metadata?.avatar_url === "string" && user.user_metadata.avatar_url.trim()
      ? user.user_metadata.avatar_url.trim()
      : typeof user?.user_metadata?.picture === "string" && user.user_metadata.picture.trim()
        ? user.user_metadata.picture.trim()
        : "";
  const visibleMenu = isAdmin
    ? menu
    : menu.filter(item =>
        item.id !== "utilisateurs" &&
        item.id !== "roles" &&
        item.id !== "parametres" &&
        currentUserPermissions.includes(item.id)
      );
  const current = visibleMenu.find(item => item.id === active) || menu[0];

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
          <h1 style={{ color: "#172554" }}>{appBrandName}</h1>
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
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 9,
          marginBottom: 24,
          paddingTop: 8
        }}>
          {profilePhotoUrl ? (
            <img
              src={profilePhotoUrl}
              alt={`Photo de profil de ${currentDisplayName || "l'utilisateur"}`}
              style={{
                width: 88,
                height: 88,
                borderRadius: "50%",
                objectFit: "cover",
                border: "3px solid rgba(255,255,255,0.85)"
              }}
            />
          ) : (
            <div
              aria-label="Photo de profil non définie"
              style={{
                width: 88,
                height: 88,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "#dbeafe",
                color: "#1e40af",
                border: "3px solid rgba(255,255,255,0.85)",
                fontSize: 36,
                fontWeight: 700
              }}
            >
              {(currentDisplayName || "U").trim().charAt(0).toUpperCase()}
            </div>
          )}
          <strong style={{ color: "white", fontSize: 18, textAlign: "center", overflowWrap: "anywhere" }}>
            {currentDisplayName || "Utilisateur"}
          </strong>
        </div>
        <p style={{ color: "#94a3b8", fontSize: 11 }}>MENU PRINCIPAL</p>

        {visibleMenu.map(item => (
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
              background: active === item.id ? appAccentColor : "transparent",
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
            👤 {currentDisplayName || "Utilisateur"}
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
              {visibleMenu.filter(item => item.id !== "accueil" && item.id !== "parametres").map(item => (
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

        {isAdmin && active === "utilisateurs" && (
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
                  {roles.map(role => <option key={role.role_key} value={role.role_key}>{role.name}</option>)}
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
  {roles.find(role => role.role_key === item.role)?.name || item.role}
</td>

<td style={{
  padding: 12,
  borderBottom: "1px solid #e2e8f0",
  whiteSpace: "nowrap"
}}>
  <select value={item.role} onChange={e => changeRole(item, e.target.value)} style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 6, marginRight: 8 }}>
    {roles.map(role => <option key={role.role_key} value={role.role_key}>{role.name}</option>)}
  </select>

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
{isAdmin && active === "roles" && (
  <>
    <h2>🛡️ Gestion des rôles</h2>
    <p style={{ color: "#64748b" }}>Crée des rôles personnalisés et choisis les rubriques auxquelles leurs utilisateurs peuvent accéder.</p>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20, marginTop: 20 }}>
      <div style={{ background: "white", padding: 22, borderRadius: 12, border: "1px solid #e2e8f0" }}>
        <h3>{editingRoleId ? "Modifier le rôle" : "➕ Créer un rôle"}</h3>
        <form onSubmit={saveRole}>
          <label>Nom du rôle</label>
          <input value={roleName} onChange={e => setRoleName(e.target.value)} required maxLength={60} placeholder="Ex. Responsable" style={inputStyle} />
          <strong>Autorisations</strong>
          <p style={{ color: "#64748b", fontSize: 13 }}>Choisis les rubriques visibles pour les utilisateurs de ce rôle.</p>
          {permissionOptions.map(option => (
            <label key={option.id} style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0" }}>
              <input type="checkbox" checked={rolePermissions.includes(option.id)} onChange={e => setRolePermissions(current => e.target.checked ? [...current, option.id] : current.filter(value => value !== option.id))} />
              {option.label}
            </label>
          ))}
          <strong style={{ display: "block", marginTop: 18 }}>Accès aux dossiers et fichiers</strong>
          <p style={{ color: "#64748b", fontSize: 13 }}>Une règle par ligne au format <code>deny|folder|Documents/Confidentiel</code> ou <code>allow|file|Documents/Confidentiel/rapport.pdf</code>. Un refus sur un dossier s'applique à son contenu. Une autorisation explicite sur un fichier constitue une exception.</p>
          <div style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: 12, maxHeight: 420, overflowY: "auto", marginTop: 8 }}>
            {loadingRoleFileEntries ? <p>Chargement des dossiers et fichiers...</p> : roleFileEntries.length === 0 ? <p style={{ color: "#64748b" }}>Aucun fichier trouvé dans le stockage.</p> : roleFileEntries.map(entry => {
              const depth = entry.path.split("/").length - 1;
              const name = entry.path.split("/").pop() || entry.path;
              const key = `${entry.type}:${entry.path}`;
              return <label key={key} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 4px", paddingLeft: 8 + depth * 18, borderBottom: "1px solid #f1f5f9", cursor: "pointer" }}>
                <input type="checkbox" checked={!!roleFileDenied[key]} onChange={e => setRoleFileDenied(current => ({ ...current, [key]: e.target.checked }))} />
                <span>{entry.type === "folder" ? "📁" : "📄"} {name}</span>
                <span style={{ marginLeft: "auto", fontSize: 11, color: roleFileDenied[key] ? "#dc2626" : "#15803d" }}>{roleFileDenied[key] ? "Interdit / invisible" : "Autorisé"}</span>
              </label>;
            })}
          </div>
          <p style={{ color: "#64748b", fontSize: 12 }}>Coché = interdit et invisible. Un dossier interdit masque son contenu. Décoche un fichier pour créer une exception d'accès s'il se trouve dans un dossier interdit.</p>
          <button disabled={savingRole} style={{ width: "100%", padding: 12, marginTop: 12, background: "#2563eb", color: "white", border: 0, borderRadius: 8, cursor: "pointer" }}>{savingRole ? "Enregistrement..." : editingRoleId ? "Enregistrer les modifications" : "Créer le rôle"}</button>
          {editingRoleId && <button type="button" onClick={() => { setEditingRoleId(""); setRoleName(""); setRolePermissions(["accueil"]); setRoleFileRulesText(""); setRoleFileDenied({}); }} style={{ width: "100%", padding: 10, marginTop: 8, border: "1px solid #cbd5e1", borderRadius: 8, background: "white" }}>Annuler</button>}
        </form>
        {roleError && <p style={{ color: "#dc2626" }}>{roleError}</p>}
        {roleSuccess && <p style={{ color: "#15803d" }}>{roleSuccess}</p>}
      </div>
      <div style={{ background: "white", padding: 22, borderRadius: 12, border: "1px solid #e2e8f0" }}>
        <h3>Rôles existants</h3>
        {loadingRoles ? <p>Chargement...</p> : roles.map(role => (
          <div key={role.id} style={{ padding: "14px 0", borderBottom: "1px solid #e2e8f0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <strong>{role.name}</strong>
              {role.role_key === "admin" ? <span style={{ color: "#64748b", fontSize: 12 }}>Protégé</span> : <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => startEditRole(role)} style={{ padding: "6px 9px", border: 0, borderRadius: 6, background: "#dbeafe", color: "#1d4ed8" }}>Modifier</button>
                {!role.is_system && <button onClick={() => deleteRole(role)} style={{ padding: "6px 9px", border: 0, borderRadius: 6, background: "#fee2e2", color: "#b91c1c" }}>Supprimer</button>}
              </div>}
            </div>
            <p style={{ color: "#64748b", fontSize: 13, marginBottom: 0 }}>{(role.permissions || []).map(permission => permissionOptions.find(option => option.id === permission)?.label || permission).join(" · ") || "Aucune rubrique"}</p>
          </div>
        ))}
      </div>
    </div>
  </>
)}

{active === "fichiers" && (
  <>
    <h2>📁 Fichiers partagés</h2>

    <p style={{ color: "#64748b" }}>
      Consulte les documents de ton équipe. Les aperçus et téléchargements sont disponibles pour tous les membres connectés.
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

    {fileUserCanManage && (<>
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

    {/* Quota de stockage gratuit Backblaze B2 */}
    <div style={{ background: "white", padding: 18, borderRadius: 12, marginBottom: 20 }}>
      <h3>☁️ Stockage partagé</h3>
      <p style={{ color: "#475569", marginBottom: 8 }}>
        {(storageUsageBytes / 1_000_000_000).toFixed(2)} Go utilisés sur 10 Go gratuits.
      </p>
      <div style={{ height: 12, background: "#e2e8f0", borderRadius: 999, overflow: "hidden" }}>
        <div style={{
          width: `${Math.min(100, (storageUsageBytes / MAX_STORAGE_BYTES) * 100)}%`,
          height: "100%", background: storageUsageBytes >= MAX_STORAGE_BYTES ? "#dc2626" : "#2563eb",
        }} />
      </div>
      <p style={{ color: "#64748b", fontSize: 12, marginTop: 8 }}>
        Limite de l'application : 10 Go au total pour l'ensemble des membres.
      </p>
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
    </>)}

    {/* Messages */}
    {filesError && (
      <p style={{ color: "#dc2626" }}>{filesError}</p>
    )}

    {filesSuccess && (
      <p style={{ color: "#15803d" }}>{filesSuccess}</p>
    )}

    {fileUserCanManage && uploadProgress !== null && (
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
                <th style={{ padding: 12 }}>Consulter / télécharger</th>
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
                    {item.type === "folder" && (
                      <>
                        <button
                          onClick={() => setCurrentFolder(item.path)}
                          style={{
                            padding: 8,
                            background: "#2563eb",
                            color: "white",
                            border: 0,
                            borderRadius: 6,
                            cursor: "pointer",
                            marginRight: 6,
                            marginBottom: 4,
                          }}
                        >
                          Ouvrir
                        </button>
                        <button
                          onClick={() => downloadFolder(item)}
                          style={{
                            padding: 8,
                            background: "#15803d",
                            color: "white",
                            border: 0,
                            borderRadius: 6,
                            cursor: "pointer",
                            marginRight: 6,
                            marginBottom: 4,
                          }}
                        >
                          Télécharger le dossier (.zip)
                        </button>
                      </>
                    )}

                    {item.type === "file" && item.previewUrl && (
                      <a
                        href={item.previewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: "inline-block",
                          padding: 8,
                          background: "#2563eb",
                          color: "white",
                          borderRadius: 6,
                          textDecoration: "none",
                          marginRight: 6,
                          marginBottom: 4,
                        }}
                      >
                        Aperçu
                      </a>
                    )}

                    {item.type === "file" && item.downloadUrl && (
                      <a
                        href={item.downloadUrl}
                        style={{
                          display: "inline-block",
                          padding: 8,
                          background: "#15803d",
                          color: "white",
                          borderRadius: 6,
                          textDecoration: "none",
                          marginRight: 6,
                          marginBottom: 4,
                        }}
                      >
                        Télécharger
                      </a>
                    )}

                    {fileUserCanManage && (<>
                    <button
                      onClick={() => renameEntry(item)}
                      disabled={fileActionLoading}
                      style={{
                        padding: 8,
                        background: "#d97706",
                        color: "white",
                        border: 0,
                        borderRadius: 6,
                        cursor: "pointer",
                        marginRight: 6,
                        marginBottom: 4,
                      }}
                    >
                      Renommer
                    </button>

                    <button
                      onClick={() => moveEntry(item)}
                      disabled={fileActionLoading}
                      style={{
                        padding: 8,
                        background: "#7c3aed",
                        color: "white",
                        border: 0,
                        borderRadius: 6,
                        cursor: "pointer",
                        marginRight: 6,
                        marginBottom: 4,
                      }}
                    >
                      Déplacer
                    </button>

                    <button
                      onClick={() => deleteFile(item)}
                      disabled={fileActionLoading}
                      style={{
                        padding: 8,
                        background: "#dc2626",
                        color: "white",
                        border: 0,
                        borderRadius: 6,
                        cursor: "pointer",
                        marginBottom: 4,
                      }}
                    >
                      Supprimer
                    </button>
                    </>)}
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
        {active === "messages" && <Messenger currentUserId={user.id} />}

        {isAdmin && active === "parametres" && <AdminSettings />}

        {active !== "accueil" &&
 active !== "utilisateurs" &&
 active !== "roles" &&
 active !== "fichiers" &&
 active !== "messages" &&
 active !== "parametres" && (
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
