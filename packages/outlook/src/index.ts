import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { downloadAttachment, listAttachments, listFolderMessages, listInbox, listUnread, markAsRead, readMessage, searchMail, sendMail, createDraft } from "./graph.js";

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
