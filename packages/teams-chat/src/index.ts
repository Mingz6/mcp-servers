import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
    findChatByParticipant,
    getMyProfile,
    listChats,
    readChatMessages,
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
        return `[${date}] ${m.from}: ${m.body}`;
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
