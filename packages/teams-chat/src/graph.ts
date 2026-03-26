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
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph API ${response.status}: ${body}`);
  }

  return response.json();
}

// --- Types ---

export interface ChatSummary {
  id: string;
  topic: string | null;
  chatType: string;
  lastUpdated: string;
  members: string[];
  lastMessage?: string;
}

export interface ChatMessage {
  id: string;
  from: string;
  body: string;
  createdAt: string;
  messageType: string;
}

// --- API Functions ---

export async function listChats(top = 20): Promise<ChatSummary[]> {
  const data = await graphFetch("/me/chats", {
    $top: String(top),
    $expand: "members,lastMessagePreview",
    $orderby: "lastMessagePreview/createdDateTime desc",
  });

  return (data.value || []).map((chat: any) => ({
    id: chat.id,
    topic: chat.topic,
    chatType: chat.chatType,
    lastUpdated:
      chat.lastMessagePreview?.createdDateTime || chat.createdDateTime,
    members: (chat.members || [])
      .map((m: any) => m.displayName)
      .filter(Boolean),
    lastMessage: chat.lastMessagePreview?.body?.content
      ? truncate(stripHtml(chat.lastMessagePreview.body.content), 120)
      : undefined,
  }));
}

export async function readChatMessages(
  chatId: string,
  top = 30
): Promise<ChatMessage[]> {
  const data = await graphFetch(
    `/me/chats/${encodeURIComponent(chatId)}/messages`,
    {
      $top: String(top),
      $orderby: "createdDateTime desc",
    }
  );

  return (data.value || [])
    .filter((msg: any) => msg.body?.content)
    .map((msg: any) => ({
      id: msg.id,
      from:
        msg.from?.user?.displayName ||
        msg.from?.application?.displayName ||
        "System",
      body: stripHtml(msg.body.content),
      createdAt: msg.createdDateTime,
      messageType: msg.messageType,
    }))
    .reverse();
}

export async function findChatByParticipant(
  name: string
): Promise<ChatSummary[]> {
  // Graph doesn't have a direct chat search — fetch recent chats and filter locally
  const chats = await listChats(50);
  const lower = name.toLowerCase();
  return chats.filter(
    (chat) =>
      chat.members.some((m) => m.toLowerCase().includes(lower)) ||
      (chat.topic && chat.topic.toLowerCase().includes(lower))
  );
}

export async function getMyProfile(): Promise<{
  displayName: string;
  mail: string;
}> {
  return graphFetch("/me", { $select: "displayName,mail" });
}

// --- PR Extraction ---

export interface PrLink {
  owner: string;
  repo: string;
  number: number;
  url: string;
  postedBy: string;
  postedAt: string;
  context: string;
}

const PR_URL_RE = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/g;

export async function extractPrLinks(
  chatId: string,
  sinceDate: string,
  excludeAuthor?: string
): Promise<PrLink[]> {
  // Fetch enough messages to cover the time window
  const messages = await readChatMessages(chatId, 50);

  const cutoff = new Date(sinceDate);
  const seen = new Set<string>();
  const results: PrLink[] = [];

  for (const msg of messages) {
    if (new Date(msg.createdAt) < cutoff) continue;
    if (excludeAuthor && msg.from.toLowerCase().includes(excludeAuthor.toLowerCase())) continue;

    for (const match of msg.body.matchAll(PR_URL_RE)) {
      const key = `${match[1]}/${match[2]}#${match[3]}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        owner: match[1],
        repo: match[2],
        number: Number(match[3]),
        url: match[0],
        postedBy: msg.from,
        postedAt: msg.createdAt,
        context: truncate(msg.body.replace(/\n/g, " "), 200),
      });
    }
  }

  return results;
}

// --- Helpers ---

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .trim();
}
