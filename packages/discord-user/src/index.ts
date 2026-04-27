/**
 * Read-only Discord MCP server (user-token mode).
 *
 * IMPORTANT: This server has NO write tools. All inputs are GET requests.
 * Replies are produced as draft text only \u2014 the user pastes them into
 * Discord manually. This minimizes ToS risk: Discord's selfbot detection
 * primarily flags WRITE patterns (rapid sends, mass reactions, joins).
 *
 * Tools:
 *   - discord_user_whoami            : confirm token works
 *   - discord_user_list_guilds       : list servers I'm in
 *   - discord_user_list_channels     : list channels in a server
 *   - discord_user_list_dms          : list DM/group DM conversations
 *   - discord_user_read_messages     : read messages (channel or DM) with cursor
 *   - discord_user_get_thread_context: fetch a message + N msgs before for reply context
 *   - discord_user_search            : Discord native message search
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DiscordAPIError, DiscordUserClient } from "./client.js";
import type { Channel, Message } from "./types.js";

const TOKEN = process.env.DISCORD_USER_TOKEN;
const DEFAULT_GUILD = process.env.DISCORD_USER_DEFAULT_GUILD || undefined;

if (!TOKEN) {
  console.error("ERROR: DISCORD_USER_TOKEN env var is required (your USER token, not a bot token)");
  process.exit(1);
}

const client = new DiscordUserClient(TOKEN);
const server = new McpServer({ name: "discord-user", version: "1.0.0" });

function toolError(err: unknown) {
  const message =
    err instanceof DiscordAPIError
      ? `Discord API ${err.status}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

function fmtMessage(m: Message): string {
  const author = m.author.global_name || m.author.username;
  const ts = new Date(m.timestamp).toISOString();
  const attach =
    m.attachments.length > 0
      ? ` [\ud83d\udcce ${m.attachments.map((a) => a.filename).join(", ")}]`
      : "";
  const reply = m.referenced_message
    ? ` (\u21a9 reply to ${m.referenced_message.author.username}: ${truncate(m.referenced_message.content, 60)})`
    : "";
  const body = m.content || "(no text)";
  return `[${ts}] ${author} (msgId: ${m.id})${reply}: ${body}${attach}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

function fmtChannel(c: Channel): string {
  const dmName =
    c.recipients && c.recipients.length > 0
      ? c.recipients.map((r) => r.global_name || r.username).join(", ")
      : null;
  const name = c.name || dmName || "(unnamed)";
  return `[type:${c.type}] ${name} (id: ${c.id})`;
}

// ─── whoami ───────────────────────────────────────────────────────────────
server.tool(
  "discord_user_whoami",
  "Confirm the user token works and report which Discord account is logged in.",
  {},
  async () => {
    try {
      const me = await client.getCurrentUser();
      return {
        content: [
          {
            type: "text" as const,
            text: `Logged in as ${me.global_name || me.username} (id: ${me.id})`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// ─── list servers ─────────────────────────────────────────────────────────
server.tool(
  "discord_user_list_guilds",
  "List all Discord servers (guilds) you are a member of.",
  {},
  async () => {
    try {
      const guilds = await client.getMyGuilds();
      const lines = guilds.map(
        (g, i) =>
          `${i + 1}. ${g.name} (id: ${g.id}, members: ${g.approximate_member_count ?? "?"})`
      );
      return {
        content: [
          { type: "text" as const, text: lines.join("\n") || "Not in any guilds." },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// ─── list channels in a server ────────────────────────────────────────────
server.tool(
  "discord_user_list_channels",
  "List channels in a guild. Defaults to DISCORD_USER_DEFAULT_GUILD if guildId omitted.",
  {
    guildId: z.string().optional().describe("Guild/server ID. Optional if env default is set."),
  },
  async ({ guildId }) => {
    try {
      const id = guildId || DEFAULT_GUILD;
      if (!id) throw new Error("guildId required (or set DISCORD_USER_DEFAULT_GUILD)");
      const channels = await client.getGuildChannels(id);
      const lines = channels
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map(fmtChannel);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

// ─── list DMs ─────────────────────────────────────────────────────────────
server.tool(
  "discord_user_list_dms",
  "List your DM and group DM conversations (most recent first).",
  {
    count: z.number().min(1).max(50).default(20).describe("How many to return (1-50)"),
  },
  async ({ count }) => {
    try {
      const dms = await client.getDMChannels();
      const lines = dms.slice(0, count).map(fmtChannel);
      return {
        content: [
          { type: "text" as const, text: lines.join("\n") || "No DMs found." },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// ─── read messages ────────────────────────────────────────────────────────
server.tool(
  "discord_user_read_messages",
  "Read recent messages from a channel or DM. Supports cursor pagination (before/after/around msgId).",
  {
    channelId: z.string().describe("Channel ID or DM channel ID"),
    count: z.number().min(1).max(100).default(30).describe("How many messages (1-100)"),
    before: z.string().optional(),
    after: z.string().optional(),
    around: z.string().optional(),
  },
  async ({ channelId, count, before, after, around }) => {
    try {
      const cursorCount = [before, after, around].filter(Boolean).length;
      if (cursorCount > 1) throw new Error("Pass at most one of before/after/around");
      const messages = await client.getMessages(channelId, {
        limit: count,
        before,
        after,
        around,
      });
      const lines = messages
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
        .map(fmtMessage);
      return {
        content: [{ type: "text" as const, text: lines.join("\n") || "No messages." }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// ─── thread context (for drafting a reply) ────────────────────────────────
server.tool(
  "discord_user_get_thread_context",
  "Fetch a target message plus N messages before it, so you have full context to draft a reply. Use this BEFORE asking the assistant to draft a reply.",
  {
    channelId: z.string(),
    messageId: z.string().describe("The message you want to reply to"),
    contextCount: z
      .number()
      .min(1)
      .max(50)
      .default(15)
      .describe("How many preceding messages to include for context"),
  },
  async ({ channelId, messageId, contextCount }) => {
    try {
      const target = await client.getMessage(channelId, messageId);
      const before = await client.getMessages(channelId, {
        limit: contextCount,
        before: messageId,
      });
      const ordered = [...before, target].sort(
        (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
      );
      const lines = ordered.map((m) =>
        m.id === messageId ? `\u2192 ${fmtMessage(m)}  \u2190 (TARGET)` : `   ${fmtMessage(m)}`
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Context (oldest first), arrow marks the message to reply to:\n\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// ─── search ───────────────────────────────────────────────────────────────
server.tool(
  "discord_user_search",
  "Search messages in a guild using Discord's native search API (powerful filters: content, author, channel, date range).",
  {
    guildId: z.string().optional().describe("Guild ID. Optional if DISCORD_USER_DEFAULT_GUILD is set."),
    content: z.string().optional().describe("Substring to match in message content"),
    authorId: z.string().optional().describe("Filter by author's user ID"),
    channelId: z.string().optional().describe("Limit to one channel"),
    has: z
      .enum(["link", "embed", "file", "video", "image", "sound", "sticker"])
      .optional()
      .describe("Filter by attachment type"),
    offset: z.number().min(0).optional().describe("Pagination offset (Discord returns 25/page)"),
  },
  async ({ guildId, content, authorId, channelId, has, offset }) => {
    try {
      const id = guildId || DEFAULT_GUILD;
      if (!id) throw new Error("guildId required (or set DISCORD_USER_DEFAULT_GUILD)");
      const result = await client.searchGuild(id, {
        content,
        author_id: authorId,
        channel_id: channelId,
        has,
        offset,
      });
      const flat = result.messages.flat();
      const lines = flat.map(fmtMessage);
      return {
        content: [
          {
            type: "text" as const,
            text:
              flat.length === 0
                ? `No matches (total: ${result.total_results}).`
                : `${flat.length} of ${result.total_results} match(es):\n\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// ─── boot ─────────────────────────────────────────────────────────────────
async function main() {
  try {
    const me = await client.getCurrentUser();
    console.error(
      `discord-user MCP ready (READ-ONLY) \u2014 logged in as ${me.global_name || me.username} (${me.id})`
    );
    console.error(`  Default guild: ${DEFAULT_GUILD || "(none)"}`);
    console.error(`  Write tools intentionally absent. Drafts only \u2014 paste manually.`);
  } catch (err) {
    console.error("Token validation failed:", err);
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
