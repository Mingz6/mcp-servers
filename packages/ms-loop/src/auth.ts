import { createMsGraphAuth, type MsGraphAuth } from "mcp-msgraph-auth";
export { AuthPendingError } from "mcp-msgraph-auth";

// Thin per-service config over the shared auth client (see packages/msgraph-auth —
// factored out 2026-10-01 so the cross-process lock/notify/cache logic that teams-chat,
// outlook, and ms-loop all share identically only needs to be fixed in one place).
const auth: MsGraphAuth = createMsGraphAuth({
  envPrefix: "LOOP_MCP",
  logPrefix: "ms-loop",
  label: "MS Loop MCP",
  serviceName: "Microsoft Loop",
  // Delegated permissions needed for Loop CRUD
  scopes: ["Files.ReadWrite.All", "Sites.ReadWrite.All", "User.Read"],
  setupHint: "Set it to the Azure AD app registration client ID.",
});

export const getAccessToken = auth.getAccessToken;
export const getAccessTokenInteractive = auth.getAccessTokenInteractive;
export const clearTokenCache = auth.clearTokenCache;
