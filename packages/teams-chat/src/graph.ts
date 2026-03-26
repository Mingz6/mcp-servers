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
      $orderby: "createdDateTime asc",
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
    }));
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
