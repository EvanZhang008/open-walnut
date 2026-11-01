/**
 * The pictures of a user line go to the CLI as image blocks (2026-11-01, the user:
 * "if we can directly input it to AI that is one round less"). Pure and
 * self-contained, shared by both daemon twins: daemon-core.ts imports it,
 * daemon-source.ts inlines its text (fn.toString()), so NOTHING here may
 * reference module scope, imports, or helpers.
 *
 * A picture reaches the session's host as a file, and the message names it under
 * the images header every surface knows (`IMAGES_ATTACHED_LINE`,
 * core/sessions/cloud-images.ts): the web, the phone and the history reader find
 * the pictures by that header and those paths, so the text stays exactly as the
 * server wrote it. Here, at the FIFO write on the host that holds the files, each
 * listed picture that is a real png, jpeg, gif or webp (by its bytes, not its
 * name) and within the caps is added in front of the text as an image block, and
 * one Walnut hint after the text tells the model it already sees them. Claude
 * Code downsizes a large picture itself (to at most 2000 px, as JPEG) before it
 * stores and sends it, so the caps only bound the line written into the pipe.
 * A picture left out (too large, an unknown type, gone) stays a path to Read,
 * and the hint names it; with none attached the line is the text as before.
 *
 * Only Walnut's own picture folders are read (`roots`: the host's
 * `<daemon dir>/images/` and `<daemon dir>-images/`), never a path some other
 * text names: the header can come in any message (a peer's, a forwarded one),
 * and Claude Code would ask before a Read outside the session's folder. The caps
 * keep the line inside the FIFO write deadline (20 s; about 2.6 MB/s through a
 * 64 KB pipe when the CLI reads at once): 6 MB of pictures is 8 MB of line.
 *
 * The whole message stays ONE text block: the history reader takes a mid-turn
 * line's text from the first text block of its `queued_command` attachment, and
 * the CLI's `remove` record joins every text block, so both read the same words.
 */

export interface UserLinePicture { path: string; mediaType: string; bytes: number }
export interface UserLineSkipped { path: string; reason: 'missing' | 'not_file' | 'too_large' | 'message_cap' | 'type' | 'read_error' | 'not_absolute' | 'not_walnut' | 'count' }
export interface UserLineContent {
  /** The line's `message.content`: the text itself, or image blocks then one text block. */
  content: string | Array<Record<string, unknown>>
  attached: UserLinePicture[]
  skipped: UserLineSkipped[]
}

interface UserLineFs {
  statSync(p: string): { isFile(): boolean; size: number }
  readFileSync(p: string): Uint8Array
}

export function userLineContent(message: string, fs: UserLineFs, roots: readonly string[]): UserLineContent {
  // Byte-for-byte core/sessions/cloud-images.ts IMAGES_ATTACHED_LINE (a test pins it).
  const HEADER = '[Images attached \u2014 use the Read tool to view them]'
  // Per picture and per line, in file bytes (base64 adds a third).
  const MAX_PICTURE_BYTES = 5 * 1024 * 1024
  const MAX_LINE_BYTES = 6 * 1024 * 1024
  const MAX_PICTURES = 10
  const plain: UserLineContent = { content: message, attached: [], skipped: [] }
  if (typeof message !== 'string') return plain
  // Every header at a line start: the CLI's queue joins messages sent close together.
  const paths: string[] = []
  for (let at = message.indexOf(HEADER); at >= 0; at = message.indexOf(HEADER, at + 1)) {
    if (at > 0 && message.charCodeAt(at - 1) !== 10) continue
    const lines = message.slice(at + HEADER.length).split('\n')
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.slice(0, 2) !== '- ') break
      const p = line.slice(2).trim()
      if (p && paths.indexOf(p) < 0) paths.push(p)
    }
  }
  if (paths.length === 0) return plain
  const inRoot = (p: string): boolean => p.split('/').every((seg) => seg !== '..' && seg !== '.')
    && (roots || []).some((r) => typeof r === 'string' && r.length > 1 && p.slice(0, r.length) === r && p.length > r.length)

  const sniff = (b: Uint8Array): string | null => {
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
    if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38
      && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif'
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
    return null
  }
  const base64 = (b: Uint8Array): string => {
    const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer
    if (B) return B.from(b).toString('base64')
    let s = ''
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 0x8000)))
    return btoa(s)
  }

  const blocks: Array<Record<string, unknown>> = []
  const attached: UserLinePicture[] = []
  const skipped: UserLineSkipped[] = []
  let total = 0
  for (const p of paths) {
    if (attached.length >= MAX_PICTURES) { skipped.push({ path: p, reason: 'count' }); continue }
    if (p.charAt(0) !== '/') { skipped.push({ path: p, reason: 'not_absolute' }); continue }
    if (!inRoot(p)) { skipped.push({ path: p, reason: 'not_walnut' }); continue }
    let size = 0
    try {
      const st = fs.statSync(p)
      if (!st.isFile()) { skipped.push({ path: p, reason: 'not_file' }); continue }
      size = st.size
    } catch { skipped.push({ path: p, reason: 'missing' }); continue }
    if (size > MAX_PICTURE_BYTES) { skipped.push({ path: p, reason: 'too_large' }); continue }
    if (total + size > MAX_LINE_BYTES) { skipped.push({ path: p, reason: 'message_cap' }); continue }
    let bytes: Uint8Array
    try { bytes = fs.readFileSync(p) } catch { skipped.push({ path: p, reason: 'read_error' }); continue }
    // Read again in case it grew between the stat and the read.
    if (bytes.length > MAX_PICTURE_BYTES || total + bytes.length > MAX_LINE_BYTES) {
      skipped.push({ path: p, reason: bytes.length > MAX_PICTURE_BYTES ? 'too_large' : 'message_cap' }); continue
    }
    const mediaType = sniff(bytes)
    if (!mediaType) { skipped.push({ path: p, reason: 'type' }); continue }
    total += bytes.length
    blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64(bytes) } })
    attached.push({ path: p, mediaType, bytes: bytes.length })
  }
  if (attached.length === 0) return { content: message, attached, skipped }

  // A path is the user's file name: keep it from opening or closing a reminder tag.
  const safe = (s: string): string => s.replace(/[<>\n\r]/g, '')
  const WHY: Record<string, string> = {
    too_large: 'too large to send with the message', message_cap: 'the message already carries as many pictures as it can',
    type: 'not a png, jpeg, gif or webp picture', missing: 'the file was not found', not_file: 'not a file',
    read_error: 'the file could not be read', not_absolute: 'not a full path', count: 'too many pictures in one message',
    not_walnut: 'not a picture Walnut saved',
  }
  const one = attached.length === 1
  let note = (one ? 'This picture is' : 'These pictures are') + ' in this message as '
    + (one ? 'an image' : 'images') + ', so you see ' + (one ? 'it' : 'them')
    + ' already: do not use the Read tool to view ' + (one ? 'it' : 'them') + ': '
    + attached.map((a) => safe(a.path)).join('; ') + '. The paths are where the files are saved.'
  if (skipped.length > 0) {
    note += ' Not in this message, so Read ' + (skipped.length === 1 ? 'it' : 'them') + ' if you need '
      + (skipped.length === 1 ? 'it' : 'them') + ': '
      + skipped.map((s) => `${safe(s.path)} (${WHY[s.reason] || s.reason})`).join('; ') + '.'
  }
  const text = message + '\n\n<system-reminder>\nWalnut (images): ' + note + '\n</system-reminder>'
  blocks.push({ type: 'text', text })
  return { content: blocks, attached, skipped }
}
