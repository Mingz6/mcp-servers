/**
 * Interactive sign-in for the Outlook MCP server.
 *
 * Run: npm run build && npm run login
 *
 * Prints a device code, waits for you to complete sign-in in any browser, then
 * proves the token works by reading the inbox. Must be run on the machine whose
 * token cache the consumer reads — for worker-center that is the Mac Mini, since
 * the container bind-mounts the Mini's ~/.mcp-outlook.
 */
import { getAccessTokenInteractive } from "./auth.js";
import { listInbox } from "./graph.js";

async function main() {
  console.log("Authenticating...");
  await getAccessTokenInteractive();
  console.log("✅ Got access token\n");

  const messages = await listInbox(5);
  console.log(`Inbox reachable — ${messages.length} recent message(s):\n`);
  for (const m of messages) {
    console.log(`  ${m.from || "Unknown"} — ${m.subject || "(no subject)"}`);
  }

  console.log("\n✅ Signed in. Token cache written; the MCP server is ready.");
}

main().catch((err) => {
  console.error("❌ Sign-in failed:", err.message);
  process.exit(1);
});
