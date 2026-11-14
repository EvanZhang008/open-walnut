/**
 * The three small decisions the reader's header and body make about a message, kept pure so they
 * can be read (and graded) without a DOM: who the sender's mark is, what an attachment IS, and
 * whether a plain-text body is prose or a printout.
 */
import type { MailAddress, MailAttachmentMeta } from '@/api/mail';

/**
 * The sender's mark: one letter and one hue.
 *
 * Eight hues, hashed on the ADDRESS rather than the display name, so the same person keeps the same
 * colour when they change how their name is spelled. Saturation and lightness are fixed at a value
 * that carries white text in both themes, which is why the palette is expressed as a hue alone: a
 * per-hue hand-picked colour would need a second set for dark mode and would drift out of step.
 */
const AVATAR_HUES = [4, 28, 46, 96, 152, 190, 222, 286];

export interface SenderMark {
  /** One grapheme, upper-cased. Non-Latin scripts keep their own character. */
  initial: string;
  hue: number;
}

export function senderMark(from: MailAddress | undefined): SenderMark {
  const name = from?.name?.trim() || from?.address?.trim() || '';
  const key = (from?.address?.trim() || name).toLowerCase();
  return { initial: firstLetter(name), hue: AVATAR_HUES[hashOf(key) % AVATAR_HUES.length]! };
}

/**
 * The first LETTER, not the first character.
 *
 * A display name often opens with a quote, a bracket or a zero-width mark that carries no meaning
 * at 36px, and `[...name][0]` on `"Keeper Reports"` would put a quotation mark in the circle.
 */
function firstLetter(name: string): string {
  for (const char of name) {
    if (/[\p{L}\p{N}]/u.test(char)) return char.toUpperCase();
  }
  return '?';
}

/** A stable small hash. Not cryptographic: it only has to spread eight ways. */
function hashOf(value: string): number {
  let hash = 0;
  for (let at = 0; at < value.length; at += 1) {
    hash = (hash * 31 + value.charCodeAt(at)) | 0;
  }
  return Math.abs(hash);
}

export type AttachmentKind = 'image' | 'pdf' | 'doc' | 'sheet' | 'archive' | 'file';

const EXTENSION_KIND: Record<string, AttachmentKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', heic: 'image',
  bmp: 'image', tif: 'image', tiff: 'image', svg: 'image', avif: 'image',
  pdf: 'pdf',
  doc: 'doc', docx: 'doc', rtf: 'doc', odt: 'doc', pages: 'doc', txt: 'doc', md: 'doc',
  xls: 'sheet', xlsx: 'sheet', csv: 'sheet', numbers: 'sheet', ods: 'sheet',
  zip: 'archive', gz: 'archive', tgz: 'archive', rar: 'archive', '7z': 'archive',
};

/**
 * Which glyph an attachment gets.
 *
 * The MIME type is asked first, because it is what the message declared; the extension is the
 * fallback for the providers that send `application/octet-stream` for everything.
 */
export function attachmentKind(attachment: MailAttachmentMeta): AttachmentKind {
  const mime = attachment.mimeType?.toLowerCase() ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.includes('spreadsheet') || mime === 'text/csv') return 'sheet';
  if (mime.includes('word') || mime.startsWith('text/')) return 'doc';
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('tar')) return 'archive';
  const extension = /\.([a-z0-9]{1,6})$/i.exec(attachment.filename ?? '')?.[1]?.toLowerCase();
  return (extension && EXTENSION_KIND[extension]) || 'file';
}

/** Box-drawing and block characters: a printout drawn with them needs its columns kept. */
const BOX_DRAWING = /[─-╿▀-▟]/;

/** A line that only means what it says at a fixed pitch. */
const INDENTED = /^(?: {2,}|\t)\S/;

/**
 * Whether a plain-text body is a PRINTOUT rather than prose.
 *
 * Mail is prose, and setting all of it in monospace (what this reader used to do) makes an ordinary
 * note read like a log file. The exception is real: a stack trace, a table drawn with box characters
 * or a diff loses its meaning the moment the pitch varies, so those keep the fixed font.
 *
 * The test is deliberately blunt (a share of lines that are indented or drawn), because the cost of
 * being wrong is small in one direction and large in the other: prose set in monospace is ugly, a
 * table set proportionally is unreadable.
 */
export function looksLikeCode(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.trim());
  if (lines.length < 4) return false;
  let marked = 0;
  for (const line of lines) {
    if (INDENTED.test(line) || BOX_DRAWING.test(line)) marked += 1;
  }
  return marked / lines.length >= 0.4;
}

/**
 * Whether there is anything to render, whatever the declared format says.
 *
 * An html part counts only when something in it would paint: text outside `<head>`, `<style>`
 * and `<script>`, or an image. A provider can hand over a complete document whose every cell was
 * stripped on its way here (seen live: a 1 KB newsletter shell of nested empty tables), and a
 * frame showing that is a white card with nothing on it, which reads as a broken reader.
 */
export function hasBodyContent(body: { html?: string; text?: string }): boolean {
  if (body.text?.trim()) return true;
  const html = body.html ?? '';
  if (!html.trim()) return false;
  if (/<img\b/i.test(html)) return true;
  const visible = html
    .replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;|\s/g, '');
  return visible.length > 0;
}
