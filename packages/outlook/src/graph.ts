import { getAccessToken } from "./auth.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function graphFetch(
  path: string,
  params?: Record<string, string>
): Promise<any> {
  const token = await getAccessToken();
  const url = new URL(`${GRAPH_BASE}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph API ${response.status}: ${body}`);
  }

  return response.json();
}

// --- Types ---

export interface MailMessage {
  id: string;
  subject: string;
  from: string;
  receivedAt: string;
  preview: string;
  isRead: boolean;
  hasAttachments: boolean;
  importance: string;
}

export interface MailDetail {
  id: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  receivedAt: string;
  body: string;
  isRead: boolean;
  hasAttachments: boolean;
  importance: string;
  conversationId: string;
}

// --- API Functions ---

export async function listInbox(
  top = 15,
  filter?: string
): Promise<MailMessage[]> {
  const params: Record<string, string> = {
    $top: String(top),
    $select:
      "id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,importance",
    $orderby: "receivedDateTime desc",
  };
  if (filter) {
    params.$filter = filter;
  }

  const data = await graphFetch("/me/messages", params);

  return (data.value || []).map((msg: any) => ({
    id: msg.id,
    subject: msg.subject || "(no subject)",
    from: msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || "Unknown",
    receivedAt: msg.receivedDateTime,
    preview: msg.bodyPreview || "",
    isRead: msg.isRead,
    hasAttachments: msg.hasAttachments,
    importance: msg.importance,
  }));
}

export async function searchMail(
  query: string,
  top = 10
): Promise<MailMessage[]> {
  const params: Record<string, string> = {
    $top: String(top),
    $select:
      "id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,importance",
    $search: `"${query}"`,
  };

  const data = await graphFetch("/me/messages", params);

  return (data.value || []).map((msg: any) => ({
    id: msg.id,
    subject: msg.subject || "(no subject)",
    from: msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || "Unknown",
    receivedAt: msg.receivedDateTime,
    preview: msg.bodyPreview || "",
    isRead: msg.isRead,
    hasAttachments: msg.hasAttachments,
    importance: msg.importance,
  }));
}

export async function readMessage(messageId: string): Promise<MailDetail> {
  const data = await graphFetch(
    `/me/messages/${encodeURIComponent(messageId)}`,
    {
      $select:
        "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,isRead,hasAttachments,importance,conversationId",
    }
  );

  return {
    id: data.id,
    subject: data.subject || "(no subject)",
    from:
      data.from?.emailAddress?.name || data.from?.emailAddress?.address || "Unknown",
    to: (data.toRecipients || []).map(
      (r: any) => r.emailAddress?.name || r.emailAddress?.address
    ),
    cc: (data.ccRecipients || []).map(
      (r: any) => r.emailAddress?.name || r.emailAddress?.address
    ),
    receivedAt: data.receivedDateTime,
    body: stripHtml(data.body?.content || ""),
    isRead: data.isRead,
    hasAttachments: data.hasAttachments,
    importance: data.importance,
    conversationId: data.conversationId,
  };
}

export async function listUnread(top = 15): Promise<MailMessage[]> {
  return listInbox(top, "isRead eq false");
}

// --- Helpers ---

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, (_, href, text) => {
      if (text.includes("http")) return text;
      return `${text} (${href})`;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}
