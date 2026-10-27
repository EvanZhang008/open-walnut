/**
 * Files a person attaches to a session from a phone: a photo-library video, a
 * PDF from Files, anything. The bytes travel in chunks to the SESSION'S HOST
 * (`PUT /api/v1/sessions/:id/uploads/:uploadId`, the daemon's `upload.part`),
 * and the message that follows names the saved paths under one header line,
 * the same shape as the "[Images attached …]" header pictures get:
 *
 *   [Files attached <dash> open them from these paths]
 *   - /home/me/.local/state/open-walnut/tasks/<task>/uploads/up-…/clip.mov
 *
 *   what the person typed
 *
 * The phone writes that text itself, so every send path (the primary's queue,
 * the companion's relay and its held sends) carries it as plain words.
 */

/** One chunk: the bridge and tunnel frame budget every chunked lane here uses. */
export const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024

/** One file. The daemon holds the same cap (transfer-core.ts uploadPart). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024

export const UPLOAD_ID_RE = /^up-[A-Za-z0-9-]{8,64}$/

const MAX_UPLOAD_NAME_BYTES = 200

/** The first line of a message with attached files, the dash written as an escape. */
export const FILES_ATTACHED_LINE = '[Files attached \u2014 open them from these paths]'

/** The daemon's rule for a file name (transfer-core.ts checkUploadName), checked before any bytes move. */
export function isUploadName(name: unknown): name is string {
  if (typeof name !== 'string' || !name) return false
  if (Buffer.byteLength(name, 'utf8') > MAX_UPLOAD_NAME_BYTES) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f/\\]/.test(name)) return false
  if (name.startsWith('.') || name.trim() !== name) return false
  return !name.endsWith('.walnut-part')
}

/** The message text naming saved files (what the phone sends). */
export function withFilePaths(text: string, paths: string[]): string {
  const list = paths.map((p) => `- ${p}`).join('\n')
  return `${FILES_ATTACHED_LINE}\n${list}\n\n${text}`
}

/** "[Images attached …]" and "[Files attached …]" headers with their path lists, in any order. */
const ATTACHMENT_HEADER_RE = /^\[(?:Images|Files) attached[^\]]*\]\n(?:- \S[^\n]*\n)*\n?/

/** The words of a message without its attachment headers (titles read the words, not the paths). */
export function withoutAttachmentHeaders(text: string): string {
  let out = text
  for (let i = 0; i < 4; i++) {
    const next = out.replace(ATTACHMENT_HEADER_RE, '')
    if (next === out) break
    out = next
  }
  return out
}
