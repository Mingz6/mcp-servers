import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";
import {
  extractPrLinks,
  findChatByParticipant,
  getCalendarEvents,
  getMessageHostedContent,
  getMeetingTranscript,
  getMyProfile,
  listChats,
  listRecentMeetings,
  reactToMessage,
  readChatMessages,
  sendMessage,
} from "./teams-graph.js";
import {
  createDraft,
  downloadAttachment,
  listAttachments,
  listFolderMessages,
  listInbox,
  listUnread,
  markAsRead,
  readMessage,
  searchMail,
  sendMail,
} from "./outlook-graph.js";
import {
  createLoopFile,
  deleteLoopFile,
  getLoopByItemId,
  getLoopByShareUrl,
  listLoopContainers,
  listLoopFilesInDrive,
  renameLoopFile,
  searchLoopFiles,
  updateLoopFile,
} from "./loop.js";

// Unified Microsoft Graph MCP server — merges teams-chat, outlook, and ms-loop
// (CRNA identity only) into one process/token cache. See packages/msgraph-auth
// and /memories/repo/mcp-servers-monorepo.md for the design rationale.
// outlook-mingz6 (personal identity) keeps running the separate packages/outlook
// server unchanged — it is NOT part of this merge.
const server = new McpServer({
  name: "msgraph",
  version: "1.0.0",
});

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

// =========================================================================
// --- Teams tools ---
// =========================================================================

server.tool(
  "teams_list_chats",
  "List recent Microsoft Teams chats with participant names and last message preview. Supports pagination beyond 50 chats.",
  {
    count: z
      .number()
      .min(1)
      .max(200)
      .default(20)
      .describe("Number of chats to return (default 20, max 200). Paginates automatically."),
  },
  async ({ count }) => {
    try {
      const chats = await listChats(count);
      const lines = chats.map((c, i) => {
        const members = c.members.join(", ");
        const topic = c.topic ? ` — "${c.topic}"` : "";
        const preview = c.lastMessage ? `\n   Last: ${c.lastMessage}` : "";
        const date = c.lastUpdated
          ? new Date(c.lastUpdated).toLocaleDateString()
          : "unknown";
        return `${i + 1}. [${c.chatType}] ${members}${topic} (${date})${preview}\n   ID: ${c.id}`;
      });

      return {
        content: [
          { type: "text" as const, text: lines.join("\n\n") || "No chats found." },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "teams_read_chat",
  "Read messages from a specific Teams chat. Use teams_list_chats or teams_find_chat first to get the chat ID. Supports pagination for more than 50 messages.",
  {
    chatId: z
      .string()
      .describe("The chat ID (from teams_list_chats or teams_find_chat)"),
    count: z
      .number()
      .min(1)
      .max(200)
      .default(30)
      .describe("Number of recent messages to return (default 30, max 200). Paginates automatically."),
    includeImages: z
      .boolean()
      .default(false)
      .describe("Fetch and return inline images/screenshots as image content blocks (slower when true)"),
  },
  async ({ chatId, count, includeImages }) => {
    try {
      const messages = await readChatMessages(chatId, count);
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];

      for (const m of messages) {
        const date = new Date(m.createdAt).toLocaleString();
        const imageTag = !includeImages && m.hostedContentIds.length > 0
          ? ` [📎 ${m.hostedContentIds.length} image${m.hostedContentIds.length > 1 ? "s" : ""}]`
          : "";
        content.push({
          type: "text" as const,
          text: `[${date}] ${m.from} (msgId: ${m.id}): ${m.body}${imageTag}`,
        });

        if (includeImages) {
          for (const contentId of m.hostedContentIds) {
            try {
              const img = await getMessageHostedContent(chatId, m.id, contentId);
              content.push({
                type: "image" as const,
                data: img.data,
                mimeType: img.mimeType,
              });
            } catch (e) {
              content.push({
                type: "text" as const,
                text: `[Failed to fetch image: ${e instanceof Error ? e.message : String(e)}]`,
              });
            }
          }
        }
      }

      if (content.length === 0) {
        content.push({ type: "text" as const, text: "No messages found in this chat." });
      }

      return { content };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "teams_find_chat",
  "Find a Teams chat by participant name or chat topic. Searches through all available chats (paginated, not just recent 50). Returns matching chats with their IDs.",
  {
    query: z
      .string()
      .describe(
        "Person name or chat topic to search for (partial match, case-insensitive)"
      ),
  },
  async ({ query }) => {
    try {
      const chats = await findChatByParticipant(query);

      if (chats.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No chats found matching "${query}". Try a different name or check teams_list_chats for all recent chats.`,
            },
          ],
        };
      }

      const lines = chats.map((c, i) => {
        const members = c.members.join(", ");
        const topic = c.topic ? ` — "${c.topic}"` : "";
        const preview = c.lastMessage ? `\n   Last: ${c.lastMessage}` : "";
        return `${i + 1}. [${c.chatType}] ${members}${topic}${preview}\n   ID: ${c.id}`;
      });

      return {
        content: [{ type: "text" as const, text: lines.join("\n\n") }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "teams_whoami",
  "Check the currently authenticated Teams user (useful to verify auth is working)",
  {},
  async () => {
    try {
      const profile = await getMyProfile();
      return {
        content: [
          {
            type: "text" as const,
            text: `Authenticated as: ${profile.displayName} (${profile.mail})`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "teams_get_pending_reviews",
  "Extract GitHub PR links from a Teams chat (e.g., Build Team PRs++) for code review. Filters out your own PRs, deduplicates, and returns structured PR data. Use with a chat ID from teams_find_chat.",
  {
    chatId: z
      .string()
      .describe("The chat ID to scan for PR links"),
    since: z
      .string()
      .default("today")
      .describe("Time filter: 'today', an ISO date like '2026-03-26', or 'all' for last 50 messages"),
    excludeSelf: z
      .boolean()
      .default(true)
      .describe("Exclude PRs posted by the authenticated user (default true)"),
  },
  async ({ chatId, since, excludeSelf }) => {
    try {
      let sinceDate: string;
      if (since === "today") {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        sinceDate = today.toISOString();
      } else if (since === "all") {
        sinceDate = "2000-01-01T00:00:00Z";
      } else {
        sinceDate = new Date(since).toISOString();
      }

      let excludeAuthor: string | undefined;
      if (excludeSelf) {
        const profile = await getMyProfile();
        excludeAuthor = profile.displayName;
      }

      const prs = await extractPrLinks(chatId, sinceDate, excludeAuthor);

      if (prs.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No PR links found${since === "today" ? " from today" : ""} (excluding your own).`,
          }],
        };
      }

      const lines = prs.map((pr, i) =>
        `${i + 1}. **${pr.owner}/${pr.repo}#${pr.number}** — by ${pr.postedBy} (${new Date(pr.postedAt).toLocaleString()})\n   ${pr.url}\n   ${pr.context}`
      );

      return {
        content: [{
          type: "text" as const,
          text: `Found ${prs.length} PR(s):\n\n${lines.join("\n\n")}`,
        }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "teams_react_to_message",
  "React to a Teams chat message with an emoji (e.g., ✅, ❌, 👍, ❤️). Use teams_read_chat first to get message IDs.",
  {
    chatId: z
      .string()
      .describe("The chat ID containing the message"),
    messageId: z
      .string()
      .describe("The message ID to react to (from teams_read_chat output)"),
    emoji: z
      .string()
      .default("✅")
      .describe("The emoji to react with (any unicode emoji, e.g., ✅, ❌, 👍, ❤️)"),
  },
  async ({ chatId, messageId, emoji }) => {
    try {
      await reactToMessage(chatId, messageId, emoji);
      return {
        content: [{
          type: "text" as const,
          text: `Reacted with ${emoji} to message ${messageId}.`,
        }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "teams_send_message",
  "Send a message to a Teams chat. Supports plain text, markdown (auto-converted to rich HTML), or raw HTML. Use teams_find_chat or teams_list_chats first to get the chat ID.",
  {
    chatId: z
      .string()
      .describe("The chat ID to send the message to"),
    content: z
      .string()
      .describe("The message content"),
    format: z
      .enum(["markdown", "text", "html"])
      .default("markdown")
      .describe("Message format: 'markdown' (default, converts to rich HTML), 'text' (plain text, preserves newlines), 'html' (raw HTML pass-through)"),
  },
  async ({ chatId, content, format }) => {
    try {
      const msgId = await sendMessage(chatId, content, format);
      return {
        content: [{
          type: "text" as const,
          text: `Message sent (ID: ${msgId}).`,
        }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "teams_calendar",
  "Get calendar events from Microsoft Teams/Outlook calendar. Search by date range and optionally filter by subject keyword (e.g., 'Sprint Demo', 'standup').",
  {
    startDate: z
      .string()
      .describe("Start date in ISO format or 'today', 'tomorrow', 'this_week', 'next_week'"),
    endDate: z
      .string()
      .optional()
      .describe("End date in ISO format. Defaults to 7 days from startDate if omitted"),
    filter: z
      .string()
      .optional()
      .describe("Optional keyword to filter events by subject (case-insensitive)"),
  },
  async ({ startDate, endDate, filter }) => {
    try {
      let start: Date;
      const now = new Date();

      switch (startDate) {
        case "today":
          start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case "tomorrow":
          start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
          break;
        case "this_week": {
          const day = now.getDay();
          const diff = day === 0 ? -6 : 1 - day;
          start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff);
          break;
        }
        case "next_week": {
          const day = now.getDay();
          const diff = day === 0 ? 1 : 8 - day;
          start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff);
          break;
        }
        default:
          start = new Date(startDate);
      }

      let end: Date;
      if (endDate) {
        end = new Date(endDate);
      } else if (startDate === "today" || startDate === "tomorrow") {
        end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      } else if (startDate === "this_week" || startDate === "next_week") {
        end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
      } else {
        end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
      }

      const events = await getCalendarEvents(
        start.toISOString(),
        end.toISOString(),
        filter
      );

      if (events.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No events found${filter ? ` matching "${filter}"` : ""} between ${start.toLocaleDateString()} and ${end.toLocaleDateString()}.`,
            },
          ],
        };
      }

      const lines = events.map((e, i) => {
        const startTime = e.isAllDay
          ? "All day"
          : new Date(e.start).toLocaleString();
        const endTime = e.isAllDay ? "" : ` — ${new Date(e.end).toLocaleString()}`;
        const loc = e.location ? `\n   📍 ${e.location}` : "";
        const online = e.isOnline && e.onlineUrl ? `\n   🔗 ${e.onlineUrl}` : "";
        const body = e.bodyPreview ? `\n   ${e.bodyPreview}` : "";
        return `${i + 1}. **${e.subject}** — ${startTime}${endTime}\n   Organizer: ${e.organizer}${loc}${online}${body}`;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `${events.length} event(s) found:\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "teams_list_recent_meetings",
  "List recent Microsoft Teams online meetings for the signed-in user, with transcript availability. Use before teams_get_meeting_transcript to find the right meeting name.",
  {
    daysBack: z.number().min(1).max(60).default(30).describe("How many days back to search (default 30)"),
    limit: z.number().min(1).max(50).default(10).describe("Max meetings to return (default 10)"),
  },
  async ({ daysBack, limit }) => {
    try {
      const meetings = await listRecentMeetings(daysBack, limit);
      if (meetings.length === 0) {
        return { content: [{ type: "text" as const, text: "No Teams meetings found in the specified range." }] };
      }
      const lines = meetings.map((m, i) => {
        const date = m.start ? new Date(m.start).toLocaleString() : "unknown";
        return `${i + 1}. **${m.subject}** — ${date}`;
      });
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "teams_get_meeting_transcript",
  "Retrieve and clean the transcript for a specific Teams meeting. Returns speaker-attributed text ready for summarisation. Use teams_list_recent_meetings first to find the exact meeting name.",
  {
    meetingName: z.string().describe("Meeting subject to search for (partial match, case-insensitive)"),
    meetingDate: z.string().optional().describe("Optional date filter (YYYY-MM-DD) to narrow results"),
  },
  async ({ meetingName, meetingDate }) => {
    try {
      const transcript = await getMeetingTranscript(meetingName, meetingDate);
      return { content: [{ type: "text" as const, text: transcript }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

// =========================================================================
// --- Outlook tools ---
// =========================================================================

server.tool(
  "outlook_inbox",
  "List recent emails from Outlook inbox. Returns subject, sender, date, and preview.",
  {
    count: z
      .number()
      .min(1)
      .max(50)
      .default(15)
      .describe("Number of emails to return (default 15, max 50)"),
    unreadOnly: z
      .boolean()
      .default(false)
      .describe("If true, only return unread emails"),
  },
  async ({ count, unreadOnly }) => {
    try {
      const messages = unreadOnly
        ? await listUnread(count)
        : await listInbox(count);

      if (messages.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: unreadOnly ? "No unread emails." : "Inbox is empty.",
            },
          ],
        };
      }

      const lines = messages.map((m, i) => {
        const read = m.isRead ? "  " : "● ";
        const attach = m.hasAttachments ? " 📎" : "";
        const importance = m.importance === "high" ? " ❗" : "";
        return [
          `${read}${i + 1}. ${m.subject}${importance}${attach}`,
          `   From: ${m.from} — ${formatDate(m.receivedAt)}`,
          `   ${m.preview.slice(0, 120)}`,
          `   ID: ${m.id}`,
        ].join("\n");
      });

      const unreadCount = messages.filter((m) => !m.isRead).length;
      const header = `Inbox: ${messages.length} emails shown (${unreadCount} unread)\n`;

      return {
        content: [{ type: "text" as const, text: header + lines.join("\n\n") }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "outlook_search",
  "Search Outlook emails by keyword. Searches subject, body, and sender.",
  {
    query: z
      .string()
      .describe("Search query — matches subject, body, sender name, or email address"),
    count: z
      .number()
      .min(1)
      .max(25)
      .default(10)
      .describe("Number of results to return (default 10, max 25)"),
  },
  async ({ query, count }) => {
    try {
      const messages = await searchMail(query, count);

      if (messages.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No emails found matching "${query}".`,
            },
          ],
        };
      }

      const lines = messages.map((m, i) => {
        const attach = m.hasAttachments ? " 📎" : "";
        return [
          `${i + 1}. ${m.subject}${attach}`,
          `   From: ${m.from} — ${formatDate(m.receivedAt)}`,
          `   ${m.preview.slice(0, 120)}`,
          `   ID: ${m.id}`,
        ].join("\n");
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Search results for "${query}" (${messages.length}):\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "outlook_read",
  "Read the full content of a specific email by its ID. Use outlook_inbox or outlook_search first to find the ID.",
  {
    messageId: z
      .string()
      .describe("The email message ID (from outlook_inbox or outlook_search)"),
  },
  async ({ messageId }) => {
    try {
      const msg = await readMessage(messageId);

      const parts = [
        `Subject: ${msg.subject}`,
        `From: ${msg.from}`,
        `To: ${msg.to.join(", ")}`,
        msg.cc.length > 0 ? `CC: ${msg.cc.join(", ")}` : null,
        `Date: ${formatDate(msg.receivedAt)}`,
        `Importance: ${msg.importance}`,
        msg.hasAttachments ? "Attachments: Yes" : null,
        `Read: ${msg.isRead ? "Yes" : "No"}`,
        "",
        "--- Body ---",
        msg.body,
      ].filter(Boolean);

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "outlook_mark_read",
  "Mark one or more emails as read by their IDs.",
  {
    messageIds: z
      .array(z.string())
      .min(1)
      .describe("Array of email message IDs to mark as read"),
  },
  async ({ messageIds }) => {
    try {
      const count = await markAsRead(messageIds);
      return {
        content: [
          {
            type: "text" as const,
            text: `Marked ${count} email${count === 1 ? "" : "s"} as read.`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "outlook_folder",
  "List emails from a specific Outlook folder by name (e.g., 'Devops', 'Alerts', 'MSTeam', 'ItGroup').",
  {
    folder: z
      .string()
      .describe("The folder name (case-sensitive, e.g., 'Devops', 'Alerts')"),
    count: z
      .number()
      .min(1)
      .max(50)
      .default(15)
      .describe("Number of emails to return (default 15, max 50)"),
    unreadOnly: z
      .boolean()
      .default(false)
      .describe("If true, only return unread emails"),
  },
  async ({ folder, count, unreadOnly }) => {
    try {
      const messages = await listFolderMessages(folder, count, unreadOnly);

      if (messages.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: unreadOnly
                ? `No unread emails in "${folder}".`
                : `No emails in "${folder}".`,
            },
          ],
        };
      }

      const lines = messages.map((m, i) => {
        const read = m.isRead ? "  " : "● ";
        const attach = m.hasAttachments ? " 📎" : "";
        const importance = m.importance === "high" ? " ❗" : "";
        return [
          `${read}${i + 1}. ${m.subject}${importance}${attach}`,
          `   From: ${m.from} — ${formatDate(m.receivedAt)}`,
          `   ${m.preview.slice(0, 120)}`,
          `   ID: ${m.id}`,
        ].join("\n");
      });

      const unreadCount = messages.filter((m) => !m.isRead).length;
      const header = `Folder "${folder}": ${messages.length} emails shown (${unreadCount} unread)\n`;

      return {
        content: [{ type: "text" as const, text: header + lines.join("\n\n") }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "outlook_attachments",
  "List attachments on an email. Use outlook_inbox or outlook_search first to find the message ID.",
  {
    messageId: z
      .string()
      .describe("The email message ID"),
  },
  async ({ messageId }) => {
    try {
      const attachments = await listAttachments(messageId);

      if (attachments.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No attachments on this email." }],
        };
      }

      const lines = attachments.map((a, i) => {
        const sizeKb = (a.size / 1024).toFixed(1);
        const inline = a.isInline ? " (inline)" : "";
        return `${i + 1}. ${a.name}${inline}\n   Type: ${a.contentType} | Size: ${sizeKb} KB\n   ID: ${a.id}`;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Attachments (${attachments.length}):\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "outlook_download_attachment",
  "Download an email attachment to a local temp file. Returns the file path. Use outlook_attachments first to get the attachment ID.",
  {
    messageId: z
      .string()
      .describe("The email message ID"),
    attachmentId: z
      .string()
      .describe("The attachment ID (from outlook_attachments)"),
  },
  async ({ messageId, attachmentId }) => {
    try {
      const attachment = await downloadAttachment(messageId, attachmentId);
      const dir = join(tmpdir(), "outlook-attachments");
      await mkdir(dir, { recursive: true });
      const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = join(dir, safeName);
      await writeFile(filePath, Buffer.from(attachment.contentBytes, "base64"));

      return {
        content: [
          {
            type: "text" as const,
            text: `Downloaded: ${attachment.name}\nType: ${attachment.contentType}\nSize: ${(attachment.size / 1024).toFixed(1)} KB\nSaved to: ${filePath}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "outlook_send",
  "Send an email from the work Outlook account, OR create a draft for user review (preferred default).",
  {
    to: z
      .array(z.string())
      .min(1)
      .describe("Array of recipient email addresses"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Plain text email body"),
    cc: z
      .array(z.string())
      .optional()
      .describe("Optional CC recipients"),
    bcc: z
      .array(z.string())
      .optional()
      .describe("Optional BCC recipients"),
    draft: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "DEFAULT TRUE. When true, saves to Outlook Drafts folder for user review (returns webLink to open). When false, sends immediately. Only set false after the user has explicitly approved the exact draft content."
      ),
  },
  async ({ to, subject, body, cc, bcc, draft }) => {
    try {
      if (draft) {
        const { webLink } = await createDraft(to, subject, body, cc, bcc);
        return {
          content: [
            {
              type: "text" as const,
              text: `Draft saved to Outlook Drafts folder. To: ${to.join(", ")}${cc?.length ? ` | CC: ${cc.join(", ")}` : ""}. Open for review: ${webLink}`,
            },
          ],
        };
      }
      await sendMail(to, subject, body, cc, bcc);
      return {
        content: [
          {
            type: "text" as const,
            text: `Email SENT to ${to.join(", ")}${cc?.length ? ` (CC: ${cc.join(", ")})` : ""}.`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// =========================================================================
// --- Loop tools ---
// =========================================================================

server.tool(
  "loop_list_workspaces",
  "List all Microsoft Loop workspaces (drives) you have access to. Returns driveId, name, and file count for each.",
  {},
  async () => {
    try {
      const workspaces = await listLoopContainers();
      if (workspaces.length === 0) {
        return { content: [{ type: "text" as const, text: "No Loop workspaces found." }] };
      }
      const text = workspaces
        .map(
          (ws) =>
            `• ${ws.name} (driveId: ${ws.driveId}, ${ws.loopFileCount} files)${ws.webUrl ? `\n  ${ws.webUrl}` : ""}`
        )
        .join("\n");
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "loop_list_files",
  "List all Loop files (.loop/.fluid) in a specific drive/workspace.",
  {
    driveId: z.string().describe("The drive ID of the workspace"),
    path: z
      .string()
      .optional()
      .describe("Subfolder path (default: root). Use 'root' or 'Folder/Subfolder'."),
  },
  async ({ driveId, path }) => {
    try {
      const files = await listLoopFilesInDrive(driveId, path);
      if (files.length === 0) {
        return { content: [{ type: "text" as const, text: "No Loop files found in this drive." }] };
      }
      const text = files
        .map(
          (f) =>
            `• ${f.name} (id: ${f.id}, modified: ${f.lastModified}, size: ${f.size}B)\n  ${f.webUrl}`
        )
        .join("\n");
      return { content: [{ type: "text" as const, text: `${files.length} Loop files:\n${text}` }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "loop_search",
  "Search for Loop files by keyword across all workspaces. Returns file metadata and a content summary snippet.",
  {
    query: z.string().describe("Search query (searches file names and content)"),
  },
  async ({ query }) => {
    try {
      const files = await searchLoopFiles(query);
      if (files.length === 0) {
        return { content: [{ type: "text" as const, text: `No Loop files found for "${query}".` }] };
      }
      const text = files
        .map(
          (f) => {
            let entry = `• ${f.name} (driveId: ${f.driveId}, id: ${f.id}, modified: ${f.lastModified})\n  ${f.webUrl}`;
            if (f.summary) {
              entry += `\n  Summary: ${f.summary}`;
            }
            return entry;
          }
        )
        .join("\n");
      return { content: [{ type: "text" as const, text: `${files.length} results:\n${text}` }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "loop_read_by_url",
  "Read a Loop file's content given its sharing URL. For Loop workspace files (SPE containers), returns a search-indexed summary. For OneDrive-stored .loop files, attempts full HTML content.",
  {
    shareUrl: z.string().describe("The full sharing URL of the Loop file"),
    includeText: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include plain-text version (default true)"),
  },
  async ({ shareUrl, includeText }) => {
    try {
      const content = await getLoopByShareUrl(shareUrl, includeText);
      const parts = [
        `**${content.name}**`,
        `Modified: ${content.lastModified}`,
        `URL: ${content.webUrl}`,
        `DriveId: ${content.driveId} | ItemId: ${content.itemId}`,
        `Content source: ${content.contentSource}`,
        "",
      ];
      if (content.contentSource === "unavailable") {
        parts.push("⚠️ Content not available — Loop workspace files in SPE containers require FileStorageContainer.Selected permission.");
        parts.push("Use loop_search to find content summaries instead.");
      } else if (content.text) {
        parts.push("--- Content ---", content.text);
      } else {
        parts.push("--- HTML ---", content.html);
      }
      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "loop_read_by_id",
  "Read a Loop file's content using driveId and itemId. For Loop workspace files (SPE containers), returns a search-indexed summary. For OneDrive-stored .loop files, attempts full HTML content.",
  {
    driveId: z.string().describe("The drive ID containing the Loop file"),
    itemId: z.string().describe("The item ID of the Loop file"),
    includeText: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include plain-text version (default true)"),
  },
  async ({ driveId, itemId, includeText }) => {
    try {
      const content = await getLoopByItemId(driveId, itemId, includeText);
      const parts = [
        `**${content.name}**`,
        `Modified: ${content.lastModified}`,
        `URL: ${content.webUrl}`,
        `Content source: ${content.contentSource}`,
        "",
      ];
      if (content.contentSource === "unavailable") {
        parts.push("⚠️ Content not available — Loop workspace files in SPE containers require FileStorageContainer.Selected permission.");
        parts.push("Use loop_search to find content summaries instead.");
      } else if (content.text) {
        parts.push("--- Content ---", content.text);
      } else {
        parts.push("--- HTML ---", content.html);
      }
      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "loop_create",
  "Create a new Loop file with HTML content in a specific workspace drive. NOTE: only works on personal OneDrive drives — shared Loop workspaces (SPE containers) return 403; use the browser for those. The created file also cannot be read back via loop_read_by_id.",
  {
    driveId: z.string().describe("The drive ID to create the file in"),
    fileName: z
      .string()
      .describe("Name for the new Loop file (with or without .loop extension)"),
    htmlContent: z
      .string()
      .describe("HTML content for the Loop file"),
    parentPath: z
      .string()
      .optional()
      .describe("Optional parent folder path (default: drive root)"),
  },
  async ({ driveId, fileName, htmlContent, parentPath }) => {
    try {
      const result = await createLoopFile(driveId, fileName, htmlContent, parentPath);
      return {
        content: [
          {
            type: "text" as const,
            text: `Created: ${result.name}\nID: ${result.id}\nDrive: ${result.driveId}\nURL: ${result.webUrl}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "loop_update",
  "Replace the entire content of an existing Loop file (not a patch/append). NOTE: only works on personal OneDrive drives — shared Loop workspaces (SPE containers) return 403; use the browser for those.",
  {
    driveId: z.string().describe("The drive ID of the file"),
    itemId: z.string().describe("The item ID of the Loop file to update"),
    htmlContent: z.string().describe("New HTML content to replace the file with"),
  },
  async ({ driveId, itemId, htmlContent }) => {
    try {
      const result = await updateLoopFile(driveId, itemId, htmlContent);
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated: ${result.name}\nURL: ${result.webUrl}\nModified: ${result.lastModified}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "loop_rename",
  "Rename an existing Loop file. NOTE: only works on personal OneDrive drives — shared Loop workspaces (SPE containers) return 403; use the browser for those.",
  {
    driveId: z.string().describe("The drive ID of the file"),
    itemId: z.string().describe("The item ID of the Loop file to rename"),
    newName: z.string().describe("The new name (with or without .loop extension)"),
  },
  async ({ driveId, itemId, newName }) => {
    try {
      const result = await renameLoopFile(driveId, itemId, newName);
      return {
        content: [
          {
            type: "text" as const,
            text: `Renamed to: ${result.name}\nURL: ${result.webUrl}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "loop_delete",
  "Delete a Loop file permanently. This action cannot be undone. NOTE: only works on personal OneDrive drives — shared Loop workspaces (SPE containers) return 403; use the browser for those.",
  {
    driveId: z.string().describe("The drive ID of the file"),
    itemId: z.string().describe("The item ID of the Loop file to delete"),
  },
  async ({ driveId, itemId }) => {
    try {
      await deleteLoopFile(driveId, itemId);
      return {
        content: [{ type: "text" as const, text: `Deleted item ${itemId} from drive ${driveId}.` }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[msgraph] Unified Teams/Outlook/Loop MCP server running on stdio (27 tools)");
}

process.on("unhandledRejection", (err) => { console.error("[msgraph] Unhandled rejection:", err); process.exit(1); });
process.on("uncaughtException", (err) => { console.error("[msgraph] Uncaught exception:", err); process.exit(1); });

main().catch((error) => {
  console.error("Fatal:", error.message || error);
  process.exit(1);
});
