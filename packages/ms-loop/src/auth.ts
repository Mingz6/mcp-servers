import {
    PublicClientApplication,
    type DeviceCodeRequest,
    type TokenCacheContext,
} from "@azure/msal-node";
import { spawn } from "child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const CACHE_DIR = join(homedir(), ".mcp-ms-loop");
const CACHE_PATH = join(CACHE_DIR, "token-cache.json");
const CACHE_TMP_PATH = `${CACHE_PATH}.tmp`;

// Delegated permissions needed for Loop CRUD
const SCOPES = [
  "Files.ReadWrite.All",
  "Sites.ReadWrite.All",
  "User.Read",
];

let msalInstance: PublicClientApplication | null = null;

/** Thrown when sign-in is required. Carries the code/URL to show the user and the in-flight token promise. */
export class AuthPendingError extends Error {
  constructor(
    message: string,
    public readonly verificationUri: string,
    public readonly userCode: string,
    public readonly expiresAt: number,
    public readonly tokenPromise: Promise<string>
  ) {
    super(message);
    this.name = "AuthPendingError";
  }
}

// Tracks an in-flight device code sign-in so rapid/concurrent tool calls surface the
// same pending code instead of requesting a new one on every call.
let pendingAuth: AuthPendingError | null = null;

function tryOpenBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // best-effort only — the printed URL still works if this fails
  }
}

async function loadCache(): Promise<string | undefined> {
  try {
    const data = await readFile(CACHE_PATH, "utf-8");
    JSON.parse(data); // validate
    return data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    console.error(
      `[ms-loop] Token cache unreadable (${(err as Error).message}) — starting fresh.`
    );
    try {
      await unlink(CACHE_PATH);
    } catch {
      /* ignore */
    }
    return undefined;
  }
}

async function saveCache(cache: string): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CACHE_TMP_PATH, cache, { mode: 0o600 });
  await rename(CACHE_TMP_PATH, CACHE_PATH);
}

export async function getMsalInstance(): Promise<PublicClientApplication> {
  if (msalInstance) return msalInstance;

  const clientId = process.env.LOOP_MCP_CLIENT_ID;
  const tenantId = process.env.LOOP_MCP_TENANT_ID || "common";

  if (!clientId) {
    throw new Error(
      "LOOP_MCP_CLIENT_ID is not set. Set it to the Azure AD app registration client ID."
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

// Starts (or reuses) a device code sign-in. Resolves as soon as the code is ready to
// show — it does NOT wait for the user to finish signing in. Polling for completion
// continues in the background so a later retry succeeds silently once they do.
async function startOrReusePendingAuth(pca: PublicClientApplication): Promise<AuthPendingError> {
  if (pendingAuth && pendingAuth.expiresAt > Date.now()) {
    return pendingAuth;
  }

  let settleCodeReady: (v: { verificationUri: string; userCode: string; expiresIn: number }) => void;
  const codeReady = new Promise<{ verificationUri: string; userCode: string; expiresIn: number }>((resolve) => {
    settleCodeReady = resolve;
  });

  const request: DeviceCodeRequest = {
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      console.error(`\n🔐 MS Loop MCP — Sign in required:`);
      console.error(response.message);
      console.error();
      tryOpenBrowser(response.verificationUri);
      settleCodeReady({
        verificationUri: response.verificationUri,
        userCode: response.userCode,
        expiresIn: response.expiresIn,
      });
    },
  };

  const tokenPromise = pca.acquireTokenByDeviceCode(request).then((result) => {
    if (!result) throw new Error("Authentication failed — no token received from device code flow");
    return result.accessToken;
  });

  // Never let the background poll crash the process on expiry/failure — just clear the pending state.
  tokenPromise
    .catch((err) => {
      console.error(`[ms-loop] Background sign-in ended without success: ${(err as Error).message}`);
    })
    .finally(() => {
      if (pendingAuth?.tokenPromise === tokenPromise) pendingAuth = null;
    });

  // Race the code becoming available against the whole flow failing before that happens
  // (e.g. bad client ID) — otherwise a hard failure here would hang forever.
  const outcome = await Promise.race([
    codeReady.then((code) => ({ ok: true as const, code })),
    tokenPromise.then(
      () => ({ ok: false as const, error: new Error("Device code flow ended before a code was issued.") }),
      (error: Error) => ({ ok: false as const, error })
    ),
  ]);

  if (!outcome.ok) throw outcome.error;

  const expiresAt = Date.now() + outcome.code.expiresIn * 1000;
  pendingAuth = new AuthPendingError(
    `AUTH_REQUIRED: Sign in to Microsoft Loop to continue.\n` +
      `1. Open ${outcome.code.verificationUri} (a browser tab was also opened automatically)\n` +
      `2. Enter code: ${outcome.code.userCode}\n` +
      `Expires in ~${Math.max(1, Math.round(outcome.code.expiresIn / 60))} min. ` +
      `Sign-in keeps working in the background — just retry this tool after you finish.`,
    outcome.code.verificationUri,
    outcome.code.userCode,
    expiresAt,
    tokenPromise
  );
  return pendingAuth;
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
      pendingAuth = null; // signed in — clear any stale pending sign-in state
      return result.accessToken;
    } catch {
      // Silent failed — fall through to device code
    }
  }

  // Fail fast with the sign-in code instead of blocking the caller for up to ~15 min.
  throw await startOrReusePendingAuth(pca);
}

export async function clearTokenCache(): Promise<void> {
  try {
    await unlink(CACHE_PATH);
  } catch {
    // Already gone — fine
  }
  msalInstance = null;
  pendingAuth = null;
}
