import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_BYTES, readAttachments } from "./attachments.js";

const dir = mkdtempSync(join(tmpdir(), "outlook-attach-"));

test("readAttachments sends the file name, its type and base64 bytes", () => {
  const png = join(dir, "Screenshot 22.49.27.PNG");
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const other = join(dir, "notes.xyz");
  writeFileSync(other, "hi");
  assert.deepEqual(readAttachments([png, other]), [
    { name: "Screenshot 22.49.27.PNG", contentType: "image/png", contentBytes: "iVBORw==" },
    { name: "notes.xyz", contentType: "application/octet-stream", contentBytes: "aGk=" },
  ]);
});

test("readAttachments refuses a file Graph can't take in one request, and a missing one", () => {
  const big = join(dir, "big.jpg");
  writeFileSync(big, Buffer.alloc(MAX_BYTES));
  assert.throws(() => readAttachments([big]), /big\.jpg is 3\.1 MB; an attachment must be under 3 MB/);
  assert.throws(() => readAttachments([join(dir, "gone.png")]), /ENOENT/);
});

test("no attachments is an empty list", () => {
  assert.deepEqual(readAttachments([]), []);
});
