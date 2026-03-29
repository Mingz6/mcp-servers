import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listInbox, listUnread, readMessage, searchMail } from "./graph.js";

const server = new McpServer({
  name: "outlook",
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

// --- Tools ---

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

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Outlook MCP server started");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
