import {
    PublicClientApplication,
    type DeviceCodeRequest,
    type TokenCacheContext,
} from "@azure/msal-node";
import { spawn } from "child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

// Keyed by identity, so every MCP server signing in as the same app+tenant shares one
// refresh token and a single device-code sign-in covers all of them. An explicit
// OUTLOOK_MCP_CACHE_DIR still wins, for accounts that must stay isolated.
const CACHE_DIR =
  process.env.OUTLOOK_MCP_CACHE_DIR ||
  join(
    homedir(),
    ".mcp-msgraph",
    `${process.env.OUTLOOK_MCP_TENANT_ID || "common"}__${process.env.OUTLOOK_MCP_CLIENT_ID || "unknown"}`
  );
const CACHE_PATH = join(CACHE_DIR, "token-cache.json");
const CACHE_TMP_PATH = `${CACHE_PATH}.tmp`;

const SCOPES = ["Mail.ReadWrite", "Mail.Send", "User.Read"];

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

const LOCK_PATH = join(CACHE_DIR, "auth-lock.json");
const LOCK_TTL_MS = 20 * 60 * 1000; // generous cap; narrowed to the real code's expiresIn once known

interface AuthLock {
  pid: number;
  label: string;
  verificationUri?: string;
  userCode?: string;
  expiresAt: number;
}

async function readLock(): Promise<AuthLock | null> {
  try {
    return JSON.parse(await readFile(LOCK_PATH, "utf-8")) as AuthLock;
  } catch {
    return null;
  }
}

// Atomic create (fails if the file already exists) — the real mutex. teams-chat, outlook,
// and ms-loop all share this CACHE_DIR for the same tenant+client identity, so whichever
// process creates this file first is the only one that opens a browser tab / prints a code.
async function claimLock(label: string): Promise<boolean> {
  try {
    await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
    const lock: AuthLock = { pid: process.pid, label, expiresAt: Date.now() + LOCK_TTL_MS };
    await writeFile(LOCK_PATH, JSON.stringify(lock), { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

async function updateLock(patch: Partial<AuthLock>): Promise<void> {
  const lock = await readLock();
  if (!lock || lock.pid !== process.pid) return; // another process already reclaimed it
  try {
    await writeFile(LOCK_PATH, JSON.stringify({ ...lock, ...patch }), { mode: 0o600 });
  } catch {
    // best-effort — a waiter just keeps polling acquireTokenSilent instead
  }
}

async function releaseLock(): Promise<void> {
  const lock = await readLock();
  if (lock?.pid !== process.pid) return;
  try { await unlink(LOCK_PATH); } catch { /* ignore */ }
}

// Surfaces the code another teams-chat/outlook/ms-loop process already has pending, instead
// of starting (and popping up) a second device-code flow for the same shared account.
function waitOnOtherProcess(pca: PublicClientApplication, lock: AuthLock, label: string): AuthPendingError {
  const tokenPromise = (async (): Promise<string> => {
    while (Date.now() < lock.expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const accounts = await pca.getTokenCache().getAllAccounts();
      if (accounts.length === 0) continue;
      try {
        const result = await pca.acquireTokenSilent({ account: accounts[0], scopes: SCOPES });
        return result.accessToken;
      } catch {
        // that process's sign-in hasn't landed yet — keep polling
      }
    }
    throw new Error("Shared sign-in expired before this process saw a fresh token.");
  })();

  tokenPromise
    .finally(() => {
      if (pendingAuth?.tokenPromise === tokenPromise) pendingAuth = null;
    })
    .catch(() => { /* already surfaced via AuthPendingError.tokenPromise */ });

  return new AuthPendingError(
    `AUTH_REQUIRED: Sign in to ${label} to continue.\n` +
      `${lock.label} already started this sign-in (same shared account) — use ITS popup/notification, ` +
      `don't expect a second one:\n` +
      `1. Open ${lock.verificationUri ?? "(code still being issued — retry this tool in a few seconds)"}\n` +
      `2. Enter code: ${lock.userCode ?? "(pending)"}\n` +
      `Sign-in keeps working in the background — just retry this tool after you finish.`,
    lock.verificationUri ?? "",
    lock.userCode ?? "",
    lock.expiresAt,
    tokenPromise
  );
}

function notifyUser(label: string, userCode: string, verificationUri: string): void {
  if (process.platform !== "darwin") return;
  const body = `Enter code ${userCode} at ${verificationUri}`.replace(/"/g, '\\"');
  const title = `${label} sign-in needed`.replace(/"/g, '\\"');
  try {
    spawn("osascript", ["-e", `display notification "${body}" with title "${title}" sound name "Glass"`], {
      stdio: "ignore",
      detached: true,
    }).unref();
  } catch {
    // best-effort — the printed code/popup still work if this fails
  }
}

async function loadCache(): Promise<string | undefined> {
  try {
    const data = await readFile(CACHE_PATH, "utf-8");
    // Validate before handing to MSAL — a corrupt cache crashes every tool call.
    JSON.parse(data);
    return data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    console.error(`[outlook] Token cache unreadable (${(err as Error).message}) — starting fresh.`);
    try { await unlink(CACHE_PATH); } catch { /* ignore */ }
    return undefined;
  }
}

async function saveCache(cache: string): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
  // Atomic write: full file to .tmp, then rename. Prevents partial/concurrent writes
  // from corrupting the cache (which makes MSAL throw on every subsequent call).
  await writeFile(CACHE_TMP_PATH, cache, { mode: 0o600 });
  await rename(CACHE_TMP_PATH, CACHE_PATH);
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

// Starts (or reuses) a device code sign-in. Resolves as soon as the code is ready to
// show — it does NOT wait for the user to finish signing in. Polling for completion
// continues in the background so a later retry succeeds silently once they do.
async function startOrReusePendingAuth(pca: PublicClientApplication): Promise<AuthPendingError> {
  if (pendingAuth && pendingAuth.expiresAt > Date.now()) {
    return pendingAuth;
  }

  const LABEL = "Outlook MCP";

  // Cross-process check: teams-chat, outlook, and ms-loop share one on-disk identity, so if
  // another of them already has a device code pending, reuse ITS code instead of opening a
  // second browser tab for the exact same sign-in.
  const existingLock = await readLock();
  if (existingLock && existingLock.expiresAt > Date.now() && existingLock.pid !== process.pid) {
    pendingAuth = waitOnOtherProcess(pca, existingLock, LABEL);
    return pendingAuth;
  }
  if (existingLock) await releaseLock(); // ours or expired — clear before reclaiming

  if (!(await claimLock(LABEL))) {
    // Lost the race to another process that claimed it between our read and write.
    const freshLock = await readLock();
    if (freshLock && freshLock.pid !== process.pid) {
      pendingAuth = waitOnOtherProcess(pca, freshLock, LABEL);
      return pendingAuth;
    }
  }

  let settleCodeReady: (v: { verificationUri: string; userCode: string; expiresIn: number }) => void;
  const codeReady = new Promise<{ verificationUri: string; userCode: string; expiresIn: number }>((resolve) => {
    settleCodeReady = resolve;
  });

  const request: DeviceCodeRequest = {
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      console.error(`\n🔐 Outlook MCP — Sign in required:`);
      console.error(response.message);
      console.error();
      tryOpenBrowser(response.verificationUri);
      notifyUser(LABEL, response.userCode, response.verificationUri);
      void updateLock({
        verificationUri: response.verificationUri,
        userCode: response.userCode,
        expiresAt: Date.now() + response.expiresIn * 1000,
      });
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
      console.error(`[outlook] Background sign-in ended without success: ${(err as Error).message}`);
    })
    .finally(() => {
      if (pendingAuth?.tokenPromise === tokenPromise) pendingAuth = null;
      void releaseLock();
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
    `AUTH_REQUIRED: Sign in to Microsoft Outlook to continue.\n` +
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
    } catch (err) {
      const e = err as { errorCode?: string; name?: string; message?: string };
      console.error(
        `[outlook] Silent token refresh failed (${e.errorCode ?? e.name ?? "unknown"}): ${e.message ?? ""}`
      );

      // Only a genuine interaction-required error should cost a device-code sign-in.
      const needsInteraction =
        e.name === "InteractionRequiredAuthError" ||
        ["interaction_required", "consent_required", "login_required"].includes(e.errorCode ?? "") ||
        /AADSTS(50076|50078|50079|50173|53003|70043|700082)/.test(e.message ?? "");

      if (!needsInteraction) {
        try {
          const retry = await pca.acquireTokenSilent({ account: accounts[0], scopes: SCOPES, forceRefresh: true });
          pendingAuth = null;
          return retry.accessToken;
        } catch (retryErr) {
          console.error(`[outlook] Forced refresh also failed: ${(retryErr as Error).message}`);
        }
      }
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

// getAccessToken() deliberately fails fast so MCP tool calls don't block for
// ~15 min waiting on a human. A CLI login is the opposite: it should print the
// code and then actually wait for the sign-in to land.
export async function getAccessTokenInteractive(): Promise<string> {
  try {
    return await getAccessToken();
  } catch (err) {
    if (err instanceof AuthPendingError) {
      console.log(err.message);
      return await err.tokenPromise;
    }
    throw err;
  }
}
