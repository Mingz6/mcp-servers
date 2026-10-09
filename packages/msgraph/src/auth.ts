import { createMsGraphAuth, type MsGraphAuth } from "mcp-msgraph-auth";
export { AuthPendingError } from "mcp-msgraph-auth";

// Unified auth for the merged msgraph server (teams_* + outlook_* + loop_* tools in one
// process). Union of the scopes teams-chat, outlook, and ms-loop each requested separately —
// safe to request as one token set since all three use the SAME CRNA app registration/tenant
// and already shared one on-disk token cache even as 3 separate processes (see
// /memories/mcp-loop-auth.md). envPrefix "MSGRAPH_MCP" is new; mcp.json must set
// MSGRAPH_MCP_CLIENT_ID / MSGRAPH_MCP_TENANT_ID (same values as the old TEAMS_MCP_*/
// OUTLOOK_MCP_*/LOOP_MCP_* vars) for this server's entry.
const auth: MsGraphAuth = createMsGraphAuth({
  envPrefix: "MSGRAPH_MCP",
  logPrefix: "msgraph",
  label: "MS Graph MCP",
  serviceName: "Microsoft Graph (Teams/Outlook/Loop)",
  scopes: [
    "Chat.ReadWrite",
    "ChatMessage.Send",
    "Calendars.Read",
    "OnlineMeetings.Read",
    "OnlineMeetingTranscript.Read.All",
    "OnlineMeetingAiInsight.Read.All",
    "CallTranscripts.Read.All",
    "Mail.ReadWrite",
    "Mail.Send",
    "Files.ReadWrite.All",
    "Sites.ReadWrite.All",
    "User.Read",
  ],
  setupHint: "Use the same Azure AD app registration as the old teams-chat/outlook/ms-loop servers. See README.md.",
});

export const getAccessToken = auth.getAccessToken;
export const getAccessTokenInteractive = auth.getAccessTokenInteractive;
export const clearTokenCache = auth.clearTokenCache;
