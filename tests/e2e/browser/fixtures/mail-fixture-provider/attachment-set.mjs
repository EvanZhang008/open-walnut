/**
 * `PW_MAIL_ATTACHMENTS=1`: attachments that really open, and the big message that started it.
 *
 * 2026-11-13: a Gmail message with a 2.2 MB PDF opened as "This message body is too big to cache" and
 * its attachment chip did nothing. The reader now gets the text of such a message (the provider reads
 * its text parts only) and a chip opens its file on a click, never before. This set is that message as
 * the base sees it:
 *
 * - BIG_MESSAGE reports a source of about 2.4 MB (`bodyBytes`, the RFC822.SIZE a server would give),
 *   while its text and html are a few hundred bytes: what the provider hands over after reading parts.
 * - Three attachments, one per thing a click does: a 2.3 MB PDF opens in Walnut's PDF viewer, a PNG
 *   in its image viewer, and an .html file is DOWNLOADED, never rendered.
 *
 * With the flag on, this provider declares `attachments: 'download'`, so every listed attachment of
 * every fixture message opens; one without its own bytes here gets a small generated file of its type.
 * Every `getAttachment` call is written to `<home>/mail-fixture-attachment-calls.json`, so a spec can
 * assert that reading a message asked for none and each click asked for one.
 *
 * Addresses are `*.invalid` (RFC 2606) and nothing here resolves.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const attachmentsOn = process.env.PW_MAIL_ATTACHMENTS === '1';

export const BIG_MESSAGE = 'INBOX:12:1';
export const BIG_PDF = '2';
export const BIG_IMAGE = '3';
export const BIG_HTML = '4';

const CALLS = path.join(process.env.OPEN_WALNUT_HOME || os.tmpdir(), 'mail-fixture-attachment-calls.json');

function record(entry) {
  let held = [];
  try { held = JSON.parse(fs.readFileSync(CALLS, 'utf8')); } catch { held = []; }
  held.push({ ...entry, at: Date.now() });
  const staging = `${CALLS}.${process.pid}.tmp`;
  fs.writeFileSync(staging, JSON.stringify(held, null, 2));
  fs.renameSync(staging, CALLS);
}

function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * A one-page PDF that says `title`, padded with an unreferenced stream to `padBytes` more: the size of
 * a real report's embedded images, without the images. The cross-reference offsets are computed, so
 * pdf.js reads it as a well-formed file.
 */
export function pdfBytes(title, padBytes = 0) {
  const safe = title.replace(/[()\\]/g, ' ');
  const stream = (data) => Buffer.concat([
    Buffer.from(`<< /Length ${data.length} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ]);
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', 'latin1'),
    stream(Buffer.from(`BT /F1 28 Tf 72 680 Td (${safe}) Tj ET`, 'latin1')),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'latin1'),
    ...(padBytes > 0 ? [stream(Buffer.alloc(padBytes, 0x41))] : []),
  ];
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let at = chunks[0].length;
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(at);
    const one = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(one);
    at += one.length;
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(at),
    '%%EOF',
    '',
  ].join('\n');
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real PNG, `width` by `height`, in three horizontal bands: something an `<img>` must decode. */
export function pngBytes(width = 96, height = 64) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const bands = [[22, 96, 160], [240, 236, 220], [30, 140, 90]];
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // no filter
    const [r, g, b] = bands[Math.min(2, Math.floor((y * 3) / height))];
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An html file that would show itself if anything rendered it. Nothing may. */
const HOSTILE_HTML = Buffer.from(
  '<!doctype html><html><head><title>notice</title></head><body>'
  + '<h1 id="rendered">If you can read this, the attachment was rendered</h1>'
  + '<script>document.title = "ran"; parent.postMessage("attachment script ran", "*")</script>'
  + '</body></html>',
  'utf8',
);

const BIG_PDF_BYTES = pdfBytes('Harbour survey, page 1', 2_300_000);
const BIG_IMAGE_BYTES = pngBytes();

/** Bytes per attachment of BIG_MESSAGE, by part id. */
const BIG_FILES = new Map([
  [BIG_PDF, { filename: 'harbour-survey.pdf', mimeType: 'application/pdf', bytes: BIG_PDF_BYTES }],
  [BIG_IMAGE, { filename: 'north-basin.png', mimeType: 'image/png', bytes: BIG_IMAGE_BYTES }],
  [BIG_HTML, { filename: 'notice "draft".html', mimeType: 'text/html', bytes: HOSTILE_HTML }],
]);

const TEXT = 'The survey of the north basin is done.\n\nDepths, the dredging plan and the photos are in the attached report.\n\nPriya';
const HTML = '<div><p>The survey of the <b>north basin</b> is done.</p><p>Depths, the dredging plan and the photos are in the attached report.</p><p>Priya</p></div>';

export function attachmentMessages(now) {
  // About what a server reports for this message: base64 grows each file by a third.
  const encoded = [...BIG_FILES.values()].reduce((sum, one) => sum + Math.ceil(one.bytes.length * 4 / 3), 0);
  return [{
    messageId: BIG_MESSAGE,
    rfcMessageId: '<harbour-survey-12@harbour.example.invalid>',
    mailboxId: 'INBOX',
    from: { name: 'Priya at the Harbour', address: 'priya@harbour.example.invalid' },
    to: [{ address: 'ctx-writer@example.invalid' }],
    subject: 'Harbour survey, full report attached',
    snippet: 'The survey of the north basin is done.',
    sentAt: now - 3 * 60 * 1000,
    attachments: [...BIG_FILES.entries()].map(([id, one]) => ({
      id, filename: one.filename, mimeType: one.mimeType, bytes: Math.ceil(one.bytes.length * 4 / 3),
    })),
    body: { format: 'both', text: TEXT, html: HTML },
    sourceBytes: encoded + 4_096,
    unreadAtFirstSight: false,
  }];
}

/** A small file of the attachment's own type, for a fixture message that lists one with no bytes here. */
function generatedFile(attachment) {
  const type = (attachment.mimeType ?? '').toLowerCase();
  const name = attachment.filename ?? 'attachment';
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) return pdfBytes(name);
  if (type.startsWith('image/')) return pngBytes(48, 32);
  return Buffer.from(`${name}\n\nA fixture file.\n`, 'utf8');
}

async function* chunked(bytes, signal) {
  const step = 256 * 1024;
  for (let at = 0; at < bytes.length; at += step) {
    if (signal?.aborted) return;
    yield bytes.subarray(at, at + step);
    // A real transport is not instant: a cancelled download has a moment in which to be cancelled.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** `getAttachment` over the fixture's messages, found through `find(messageId)`. */
export function attachmentMethodsFor(find) {
  return {
    async getAttachment(_accountId, messageId, attachmentId, options) {
      record({ messageId, attachmentId });
      const message = find(messageId);
      if (!message) throw providerError('not-found', `no fixture message ${messageId}`);
      const listed = (message.attachments ?? []).find((one) => one.id === attachmentId);
      if (!listed) throw providerError('not-found', `This message has no attachment "${attachmentId}".`);
      const file = messageId === BIG_MESSAGE ? BIG_FILES.get(attachmentId) : undefined;
      const bytes = file?.bytes ?? generatedFile(listed);
      if (bytes.length > options.maxBytes) throw providerError('too-large', 'That attachment is over the cap Walnut opens.');
      return {
        filename: file?.filename ?? listed.filename,
        mimeType: file?.mimeType ?? listed.mimeType,
        bytes: bytes.length,
        content: chunked(bytes, options.signal),
      };
    },
  };
}
