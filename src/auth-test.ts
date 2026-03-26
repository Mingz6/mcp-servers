/**
 * Quick test: authenticates and lists your 5 most recent chats.
 * Run: npm run build && npm run auth-test
 */
import { getAccessToken } from "./auth.js";
import { getMyProfile, listChats } from "./graph.js";

async function main() {
  console.log("Authenticating...");
  const token = await getAccessToken();
  console.log("✅ Got access token\n");

  const profile = await getMyProfile();
  console.log(`Signed in as: ${profile.displayName} (${profile.mail})\n`);

  console.log("Fetching 5 most recent chats...\n");
  const chats = await listChats(5);

  for (const chat of chats) {
    const members = chat.members.join(", ");
    const topic = chat.topic ? ` — "${chat.topic}"` : "";
    console.log(`[${chat.chatType}] ${members}${topic}`);
    if (chat.lastMessage) console.log(`  Last: ${chat.lastMessage}`);
    console.log();
  }

  console.log("✅ Auth test passed — MCP server is ready to use.");
}

main().catch((err) => {
  console.error("❌ Auth test failed:", err.message);
  process.exit(1);
});
