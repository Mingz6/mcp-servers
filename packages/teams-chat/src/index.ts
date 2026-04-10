import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
    extractPrLinks,
    findChatByParticipant,
    getCalendarEvents,
    getMyProfile,
    listChats,
    reactToMessage,
    readChatMessages,
    sendMessage,
} from "./graph.js";

const server = new McpServer({
  name: "teams-chat",
  version: "1.0.0",
});

// --- Tools ---

function toolError(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

server.tool(
  "teams_list_chats",
  "List recent Microsoft Teams chats with participant names and last message preview",
  {
    count: z
      .number()
      .min(1)
      .max(50)
      .default(20)
      .describe("Number of chats to return (default 20, max 50)"),
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
  "Read messages from a specific Teams chat. Use teams_list_chats or teams_find_chat first to get the chat ID.",
  {
    chatId: z
      .string()
      .describe("The chat ID (from teams_list_chats or teams_find_chat)"),
    count: z
      .number()
      .min(1)
      .max(50)
      .default(30)
      .describe("Number of recent messages to return (default 30, max 50)"),
  },
  async ({ chatId, count }) => {
    try {
      const messages = await readChatMessages(chatId, count);
      const lines = messages.map((m) => {
        const date = new Date(m.createdAt).toLocaleString();
        return `[${date}] ${m.from} (msgId: ${m.id}): ${m.body}`;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: lines.join("\n") || "No messages found in this chat.",
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "teams_find_chat",
  "Find a Teams chat by participant name or chat topic. Returns matching chats with their IDs.",
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
  "Send a message to a Teams chat. Use teams_find_chat or teams_list_chats first to get the chat ID.",
  {
    chatId: z
      .string()
      .describe("The chat ID to send the message to"),
    content: z
      .string()
      .describe("The message content (plain text or HTML)"),
  },
  async ({ chatId, content }) => {
    try {
      const msgId = await sendMessage(chatId, content);
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

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Teams Chat MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal:", error.message || error);
  process.exit(1);
});
