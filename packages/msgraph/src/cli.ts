// Unattended sender for ~/code/brain/scripts/send-queue.py. Same sign-in cache as the msgraph MCP
// server, but silent token only: nobody is at the keyboard at 07:00. The body comes on stdin.
// Prints one JSON line. Exit 0 sent, 3 sign-in needed, 1 anything else.
//
//   cli.js teams --chat ID [--format markdown|html]
//   cli.js mail --to A [--to B] [--cc C] --subject S
//   cli.js reply (--internet-message-id ID | --message-id ID) [--sender-only] [--draft]
//   cli.js mail-info --message-id ID

process.env.MSGRAPH_MCP_CLIENT_ID ||= process.env.TEAMS_MCP_CLIENT_ID;
process.env.MSGRAPH_MCP_TENANT_ID ||= process.env.TEAMS_MCP_TENANT_ID;
process.env.MSGRAPH_MCP_SILENT_ONLY = "1";

const BOOLEAN_FLAGS = new Set(["sender-only", "draft"]);

function out(result: Record<string, unknown>, code: number): never {
  console.log(JSON.stringify(result));
  process.exit(code);
}

function parse(argv: string[]): { cmd: string; opts: Record<string, string[]>; flags: Set<string> } {
  const [cmd = "", ...rest] = argv;
  const opts: Record<string, string[]> = {};
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) out({ ok: false, error: `unexpected argument ${arg}` }, 1);
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags.add(key);
      continue;
    }
    const value = rest[++i];
    if (value === undefined) out({ ok: false, error: `${arg} needs a value` }, 1);
    (opts[key] ??= []).push(value);
  }
  return { cmd, opts, flags };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  const { cmd, opts, flags } = parse(process.argv.slice(2));
  const one = (key: string) => opts[key]?.[0];
  const need = (key: string) => one(key) ?? out({ ok: false, error: `--${key} is required` }, 1);

  // Imported after the env above is set: auth.ts picks its token cache folder at import time.
  const outlook = await import("./outlook-graph.js");

  switch (cmd) {
    case "teams": {
      const teams = await import("./teams-graph.js");
      // "text" used to collapse paragraph breaks in the Teams client — banned here too, not just
      // in the two callers (outbox.py, send-queue.py) that used to be able to request it.
      const format = (one("format") ?? "markdown") as "markdown" | "html";
      if (!(["markdown", "html"] as string[]).includes(format)) out({ ok: false, error: `bad --format ${format}` }, 1);
      const chat = need("chat");
      const body = await readStdin();
      if (!body.trim()) out({ ok: false, error: "empty body" }, 1);
      out({ ok: true, id: await teams.sendMessage(chat, body, format) }, 0);
    }
    case "mail": {
      const to = opts.to ?? out({ ok: false, error: "--to is required" }, 1);
      const subject = need("subject");
      const body = await readStdin();
      if (!body.trim()) out({ ok: false, error: "empty body" }, 1);
      await outlook.sendMail(to, subject, body, opts.cc);
      out({ ok: true }, 0);
    }
    case "reply": {
      const internetId = one("internet-message-id");
      let messageId = one("message-id");
      if (internetId) messageId = await outlook.findMessageId(internetId);
      if (!messageId) out({ ok: false, error: "--internet-message-id or --message-id is required" }, 1);
      const body = await readStdin();
      if (!body.trim()) out({ ok: false, error: "empty body" }, 1);
      const draft = flags.has("draft");
      const sent = await outlook.replyToMessage(messageId, body, !flags.has("sender-only"), draft);
      out({ ok: true, id: sent.id, ...(draft ? { webLink: sent.webLink } : {}) }, 0);
    }
    case "mail-info": {
      out({ ok: true, ...(await outlook.getMessageRef(need("message-id"))) }, 0);
    }
    default:
      out({ ok: false, error: `unknown command '${cmd}' (teams | mail | reply | mail-info)` }, 1);
  }
}

main().catch((err: Error) => {
  const signIn = err.message?.startsWith("SIGN_IN_REQUIRED") || err.name === "AuthPendingError";
  out({ ok: false, error: err.message, signIn }, signIn ? 3 : 1);
});
