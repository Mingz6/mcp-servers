import { getAccessToken } from "./auth.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function graphFetch(
  path: string,
  params?: Record<string, string>,
  extraHeaders?: Record<string, string>
): Promise<any> {
  const token = await getAccessToken();
  const url = new URL(`${GRAPH_BASE}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, ...(extraHeaders ?? {}) },
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

async function graphPostEmpty(path: string): Promise<void> {
  const token = await getAccessToken();
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Length": "0" },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph API POST ${response.status}: ${text}`);
  }
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

  // Graph requires ConsistencyLevel: eventual for $search; without it the request 400s.
  const data = await graphFetch("/me/messages", params, {
    ConsistencyLevel: "eventual",
  });

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
    // OData escapes single quotes by doubling them. Folders like "Mike's stuff" otherwise 400.
    $filter: `displayName eq '${folderName.replace(/'/g, "''")}'`,
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

export interface MessageRef {
  id: string;
  internetMessageId: string;
  subject: string;
  from: string;
}

export async function getMessageRef(messageId: string): Promise<MessageRef> {
  const data = await graphFetch(`/me/messages/${encodeURIComponent(messageId)}`, {
    $select: "id,internetMessageId,subject,from",
  });
  return {
    id: data.id,
    internetMessageId: data.internetMessageId,
    subject: data.subject || "(no subject)",
    from: data.from?.emailAddress?.address || "Unknown",
  };
}

/** Graph ids change when a message moves folders; the Internet message id doesn't. */
export async function findMessageId(internetMessageId: string): Promise<string> {
  const data = await graphFetch("/me/messages", {
    $filter: `internetMessageId eq '${internetMessageId.replace(/'/g, "''")}'`,
    $select: "id,isDraft",
    $top: "5",
  });
  const hit = (data.value || []).find((m: any) => !m.isDraft);
  if (!hit) throw new Error(`No message with Internet id ${internetMessageId}`);
  return hit.id;
}

/**
 * Reply inside the original thread: Graph builds the reply (recipients, "RE:" subject, quoted
 * history, conversation headers), and the new text goes on top. A fresh /sendMail with the
 * same subject starts a separate thread instead.
 */
export async function replyToMessage(
  messageId: string,
  body: string,
  replyAll = true,
  draft = true
): Promise<{ id: string; webLink: string }> {
  const action = replyAll ? "createReplyAll" : "createReply";
  const reply = await graphPostJson<{ id: string; webLink: string; body: { contentType: string; content: string } }>(
    `/me/messages/${encodeURIComponent(messageId)}/${action}`,
    {}
  );
  const quoted = reply.body?.content ?? "";
  const content =
    reply.body?.contentType?.toLowerCase() === "html"
      ? insertAfterBodyTag(quoted, textToHtml(body))
      : `${body}\r\n\r\n${quoted}`;
  await graphPatch(`/me/messages/${encodeURIComponent(reply.id)}`, {
    body: { contentType: reply.body?.contentType ?? "html", content },
  });
  if (!draft) {
    await graphPostEmpty(`/me/messages/${encodeURIComponent(reply.id)}/send`);
  }
  return { id: reply.id, webLink: reply.webLink };
}

function insertAfterBodyTag(html: string, fragment: string): string {
  const m = /<body[^>]*>/i.exec(html);
  if (!m) return fragment + html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + fragment + html.slice(at);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text (blank-line paragraphs, 4-space code blocks, [text](url) links) to Outlook HTML. */
export function textToHtml(text: string): string {
  const linkify = (escaped: string) =>
    escaped
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:])/g, '$1<a href="$2">$2</a>');
  const blocks = text.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  const html = blocks
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((l) => /^ {4}/.test(l) || l.trim() === "")) {
        const code = lines.map((l) => escapeHtml(l.slice(4))).join("\n");
        return `<pre style="font-family: Consolas, Menlo, monospace; font-size: 10pt">${code}</pre>`;
      }
      return `<p>${lines.map((l) => linkify(escapeHtml(l))).join("<br>")}</p>`;
    })
    .join("\n");
  return `<div style="font-family: Aptos, Calibri, Helvetica, sans-serif; font-size: 12pt; color: rgb(0, 0, 0)">${html}</div>`;
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
