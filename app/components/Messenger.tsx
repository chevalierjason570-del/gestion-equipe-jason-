

















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




