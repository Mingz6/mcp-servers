#!/usr/bin/env node
/**
 * WhatsApp MCP Server — read chats, search messages, send messages, list contacts.
 *
 * Uses Baileys (WebSocket-based WhatsApp Web API) for full personal chat access.
 * First run requires QR code scan via: node login.mjs
 * Auth state is saved to ~/.whatsapp-mcp/auth/ and reused.
 *
 * Tools: whatsapp_login, whatsapp_close, whatsapp_chats, whatsapp_messages,
 *        whatsapp_search, whatsapp_send_message, whatsapp_contacts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
} from "baileys";
import fs from "fs";
import os from "os";
import path from "path";
import P from "pino";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AUTH_DIR = path.join(os.homedir(), ".whatsapp-mcp", "auth");
const CACHE_FILE = path.join(os.homedir(), ".whatsapp-mcp", "chat-cache.json");
const logger = P({ level: "silent" });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sock = null;
let connectionOpen = false;
let retryCount = 0;

// In-memory stores populated by events
const chatStore = new Map();     // jid -> { id, name, unread, lastMsg, ... }
const contactStore = new Map();  // jid -> { id, name, phone }
const messageStore = new Map();  // jid -> [messages] (recent N per chat)

const MAX_MSGS_PER_CHAT = 200;

// ---------------------------------------------------------------------------
// Disk cache — survives process restarts (Baileys only syncs on QR pairing)
// ---------------------------------------------------------------------------

let _savePending = null;

function saveCache() {
  // Debounce — many events fire in quick succession
  if (_savePending) clearTimeout(_savePending);
  _savePending = setTimeout(() => {
    try {
      const data = {
        ts: Date.now(),
        chats: [...chatStore.values()],
        contacts: [...contactStore.values()],
      };
      fs.writeFileSync(CACHE_FILE, JSON.stringify(data), { mode: 0o600 });
      console.error(`[cache] saved ${data.chats.length} chats, ${data.contacts.length} contacts`);
    } catch (e) {
      console.error("[cache] save error:", e.message);
    }
  }, 500);
}

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (!data.chats?.length) return false;
    for (const c of data.chats) chatStore.set(c.id, c);
    for (const c of (data.contacts || [])) contactStore.set(c.id, c);
    const age = Math.round((Date.now() - (data.ts || 0)) / 60000);
    console.error(`[cache] loaded ${chatStore.size} chats, ${contactStore.size} contacts (${age}m old)`);
    return true;
  } catch (e) {
    console.error("[cache] load error:", e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Baileys connection
// ---------------------------------------------------------------------------

function ensureAuthDir() {
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
}

async function connectWhatsApp() {
  if (sock && connectionOpen) return sock;

  ensureAuthDir();
  loadCache();

  if (!fs.existsSync(path.join(AUTH_DIR, "creds.json"))) {
    throw new Error(
      "Not logged in. Run: cd packages/whatsapp && node login.mjs"
    );
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: true,
    shouldSyncHistoryMessage: () => true,
    getMessage: async (key) => {
      const msgs = messageStore.get(key.remoteJid) || [];
      return msgs.find((m) => m.key?.id === key.id)?.message;
    },
  });

  // Connection lifecycle
  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "open") {
      connectionOpen = true;
      retryCount = 0;
      console.error("[whatsapp-mcp] Connected");
    }
    if (connection === "close") {
      connectionOpen = false;
      const code = (lastDisconnect?.error)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error("[whatsapp-mcp] Logged out — session invalidated");
      } else if (code === 408 || code === 440 || code === 500 || code === 515) {
        // Transient errors — retry a few times
        retryCount++;
        if (retryCount <= 3) {
          console.error(`[whatsapp-mcp] Reconnecting (attempt ${retryCount}/3)...`);
          const oldSock = sock;
          sock = null;
          try { oldSock.end(); } catch (_) {}
          setTimeout(() => connectWhatsApp().catch(console.error), 3000);
        } else {
          console.error("[whatsapp-mcp] Max retries reached, giving up");
        }
      } else {
        console.error(`[whatsapp-mcp] Connection closed (code=${code}), not retrying`);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Debug: log all events to stderr
  const origEmit = sock.ev.emit?.bind(sock.ev);
  if (origEmit) {
    sock.ev.emit = (event, ...args) => {
      if (event !== "creds.update") {
        const summary = Array.isArray(args[0])
          ? `[${args[0].length} items]`
          : typeof args[0] === "object"
            ? JSON.stringify(Object.keys(args[0]))
            : String(args[0]);
        console.error(`[ev] ${event} ${summary}`);
      }
      return origEmit(event, ...args);
    };
  }

  // Store chats
  sock.ev.on("chats.upsert", (chats) => {
    console.error(`[store] chats.upsert: ${chats.length} chats`);
    for (const c of chats) {
      chatStore.set(c.id, {
        id: c.id,
        name: c.name || c.id,
        unread: c.unreadCount || 0,
        conversationTimestamp: c.conversationTimestamp,
      });
    }
    saveCache();
  });
  sock.ev.on("chats.update", (updates) => {
    for (const u of updates) {
      const existing = chatStore.get(u.id) || { id: u.id, name: u.id };
      chatStore.set(u.id, { ...existing, ...u, name: u.name || existing.name });
    }
    saveCache();
  });

  // Store contacts
  sock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) {
      contactStore.set(c.id, {
        id: c.id,
        name: c.name || c.notify || c.verifiedName || c.id,
        phone: c.id.replace("@s.whatsapp.net", ""),
      });
    }
    saveCache();
  });
  sock.ev.on("contacts.update", (updates) => {
    for (const u of updates) {
      const existing = contactStore.get(u.id) || { id: u.id, phone: u.id };
      contactStore.set(u.id, { ...existing, ...u });
    }
    saveCache();
  });

  // Store messages
  sock.ev.on("messages.upsert", ({ messages: msgs }) => {
    for (const m of msgs) {
      const jid = m.key.remoteJid;
      if (!jid) continue;
      const list = messageStore.get(jid) || [];
      list.push(m);
      if (list.length > MAX_MSGS_PER_CHAT) list.shift();
      messageStore.set(jid, list);
    }
  });

  // History sync (initial load)
  sock.ev.on("messaging-history.set", ({ chats, contacts, messages, isLatest }) => {
    console.error(`[store] messaging-history.set: ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs, isLatest=${isLatest}`);
    for (const c of chats) {
      chatStore.set(c.id, {
        id: c.id,
        name: c.name || c.id,
        unread: c.unreadCount || 0,
        conversationTimestamp: c.conversationTimestamp,
      });
    }
    for (const c of contacts) {
      contactStore.set(c.id, {
        id: c.id,
        name: c.name || c.notify || c.verifiedName || c.id,
        phone: c.id.replace("@s.whatsapp.net", ""),
      });
    }
    for (const m of messages) {
      const jid = m.key?.remoteJid;
      if (!jid) continue;
      const list = messageStore.get(jid) || [];
      list.push(m);
      if (list.length > MAX_MSGS_PER_CHAT) list.shift();
      messageStore.set(jid, list);
    }
    saveCache();
  });

  // Wait for connection
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Connection timeout (30s)")),
      30000
    );
    const handler = ({ connection, lastDisconnect }) => {
      if (connection === "open") {
        clearTimeout(timeout);
        sock.ev.off("connection.update", handler);
        resolve();
      }
      if (connection === "close") {
        const code = (lastDisconnect?.error)?.output?.statusCode;
        // Non-retryable codes — reject immediately instead of hanging
        if (code === DisconnectReason.loggedOut || (code && code !== 408 && code !== 440 && code !== 500 && code !== 515)) {
          clearTimeout(timeout);
          sock.ev.off("connection.update", handler);
          reject(new Error(`Connection failed (code=${code})`));
        }
      }
    };
    if (connectionOpen) {
      clearTimeout(timeout);
      resolve();
    } else {
      sock.ev.on("connection.update", handler);
    }
  });

  // Wait for initial history sync (Baileys fires messaging-history.set after connect)
  // If cache was loaded, only wait 3s for fresh data; otherwise wait up to 15s
  if (chatStore.size === 0) {
    await new Promise((resolve) => {
      const syncTimeout = setTimeout(resolve, 15000);
      const syncHandler = ({ isLatest }) => {
        if (isLatest) {
          clearTimeout(syncTimeout);
          sock.ev.off("messaging-history.set", syncHandler);
          setTimeout(resolve, 500);
        }
      };
      sock.ev.on("messaging-history.set", syncHandler);
    });
  } else {
    // Cache loaded — give a short window for live updates, don't block
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  return sock;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(msg) {
  if (!msg?.message) return "";
  const m = msg.message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    (m.templateMessage?.hydratedTemplate?.hydratedContentText) ||
    ""
  );
}

function formatMessage(msg) {
  const text = extractText(msg);
  const sender = msg.key.fromMe
    ? "me"
    : contactStore.get(msg.key.participant || msg.key.remoteJid)?.name ||
      msg.pushName ||
      msg.key.participant ||
      msg.key.remoteJid;

  let mediaType = null;
  if (msg.message) {
    if (msg.message.imageMessage) mediaType = "image";
    else if (msg.message.videoMessage) mediaType = "video";
    else if (msg.message.audioMessage) mediaType = "audio";
    else if (msg.message.documentMessage) mediaType = "document";
    else if (msg.message.stickerMessage) mediaType = "sticker";
  }

  return {
    id: msg.key.id,
    date: msg.messageTimestamp
      ? new Date(
          (typeof msg.messageTimestamp === "number"
            ? msg.messageTimestamp
            : Number(msg.messageTimestamp)) * 1000
        ).toISOString()
      : null,
    sender,
    text,
    media: mediaType,
    from_me: msg.key.fromMe || false,
  };
}

function resolveJid(identifier) {
  if (!identifier) throw new Error("Chat identifier required");
  const id = identifier.trim();

  // Already a JID
  if (id.includes("@")) return id;

  // Phone number
  if (/^\+?\d{7,15}$/.test(id.replace(/[\s-]/g, ""))) {
    const num = id.replace(/[^\d]/g, "");
    return `${num}@s.whatsapp.net`;
  }

  // Name search — find in contacts and chats
  const lower = id.toLowerCase();
  for (const [jid, c] of contactStore) {
    if (c.name?.toLowerCase().includes(lower)) return jid;
  }
  for (const [jid, c] of chatStore) {
    if (c.name?.toLowerCase().includes(lower)) return jid;
  }

  throw new Error(
    `Could not resolve "${identifier}" — try a phone number, JID, or exact name`
  );
}

function chatName(jid) {
  return (
    chatStore.get(jid)?.name ||
    contactStore.get(jid)?.name ||
    jid
  );
}

// ---------------------------------------------------------------------------
// MCP Server & Tools
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: "whatsapp", version: "1.0.0" },
  {
    instructions:
      "Read and send WhatsApp messages, search chats, list contacts. " +
      "Tools: whatsapp_chats, whatsapp_messages, whatsapp_search, " +
      "whatsapp_send_message, whatsapp_contacts, whatsapp_login, whatsapp_close.",
  }
);

// --- whatsapp_login ---
server.registerTool(
  "whatsapp_login",
  {
    description:
      "Force interactive login. Only needed on first use or session expiry.",
  },
  async () => {
    throw new Error(
      "Interactive login required. Run from terminal:\n" +
        "  cd ~/code/personal/mcp-servers/packages/whatsapp\n" +
        "  node login.mjs"
    );
  }
);

// --- whatsapp_close ---
server.registerTool(
  "whatsapp_close",
  { description: "Disconnect the WhatsApp client." },
  async () => {
    if (sock) {
      await sock.end();
      sock = null;
      connectionOpen = false;
    }
    return { content: [{ type: "text", text: "Disconnected." }] };
  }
);

// --- whatsapp_chats ---
server.registerTool(
  "whatsapp_chats",
  {
    description: "List recent chats/conversations with last message preview.",
    inputSchema: z.object({
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(30)
        .describe("Max chats to return (default 30, max 100)"),
    }),
  },
  async ({ limit }) => {
    await connectWhatsApp();
    limit = Math.min(limit || 30, 100);

    const chats = [...chatStore.values()]
      .sort(
        (a, b) =>
          (Number(b.conversationTimestamp) || 0) -
          (Number(a.conversationTimestamp) || 0)
      )
      .slice(0, limit)
      .map((c) => {
        const msgs = messageStore.get(c.id) || [];
        const lastMsg = msgs[msgs.length - 1];
        const isGroup = c.id.endsWith("@g.us");
        return {
          id: c.id,
          name: c.name,
          type: isGroup ? "group" : "dm",
          unread: c.unread || c.unreadCount || 0,
          last_message: lastMsg
            ? {
                date: lastMsg.messageTimestamp
                  ? new Date(Number(lastMsg.messageTimestamp) * 1000).toISOString()
                  : null,
                text: extractText(lastMsg).slice(0, 100),
                sender: lastMsg.key.fromMe
                  ? "me"
                  : lastMsg.pushName || "",
              }
            : null,
        };
      });

    return {
      content: [
        { type: "text", text: JSON.stringify(chats, null, 2) },
      ],
    };
  }
);

// --- whatsapp_messages ---
server.registerTool(
  "whatsapp_messages",
  {
    description: "Read messages from a specific chat.",
    inputSchema: z.object({
      chat: z
        .string()
        .describe(
          "Chat name, phone number (+1234567890), or JID (12345@s.whatsapp.net)"
        ),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Number of messages to fetch (default 20, max 100)"),
    }),
  },
  async ({ chat, limit }) => {
    await connectWhatsApp();
    limit = Math.min(limit || 20, 100);
    const jid = resolveJid(chat);

    // Try in-memory store first
    let msgs = (messageStore.get(jid) || []).slice(-limit);

    // If empty, try fetching from WhatsApp
    if (msgs.length === 0 && sock) {
      const fetched = await sock.fetchMessageHistory(50, null, jid);
      // fetchMessageHistory triggers messaging-history.set event
      // Wait briefly for the event handler to populate the store
      await new Promise((r) => setTimeout(r, 2000));
      msgs = (messageStore.get(jid) || []).slice(-limit);
    }

    const result = msgs.map(formatMessage);
    return {
      content: [
        { type: "text", text: JSON.stringify(result, null, 2) },
      ],
    };
  }
);

// --- whatsapp_search ---
server.registerTool(
  "whatsapp_search",
  {
    description:
      "Search messages by text across all chats or within a specific chat.",
    inputSchema: z.object({
      query: z.string().describe("Search text"),
      chat: z
        .string()
        .default("")
        .describe("Optional — chat name/phone/JID to search within"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(20)
        .describe("Max results (default 20, max 50)"),
    }),
  },
  async ({ query, chat, limit }) => {
    await connectWhatsApp();
    limit = Math.min(limit || 20, 50);
    const lower = query.toLowerCase();

    let searchEntries;
    if (chat) {
      const jid = resolveJid(chat);
      searchEntries = [[jid, messageStore.get(jid) || []]];
    } else {
      searchEntries = [...messageStore.entries()];
    }

    const results = [];
    for (const [jid, msgs] of searchEntries) {
      for (const msg of msgs) {
        if (results.length >= limit) break;
        const text = extractText(msg);
        if (text.toLowerCase().includes(lower)) {
          const entry = formatMessage(msg);
          entry.chat = chatName(jid);
          entry.chat_id = jid;
          results.push(entry);
        }
      }
      if (results.length >= limit) break;
    }

    return {
      content: [
        { type: "text", text: JSON.stringify(results, null, 2) },
      ],
    };
  }
);

// --- whatsapp_send_message ---
server.registerTool(
  "whatsapp_send_message",
  {
    description: "Send a text message to a WhatsApp chat.",
    inputSchema: z.object({
      chat: z.string().describe("Chat name, phone number, or JID"),
      text: z.string().describe("Message text to send"),
      confirm_send: z
        .boolean()
        .default(true)
        .describe(
          "Safety guard. Set True to send, False for dry run. Default True."
        ),
    }),
  },
  async ({ chat, text, confirm_send }) => {
    if (!confirm_send) {
      return {
        content: [
          {
            type: "text",
            text: `DRY RUN — would send to '${chat}':\n${text}`,
          },
        ],
      };
    }

    const s = await connectWhatsApp();
    const jid = resolveJid(chat);
    const sent = await s.sendMessage(jid, { text });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: "sent",
              to: chatName(jid),
              jid,
              message_id: sent?.key?.id,
              timestamp: new Date().toISOString(),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// --- whatsapp_contacts ---
server.registerTool(
  "whatsapp_contacts",
  {
    description: "List WhatsApp contacts.",
    inputSchema: z.object({
      limit: z
        .number()
        .min(1)
        .max(500)
        .default(50)
        .describe("Max contacts to return (default 50, max 500)"),
      search: z
        .string()
        .default("")
        .describe("Optional name filter"),
    }),
  },
  async ({ limit, search }) => {
    await connectWhatsApp();
    limit = Math.min(limit || 50, 500);

    let contacts = [...contactStore.values()];
    if (search) {
      const lower = search.toLowerCase();
      contacts = contacts.filter((c) =>
        c.name?.toLowerCase().includes(lower)
      );
    }

    const result = contacts.slice(0, limit).map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone || c.id.replace("@s.whatsapp.net", ""),
    }));

    return {
      content: [
        { type: "text", text: JSON.stringify(result, null, 2) },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[whatsapp-mcp] MCP server running on stdio");
}

process.on("unhandledRejection", (err) => { console.error("[whatsapp-mcp] Unhandled rejection:", err); process.exit(1); });
process.on("uncaughtException", (err) => { console.error("[whatsapp-mcp] Uncaught exception:", err); process.exit(1); });

main().catch((err) => {
  console.error("[whatsapp-mcp] Fatal:", err);
  process.exit(1);
});
