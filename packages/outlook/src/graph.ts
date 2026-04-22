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

async function graphPatch(
  path: string,
  body: Record<string, unknown>
): Promise<void> {
  const token = await getAccessToken();
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph API PATCH ${response.status}: ${text}`);
  }
}

async function graphPost(
  path: string,
  body: Record<string, unknown>
): Promise<void> {
  const token = await getAccessToken();
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph API POST ${response.status}: ${text}`);
  }
}

async function graphPostJson<T>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const token = await getAccessToken();
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph API POST ${response.status}: ${text}`);
  }
  return (await response.json()) as T;
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

export async function listFolderMessages(
  folderName: string,
  top = 15,
  unreadOnly = false
): Promise<MailMessage[]> {
  const folders = await graphFetch("/me/mailFolders", {
    $filter: `displayName eq '${folderName}'`,
    $select: "id,displayName",
  });

  const folder = (folders.value || [])[0];
  if (!folder) {
    throw new Error(`Mail folder "${folderName}" not found`);
  }

  const params: Record<string, string> = {
    $top: String(top),
    $select:
      "id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,importance",
    $orderby: "receivedDateTime desc",
  };
  if (unreadOnly) {
    params.$filter = "isRead eq false";
  }

  const data = await graphFetch(
    `/me/mailFolders/${encodeURIComponent(folder.id)}/messages`,
    params
  );

  return (data.value || []).map((msg: any) => ({
    id: msg.id,
    subject: msg.subject || "(no subject)",
    from:
      msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || "Unknown",
    receivedAt: msg.receivedDateTime,
    preview: msg.bodyPreview || "",
    isRead: msg.isRead,
    hasAttachments: msg.hasAttachments,
    importance: msg.importance,
  }));
}

export async function sendMail(
  to: string[],
  subject: string,
  body: string,
  cc?: string[],
  bcc?: string[]
): Promise<void> {
  const toRecipients = to.map((addr) => ({
    emailAddress: { address: addr },
  }));
  const ccRecipients = (cc || []).map((addr) => ({
    emailAddress: { address: addr },
  }));
  const bccRecipients = (bcc || []).map((addr) => ({
    emailAddress: { address: addr },
  }));

  await graphPost("/me/sendMail", {
    message: {
      subject,
      body: { contentType: "Text", content: body },
      toRecipients,
      ccRecipients,
      bccRecipients,
    },
  });
}

export async function createDraft(
  to: string[],
  subject: string,
  body: string,
  cc?: string[],
  bcc?: string[]
): Promise<{ id: string; webLink: string }> {
  const toRecipients = to.map((addr) => ({
    emailAddress: { address: addr },
  }));
  const ccRecipients = (cc || []).map((addr) => ({
    emailAddress: { address: addr },
  }));
  const bccRecipients = (bcc || []).map((addr) => ({
    emailAddress: { address: addr },
  }));

  const result = await graphPostJson<{ id: string; webLink: string }>(
    "/me/messages",
    {
      subject,
      body: { contentType: "Text", content: body },
      toRecipients,
      ccRecipients,
      bccRecipients,
    }
  );

  return {
    id: result.id,
    webLink: result.webLink,
  };
}

export interface AttachmentInfo {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
}

export interface AttachmentContent extends AttachmentInfo {
  contentBytes: string; // base64
}

export async function listAttachments(
  messageId: string
): Promise<AttachmentInfo[]> {
  const data = await graphFetch(
    `/me/messages/${encodeURIComponent(messageId)}/attachments`,
    { $select: "id,name,contentType,size,isInline" }
  );

  return (data.value || []).map((a: any) => ({
    id: a.id,
    name: a.name || "(unnamed)",
    contentType: a.contentType || "application/octet-stream",
    size: a.size || 0,
    isInline: a.isInline || false,
  }));
}

export async function downloadAttachment(
  messageId: string,
  attachmentId: string
): Promise<AttachmentContent> {
  const data = await graphFetch(
    `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  );

  return {
    id: data.id,
    name: data.name || "(unnamed)",
    contentType: data.contentType || "application/octet-stream",
    size: data.size || 0,
    isInline: data.isInline || false,
    contentBytes: data.contentBytes || "",
  };
}

export async function markAsRead(messageIds: string[]): Promise<number> {
  let count = 0;
  for (const id of messageIds) {
    await graphPatch(`/me/messages/${encodeURIComponent(id)}`, {
      isRead: true,
    });
    count++;
  }
  return count;
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
