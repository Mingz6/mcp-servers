import { readFile } from "fs/promises";
import { simpleParser, type ParsedMail } from "mailparser";

export interface ParsedEmlx {
  mail: ParsedMail;
  isPartial: boolean;
}

export async function parseEmlx(filePath: string): Promise<ParsedEmlx> {
  const isPartial = filePath.endsWith(".partial.emlx");
  const buffer = await readFile(filePath);

  // .emlx format: first line = byte count of the RFC822 message
  const newlineIdx = buffer.indexOf(0x0a);
  if (newlineIdx === -1) throw new Error("Invalid .emlx: no newline found");

  const byteCountStr = buffer.subarray(0, newlineIdx).toString("utf-8").trim();
  const byteCount = parseInt(byteCountStr, 10);

  if (isNaN(byteCount))
    throw new Error(`Invalid .emlx: bad byte count "${byteCountStr}"`);

  // Extract RFC822 message (skip the byte-count line)
  const msgStart = newlineIdx + 1;
  const msgEnd = msgStart + byteCount;
  const messageBuffer = buffer.subarray(
    msgStart,
    Math.min(msgEnd, buffer.length)
  );

  const mail = await simpleParser(messageBuffer);

  return { mail, isPartial };
}

export function getPlainBody(mail: ParsedMail): string {
  if (mail.text) return mail.text;

  // Fall back to stripping HTML
  if (mail.html && typeof mail.html === "string") {
    return stripHtml(mail.html);
  }

  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(
      /<a\s[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi,
      (_: string, href: string, text: string) => {
        if (text.includes("http")) return text;
        return `${text} (${href})`;
      }
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}
