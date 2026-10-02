import { createMsGraphAuth, type MsGraphAuth } from "mcp-msgraph-auth";
export { AuthPendingError } from "mcp-msgraph-auth";

// Thin per-service config over the shared auth client (see packages/msgraph-auth —
// factored out 2026-10-01 so the cross-process lock/notify/cache logic that teams-chat,
// outlook, and ms-loop all share identically only needs to be fixed in one place).
const auth: MsGraphAuth = createMsGraphAuth({
  envPrefix: "TEAMS_MCP",
  logPrefix: "teams-chat",
  label: "Teams MCP",
  serviceName: "Microsoft Teams",
  scopes: [
    "Chat.ReadWrite",
    "ChatMessage.Send",
    "User.Read",
    "Calendars.Read",
    "OnlineMeetings.Read",
    "OnlineMeetingTranscript.Read.All",
  ],
  setupHint:
    "Register an Azure AD app and set this env var to its Application (client) ID. See README.md for setup instructions.",
});

export const getAccessToken = auth.getAccessToken;
export const getAccessTokenInteractive = auth.getAccessTokenInteractive;
export const clearTokenCache = auth.clearTokenCache;
