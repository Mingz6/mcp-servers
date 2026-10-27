import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

// Graph takes a file in one POST only under 3 MB; anything bigger needs an upload session.
export const MAX_BYTES = 3 * 1024 * 1024;

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
};

export interface FileAttachment {
  name: string;
  contentType: string;
  contentBytes: string;
}

export function readAttachments(paths: string[]): FileAttachment[] {
  return paths.map((path) => {
    const size = statSync(path).size;
    if (size >= MAX_BYTES) {
      throw new Error(`${basename(path)} is ${(size / 1e6).toFixed(1)} MB; an attachment must be under 3 MB`);
    }
    return {
      name: basename(path),
      contentType: TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      contentBytes: readFileSync(path).toString("base64"),
    };
  });
}
