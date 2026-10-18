// Unattended sender for the personal mailbox, used by ~/code/brain/outbox/outbox.py when Ming presses
// Send now or a scheduled send comes due. Silent token only. The body comes on stdin; prints one JSON line.
// Exit 0 sent, 3 sign-in needed, 1 anything else.
//
//   cli.js mail --to A [--to B] [--cc C] --subject S
//   cli.js reply --message-id ID [--sender-only]
//   cli.js whoami

process.env.OUTLOOK_MCP_SILENT_ONLY = "1";

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
    if (key === "sender-only") {
      flags.add(key);
      continue;
    }
    const value = rest[++i];
    if (value === undefined) out({ ok: false, error: `${arg} needs a value` }, 1);
    (opts[key] ??= []).push(value);
  }
  return { cmd, opts, flags };
}

async function readBody(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf-8");
  if (!body.trim()) out({ ok: false, error: "empty body" }, 1);
  return body;
}

async function main(): Promise<void> {
  const { cmd, opts, flags } = parse(process.argv.slice(2));
  const need = (key: string) => opts[key]?.[0] ?? out({ ok: false, error: `--${key} is required` }, 1);
  // Imported after the env above is set: auth.ts reads it when it loads.
  const graph = await import("./graph.js");

  switch (cmd) {
    case "mail": {
      const to = opts.to ?? out({ ok: false, error: "--to is required" }, 1);
      const subject = need("subject");
      await graph.sendMail(to, subject, await readBody(), opts.cc);
      out({ ok: true }, 0);
    }
    case "reply": {
      const messageId = need("message-id");
      const sent = await graph.replyToMessage(messageId, await readBody(), !flags.has("sender-only"), false);
      out({ ok: true, id: sent.id }, 0);
    }
    case "whoami":
      out({ ok: true, ...(await graph.whoAmI()) }, 0);
    default:
      out({ ok: false, error: `unknown command '${cmd}' (mail | reply | whoami)` }, 1);
  }
}

main().catch((err: Error) => {
  const signIn = err.message?.startsWith("SIGN_IN_REQUIRED") || err.name === "AuthPendingError";
  out({ ok: false, error: err.message, signIn }, signIn ? 3 : 1);
});
