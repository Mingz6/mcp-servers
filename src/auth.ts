import {
    PublicClientApplication,
    type DeviceCodeRequest,
    type TokenCacheContext,
} from "@azure/msal-node";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const CACHE_DIR = join(homedir(), ".mcp-teams-chat");
const CACHE_PATH = join(CACHE_DIR, "token-cache.json");

const SCOPES = ["Chat.Read", "User.Read"];

let msalInstance: PublicClientApplication | null = null;

async function loadCache(): Promise<string | undefined> {
  try {
    return await readFile(CACHE_PATH, "utf-8");
  } catch {
    return undefined;
  }
}

async function saveCache(cache: string): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CACHE_PATH, cache, { mode: 0o600 });
}

export async function getMsalInstance(): Promise<PublicClientApplication> {
  if (msalInstance) return msalInstance;

  const clientId = process.env.TEAMS_MCP_CLIENT_ID;
  const tenantId = process.env.TEAMS_MCP_TENANT_ID || "common";

  if (!clientId) {
    throw new Error(
      "TEAMS_MCP_CLIENT_ID is not set. " +
        "Register an Azure AD app and set this env var to its Application (client) ID. " +
        "See README.md for setup instructions."
    );
  }

  const cachePlugin = {
    beforeCacheAccess: async (ctx: TokenCacheContext) => {
      const data = await loadCache();
      if (data) ctx.tokenCache.deserialize(data);
    },
    afterCacheAccess: async (ctx: TokenCacheContext) => {
      if (ctx.cacheHasChanged) {
        await saveCache(ctx.tokenCache.serialize());
      }
    },
  };

  msalInstance = new PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
    cache: { cachePlugin },
  });

  return msalInstance;
}

export async function getAccessToken(): Promise<string> {
  const pca = await getMsalInstance();

  // Try silent acquisition first (cached/refreshed token)
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    try {
      const result = await pca.acquireTokenSilent({
        account: accounts[0],
        scopes: SCOPES,
      });
      return result.accessToken;
    } catch {
      // Silent failed — fall through to device code
    }
  }

  // Device code flow — prints a URL + code to stderr for the user
  const request: DeviceCodeRequest = {
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      console.error(`\n🔐 Teams MCP — Sign in required:`);
      console.error(response.message);
      console.error();
    },
  };

  const result = await pca.acquireTokenByDeviceCode(request);
  if (!result) {
    throw new Error("Authentication failed — no token received from device code flow");
  }

  return result.accessToken;
}

export async function clearTokenCache(): Promise<void> {
  try {
    await unlink(CACHE_PATH);
  } catch {
    // Already gone — fine
  }
  msalInstance = null;
}
