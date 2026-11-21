"use client";

import { type CSSProperties, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type Contact = {
  id: string;
  username: string;
  display_name: string;
  role: string;
  hasConversation?: boolean;
  conversationId?: string | null;
  lastMessage?: string;
  lastMessageAt?: string | null;
};

type Conversation = {
  id: string;
  title: string;
  otherUser: Contact;
  canSend: boolean;
  lastMessage: string;
  lastMessageAt: string;
};

type ChatMessage = {
  id: string;
  conversation_id: string;
  sender_id: string;
  senderDisplayName?: string;
  body: string;
  attachment_key: string | null;
  attachment_name: string | null;
  attachment_mime: string | null;
  attachment_size: number;
  message_type: "text" | "image" | "audio" | "file";
  created_at: string;
  previewUrl: string | null;
  downloadUrl: string | null;
};

type Props = { currentUserId: string };

const cardStyle: CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
};

const primaryButton: CSSProperties = {
  border: 0,
  borderRadius: 8,
  background: "#1d4ed8",
  color: "#fff",
  padding: "10px 14px",
  cursor: "pointer",
  fontWeight: 600,
};

const secondaryButton: CSSProperties = {
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  background: "#fff",
  color: "#1e293b",
  padding: "9px 12px",
  cursor: "pointer",
};

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function messageSummary(message: ChatMessage) {
  if (message.body) return message.body;
  if (message.message_type === "image") return "📷 Photo";
  if (message.message_type === "audio") return "🎤 Message vocal";
  return message.attachment_name || "📎 Pièce jointe";
}

export default function Messenger({ currentUserId }: Props) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [currentRole, setCurrentRole] = useState("standard");
  const [attachmentProgress, setAttachmentProgress] = useState("");
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const selectedConversationRef = useRef<string | null>(null);

  const getToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || "";
  }, []);

  const requestJson = useCallback(async (url: string, init: RequestInit = {}) => {
    const token = await getToken();
    if (!token) throw new Error("Session expirée. Reconnecte-toi.");
    const response = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Erreur serveur (${response.status}).`);
    return result;
  }, [getToken]);

  const loadSidebar = useCallback(async () => {
    const result = await requestJson("/api/messages");
    setContacts(result.users || result.contacts || []);
    setConversations(result.conversations || []);
    setCurrentRole(result.currentUser?.role || "standard");
    setNotice(result.setupWarning || "");
    return result;
  }, [requestJson]);

  const loadMessages = useCallback(async (conversationId: string, quiet = false) => {
    if (!quiet) setLoadingMessages(true);
    try {
      const result = await requestJson(`/api/messages/${encodeURIComponent(conversationId)}`);
      if (selectedConversationRef.current === conversationId) {
        setMessages(result.messages || []);
        setCurrentRole(result.currentUserRole || "standard");
      }
    } catch (err) {
      if (!quiet) setError(err instanceof Error ? err.message : "Impossible de charger les messages.");
    } finally {
      if (!quiet) setLoadingMessages(false);
    }
  }, [requestJson]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    loadSidebar()
      .catch(err => { if (mounted) setError(err instanceof Error ? err.message : "Messagerie indisponible."); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [currentUserId, loadSidebar]);

  useEffect(() => {
    selectedConversationRef.current = selectedConversation?.id || null;
    if (!selectedConversation) {
      setMessages([]);
      return;
    }
    setError("");
    loadMessages(selectedConversation.id);
    const timer = window.setInterval(() => {
      loadMessages(selectedConversation.id, true).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [selectedConversation, loadMessages]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => () => {
    mediaRecorderRef.current?.stop();
    mediaStreamRef.current?.getTracks().forEach(track => track.stop());
  }, []);

  const filteredContacts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("fr");
    return contacts.filter(contact =>
      !query || `${contact.display_name} ${contact.username}`.toLocaleLowerCase("fr").includes(query)
    );
  }, [contacts, search]);

  const openConversation = async (contact: Contact) => {
    setError("");
    setNotice("");
    try {
      const result = await requestJson("/api/messages", {
        method: "POST",
        body: JSON.stringify({ targetUserId: contact.id }),
      });
      const conversation: Conversation = {
        id: result.conversation.id,
        title: contact.display_name || contact.username,
        otherUser: contact,
        canSend: true,
        lastMessage: "Aucun message pour le moment",
        lastMessageAt: result.conversation.last_message_at,
      };
      setSelectedConversation(conversation);
      await loadSidebar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impossible d'ouvrir la conversation.");
    }
  };

  const sendText = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !selectedConversation || sending) return;
    setSending(true);
    setError("");
    setNotice("");
    try {
      const sendResult = await requestJson(`/api/messages/${selectedConversation.id}`, {
        method: "POST",
        body: JSON.stringify({ body: text, messageType: "text" }),
      });
      if (currentRole !== "admin") {
        if (sendResult.emailNotification === "sent") {
          setNotice("Message envoyé. Une notification e-mail a été envoyée à l'administrateur.");
        } else if (sendResult.emailNotification === "not_configured") {
          setNotice("Message envoyé. Les notifications e-mail ne sont pas encore configurées.");
        } else if (sendResult.emailNotification === "failed") {
          setNotice("Message envoyé, mais la notification e-mail n'a pas pu être envoyée.");
        }
      }
      setDraft("");
      await loadMessages(selectedConversation.id, true);
      await loadSidebar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impossible d'envoyer le message.");
    } finally {
      setSending(false);
    }
  };

  const sendAttachment = async (file: File) => {
    if (!selectedConversation || sending) return;
    const maxBytes = 100 * 1024 * 1024;
    if (!file.size || file.size > maxBytes) {
      setError("La pièce jointe doit faire entre 1 octet et 100 Mo.");
      return;
    }

    setSending(true);
    setError("");
    setNotice("");
    setAttachmentProgress("Préparation de l'envoi…");
    let uploadedKey = "";
    try {
      const contentType = file.type || "application/octet-stream";
      const prepared = await requestJson("/api/messages/upload", {
        method: "POST",
        body: JSON.stringify({
          conversationId: selectedConversation.id,
          fileName: file.name,
          contentType,
          size: file.size,
        }),
      });
      uploadedKey = prepared.key;
      setAttachmentProgress(`Envoi de ${file.name} (${formatSize(file.size)})…`);

      const uploadResponse = await fetch(prepared.url, {
        method: "PUT",
        headers: { "Content-Type": prepared.contentType },
        body: file,
      });
      if (!uploadResponse.ok) {
        const detail = await uploadResponse.text().catch(() => "");
        throw new Error(`Backblaze a refusé la pièce jointe (HTTP ${uploadResponse.status}${detail ? ` : ${detail.slice(0, 180)}` : ""}).`);
      }

      const sendResult = await requestJson(`/api/messages/${selectedConversation.id}`, {
        method: "POST",
        body: JSON.stringify({
          body: "",
          attachmentKey: prepared.key,
          attachmentName: file.name,
          attachmentMime: contentType,
          attachmentSize: file.size,
          messageType: prepared.messageType,
        }),
      });
      uploadedKey = "";
      const emailSuffix = currentRole !== "admin"
        ? sendResult.emailNotification === "sent"
          ? " Une notification e-mail a été envoyée à l'administrateur."
          : sendResult.emailNotification === "not_configured"
            ? " Les notifications e-mail ne sont pas encore configurées."
            : sendResult.emailNotification === "failed"
              ? " La notification e-mail n'a pas pu être envoyée."
              : ""
        : "";
      setNotice(`Pièce jointe envoyée.${emailSuffix}`);
      await loadMessages(selectedConversation.id, true);
      await loadSidebar();
    } catch (err) {
      if (uploadedKey) {
        requestJson("/api/messages/upload", {
          method: "DELETE",
          body: JSON.stringify({ conversationId: selectedConversation.id, key: uploadedKey }),
        }).catch(() => undefined);
      }
      setError(err instanceof Error ? err.message : "Impossible d'envoyer la pièce jointe.");
    } finally {
      setSending(false);
      setAttachmentProgress("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const startVoiceRecording = async () => {
    setError("");
    setNotice("");
    if (!selectedConversation) {
      setError("Choisis d'abord une conversation.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("L'enregistrement vocal n'est pas pris en charge par ce navigateur.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
          ? "audio/ogg;codecs=opus"
          : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = event => {
        if (event.data.size) audioChunksRef.current.push(event.data);
      };
      recorder.onerror = () => setError("L'enregistrement vocal a rencontré une erreur.");
      recorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        const type = recorder.mimeType || "audio/webm";
        const extension = type.includes("ogg") ? "ogg" : "webm";
        const blob = new Blob(audioChunksRef.current, { type });
        if (blob.size) {
          const file = new File([blob], `message-vocal-${Date.now()}.${extension}`, { type });
          await sendAttachment(file);
        }
        audioChunksRef.current = [];
        setRecording(false);
      };
      recorder.start(500);
      setRecording(true);
    } catch {
      setError("Impossible d'accéder au microphone. Vérifie l'autorisation du navigateur.");
    }
  };

  const stopVoiceRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  };

  const deleteMessage = async (message: ChatMessage) => {
    if (!selectedConversation) return;
    const confirmed = window.confirm("Supprimer définitivement ce message et sa pièce jointe éventuelle ?");
    if (!confirmed) return;
    setError("");
    try {
      await requestJson(`/api/messages/${selectedConversation.id}`, {
        method: "DELETE",
        body: JSON.stringify({ messageId: message.id }),
      });
      await loadMessages(selectedConversation.id, true);
      await loadSidebar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impossible de supprimer le message.");
    }
  };

  const activeConversation = selectedConversation;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(230px, 300px) minmax(0, 1fr)", gap: 16, minHeight: 620 }}>
      <aside style={{ ...cardStyle, padding: 14, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <h2 style={{ margin: "4px 0 12px", fontSize: 20 }}>Messages privés</h2>
          <button onClick={() => loadSidebar().catch(err => setError(err.message))} style={{ ...secondaryButton, padding: "6px 9px" }} title="Actualiser">↻</button>
        </div>
        <p style={{ margin: "0 0 12px", color: "#64748b", fontSize: 12 }}>
          {currentRole === "admin"
            ? "Tu peux discuter en privé avec chaque membre, un par un."
            : "Tu peux uniquement discuter en privé avec l'administrateur."}
        </p>
        {currentRole !== "admin" && (
          <p style={{ margin: "-4px 0 12px", color: "#64748b", fontSize: 11 }}>
            Chaque message envoyé à l'administrateur déclenche une notification e-mail.
          </p>
        )}
        <input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Rechercher un membre…"
          aria-label="Rechercher un membre"
          style={{ width: "100%", boxSizing: "border-box", padding: 10, border: "1px solid #cbd5e1", borderRadius: 8, marginBottom: 12 }}
        />
        <h3 style={{ fontSize: 13, color: "#64748b", margin: "8px 0" }}>
          {currentRole === "admin" ? `TOUS LES UTILISATEURS (${filteredContacts.length})` : "CONTACTER L'ADMINISTRATEUR"}
        </h3>
        <div style={{ maxHeight: 180, overflowY: "auto", marginBottom: 16 }}>
          {loading ? <p style={{ color: "#64748b", fontSize: 13 }}>Chargement des membres…</p> : filteredContacts.map(contact => (
            <button
              key={contact.id}
              onClick={() => openConversation(contact)}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, textAlign: "left", padding: 9, border: 0, borderRadius: 8, background: "#f8fafc", cursor: "pointer", marginBottom: 5 }}
            >
              <span style={{ width: 31, height: 31, borderRadius: "50%", background: "#dbeafe", color: "#1d4ed8", display: "grid", placeItems: "center", fontWeight: 700 }}>
                {(contact.display_name || contact.username || "?").slice(0, 1).toUpperCase()}
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <strong style={{ display: "block", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis" }}>{contact.display_name || contact.username}</strong>
                <small style={{ display: "block", color: "#64748b" }}>{contact.role === "admin" ? "Administrateur" : "Membre"}</small>
                {currentRole === "admin" && <small style={{ display: "block", color: contact.hasConversation ? "#15803d" : "#2563eb", marginTop: 2 }}>{contact.hasConversation ? (contact.lastMessage || "Conversation existante") : "Nouvelle conversation"}</small>}
              </span>
              <span style={{ color: "#2563eb", fontSize: 12, fontWeight: 700 }}>{contact.hasConversation ? "Ouvrir" : "＋"}</span>
            </button>
          ))}
          {!loading && filteredContacts.length === 0 && (
            <p style={{ color: "#64748b", fontSize: 13 }}>
              {currentRole === "admin" ? "Aucun autre utilisateur membre trouvé dans profiles." : "Aucun administrateur disponible."}
            </p>
          )}
          {notice && !selectedConversation && <p role="status" style={{ color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", padding: 9, borderRadius: 8, fontSize: 12 }}>{notice}</p>}
        </div>
        <h3 style={{ fontSize: 13, color: "#64748b", margin: "8px 0" }}>CONVERSATIONS</h3>
        <div style={{ maxHeight: 310, overflowY: "auto" }}>
          {conversations.map(conversation => (
            <button
              key={conversation.id}
              onClick={() => setSelectedConversation(conversation)}
              style={{ width: "100%", padding: 10, border: 0, borderRadius: 8, textAlign: "left", cursor: "pointer", marginBottom: 5, background: selectedConversation?.id === conversation.id ? "#dbeafe" : "#f8fafc" }}
            >
              <strong style={{ display: "block", fontSize: 13 }}>{conversation.title || conversation.otherUser.display_name || conversation.otherUser.username}</strong>
              <span style={{ display: "block", fontSize: 12, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{conversation.lastMessage}</span>
              <small style={{ color: "#94a3b8" }}>{formatDate(conversation.lastMessageAt)}</small>
            </button>
          ))}
          {!loading && conversations.length === 0 && (
            <p style={{ color: "#64748b", fontSize: 13 }}>
              {currentRole === "admin" ? "Aucune conversation active. La liste ci-dessus affiche tous les membres ; clique sur un nom pour ouvrir sa conversation privée." : "Aucune conversation. Contacte l'administrateur ci-dessus."}
            </p>
          )}
        </div>
      </aside>

      <section style={{ ...cardStyle, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
        {activeConversation ? (
          <>
            <header style={{ padding: 15, borderBottom: "1px solid #e2e8f0", background: "#f8fafc" }}>
              <strong>{activeConversation.title || activeConversation.otherUser.display_name || activeConversation.otherUser.username}</strong>
              <div style={{ color: "#64748b", fontSize: 12, marginTop: 3 }}>
                Conversation privée entre toi et {activeConversation.otherUser.role === "admin" ? "l'administrateur" : "un membre"} · Actualisation automatique
              </div>
            </header>
            <div style={{ flex: 1, minHeight: 360, maxHeight: 520, overflowY: "auto", padding: 16, background: "#f8fafc" }}>
              {loadingMessages ? <p style={{ color: "#64748b" }}>Chargement des messages…</p> : messages.length === 0 ? (
                <div style={{ textAlign: "center", margin: "70px auto", color: "#64748b" }}>
                  <div style={{ fontSize: 38 }}>💬</div>
                  <strong>Commence la conversation</strong>
                  <p style={{ fontSize: 13 }}>Seuls toi et {activeConversation.otherUser.role === "admin" ? "l'administrateur" : "ce membre"} pouvez participer à cet échange.</p>
                </div>
              ) : messages.map(message => {
                const own = message.sender_id === currentUserId;
                const canDelete = currentRole === "admin";
                return (
                  <div key={message.id} style={{ display: "flex", justifyContent: own ? "flex-end" : "flex-start", marginBottom: 12 }}>
                    <article style={{ maxWidth: "min(78%, 560px)", background: own ? "#dbeafe" : "#fff", border: "1px solid #dbe3ef", borderRadius: 12, padding: 10, boxShadow: "0 1px 2px rgba(15,23,42,.04)" }}>
                      {currentRole === "admin" && <div style={{ color: "#475569", fontSize: 11, fontWeight: 700, marginBottom: 5 }}>{message.senderDisplayName || "Membre"}</div>}
                      {message.body && <p style={{ margin: "0 0 7px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.body}</p>}
                      {message.message_type === "image" && message.previewUrl && (
                        <a href={message.previewUrl} target="_blank" rel="noreferrer">
                          <img src={message.previewUrl} alt={message.attachment_name || "Photo"} style={{ display: "block", maxWidth: "100%", maxHeight: 300, borderRadius: 8, objectFit: "contain" }} />
                        </a>
                      )}
                      {message.message_type === "audio" && message.previewUrl && (
                        <audio controls preload="none" src={message.previewUrl} style={{ maxWidth: "100%" }}>Ton navigateur ne lit pas cet audio.</audio>
                      )}
                      {message.message_type === "file" && message.previewUrl && message.attachment_mime === "application/pdf" && (
                        <a href={message.previewUrl} target="_blank" rel="noreferrer" style={{ color: "#1d4ed8", fontWeight: 600, overflowWrap: "anywhere", marginRight: 10 }}>
                          Aperçu PDF
                        </a>
                      )}
                      {message.message_type === "file" && message.downloadUrl && (
                        <a href={message.downloadUrl} target="_blank" rel="noreferrer" style={{ color: "#1d4ed8", fontWeight: 600, overflowWrap: "anywhere" }}>
                          📎 Télécharger : {message.attachment_name || "document"}
                        </a>
                      )}
                      {message.attachment_size > 0 && <div style={{ color: "#64748b", fontSize: 11, marginTop: 5 }}>{formatSize(message.attachment_size)}</div>}
                      <footer style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 6 }}>
                        <small style={{ color: "#64748b" }}>{formatDate(message.created_at)}</small>
                        {canDelete && (
                          <button onClick={() => deleteMessage(message)} style={{ border: 0, background: "transparent", color: "#b91c1c", padding: 3, fontSize: 11, cursor: "pointer" }}>
                            Supprimer
                          </button>
                        )}
                      </footer>
                    </article>
                  </div>
                );
              })}
              <div ref={messageEndRef} />
            </div>
            <div style={{ borderTop: "1px solid #e2e8f0", padding: 12, background: "#fff" }}>
              {error && <p role="alert" style={{ color: "#b91c1c", background: "#fef2f2", padding: 9, borderRadius: 8, fontSize: 13 }}>{error}</p>}
              {notice && <p role="status" style={{ color: "#166534", background: "#f0fdf4", padding: 9, borderRadius: 8, fontSize: 13 }}>{notice}</p>}
              {attachmentProgress && <p style={{ color: "#475569", fontSize: 12 }}>{attachmentProgress}</p>}
              {activeConversation.canSend && <form onSubmit={sendText} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <textarea
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  placeholder="Écrire un message privé…"
                  rows={2}
                  maxLength={5000}
                  disabled={sending || recording}
                  style={{ flex: 1, minWidth: 0, resize: "vertical", border: "1px solid #cbd5e1", borderRadius: 8, padding: 10, font: "inherit" }}
                />
                <button type="submit" disabled={sending || !draft.trim()} style={{ ...primaryButton, opacity: sending || !draft.trim() ? .6 : 1 }}>Envoyer</button>
              </form>}
              {activeConversation.canSend && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 9 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.odt,.ods"
                  style={{ display: "none" }}
                  onChange={event => {
                    const file = event.target.files?.[0];
                    if (file) sendAttachment(file);
                  }}
                />
                <button type="button" disabled={sending || recording} onClick={() => fileInputRef.current?.click()} style={secondaryButton}>📎 Photo / document</button>
                {!recording ? (
                  <button type="button" disabled={sending} onClick={startVoiceRecording} style={secondaryButton}>🎙️ Enregistrer un vocal</button>
                ) : (
                  <button type="button" onClick={stopVoiceRecording} style={{ ...secondaryButton, color: "#b91c1c", borderColor: "#fecaca" }}>⏹ Arrêter et envoyer le vocal</button>
                )}
                <span style={{ color: "#94a3b8", fontSize: 11, alignSelf: "center" }}>Pièces jointes : 100 Mo maximum</span>
              </div>}
            </div>
          </>
        ) : (
          <div style={{ display: "grid", placeItems: "center", flex: 1, minHeight: 500, padding: 20, textAlign: "center", color: "#64748b" }}>
            <div>
              <div style={{ fontSize: 54 }}>💬</div>
              <h2 style={{ color: "#1e293b" }}>Messagerie privée</h2>
              <p>{currentRole === "admin" ? "Choisis un membre pour lui parler en privé." : "Choisis l'administrateur pour lui envoyer un message privé."}</p>
              <p style={{ fontSize: 12 }}>Aucune conversation entre membres : tous les échanges passent par l'administrateur.</p>
              {error && <p role="alert" style={{ color: "#b91c1c" }}>{error}</p>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
