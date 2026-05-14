#!/usr/bin/env node
/**
 * Interactive WhatsApp login — shows QR code in terminal.
 * Run once: node login.mjs
 * After scanning, auth state is saved to ~/.whatsapp-mcp/auth/ and reused by mcp_server.mjs.
 */

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
import qrcode from "qrcode-terminal";

const AUTH_DIR = path.join(os.homedir(), ".whatsapp-mcp", "auth");
const CACHE_FILE = path.join(os.homedir(), ".whatsapp-mcp", "chat-cache.json");
const logger = P({ level: "warn" });

fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });

async function login() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`Using WA version: ${version.join(".")}`);
  console.log("Waiting for QR code...\n");

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    markOnlineOnConnect: false,
    syncFullHistory: true,
    shouldSyncHistoryMessage: () => true,
  });

  let intentionalClose = false;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\n📱 Scan this QR code with WhatsApp > Linked Devices > Link a Device\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("\n✅ Logged in! Auth saved to:", AUTH_DIR);
      console.log("Waiting a few seconds for initial sync...\n");
      // Give history sync 15s then exit — data comes through the MCP server later
      setTimeout(() => {
        intentionalClose = true;
        console.log("✅ Done. You can now restart the MCP server.\n");
        sock.end();
        process.exit(0);
      }, 15000);
    }
    if (connection === "close") {
      if (intentionalClose) return;
      const code = (lastDisconnect?.error)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error("Logged out. Delete", AUTH_DIR, "and try again.");
        process.exit(1);
      }
      // Retry
      console.log("Reconnecting...");
      login();
    }
  });

  // Log history sync events if they happen during login
  const chatStore = new Map();
  const contactStore = new Map();
  sock.ev.on("messaging-history.set", ({ chats, contacts, messages, isLatest }) => {
    console.log(`[sync] ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (isLatest=${isLatest})`);
    for (const c of chats) chatStore.set(c.id, { id: c.id, name: c.name || c.id, unread: c.unreadCount || 0, conversationTimestamp: c.conversationTimestamp });
    for (const c of contacts) contactStore.set(c.id, { id: c.id, name: c.name || c.notify || c.verifiedName || c.id, phone: c.id.replace("@s.whatsapp.net", "") });
    // Save cache for the MCP server
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), chats: [...chatStore.values()], contacts: [...contactStore.values()] }), { mode: 0o600 });
      console.log(`[cache] saved ${chatStore.size} chats, ${contactStore.size} contacts`);
    } catch (e) {
      console.error("[cache] save error:", e.message);
    }
  });
}

login().catch((err) => {
  console.error("Login failed:", err);
  process.exit(1);
});
