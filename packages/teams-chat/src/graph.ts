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
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...extraHeaders,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph API ${response.status}: ${body}`);
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Failed to parse Graph API JSON (${text.length} chars): ${(e as Error).message}\n` +
      `Response starts with: ${text.slice(0, 200)}...\nResponse ends with: ...${text.slice(-200)}`
    );
  }
}

async function graphFetchUrl(fullUrl: string): Promise<any> {
  const token = await getAccessToken();
  const response = await fetch(fullUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph API ${response.status}: ${body}`);
  }

  return response.json();
}

async function graphFetchBinary(path: string): Promise<{ data: Buffer; contentType: string }> {
  const token = await getAccessToken();
  const url = `${GRAPH_BASE}${path}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph API ${response.status}: ${body}`);
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const arrayBuffer = await response.arrayBuffer();
  return { data: Buffer.from(arrayBuffer), contentType };
}

async function graphPost(
  path: string,
  body: Record<string, unknown>
): Promise<Response> {
  const token = await getAccessToken();
  const url = `${GRAPH_BASE}${path}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph API ${response.status}: ${text}`);
  }

  return response;
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
  hostedContentIds: string[];
}

// --- API Functions ---

export async function listChats(top = 20): Promise<ChatSummary[]> {
  const pageSize = Math.min(top, 50); // Graph API max per page is 50
  const data = await graphFetch("/me/chats", {
    $top: String(pageSize),
    $expand: "members,lastMessagePreview",
    $orderby: "lastMessagePreview/createdDateTime desc",
  });

  const results: ChatSummary[] = [];
  const mapChat = (chat: any): ChatSummary => ({
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
  });

  for (const chat of data.value || []) {
    results.push(mapChat(chat));
  }

  // Follow pagination if we need more than one page
  let nextLink: string | undefined = data["@odata.nextLink"];
  const maxPages = 20; // Safety: max 1000 chats
  let page = 0;

  while (nextLink && results.length < top && page < maxPages) {
    page++;
    const pageData = await graphFetchUrl(nextLink);
    for (const chat of pageData.value || []) {
      results.push(mapChat(chat));
      if (results.length >= top) break;
    }
    nextLink = pageData["@odata.nextLink"];
  }

  return results.slice(0, top);
}

export async function readChatMessages(
  chatId: string,
  top = 30
): Promise<ChatMessage[]> {
  const pageSize = Math.min(top, 50);
  const data = await graphFetch(
    `/me/chats/${encodeURIComponent(chatId)}/messages`,
    {
      $top: String(pageSize),
      $orderby: "createdDateTime desc",
    }
  );

  const allMessages: any[] = [...(data.value || [])];

  // Follow pagination if we need more messages
  let nextLink: string | undefined = data["@odata.nextLink"];
  const maxPages = 20;
  let page = 0;

  while (nextLink && allMessages.length < top && page < maxPages) {
    page++;
    const pageData = await graphFetchUrl(nextLink);
    allMessages.push(...(pageData.value || []));
    nextLink = pageData["@odata.nextLink"];
  }

  return allMessages
    .slice(0, top)
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
      hostedContentIds: extractHostedContentIds(msg.body.content),
    }))
    .reverse();
}

export async function findChatByParticipant(
  name: string
): Promise<ChatSummary[]> {
  // Paginate through all chats (up to 500) to find matches
  const chats = await listChats(500);
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

// --- Write Operations ---

export async function reactToMessage(
  chatId: string,
  messageId: string,
  emoji: string
): Promise<void> {
  await graphPost(
    `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/setReaction`,
    { reactionType: emoji }
  );
}

export async function sendMessage(
  chatId: string,
  content: string,
  format: "text" | "html" | "markdown" = "markdown"
): Promise<string> {
  let body: { contentType: string; content: string };

  if (format === "html") {
    body = { contentType: "html", content };
  } else if (format === "text") {
    body = { contentType: "text", content };
  } else {
    // markdown (default): convert to HTML for rich display
    body = { contentType: "html", content: markdownToHtml(content) };
  }

  const response = await graphPost(
    `/chats/${encodeURIComponent(chatId)}/messages`,
    { body }
  );
  const data = await response.json();
  return data.id;
}

function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const html: string[] = [];
  let inUl = false;
  let inOl = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Inline formatting
    line = line
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__(.+?)__/g, "<strong>$1</strong>")
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Unordered list item: - item or * item
    const ulMatch = line.match(/^[\s]*[-*]\s+(.+)$/);
    // Ordered list item: 1. item
    const olMatch = line.match(/^[\s]*\d+\.\s+(.+)$/);

    if (ulMatch) {
      if (inOl) { html.push("</ol>"); inOl = false; }
      if (!inUl) { html.push("<ul>"); inUl = true; }
      html.push(`<li>${ulMatch[1]}</li>`);
    } else if (olMatch) {
      if (inUl) { html.push("</ul>"); inUl = false; }
      if (!inOl) { html.push("<ol>"); inOl = true; }
      html.push(`<li>${olMatch[1]}</li>`);
    } else {
      // Close any open lists
      if (inUl) { html.push("</ul>"); inUl = false; }
      if (inOl) { html.push("</ol>"); inOl = false; }

      if (line.trim() === "") {
        html.push("<br>");
      } else {
        html.push(`<p>${line}</p>`);
      }
    }
  }

  // Close any trailing lists
  if (inUl) html.push("</ul>");
  if (inOl) html.push("</ol>");

  return html.join("");
}

// --- Calendar ---

export interface CalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  isAllDay: boolean;
  location: string;
  organizer: string;
  isOnline: boolean;
  onlineUrl: string | null;
  bodyPreview: string;
}

export async function getCalendarEvents(
  startDate: string,
  endDate: string,
  filter?: string
): Promise<CalendarEvent[]> {
  const data = await graphFetch(
    "/me/calendarView",
    {
      startDateTime: new Date(startDate).toISOString(),
      endDateTime: new Date(endDate).toISOString(),
      $top: "50",
      $orderby: "start/dateTime",
      $select:
        "id,subject,start,end,isAllDay,location,organizer,isOnlineMeeting,onlineMeeting,bodyPreview",
    },
    { Prefer: 'outlook.timezone="America/Edmonton"' }
  );

  let events: CalendarEvent[] = (data.value || []).map((e: any) => ({
    id: e.id,
    subject: e.subject || "(no subject)",
    start: e.start?.dateTime || "",
    end: e.end?.dateTime || "",
    isAllDay: e.isAllDay || false,
    location: e.location?.displayName || "",
    organizer: e.organizer?.emailAddress?.name || "",
    isOnline: e.isOnlineMeeting || false,
    onlineUrl: e.onlineMeeting?.joinUrl || null,
    bodyPreview: truncate(e.bodyPreview || "", 200),
  }));

  if (filter) {
    const lower = filter.toLowerCase();
    events = events.filter(
      (e) =>
        e.subject.toLowerCase().includes(lower) ||
        e.bodyPreview.toLowerCase().includes(lower)
    );
  }

  return events;
}

// --- Meeting Transcripts ---

export interface MeetingSummary {
  id: string;
  subject: string;
  start: string;
  joinUrl: string | null;
  hasTranscript?: boolean;
}

export async function listRecentMeetings(daysBack = 30, limit = 10): Promise<MeetingSummary[]> {
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const data = await graphFetch(
    "/me/calendarView",
    {
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      $top: "50",
      $orderby: "start/dateTime desc",
      $select: "id,subject,start,isOnlineMeeting,onlineMeeting",
    },
    { Prefer: 'outlook.timezone="America/Edmonton"' }
  );

  const meetings: MeetingSummary[] = [];
  for (const e of data.value || []) {
    if (!e.isOnlineMeeting || !e.onlineMeeting?.joinUrl) continue;
    meetings.push({
      id: e.id,
      subject: e.subject || "(no subject)",
      start: e.start?.dateTime || "",
      joinUrl: e.onlineMeeting?.joinUrl || null,
    });
    if (meetings.length >= limit) break;
  }
  return meetings;
}

async function resolveOnlineMeetingId(joinUrl: string): Promise<string | null> {
  try {
    const data = await graphFetch(
      "/me/onlineMeetings",
      { $filter: `JoinWebUrl eq '${joinUrl}'` }
    );
    return data.value?.[0]?.id ?? null;
  } catch {
    // Try decoded URL
    try {
      const decoded = decodeURIComponent(joinUrl);
      const data = await graphFetch(
        "/me/onlineMeetings",
        { $filter: `JoinWebUrl eq '${decoded}'` }
      );
      return data.value?.[0]?.id ?? null;
    } catch {
      return null;
    }
  }
}

function cleanVtt(rawVtt: string): string {
  const lines = rawVtt.split("\n");
  const out: string[] = [];
  let currentSpeaker = "";
  let currentText = "";

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === "WEBVTT" || /^\d+$/.test(line) ||
        /^[0-9]{2}:[0-9]{2}:[0-9]{2}/.test(line) || line.startsWith("NOTE")) {
      continue;
    }
    // <v Speaker Name>text</v>
    const vMatch = line.match(/^<v ([^>]+)>(.+?)(?:<\/v>)?$/);
    if (vMatch) {
      const [, speaker, text] = vMatch;
      if (speaker === currentSpeaker) {
        currentText += " " + text.trim();
      } else {
        if (currentSpeaker && currentText) {
          out.push(`${currentSpeaker}: ${currentText}`);
        }
        currentSpeaker = speaker;
        currentText = text.trim();
      }
    } else if (line && currentSpeaker) {
      // continuation line without <v> tag
      currentText += " " + line;
    }
  }
  if (currentSpeaker && currentText) {
    out.push(`${currentSpeaker}: ${currentText}`);
  }
  return out.join("\n");
}

export async function getMeetingTranscript(meetingName: string, meetingDate?: string): Promise<string> {
  // Step 1: Find matching calendar events
  const daysBack = 30;
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const data = await graphFetch(
    "/me/calendarView",
    {
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      $top: "50",
      $select: "id,subject,start,isOnlineMeeting,onlineMeeting",
    },
    { Prefer: 'outlook.timezone="America/Edmonton"' }
  );

  const lower = meetingName.toLowerCase();
  let candidates = (data.value || []).filter(
    (e: any) => e.isOnlineMeeting && e.onlineMeeting?.joinUrl &&
      (e.subject || "").toLowerCase().includes(lower)
  );

  if (meetingDate) {
    const dateStr = meetingDate.slice(0, 10);
    candidates = candidates.filter(
      (e: any) => (e.start?.dateTime || "").startsWith(dateStr)
    );
  }

  if (candidates.length === 0) {
    throw new Error(`No Teams meetings found matching "${meetingName}"${meetingDate ? ` on ${meetingDate}` : " in the last 30 days"}. Try teams_list_recent_meetings to browse available meetings.`);
  }

  // Step 2: Resolve first match to online meeting ID
  const event = candidates[0];
  const meetingId = await resolveOnlineMeetingId(event.onlineMeeting.joinUrl);
  if (!meetingId) {
    throw new Error(`Could not resolve online meeting ID for "${event.subject}". The meeting may be cross-tenant or the join URL is no longer valid.`);
  }

  // Step 3: List transcripts
  const transcriptsData = await graphFetch(`/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`);
  const transcripts = transcriptsData.value || [];
  if (transcripts.length === 0) {
    throw new Error(`No transcripts available for "${event.subject}". Transcription must be started during the meeting by a participant.`);
  }

  // Step 4: Download the most recent transcript as VTT
  const tid = transcripts[transcripts.length - 1].id;
  const token = await (await import("./auth.js")).getAccessToken();
  const vttUrl = `https://graph.microsoft.com/v1.0/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(tid)}/content?$format=text/vtt`;
  const response = await fetch(vttUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: "text/vtt" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph API ${response.status} fetching transcript: ${body}`);
  }
  const rawVtt = await response.text();

  const cleaned = cleanVtt(rawVtt);
  const header = [
    `Meeting: ${event.subject}`,
    `Date: ${event.start?.dateTime || "unknown"}`,
    `Meeting link: ${event.onlineMeeting?.joinUrl || "n/a"}`,
    `Transcript ID: ${tid}`,
    "---",
    "",
  ].join("\n");
  return header + cleaned;
}

// --- Image / Hosted Content ---

function extractHostedContentIds(html: string): string[] {
  const regex = /hostedContents\/([^/]+)\/\$value/gi;
  const ids: string[] = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    ids.push(match[1]);
  }
  return [...new Set(ids)];
}

export async function getMessageHostedContent(
  chatId: string,
  messageId: string,
  hostedContentId: string
): Promise<{ data: string; mimeType: string }> {
  const path = `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/hostedContents/${encodeURIComponent(hostedContentId)}/$value`;
  const { data, contentType } = await graphFetchBinary(path);
  return { data: data.toString("base64"), mimeType: contentType };
}

// --- Helpers ---

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    // Extract href URLs before stripping tags (Teams embeds links in <a> tags)
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, (_, href, text) => {
      // If the visible text already contains the URL, keep just the text
      if (text.includes("http")) return text;
      // Otherwise append the href so it's not lost
      return `${text} ${href}`;
    })
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
