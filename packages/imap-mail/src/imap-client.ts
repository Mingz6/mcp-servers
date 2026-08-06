import { ImapFlow, type FetchMessageObject, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";

// imapflow's AuthenticationFailure class exists internally (lib/tools.js) but is NOT
// re-exported from the package's main entry — confirmed via `node -e "import('imapflow').then(m=>console.log(Object.keys(m)))"`
// (only ImapFlow/default/module.exports). Duck-type on the properties it sets instead
// of importing/instanceof-checking a class that doesn't actually exist at that path.
function isAuthFailure(err: unknown): err is Error & { authenticationFailed: true; response?: string; serverResponseCode?: string } {
  return err instanceof Error && (err as any).authenticationFailed === true;
}

export interface MailSummary {
  uid: number;
  subject: string;
  from: string;
  receivedAt: string;
  isRead: boolean;
  hasAttachments: boolean;
  preview: string;
}

export interface MailFull {
  uid: number;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  receivedAt: string;
  isRead: boolean;
  hasAttachments: boolean;
  body: string;
}

export interface MailAttachment {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
}

function readConfig() {
  const host = process.env.IMAP_MCP_HOST;
  const user = process.env.IMAP_MCP_USER;
  const password = process.env.IMAP_MCP_PASSWORD;
  const label = process.env.IMAP_MCP_LABEL || host || "IMAP account";
  const port = Number(process.env.IMAP_MCP_PORT || 993);

  const missing = [
    !host && "IMAP_MCP_HOST",
    !user && "IMAP_MCP_USER",
    !password && "IMAP_MCP_PASSWORD",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `Missing env var(s): ${missing.join(", ")}. Set these in the mcp.json entry for this server ` +
        `(see packages/imap-mail/README.md for how to get an app password per provider).`
    );
  }

  return { host: host!, port, user: user!, password: password!, label };
}

async function withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const { host, port, user, password, label } = readConfig();
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass: password },
    logger: false,
  });

  try {
    await client.connect();
  } catch (err) {
    if (isAuthFailure(err)) {
      throw new Error(
        `Could not sign in to ${label} (${user}) via IMAP — server said: "${err.response || err.message}"` +
          (err.serverResponseCode ? ` [${err.serverResponseCode}]` : "") +
          `. Check IMAP_MCP_PASSWORD is a current app password/authorization code (no extra spaces), and that ` +
          `IMAP access is actually enabled in the account's mail settings — see README.md.`
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not connect to ${label} (${user}) via IMAP: ${message}. ` +
        `Check IMAP_MCP_HOST/IMAP_MCP_PORT are correct and the network allows the connection.`
    );
  }

  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      // best-effort — connection may already be closed
    }
  }
}

function summarize(msg: FetchMessageObject): MailSummary {
  const envelope = msg.envelope;
  const fromAddr = envelope?.from?.[0];
  const from = fromAddr ? `${fromAddr.name ? `${fromAddr.name} ` : ""}<${fromAddr.address}>` : "Unknown";
  const bodyText = msg.bodyStructure ? "" : "";
  const rawDate = envelope?.date || msg.internalDate;
  const date = rawDate ? new Date(rawDate) : new Date();

  return {
    uid: msg.uid,
    subject: envelope?.subject || "(no subject)",
    from,
    receivedAt: date.toISOString(),
    isRead: msg.flags ? msg.flags.has("\\Seen") : false,
    hasAttachments: !!msg.bodyStructure && hasAttachmentPart(msg.bodyStructure),
    preview: bodyText.slice(0, 150),
  };
}

// bodyStructure is a nested tree; a part counts as an attachment if it has a
// filename or an explicit "attachment" disposition.
function hasAttachmentPart(part: any): boolean {
  if (!part) return false;
  if (part.disposition === "attachment" || part.dispositionParameters?.filename || part.parameters?.name) {
    if (part.disposition === "attachment" || part.dispositionParameters?.filename) return true;
  }
  const children = part.childNodes as any[] | undefined;
  if (children) {
    return children.some(hasAttachmentPart);
  }
  return false;
}

export async function listInbox(count: number, unreadOnly: boolean): Promise<MailSummary[]> {
  return withClient(async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const total = client.mailbox && typeof client.mailbox !== "boolean" ? client.mailbox.exists : 0;
      if (total === 0) return [];

      const searchCriteria: SearchObject = unreadOnly ? { seen: false } : { all: true };
      const uids = await client.search(searchCriteria, { uid: true });
      if (!uids || uids.length === 0) return [];

      const recentUids = uids.slice(-count).reverse();
      const results: MailSummary[] = [];
      for await (const msg of client.fetch(recentUids, { envelope: true, flags: true, bodyStructure: true, uid: true }, { uid: true })) {
        results.push(summarize(msg));
      }
      return results;
    } finally {
      lock.release();
    }
  });
}

export async function searchMail(query: string, count: number): Promise<MailSummary[]> {
  return withClient(async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search(
        { or: [{ subject: query }, { from: query }, { body: query }] },
        { uid: true }
      );
      if (!uids || uids.length === 0) return [];

      const recentUids = uids.slice(-count).reverse();
      const results: MailSummary[] = [];
      for await (const msg of client.fetch(recentUids, { envelope: true, flags: true, bodyStructure: true, uid: true }, { uid: true })) {
        results.push(summarize(msg));
      }
      return results;
    } finally {
      lock.release();
    }
  });
}

export async function readMessage(uid: number): Promise<MailFull> {
  return withClient(async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const msg = await client.fetchOne(String(uid), { envelope: true, flags: true, bodyStructure: true, source: true }, { uid: true });
      if (!msg || !msg.source) {
        throw new Error(`Message with UID ${uid} not found.`);
      }

      const parsed = await simpleParser(msg.source);
      const body = parsed.text || (parsed.html ? parsed.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "(empty body)");

      const toList = Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [];
      const ccList = Array.isArray(parsed.cc) ? parsed.cc : parsed.cc ? [parsed.cc] : [];

      return {
        uid,
        subject: parsed.subject || "(no subject)",
        from: parsed.from?.text || "Unknown",
        to: toList.map((a) => a.text),
        cc: ccList.map((a) => a.text),
        receivedAt: (parsed.date || new Date()).toISOString(),
        isRead: msg.flags ? msg.flags.has("\\Seen") : false,
        hasAttachments: (parsed.attachments || []).length > 0,
        body,
      };
    } finally {
      lock.release();
    }
  });
}

export async function listAttachments(uid: number): Promise<Omit<MailAttachment, "content">[]> {
  return withClient(async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) {
        throw new Error(`Message with UID ${uid} not found.`);
      }
      const parsed = await simpleParser(msg.source);
      return (parsed.attachments || []).map((a, i) => ({
        index: i,
        filename: a.filename || `attachment-${i}`,
        contentType: a.contentType,
        size: a.size,
      }));
    } finally {
      lock.release();
    }
  });
}

export async function downloadAttachment(uid: number, index: number): Promise<MailAttachment> {
  return withClient(async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) {
        throw new Error(`Message with UID ${uid} not found.`);
      }
      const parsed = await simpleParser(msg.source);
      const attachment = (parsed.attachments || [])[index];
      if (!attachment) {
        throw new Error(`No attachment at index ${index}. Use imap_attachments first to list valid indices.`);
      }
      return {
        index,
        filename: attachment.filename || `attachment-${index}`,
        contentType: attachment.contentType,
        size: attachment.size,
        content: attachment.content as Buffer,
      };
    } finally {
      lock.release();
    }
  });
}

export async function markAsRead(uids: number[]): Promise<number> {
  return withClient(async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
      return uids.length;
    } finally {
      lock.release();
    }
  });
}

export function accountLabel(): string {
  return process.env.IMAP_MCP_LABEL || process.env.IMAP_MCP_HOST || "IMAP account";
}
