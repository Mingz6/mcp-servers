import { createMsGraphAuth, type MsGraphAuth } from "mcp-msgraph-auth";
export { AuthPendingError } from "mcp-msgraph-auth";

// Thin per-service config over the shared auth client (see packages/msgraph-auth —
// factored out 2026-10-01 so the cross-process lock/notify/cache logic that teams-chat,
// outlook, and ms-loop all share identically only needs to be fixed in one place).
const auth: MsGraphAuth = createMsGraphAuth({
  envPrefix: "OUTLOOK_MCP",
  logPrefix: "outlook",
  label: "Outlook MCP",
  serviceName: "Microsoft Outlook",
  scopes: ["Mail.ReadWrite", "Mail.Send", "User.Read"],
  setupHint: "Use the same Azure AD app registration as teams-chat, but add Mail.Read to API permissions. See README.md.",
});

export const getAccessToken = auth.getAccessToken;
export const getAccessTokenInteractive = auth.getAccessTokenInteractive;
export const clearTokenCache = auth.clearTokenCache;
