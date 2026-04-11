import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface SendMailOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  from?: string;
  attachments?: string[];
}

function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function sendMail(options: SendMailOptions): void {
  const {
    to,
    cc = [],
    bcc = [],
    subject,
    body,
    from,
    attachments = [],
  } = options;

  if (to.length === 0) throw new Error("At least one recipient is required");

  let script = "tell application \"Mail\"\n";
  script += `  set newMessage to make new outgoing message with properties {subject:"${escapeAppleScript(subject)}", content:"${escapeAppleScript(body)}", visible:false}\n`;
  script += "  tell newMessage\n";

  if (from) {
    script += `    set sender to "${escapeAppleScript(from)}"\n`;
  }

  for (const addr of to) {
    script += `    make new to recipient at end of to recipients with properties {address:"${escapeAppleScript(addr)}"}\n`;
  }
  for (const addr of cc) {
    script += `    make new cc recipient at end of cc recipients with properties {address:"${escapeAppleScript(addr)}"}\n`;
  }
  for (const addr of bcc) {
    script += `    make new bcc recipient at end of bcc recipients with properties {address:"${escapeAppleScript(addr)}"}\n`;
  }
  for (const filePath of attachments) {
    script += `    make new attachment with properties {file name:POSIX file "${escapeAppleScript(filePath)}"} at after the last paragraph\n`;
  }

  script += "  end tell\n";
  script += "  send newMessage\n";
  script += "end tell\n";

  const tmpFile = join(tmpdir(), `applemail-send-${Date.now()}.scpt`);
  try {
    writeFileSync(tmpFile, script, "utf-8");
    execSync(`osascript "${tmpFile}"`, {
      timeout: 30000,
      encoding: "utf-8",
    });
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // cleanup failure is fine
    }
  }
}
