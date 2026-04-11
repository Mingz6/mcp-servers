import Database from "better-sqlite3";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type {
  AccountInfo,
  AttachmentInfo,
  FolderInfo,
  MailSummary,
} from "./types.js";

const MAIL_DIR = join(homedir(), "Library/Mail/V10");
const ENVELOPE_DB = join(MAIL_DIR, "MailData/Envelope Index");
const ACCOUNTS_DB = join(homedir(), "Library/Accounts/Accounts4.sqlite");

let db: InstanceType<typeof Database> | null = null;
let accountCache: AccountInfo[] | null = null;

function getDb(): InstanceType<typeof Database> {
  if (!db) {
    db = new Database(ENVELOPE_DB, { readonly: true, fileMustExist: true });
  }
  return db;
}

// --- Account mapping ---

export function getAccounts(): AccountInfo[] {
  if (accountCache) return accountCache;

  // Get unique account UUIDs from mailbox URLs
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT url FROM mailboxes
       WHERE url LIKE 'imap://%' OR url LIKE 'ews://%'`
    )
    .all() as { url: string }[];

  const uuids = new Set<string>();
  for (const row of rows) {
    const m = row.url.match(/^(?:imap|ews):\/\/([A-F0-9-]+)\//i);
    if (m) uuids.add(m[1]);
  }

  // Map UUIDs to email addresses via macOS Accounts database
  const emailMap = new Map<string, { email: string; description: string }>();

  try {
    const adb = new Database(ACCOUNTS_DB, {
      readonly: true,
      fileMustExist: true,
    });

    const allAccounts = adb
      .prepare(
        `SELECT Z_PK, ZACCOUNTDESCRIPTION, ZUSERNAME, ZIDENTIFIER, ZPARENTACCOUNT
         FROM ZACCOUNT`
      )
      .all() as {
      Z_PK: number;
      ZACCOUNTDESCRIPTION: string | null;
      ZUSERNAME: string | null;
      ZIDENTIFIER: string | null;
      ZPARENTACCOUNT: number | null;
    }[];

    const byPk = new Map(allAccounts.map((a) => [a.Z_PK, a]));

    for (const uuid of uuids) {
      const acct = allAccounts.find((a) => a.ZIDENTIFIER === uuid);
      if (!acct) continue;

      let email = acct.ZUSERNAME || null;
      let description = acct.ZACCOUNTDESCRIPTION || "";

      // Walk parent chain to find email if missing
      if (!email && acct.ZPARENTACCOUNT) {
        let parent = byPk.get(acct.ZPARENTACCOUNT);
        while (parent) {
          if (parent.ZUSERNAME) {
            email = parent.ZUSERNAME;
            if (!description && parent.ZACCOUNTDESCRIPTION) {
              description = parent.ZACCOUNTDESCRIPTION;
            }
            break;
          }
          parent = parent.ZPARENTACCOUNT
            ? byPk.get(parent.ZPARENTACCOUNT)
            : undefined;
        }
      }

      if (email) {
        emailMap.set(uuid, { email, description });
      }
    }

    adb.close();
  } catch {
    // Accounts DB not readable — fall back to UUID-only
  }

  accountCache = [];
  for (const uuid of uuids) {
    const info = emailMap.get(uuid);
    const sampleUrl = rows.find((r) => r.url.includes(uuid))?.url || "";
    accountCache.push({
      uuid,
      email: info?.email || uuid,
      description: info?.description || "",
      protocol: sampleUrl.startsWith("ews://") ? "ews" : "imap",
    });
  }

  return accountCache;
}

export function getAccountEmail(mailboxUrl: string): string {
  const m = mailboxUrl.match(/^(?:imap|ews):\/\/([A-F0-9-]+)\//i);
  if (!m) return "unknown";
  const acct = getAccounts().find((a) => a.uuid === m[1]);
  return acct?.email || m[1];
}

function getFolderName(mailboxUrl: string): string {
  const m = mailboxUrl.match(/^(?:imap|ews):\/\/[^/]+\/(.*)$/);
  if (!m) return "Unknown";
  return decodeURIComponent(m[1]).replace(/%20/g, " ");
}

// --- Mailbox URL to filesystem path ---

export function mailboxUrlToPath(url: string): string {
  const m = url.match(/^(?:imap|ews):\/\/([^/]+)\/(.*)$/);
  if (!m) return "";
  const [, uuid, pathStr] = m;
  const parts = pathStr.split("/").map((p) => decodeURIComponent(p));
  const mboxPath = parts.map((p) => `${p}.mbox`).join("/");
  return join(MAIL_DIR, uuid, mboxPath);
}

// Find inner UUID data directory inside an mbox folder
function findDataDir(mboxDir: string): string | null {
  if (!existsSync(mboxDir)) return null;
  try {
    const entries = readdirSync(mboxDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "." && entry.name !== "..") {
        const messagesDir = join(mboxDir, entry.name, "Data", "Messages");
        if (existsSync(messagesDir)) {
          return join(mboxDir, entry.name, "Data");
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- .emlx file lookup ---

export function findEmlxPath(
  messageRowId: number,
  mailboxRowId: number
): string | null {
  const row = getDb()
    .prepare("SELECT url FROM mailboxes WHERE ROWID = ?")
    .get(mailboxRowId) as { url: string } | undefined;
  if (!row) return null;

  const mboxDir = mailboxUrlToPath(row.url);
  const dataDir = findDataDir(mboxDir);
  if (!dataDir) return null;

  const messagesDir = join(dataDir, "Messages");
  const fullPath = join(messagesDir, `${messageRowId}.emlx`);
  if (existsSync(fullPath)) return fullPath;

  const partialPath = join(messagesDir, `${messageRowId}.partial.emlx`);
  if (existsSync(partialPath)) return partialPath;

  return null;
}

// --- Attachment file lookup ---

export function findAttachmentFiles(
  messageRowId: number,
  mailboxRowId: number
): string[] {
  const row = getDb()
    .prepare("SELECT url FROM mailboxes WHERE ROWID = ?")
    .get(mailboxRowId) as { url: string } | undefined;
  if (!row) return [];

  const mboxDir = mailboxUrlToPath(row.url);
  const dataDir = findDataDir(mboxDir);
  if (!dataDir) return [];

  const attachDir = join(dataDir, "Attachments", String(messageRowId));
  if (!existsSync(attachDir)) return [];

  const paths: string[] = [];
  collectFiles(attachDir, paths);
  return paths;
}

function collectFiles(dir: string, result: string[]): void {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isFile() && !entry.name.startsWith(".")) {
        result.push(fullPath);
      } else if (entry.isDirectory()) {
        collectFiles(fullPath, result);
      }
    }
  } catch {
    // ignore
  }
}

// --- Query functions ---

function resolveAccountFilter(
  account: string | undefined
): string | undefined {
  if (!account) return undefined;
  const acct = getAccounts().find(
    (a) => a.email.toLowerCase() === account.toLowerCase()
  );
  return acct?.uuid;
}

export function listMessages(options: {
  account?: string;
  folder?: string;
  unreadOnly?: boolean;
  count?: number;
}): MailSummary[] {
  const { account, folder, unreadOnly = false, count = 15 } = options;

  const conditions = ["m.deleted = 0"];
  const params: unknown[] = [];

  if (unreadOnly) {
    conditions.push("m.read = 0");
  }

  const uuid = resolveAccountFilter(account);
  if (uuid) {
    conditions.push("mb.url LIKE ?");
    params.push(`%${uuid}%`);
  }

  if (folder) {
    conditions.push("mb.url LIKE ?");
    params.push(`%${folder.replace(/ /g, "%20")}%`);
  }

  const sql = `
    SELECT m.ROWID AS id, s.subject, a.address AS sender_email, a.comment AS sender_name,
           m.date_received, m.read, m.flagged, mb.url AS mailbox_url,
           (SELECT COUNT(*) FROM attachments att WHERE att.message = m.ROWID) AS attachment_count
    FROM messages m
    JOIN subjects s ON s.ROWID = m.subject
    JOIN addresses a ON a.ROWID = m.sender
    JOIN mailboxes mb ON mb.ROWID = m.mailbox
    WHERE ${conditions.join(" AND ")}
    ORDER BY m.date_received DESC
    LIMIT ?
  `;
  params.push(count);

  const rows = getDb()
    .prepare(sql)
    .all(...params) as Array<{
    id: number;
    subject: string;
    sender_email: string;
    sender_name: string;
    date_received: number;
    read: number;
    flagged: number;
    mailbox_url: string;
    attachment_count: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    senderEmail: r.sender_email,
    senderName: r.sender_name,
    receivedAt: new Date(r.date_received * 1000).toISOString(),
    isRead: r.read === 1,
    isFlagged: r.flagged === 1,
    hasAttachments: r.attachment_count > 0,
    account: getAccountEmail(r.mailbox_url),
    folder: getFolderName(r.mailbox_url),
  }));
}

export function searchMessages(query: string, count = 10): MailSummary[] {
  const likeQuery = `%${query}%`;

  const sql = `
    SELECT m.ROWID AS id, s.subject, a.address AS sender_email, a.comment AS sender_name,
           m.date_received, m.read, m.flagged, mb.url AS mailbox_url,
           (SELECT COUNT(*) FROM attachments att WHERE att.message = m.ROWID) AS attachment_count
    FROM messages m
    JOIN subjects s ON s.ROWID = m.subject
    JOIN addresses a ON a.ROWID = m.sender
    JOIN mailboxes mb ON mb.ROWID = m.mailbox
    WHERE m.deleted = 0
    AND (s.subject LIKE ? ESCAPE '\\' OR a.address LIKE ? ESCAPE '\\' OR a.comment LIKE ? ESCAPE '\\')
    ORDER BY m.date_received DESC
    LIMIT ?
  `;

  const rows = getDb()
    .prepare(sql)
    .all(likeQuery, likeQuery, likeQuery, count) as Array<{
    id: number;
    subject: string;
    sender_email: string;
    sender_name: string;
    date_received: number;
    read: number;
    flagged: number;
    mailbox_url: string;
    attachment_count: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    senderEmail: r.sender_email,
    senderName: r.sender_name,
    receivedAt: new Date(r.date_received * 1000).toISOString(),
    isRead: r.read === 1,
    isFlagged: r.flagged === 1,
    hasAttachments: r.attachment_count > 0,
    account: getAccountEmail(r.mailbox_url),
    folder: getFolderName(r.mailbox_url),
  }));
}

export function getMessageMeta(
  messageId: number
): { mailbox: number } | null {
  const row = getDb()
    .prepare("SELECT mailbox FROM messages WHERE ROWID = ?")
    .get(messageId) as { mailbox: number } | undefined;
  return row ? { mailbox: row.mailbox } : null;
}

export function getMessageById(messageId: number): MailSummary | null {
  const sql = `
    SELECT m.ROWID AS id, s.subject, a.address AS sender_email, a.comment AS sender_name,
           m.date_received, m.read, m.flagged, mb.url AS mailbox_url,
           (SELECT COUNT(*) FROM attachments att WHERE att.message = m.ROWID) AS attachment_count
    FROM messages m
    JOIN subjects s ON s.ROWID = m.subject
    JOIN addresses a ON a.ROWID = m.sender
    JOIN mailboxes mb ON mb.ROWID = m.mailbox
    WHERE m.ROWID = ?
  `;
  const r = getDb().prepare(sql).get(messageId) as {
    id: number;
    subject: string;
    sender_email: string;
    sender_name: string;
    date_received: number;
    read: number;
    flagged: number;
    mailbox_url: string;
    attachment_count: number;
  } | undefined;
  if (!r) return null;

  return {
    id: r.id,
    subject: r.subject,
    senderEmail: r.sender_email,
    senderName: r.sender_name,
    receivedAt: new Date(r.date_received * 1000).toISOString(),
    isRead: r.read === 1,
    isFlagged: r.flagged === 1,
    hasAttachments: r.attachment_count > 0,
    account: getAccountEmail(r.mailbox_url),
    folder: getFolderName(r.mailbox_url),
  };
}

export function getRecipients(
  messageId: number
): { to: string[]; cc: string[] } {
  const rows = getDb()
    .prepare(
      `SELECT a.address, a.comment, r.type
       FROM recipients r
       JOIN addresses a ON a.ROWID = r.address
       WHERE r.message = ?
       ORDER BY r.position`
    )
    .all(messageId) as { address: string; comment: string; type: number }[];

  const to: string[] = [];
  const cc: string[] = [];

  for (const r of rows) {
    const addr = r.comment ? `${r.comment} <${r.address}>` : r.address;
    if (r.type === 0) to.push(addr);
    else if (r.type === 1) cc.push(addr);
  }

  return { to, cc };
}

export function getAttachments(messageId: number): AttachmentInfo[] {
  const meta = getMessageMeta(messageId);
  if (!meta) return [];

  const dbAttachments = getDb()
    .prepare(
      `SELECT ROWID AS id, message, name FROM attachments WHERE message = ?`
    )
    .all(messageId) as { id: number; message: number; name: string }[];

  const filePaths = findAttachmentFiles(messageId, meta.mailbox);

  return dbAttachments.map((att) => {
    const matchPath =
      filePaths.find((p) => p.endsWith(`/${att.name}`)) || null;
    return {
      id: att.id,
      messageId: att.message,
      name: att.name,
      path: matchPath,
    };
  });
}

export function listFolders(account?: string): FolderInfo[] {
  let sql = `SELECT url, total_count, unread_count FROM mailboxes
             WHERE (url LIKE 'imap://%' OR url LIKE 'ews://%')`;
  const params: unknown[] = [];

  const uuid = resolveAccountFilter(account);
  if (uuid) {
    sql += " AND url LIKE ?";
    params.push(`%${uuid}%`);
  }

  sql += " ORDER BY total_count DESC";

  const rows = getDb()
    .prepare(sql)
    .all(...params) as {
    url: string;
    total_count: number;
    unread_count: number;
  }[];

  return rows.map((r) => ({
    account: getAccountEmail(r.url),
    folder: getFolderName(r.url),
    totalCount: r.total_count,
    unreadCount: r.unread_count,
  }));
}
