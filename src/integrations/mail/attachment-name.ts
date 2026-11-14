/**
 * An attachment's name as the sender wrote it is not safe to show or to save. ONE rule, read by the
 * server (the `Content-Disposition` header, a file saved to Downloads) and by the console (the chip,
 * the viewer's bar, a link's `download` name), so what a person reads is what lands on disk.
 * Zero imports: the console imports this file as it is.
 *
 * Control characters go (a CR or LF in a header value is a response split), and so do the
 * bidirectional marks and overrides that make `invoice\u202Efdp.exe` read as `invoiceexe.pdf`.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** Longest filename kept, in characters. */
export const FILENAME_MAX_CHARS = 150

/** The name to SHOW: no control or bidi character, whitespace runs as one space. Empty when nothing is left. */
export function cleanAttachmentName(raw: string | undefined): string {
  return (raw ?? '').replace(UNSAFE_NAME_CHARS, '').replace(/\s+/g, ' ').trim()
}

/**
 * The name to SAVE under, or to put in a header: the shown name, with path separators as `_` (so a
 * name is never a path), no leading dot (so a download is never a hidden file), at most
 * `FILENAME_MAX_CHARS` characters, and `attachment` when nothing is left.
 */
export function safeFilename(raw: string | undefined): string {
  const cleaned = [...cleanAttachmentName(raw)
    .replace(/[/\\]/g, '_')
    .replace(/^[.\s]+/, '')]
    .slice(0, FILENAME_MAX_CHARS)
    .join('')
    .trim()
  return cleaned || 'attachment'
}
