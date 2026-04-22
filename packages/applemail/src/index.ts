import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getAccounts,
  listMessages,
  searchMessages,
  getMessageMeta,
  getMessageById,
  getRecipients,
  getAttachments,
  listFolders,
  findEmlxPath,
} from "./db.js";
import { parseEmlx, getPlainBody } from "./emlx.js";
import { sendMail } from "./send.js";

const server = new McpServer({
  name: "applemail",
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
  "applemail_accounts",
  "List all email accounts configured in Apple Mail.",
  {},
  async () => {
    try {
      const accounts = getAccounts();
      if (accounts.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No accounts found in Apple Mail." },
          ],
        };
      }

      const lines = accounts.map(
        (a) =>
          `• ${a.email}${a.description ? ` (${a.description})` : ""} — ${a.protocol.toUpperCase()}`
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Apple Mail accounts (${accounts.length}):\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "applemail_inbox",
  "List recent emails from Apple Mail. Can filter by account, folder, and unread status.",
  {
    account: z
      .string()
      .optional()
      .describe(
        "Filter by account email address (e.g., 'mingzhu6286@gmail.com')"
      ),
    folder: z
      .string()
      .optional()
      .describe("Filter by folder name (e.g., 'INBOX', '[Gmail]/All Mail')"),
    unreadOnly: z
      .boolean()
      .default(false)
      .describe("If true, only return unread emails"),
    count: z
      .number()
      .min(1)
      .max(50)
      .default(15)
      .describe("Number of emails to return (default 15, max 50)"),
  },
  async ({ account, folder, unreadOnly, count }) => {
    try {
      const messages = listMessages({ account, folder, unreadOnly, count });

      if (messages.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: unreadOnly
                ? "No unread emails found."
                : "No emails found.",
            },
          ],
        };
      }

      const lines = messages.map((m, i) => {
        const read = m.isRead ? "  " : "● ";
        const flag = m.isFlagged ? " ⭐" : "";
        const attach = m.hasAttachments ? " 📎" : "";
        return [
          `${read}${i + 1}. ${m.subject}${flag}${attach}`,
          `   From: ${m.senderName || m.senderEmail} — ${formatDate(m.receivedAt)}`,
          `   Account: ${m.account} | Folder: ${m.folder}`,
          `   ID: ${m.id}`,
        ].join("\n");
      });

      const unreadCount = messages.filter((m) => !m.isRead).length;
      const header = `Emails: ${messages.length} shown (${unreadCount} unread)\n`;

      return {
        content: [
          { type: "text" as const, text: header + lines.join("\n\n") },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "applemail_search",
  "Search Apple Mail emails by keyword. Matches subject, sender email, and sender name across all accounts.",
  {
    query: z
      .string()
      .describe(
        "Search query — matches subject, sender email, or sender name"
      ),
    count: z
      .number()
      .min(1)
      .max(25)
      .default(10)
      .describe("Number of results to return (default 10, max 25)"),
  },
  async ({ query, count }) => {
    try {
      const messages = searchMessages(query, count);

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
          `   From: ${m.senderName || m.senderEmail} — ${formatDate(m.receivedAt)}`,
          `   Account: ${m.account} | Folder: ${m.folder}`,
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
  "applemail_read",
  "Read the full content of a specific email by its ID. Use applemail_inbox or applemail_search first to find the ID.",
  {
    messageId: z
      .number()
      .describe(
        "The email message ID (from applemail_inbox or applemail_search)"
      ),
  },
  async ({ messageId }) => {
    try {
      const meta = getMessageMeta(messageId);
      if (!meta) {
        return toolError(new Error(`Message ${messageId} not found`));
      }

      const recipients = getRecipients(messageId);
      const summary = getMessageById(messageId);
      if (!summary) {
        return toolError(new Error(`Message ${messageId} not found`));
      }

      // Try to read the .emlx file for body
      const emlxPath = findEmlxPath(messageId, meta.mailbox);
      let body = "";
      let isPartial = false;

      if (emlxPath) {
        const parsed = await parseEmlx(emlxPath);
        body = getPlainBody(parsed.mail);
        isPartial = parsed.isPartial;
      } else {
        body = "(Message body not available locally — only headers are synced)";
        isPartial = true;
      }

      const parts = [
        `Subject: ${summary.subject}`,
        `From: ${summary.senderName ? `${summary.senderName} <${summary.senderEmail}>` : summary.senderEmail}`,
        `To: ${recipients.to.join(", ") || "(unknown)"}`,
        recipients.cc.length > 0 ? `CC: ${recipients.cc.join(", ")}` : null,
        `Date: ${formatDate(summary.receivedAt)}`,
        `Account: ${summary.account}`,
        `Folder: ${summary.folder}`,
        summary.hasAttachments ? "Attachments: Yes (use applemail_attachments to list)" : null,
        isPartial ? "⚠️ Partial download — body may be incomplete" : null,
        "",
        "--- Body ---",
        body,
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
  "applemail_attachments",
  "List attachments for a specific email and return their local file paths. Paths can be used with view_image or read_file.",
  {
    messageId: z
      .number()
      .describe("The email message ID"),
  },
  async ({ messageId }) => {
    try {
      const attachments = getAttachments(messageId);

      if (attachments.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No attachments found for message ${messageId}.`,
            },
          ],
        };
      }

      const lines = attachments.map((a, i) => {
        const pathInfo = a.path
          ? `📁 ${a.path}`
          : "⚠️ File not found locally";
        return `${i + 1}. ${a.name}\n   ${pathInfo}`;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Attachments for message ${messageId} (${attachments.length}):\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "applemail_folders",
  "List mail folders for an account (or all accounts). Shows total and unread counts.",
  {
    account: z
      .string()
      .optional()
      .describe("Filter by account email address. Omit to list all folders."),
  },
  async ({ account }) => {
    try {
      const folders = listFolders(account);

      if (folders.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No folders found." },
          ],
        };
      }

      const lines = folders.map(
        (f) =>
          `• ${f.account} / ${f.folder} — ${f.totalCount} total, ${f.unreadCount} unread`
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Mail folders (${folders.length}):\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "applemail_send",
  "Send an email via Apple Mail, OR create a draft for user review (preferred default). Apple Mail must be running.",
  {
    to: z.array(z.string()).min(1).describe("Recipient email addresses"),
    cc: z
      .array(z.string())
      .optional()
      .describe("CC email addresses"),
    bcc: z
      .array(z.string())
      .optional()
      .describe("BCC email addresses"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body (plain text)"),
    from: z
      .string()
      .optional()
      .describe(
        "Sender email address (must match an account in Apple Mail). Omit to use default."
      ),
    attachments: z
      .array(z.string())
      .optional()
      .describe("Array of absolute file paths to attach"),
    draft: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "DEFAULT TRUE. When true, opens a visible draft window in Apple Mail for the user to review and send manually. When false, sends immediately without confirmation. Only set false after the user has explicitly approved the exact draft content."
      ),
  },
  async ({ to, cc, bcc, subject, body, from, attachments, draft }) => {
    try {
      sendMail({ to, cc, bcc, subject, body, from, attachments, draft });

      const attachNote = attachments?.length
        ? ` with ${attachments.length} attachment(s)`
        : "";

      return {
        content: [
          {
            type: "text" as const,
            text: draft
              ? `Draft opened in Apple Mail for review. To: ${to.join(", ")}${cc?.length ? ` | CC: ${cc.join(", ")}` : ""}${attachNote}. User must review and click Send.`
              : `Email SENT to ${to.join(", ")}${attachNote}.`,
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
  console.error("Apple Mail MCP server started");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
