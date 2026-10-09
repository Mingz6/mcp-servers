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
    .filter((msg: any) => msg.body?.content || msg.eventDetail)
    .map((msg: any) => ({
      id: msg.id,
      from:
        msg.from?.user?.displayName ||
        msg.from?.application?.displayName ||
        "System",
      body: stripHtml(msg.body?.content || "") || describeChatEvent(msg.eventDetail),
      createdAt: msg.createdDateTime,
      messageType: msg.messageType,
      hostedContentIds: extractHostedContentIds(msg.body?.content || ""),
    }))
    .reverse();
}

// Call, recording and transcript events have an empty body; the callId here is what
// teams_get_meeting_transcript needs for an ad hoc call (those never reach the calendar).
function describeChatEvent(detail: any): string {
  if (!detail) return "";
  const type = String(detail["@odata.type"] || "event")
    .replace("#microsoft.graph.", "")
    .replace(/EventMessageDetail$/, "");
  const parts = [`[${type}]`];
  if (detail.callRecordingDisplayName) parts.push(detail.callRecordingDisplayName);
  if (detail.callRecordingStatus) parts.push(`status ${detail.callRecordingStatus}`);
  if (detail.callEventType) parts.push(detail.callEventType);
  if (detail.callDuration) parts.push(`duration ${detail.callDuration}`);
  if (detail.callId) parts.push(`callId ${detail.callId}`);
  return parts.join(" | ");
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

export interface ChatMember {
  id: string;
  displayName: string;
  email?: string;
}

interface Mention {
  id: number;
  mentionText: string;
  mentioned: { user: { id: string; displayName: string; userIdentityType: "aadUser" } };
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Turns each @[Full Name] (or @[first name], @[email]) into a Teams mention of that chat member. */
export function applyMentions(content: string, members: ChatMember[]): { content: string; mentions: Mention[] } {
  const mentions: Mention[] = [];
  const out = content.replace(/@\[([^\]]+)\]/g, (_, raw: string) => {
    const want = raw.trim().toLowerCase();
    let hits = members.filter((m) => m.displayName?.toLowerCase() === want || m.email?.toLowerCase() === want);
    if (!hits.length) hits = members.filter((m) => m.displayName?.toLowerCase().split(/\s+/)[0] === want);
    if (hits.length !== 1) {
      const names = members.map((m) => m.displayName).join(", ");
      throw new Error(`@[${raw}] matches ${hits.length} members of this chat (members: ${names})`);
    }
    const m = hits[0];
    const id = mentions.length;
    mentions.push({ id, mentionText: m.displayName, mentioned: { user: { id: m.id, displayName: m.displayName, userIdentityType: "aadUser" } } });
    return `<at id="${id}">${escapeHtml(m.displayName)}</at>`;
  });
  return { content: out, mentions };
}

async function chatMembers(chatId: string): Promise<ChatMember[]> {
  const data = await graphFetch(`/chats/${encodeURIComponent(chatId)}/members`);
  return (data.value ?? []).map((m: { userId: string; displayName: string; email?: string }) => ({
    id: m.userId,
    displayName: m.displayName,
    email: m.email,
  }));
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
    // Graph's raw contentType:"text" does NOT preserve newlines when the Teams client
    // renders it — a multi-paragraph message collapses into one solid block (hit this bug
    // 3 times before fixing it here). Always escape + convert \n to <br> instead, so this
    // format can never again produce that bug, no matter what format the caller picks.
    body = { contentType: "html", content: escapeHtml(content).replace(/\n/g, "<br>") };
  } else {
    // markdown (default): convert to HTML for rich display
    body = { contentType: "html", content: markdownToHtml(content) };
  }

  const payload: Record<string, unknown> = { body };
  if (body.contentType === "html" && /@\[[^\]]+\]/.test(body.content)) {
    const applied = applyMentions(body.content, await chatMembers(chatId));
    body.content = applied.content;
    payload.mentions = applied.mentions;
  }

  const response = await graphPost(`/chats/${encodeURIComponent(chatId)}/messages`, payload);
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

const TRANSCRIPTS_DISABLED_HINT =
  "Graph access to Teams transcripts is off for this tenant (Microsoft's default since the end of July 2026). " +
  "A Teams or Global admin turns it on in Teams admin center > Meetings > Meeting settings > Transcript API access, " +
  "or: Set-CsTeamsMeetingConfiguration -Identity Global -EnableGraphTranscriptAccess $true -EnableAttributedTranscripts $true. " +
  "Scheduled meetings still have Copilot notes through teams_get_meeting_ai_insights.";

function explainTranscriptError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("GraphAccessToTranscriptsDisabled")
    ? new Error(`${TRANSCRIPTS_DISABLED_HINT}\n(${message.slice(0, 200)})`)
    : err instanceof Error ? err : new Error(message);
}

function edmontonDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Edmonton" });
}

// Recurring meetings share one onlineMeeting id, so its transcripts and insights cover every
// instance. Keep the ones from the requested day; no day means the newest one.
function pickInstance<T extends { createdDateTime?: string | null }>(items: T[], date?: string): T | undefined {
  const dated = items
    .filter((i) => i.createdDateTime)
    .sort((a, b) => b.createdDateTime!.localeCompare(a.createdDateTime!));
  return date ? dated.find((i) => edmontonDate(i.createdDateTime!) === date) : dated[0];
}

async function fetchTranscript(basePath: string, label: string, date?: string): Promise<{ id: string; text: string }> {
  let transcripts: any[];
  try {
    transcripts = (await graphFetch(`${basePath}/transcripts`)).value || [];
  } catch (err) {
    throw explainTranscriptError(err);
  }
  const transcript = pickInstance(transcripts, date) ?? (date ? undefined : transcripts[transcripts.length - 1]);
  if (!transcript) {
    throw new Error(`No transcripts available for ${label}${date ? ` on ${date}` : ""}. Transcription must be started during the meeting by a participant.`);
  }

  const url = `${GRAPH_BASE}${basePath}/transcripts/${encodeURIComponent(transcript.id)}/content`;
  const download = async (accept: string) => {
    const token = await getAccessToken();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: accept } });
    return { response, body: await response.text() };
  };
  let { response, body } = await download("text/vtt");
  // Tenant can allow transcripts but not speaker names; the unattributed format still works then.
  if (response.status === 403 && body.includes("SpeakerAttributionNotAllowed")) {
    ({ response, body } = await download("application/vnd.microsoft.graph.transcript+text"));
  }
  if (!response.ok) {
    throw explainTranscriptError(new Error(`Graph API ${response.status} fetching transcript: ${body}`));
  }
  const text = (response.headers.get("content-type") || "").includes("vtt")
    ? cleanVtt(body)
    : body.split("\n").map((l) => l.trim()).filter((l) => l && !/^\d{2}:\d{2}:\d{2}/.test(l)).join("\n");
  return { id: transcript.id, text };
}

async function findOnlineMeeting(meetingName: string, meetingDate?: string): Promise<{ event: any; onlineMeetingId: string }> {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Newest first, so a recurring meeting's latest instance wins and a busy month can't push it past $top.
  const data = await graphFetch(
    "/me/calendarView",
    {
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      $top: "100",
      $orderby: "start/dateTime desc",
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
    throw new Error(`No Teams meetings found matching "${meetingName}"${meetingDate ? ` on ${meetingDate}` : " in the last 30 days"}. Try teams_list_recent_meetings to browse available meetings. Ad hoc calls aren't on the calendar: pass the callId from teams_read_chat instead.`);
  }

  const event = candidates[0];
  const onlineMeetingId = await resolveOnlineMeetingId(event.onlineMeeting.joinUrl);
  if (!onlineMeetingId) {
    throw new Error(`Could not resolve online meeting ID for "${event.subject}". The meeting may be cross-tenant or the join URL is no longer valid.`);
  }
  return { event, onlineMeetingId };
}

export async function getMeetingTranscript(meetingName: string, meetingDate?: string): Promise<string> {
  const { event, onlineMeetingId } = await findOnlineMeeting(meetingName, meetingDate);
  const { id, text } = await fetchTranscript(
    `/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}`,
    `"${event.subject}"`,
    meetingDate?.slice(0, 10)
  );
  const header = [
    `Meeting: ${event.subject}`,
    `Date: ${event.start?.dateTime || "unknown"}`,
    `Meeting link: ${event.onlineMeeting?.joinUrl || "n/a"}`,
    `Transcript ID: ${id}`,
    "---",
    "",
  ].join("\n");
  return header + text;
}

/** Ad hoc call (1:1 or group call started from a chat). The callId comes from teams_read_chat. */
export async function getAdhocCallTranscript(callId: string): Promise<string> {
  const { id, text } = await fetchTranscript(`/me/adhocCalls/${encodeURIComponent(callId)}`, `call ${callId}`);
  return [`Call: ${callId}`, `Transcript ID: ${id}`, "---", "", text].join("\n");
}

let myUserId: string | undefined;

/**
 * Copilot's meeting notes and action items (the Teams "Recap" AI notes). Scheduled meetings only:
 * Graph has no aiInsights for ad hoc calls. Needs OnlineMeetingAiInsight.Read.All and an
 * M365 Copilot license, and works even while transcript access is off for the tenant.
 */
export async function getMeetingAiInsights(meetingName: string, meetingDate?: string): Promise<string> {
  const { event, onlineMeetingId } = await findOnlineMeeting(meetingName, meetingDate);
  myUserId ??= (await graphFetch("/me", { $select: "id" })).id as string;
  const base = `/copilot/users/${myUserId}/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/aiInsights`;

  let insights: any[] = (await graphFetch(base)).value || [];
  if (insights.length && !insights.some((i) => i.createdDateTime)) {
    insights = await Promise.all(insights.slice(0, 40).map((i) => graphFetch(`${base}/${encodeURIComponent(i.id)}`)));
  }
  const day = meetingDate?.slice(0, 10) ?? String(event.start?.dateTime || "").slice(0, 10);
  const picked = pickInstance(insights, day);
  if (!picked) {
    const days = [...new Set(insights.filter((i) => i.createdDateTime).map((i) => edmontonDate(i.createdDateTime)))];
    throw new Error(`No Copilot notes for "${event.subject}" on ${day}.${days.length ? ` Days with notes: ${days.slice(0, 10).join(", ")}.` : " Copilot only writes notes when the meeting was transcribed."}`);
  }
  const insight = picked.meetingNotes ? picked : await graphFetch(`${base}/${encodeURIComponent(picked.id)}`);

  const lines = [
    `Meeting: ${event.subject}`,
    `Date: ${new Date(insight.createdDateTime).toLocaleString("en-CA", { timeZone: "America/Edmonton" })}`,
    "---",
    "",
    "## Notes",
  ];
  for (const note of insight.meetingNotes || []) {
    lines.push(`- **${note.title}**: ${note.text}`);
    for (const sub of note.subpoints || []) lines.push(`  - ${sub.title ? `${sub.title}: ` : ""}${sub.text}`);
  }
  lines.push("", "## Action items");
  for (const item of insight.actionItems || []) {
    lines.push(`- ${item.ownerDisplayName ? `[${item.ownerDisplayName}] ` : ""}**${item.title}**: ${item.text}`);
  }
  const mentions = insight.viewpoint?.mentionEvents || [];
  if (mentions.length) {
    lines.push("", "## Where you were mentioned");
    for (const m of mentions) {
      lines.push(`- ${m.speaker?.user?.displayName ?? "someone"}: ${m.transcriptUtterance ?? ""}`);
    }
  }
  return lines.join("\n");
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

// Graph reports Content-Type from the chat message's original attachment tag,
// which frequently disagrees with the actual bytes at hostedContents/$value
// (observed: header says image/png, body is WEBP). Consumers like Anthropic's
// API validate declared media type against real bytes and reject the whole
// request on mismatch, so sniff the magic bytes instead of trusting the header.
function sniffImageMimeType(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6 && (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return "image/gif";
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
    return "image/bmp";
  }
  return null;
}

export async function getMessageHostedContent(
  chatId: string,
  messageId: string,
  hostedContentId: string
): Promise<{ data: string; mimeType: string }> {
  const path = `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/hostedContents/${encodeURIComponent(hostedContentId)}/$value`;
  const { data, contentType } = await graphFetchBinary(path);
  const mimeType = sniffImageMimeType(data) || contentType;
  return { data: data.toString("base64"), mimeType };
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
