import {
    PublicClientApplication,
    type DeviceCodeRequest,
    type TokenCacheContext,
} from "@azure/msal-node";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const CACHE_DIR = join(homedir(), ".mcp-outlook");
const CACHE_PATH = join(CACHE_DIR, "token-cache.json");

const SCOPES = ["Mail.Read", "User.Read"];

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

  const clientId = process.env.OUTLOOK_MCP_CLIENT_ID;
  const tenantId = process.env.OUTLOOK_MCP_TENANT_ID || "common";

  if (!clientId) {
    throw new Error(
      "OUTLOOK_MCP_CLIENT_ID is not set. " +
        "Use the same Azure AD app registration as teams-chat, " +
        "but add Mail.Read to API permissions. See README.md."
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

  const request: DeviceCodeRequest = {
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      console.error(`\n🔐 Outlook MCP — Sign in required:`);
      console.error(response.message);
      console.error();
    },
  };

  const result = await pca.acquireTokenByDeviceCode(request);
  if (!result) {
    throw new Error(
      "Authentication failed — no token received from device code flow"
    );
  }

  return result.accessToken;
}
