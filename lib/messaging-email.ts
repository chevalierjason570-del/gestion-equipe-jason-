export type AdminMessageEmailStatus = "sent" | "not_configured" | "failed";

type AdminMessageEmailInput = {
  messageId: string;
  recipient: string;
  senderName: string;
  body: string;
  messageType: string;
  attachmentName: string | null;
};

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, character => entities[character] || character);
}

function getMessageDescription(input: AdminMessageEmailInput): string {
  const text = input.body.trim();
  if (text) return text.slice(0, 500);
  if (input.messageType === "image") return "Une photo a été envoyée.";
  if (input.messageType === "audio") return "Un message vocal a été envoyé.";
  if (input.attachmentName) return `Un fichier a été envoyé : ${input.attachmentName}`;
  return "Un nouveau message a été envoyé.";
}

/**
 * Send a best-effort notification to the administrator using Resend's REST API.
 * The chat message is already saved before this function runs; email failure
 * must not make the message appear unsent or cause it to be inserted again.
 */
export async function sendAdminMessageNotification(
  input: AdminMessageEmailInput,
): Promise<{ status: AdminMessageEmailStatus }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { status: "not_configured" };

  if (!input.recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.recipient)) {
    console.error("Admin message notification failed: no valid administrator email was found.");
    return { status: "failed" };
  }

  const from = process.env.MESSAGING_EMAIL_FROM?.trim()
    || "Gestion Équipe <onboarding@resend.dev>";
  const appUrl = (process.env.MESSAGING_APP_URL || "https://gestion-equipe-jason.vercel.app").replace(/\/+$/, "");
  const senderName = input.senderName || "Un membre";
  const description = getMessageDescription(input);
  const subject = `${senderName} vous a envoyé un message – Gestion Équipe`;
  const text = [
    `${senderName} vous a envoyé un message privé sur Gestion Équipe.`,
    "",
    description,
    "",
    `Ouvrir Gestion Équipe : ${appUrl}`,
    "",
    "La pièce jointe éventuelle n'est pas incluse dans cet e-mail. Connectez-vous au site pour la consulter.",
  ].join("\n");
  const html = `<!doctype html><html lang="fr"><body style="font-family:Arial,sans-serif;color:#172033;line-height:1.5"><h2>Nouveau message privé</h2><p><strong>${escapeHtml(senderName)}</strong> vous a envoyé un message sur Gestion Équipe.</p><p style="padding:12px;background:#f1f5f9;border-radius:8px;white-space:pre-wrap">${escapeHtml(description)}</p><p><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:7px">Ouvrir Gestion Équipe</a></p><p style="color:#64748b;font-size:12px">La pièce jointe éventuelle n'est pas incluse dans cet e-mail. Connectez-vous au site pour la consulter.</p></body></html>`;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `gestion-equipe-message/${input.messageId}`,
      },
      body: JSON.stringify({ from, to: [input.recipient], subject, text, html }),
      cache: "no-store",
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      console.error(`Resend message notification failed (HTTP ${response.status}): ${details.slice(0, 500)}`);
      return { status: "failed" };
    }

    return { status: "sent" };
  } catch (error) {
    console.error("Resend message notification request failed:", error);
    return { status: "failed" };
  }
}
