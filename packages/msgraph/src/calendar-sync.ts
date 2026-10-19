// One-way copy of the work calendar (Graph /me/calendarView) into a local "CRNA" calendar in
// macOS Calendar, for a Mac that can't add the Exchange account. launchd runs it every 15 min
// through calendar-sync.sh. Copies subject, times, all-day and location only: no body, no
// attendees. Each copy's notes hold a [crna:key:fingerprint] tag, which is how the next run
// finds what changed. Silent token only: an expired sign-in logs one line and exits 0.
//
// It never creates the calendar: Calendar's "make new calendar" picks the store itself, and a
// copy landing in iCloud would put work data on Apple's servers. Make it once by hand (On My Mac).
//
//   calendar-sync.js            sync
//   calendar-sync.js --dry-run  print what would change, touch nothing

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { CalendarSlot } from "./teams-graph.js";

process.env.MSGRAPH_MCP_CLIENT_ID ||= process.env.TEAMS_MCP_CLIENT_ID;
process.env.MSGRAPH_MCP_TENANT_ID ||= process.env.TEAMS_MCP_TENANT_ID;
process.env.MSGRAPH_MCP_SILENT_ONLY = "1";

const CALENDAR = "CRNA";
const DAYS_BACK = 7;
const DAYS_AHEAD = 60;
const DAY_MS = 86_400_000;
const TAG = /\[crna:[0-9a-f]{16}:[0-9a-f]{10}\]/g;

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

export function tagFor(slot: CalendarSlot): string {
  const fingerprint = [slot.subject, slot.start, slot.end, slot.isAllDay, slot.location].join("\u0001");
  return `[crna:${sha1(slot.id).slice(0, 16)}:${sha1(fingerprint).slice(0, 10)}]`;
}

export interface Plan {
  create: CalendarSlot[];
  remove: string[];
  unchanged: number;
}

// localNotes: the notes of every event in the CRNA calendar, joined. Events without a tag
// (added by hand) are left alone. A tag seen twice is removed and written again once.
export function plan(remote: CalendarSlot[], localNotes: string): Plan {
  const wanted = new Map(remote.map((s) => [tagFor(s), s]));
  const have = new Map<string, number>();
  for (const [tag] of localNotes.matchAll(TAG)) have.set(tag, (have.get(tag) ?? 0) + 1);

  const remove = [...have].filter(([tag, n]) => !wanted.has(tag) || n > 1).map(([tag]) => tag);
  const create = [...wanted].filter(([tag]) => have.get(tag) !== 1).map(([, slot]) => slot);
  return { create, remove, unchanged: wanted.size - create.length };
}

export function asText(s: string): string {
  const clean = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").slice(0, 400);
  return `"${clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function utcToLocalArgs(graphUtc: string): string {
  const d = new Date(`${graphUtc.slice(0, 19)}Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`bad Graph time ${graphUtc}`);
  return `${d.getFullYear()}, ${d.getMonth() + 1}, ${d.getDate()}, ${d.getHours()}, ${d.getMinutes()}`;
}

export function eventProps(slot: CalendarSlot): string {
  let start: string;
  let end: string;
  if (slot.isAllDay) {
    // All-day events float: take the date as written, not converted to this Mac's zone.
    const [y, m, d] = slot.start.slice(0, 10).split("-").map(Number);
    const days = Math.max(1, Math.round((Date.parse(slot.end.slice(0, 10)) - Date.parse(slot.start.slice(0, 10))) / DAY_MS));
    start = `my mk(${y}, ${m}, ${d}, 0, 0)`;
    end = `(${start}) + ${days} * days`;
  } else {
    start = `my mk(${utcToLocalArgs(slot.start)})`;
    end = `my mk(${utcToLocalArgs(slot.end)})`;
  }
  return (
    `{summary:${asText(slot.subject)}, start date:${start}, end date:${end}, ` +
    `allday event:${slot.isAllDay}, location:${asText(slot.location)}, description:${asText(tagFor(slot))}}`
  );
}

export function applyScript(p: Plan): string {
  return [
    "on mk(y, mo, d, h, mi)",
    "  set t to current date",
    "  set day of t to 1",
    "  set year of t to y",
    "  set month of t to mo",
    "  set day of t to d",
    "  set time of t to h * 3600 + mi * 60",
    "  return t",
    "end mk",
    'tell application "Calendar"',
    "  with timeout of 240 seconds",
    `    set c to calendar ${asText(CALENDAR)}`,
    // A failed delete is retried next run: the stale tag is still there and still unwanted.
    ...p.remove.map((tag) => `    try\n      delete (every event of c whose description contains ${asText(tag)})\n    end try`),
    ...p.create.map((s) => `    make new event at end of events of c with properties ${eventProps(s)}`),
    "  end timeout",
    "end tell",
  ].join("\n");
}

const READ_SCRIPT = `
if application "Calendar" is not running then
  do shell script "open -gj -a Calendar"
  repeat 40 times
    if application "Calendar" is running then exit repeat
    delay 0.5
  end repeat
  delay 3
end if
tell application "Calendar"
  if not (exists calendar ${asText(CALENDAR)}) then return "NO_CALENDAR"
  set out to ""
  repeat with d in (get description of every event of calendar ${asText(CALENDAR)})
    set d to contents of d
    if d is not missing value then set out to out & d & linefeed
  end repeat
  return "OK" & linefeed & out
end tell`;

function osascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf-8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf-8")));
    const timer = setTimeout(() => child.kill(), 250_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`osascript exit ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(script, "utf-8");
  });
}

const log = (msg: string) => console.log(`${new Date().toLocaleString("sv-SE")} ${msg}`);

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  // Imported after the env above is set: auth.ts picks its token cache folder at import time.
  const graph = await import("./teams-graph.js");

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const from = new Date(today.getTime() - DAYS_BACK * DAY_MS);
  const to = new Date(today.getTime() + (DAYS_AHEAD + 1) * DAY_MS);

  let remote: CalendarSlot[];
  try {
    remote = await graph.listCalendarSlots(from, to);
  } catch (err) {
    const e = err as Error;
    if (e.message?.startsWith("SIGN_IN_REQUIRED") || e.name === "AuthPendingError") {
      log("sign-in needed: open any msgraph tool in VS Code once, then the next run catches up");
      return;
    }
    throw err;
  }

  const read = await osascript(READ_SCRIPT);
  if (read === "NO_CALENDAR") {
    log(`no "${CALENDAR}" calendar: create it in Calendar under On My Mac, never iCloud`);
    return;
  }
  const p = plan(remote, read);
  if (!remote.length && p.remove.length) {
    // 68 days without one meeting is a Graph hiccup, not an empty calendar: keep the copies.
    log(`Graph returned no events; kept ${p.remove.length} local copies`);
    return;
  }
  if (dryRun) {
    log(`dry run: +${p.create.length} -${p.remove.length} =${p.unchanged} (${remote.length} in Graph)`);
    for (const s of p.create) console.log(`  + ${s.start.slice(0, 16)} ${s.isAllDay ? "(all day) " : ""}${s.subject}`);
    return;
  }
  if (!p.create.length && !p.remove.length) return;
  await osascript(applyScript(p));
  log(`+${p.create.length} -${p.remove.length} =${p.unchanged} (${remote.length} in Graph)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: Error) => {
    log(`error: ${err.message}`);
    process.exit(1);
  });
}
