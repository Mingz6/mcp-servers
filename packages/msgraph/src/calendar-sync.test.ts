import assert from "node:assert/strict";
import { test } from "node:test";
import { applyScript, asText, eventProps, plan, tagFor } from "./calendar-sync.js";
import type { CalendarSlot } from "./teams-graph.js";

const slot = (over: Partial<CalendarSlot> = {}): CalendarSlot => ({
  id: "AAMkAGI2",
  subject: "Sprint review",
  start: "2026-10-20T16:00:00.0000000",
  end: "2026-10-20T17:00:00.0000000",
  isAllDay: false,
  location: "Teams",
  joinUrl: "https://teams.microsoft.com/meet/123?p=abc",
  ...over,
});

test("same event, same tag; any copied field changing changes the tag", () => {
  assert.equal(tagFor(slot()), tagFor(slot()));
  assert.match(tagFor(slot()), /^\[crna:[0-9a-f]{16}:[0-9a-f]{10}\]$/);
  for (const change of [{ subject: "x" }, { start: "2026-10-20T16:30:00.0000000" }, { location: "" }, { isAllDay: true }, { joinUrl: "" }]) {
    assert.notEqual(tagFor(slot(change)), tagFor(slot()));
    assert.equal(tagFor(slot(change)).slice(0, 23), tagFor(slot()).slice(0, 23), "key part follows the Graph id");
  }
});

test("a second run with everything in place changes nothing", () => {
  const remote = [slot(), slot({ id: "B" })];
  const local = remote.map(tagFor).join("\n");
  assert.deepEqual(plan(remote, `OK\n${local}\n`), { create: [], remove: [], unchanged: 2 });
});

test("moved, cancelled, duplicated and hand-made events", () => {
  const moved = slot({ start: "2026-10-21T16:00:00.0000000", end: "2026-10-21T17:00:00.0000000" });
  const gone = slot({ id: "gone" });
  const dup = slot({ id: "dup" });
  const local = [tagFor(slot()), tagFor(gone), tagFor(dup), tagFor(dup), "my own note"].join("\n");
  const p = plan([moved, dup], local);
  assert.deepEqual(new Set(p.remove), new Set([tagFor(slot()), tagFor(gone), tagFor(dup)]));
  assert.deepEqual(p.create, [moved, dup]);
  assert.equal(p.unchanged, 0);
});

test("AppleScript strings can't be broken out of", () => {
  assert.equal(asText('a "b" \\ c'), '"a \\"b\\" \\\\ c"');
  assert.equal(asText("line1\nline2\r\t"), '"line1 line2 "');
  assert.equal(asText("x".repeat(500)).length, 402);
});

test("timed events convert UTC to this Mac's local time; all-day events keep their date", () => {
  const d = new Date("2026-10-20T16:00:00Z");
  const local = `${d.getFullYear()}, ${d.getMonth() + 1}, ${d.getDate()}, ${d.getHours()}, ${d.getMinutes()}`;
  assert.ok(eventProps(slot()).includes(`start date:my mk(${local})`));
  const allDay = eventProps(slot({ isAllDay: true, start: "2026-11-11T00:00:00.0000000", end: "2026-11-13T00:00:00.0000000" }));
  assert.ok(allDay.includes("start date:my mk(2026, 11, 11, 0, 0), end date:(my mk(2026, 11, 11, 0, 0)) + 2 * days"));
  assert.ok(allDay.includes("allday event:true"));
});

test("the join link goes in the URL field only when it is a whole https link", () => {
  assert.ok(eventProps(slot()).endsWith(', url:"https://teams.microsoft.com/meet/123?p=abc"}'));
  const long = `https://teams.microsoft.com/l/meetup-join/${"a".repeat(600)}`;
  assert.ok(eventProps(slot({ joinUrl: long })).includes(`url:"${long}"`), "longer than other fields' 400 cap");
  for (const joinUrl of ["", "javascript:alert(1)", 'https://x" & (do shell script "id") & "', `https://${"a".repeat(2000)}`]) {
    assert.ok(!eventProps(slot({ joinUrl })).includes("url:"), joinUrl.slice(0, 30));
  }
});

test("the apply script deletes before it creates", () => {
  const s = applyScript({ create: [slot()], remove: ["[crna:0123456789abcdef:0123456789]"], unchanged: 0 });
  assert.ok(s.indexOf("delete (every event") < s.indexOf("make new event"));
  assert.ok(s.includes('set c to calendar "CRNA"'));
});
