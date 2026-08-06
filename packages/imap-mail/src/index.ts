import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";
import {
  accountLabel,
  downloadAttachment,
  listAttachments,
  listInbox,
  markAsRead,
  readMessage,
  searchMail,
} from "./imap-client.js";

const server = new McpServer({
  name: "imap-mail",
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
  "imap_inbox",
  "List recent emails from the inbox. Which account this reads depends on the mcp.json entry (IMAP_MCP_LABEL identifies it below).",
  {
    count: z.number().min(1).max(50).default(15).describe("Number of emails to return (default 15, max 50)"),
    unreadOnly: z.boolean().default(false).describe("If true, only return unread emails"),
  },
  async ({ count, unreadOnly }) => {
    try {
      const messages = await listInbox(count, unreadOnly);

      if (messages.length === 0) {
        return {
          content: [{ type: "text" as const, text: unreadOnly ? "No unread emails." : "Inbox is empty." }],
        };
      }

      const lines = messages.map((m, i) => {
        const read = m.isRead ? "  " : "● ";
        const attach = m.hasAttachments ? " 📎" : "";
        return [
          `${read}${i + 1}. ${m.subject}${attach}`,
          `   From: ${m.from} — ${formatDate(m.receivedAt)}`,
          `   UID: ${m.uid}`,
        ].join("\n");
      });

      const unreadCount = messages.filter((m) => !m.isRead).length;
      const header = `${accountLabel()} inbox: ${messages.length} emails shown (${unreadCount} unread)\n`;

      return { content: [{ type: "text" as const, text: header + lines.join("\n\n") }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "imap_search",
  "Search this mailbox by keyword. Matches subject, sender, or message body.",
  {
    query: z.string().describe("Search query — matches subject, sender, or body text"),
    count: z.number().min(1).max(25).default(10).describe("Number of results to return (default 10, max 25)"),
  },
  async ({ query, count }) => {
    try {
      const messages = await searchMail(query, count);

      if (messages.length === 0) {
        return { content: [{ type: "text" as const, text: `No emails found matching "${query}".` }] };
      }

      const lines = messages.map((m, i) => {
        const attach = m.hasAttachments ? " 📎" : "";
        return [`${i + 1}. ${m.subject}${attach}`, `   From: ${m.from} — ${formatDate(m.receivedAt)}`, `   UID: ${m.uid}`].join(
          "\n"
        );
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `${accountLabel()} search results for "${query}" (${messages.length}):\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "imap_read",
  "Read the full content of a specific email by its UID. Use imap_inbox or imap_search first to find the UID.",
  {
    uid: z.number().describe("The email UID (from imap_inbox or imap_search)"),
  },
  async ({ uid }) => {
    try {
      const msg = await readMessage(uid);

      const parts = [
        `Subject: ${msg.subject}`,
        `From: ${msg.from}`,
        msg.to.length > 0 ? `To: ${msg.to.join(", ")}` : null,
        msg.cc.length > 0 ? `CC: ${msg.cc.join(", ")}` : null,
        `Date: ${formatDate(msg.receivedAt)}`,
        msg.hasAttachments ? "Attachments: Yes (use imap_attachments)" : null,
        `Read: ${msg.isRead ? "Yes" : "No"}`,
        "",
        "--- Body ---",
        msg.body,
      ].filter(Boolean);

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "imap_attachments",
  "List attachments on an email. Use imap_inbox or imap_search first to find the UID.",
  {
    uid: z.number().describe("The email UID"),
  },
  async ({ uid }) => {
    try {
      const attachments = await listAttachments(uid);

      if (attachments.length === 0) {
        return { content: [{ type: "text" as const, text: "No attachments on this email." }] };
      }

      const lines = attachments.map(
        (a) => `${a.index}. ${a.filename}\n   Type: ${a.contentType} | Size: ${(a.size / 1024).toFixed(1)} KB`
      );

      return {
        content: [{ type: "text" as const, text: `Attachments (${attachments.length}):\n\n${lines.join("\n\n")}` }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "imap_download_attachment",
  "Download an email attachment to a local temp file. Returns the file path. Use imap_attachments first to get the attachment index.",
  {
    uid: z.number().describe("The email UID"),
    index: z.number().describe("The attachment index (from imap_attachments)"),
  },
  async ({ uid, index }) => {
    try {
      const attachment = await downloadAttachment(uid, index);
      const dir = join(tmpdir(), "imap-mail-attachments");
      await mkdir(dir, { recursive: true });
      const safeName = attachment.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = join(dir, safeName);
      await writeFile(filePath, attachment.content);

      return {
        content: [
          {
            type: "text" as const,
            text: `Downloaded: ${attachment.filename}\nType: ${attachment.contentType}\nSize: ${(attachment.size / 1024).toFixed(1)} KB\nSaved to: ${filePath}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "imap_mark_read",
  "Mark one or more emails as read by their UIDs.",
  {
    uids: z.array(z.number()).min(1).describe("Array of email UIDs to mark as read"),
  },
  async ({ uids }) => {
    try {
      const count = await markAsRead(uids);
      return { content: [{ type: "text" as const, text: `Marked ${count} email${count === 1 ? "" : "s"} as read.` }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`IMAP mail MCP server started (${accountLabel()})`);
}

process.on("unhandledRejection", (err) => {
  console.error("[imap-mail] Unhandled rejection:", err);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("[imap-mail] Uncaught exception:", err);
  process.exit(1);
});

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
