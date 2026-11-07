/**
 * The attachment headers Walnut writes in front of a person's words: pure, no
 * node imports, so the server and the browser read them with one parser.
 *
 * A message with pictures or files reaches the CLI as plain text, the paths
 * under one header line each (the CLI is told to read them):
 *
 *   [Images attached <dash> use the Read tool to view them]
 *   - /path/to/a.png
 *
 *   [Files attached <dash> open them from these paths]
 *   - /path/to/clip.mov
 *
 *   what the person typed
 *
 * Every producer builds the block with `attachmentHeaderBlock`, and every
 * display reads it back with `splitAttachmentHeaders` (the queue card, the web
 * bubble), so the header is never shown as the person's words.
 * tests/core/sessions/attachment-header-producers.test.ts lists every file that
 * writes or names one.
 */

/** The first line of a message with pictures, the dash written as an escape. */
export const IMAGES_ATTACHED_LINE = '[Images attached \u2014 use the Read tool to view them]'

/** The first line of a message with attached files, the dash written as an escape. */
export const FILES_ATTACHED_LINE = '[Files attached \u2014 open them from these paths]'

export type AttachmentKind = 'images' | 'files'

/** One header block: the header line, one `- <path>` line per path, a blank line. '' for no paths. */
export function attachmentHeaderBlock(kind: AttachmentKind, paths: readonly string[]): string {
  if (paths.length === 0) return ''
  const line = kind === 'images' ? IMAGES_ATTACHED_LINE : FILES_ATTACHED_LINE
  return `${line}\n${paths.map((p) => `- ${p}`).join('\n')}\n\n`
}

/**
 * The second form, written by the web's session routes and the Personal AI's
 * session handoff (web/routes/images.ts buildSessionImageContext): one sentence
 * naming how many pictures, then one bare path per line, then a blank line.
 * Byte for byte what those routes have always sent the model.
 */
export function imageContextBlock(paths: readonly string[]): string {
  if (paths.length === 0) return ''
  const one = paths.length === 1
  return `The user attached ${one ? 'an image' : `${paths.length} images`}. Read ${one ? 'this file' : 'these files'} for visual context:\n${paths.join('\n')}\n\n`
}

/**
 * A header line, the current wording or an older one ("[Images attached, use the
 * Read tool ...]"): the kind is the second word, the rest is free.
 */
const HEADER_LINE_RE = /^\[(Images|Files) attached\b[^\]\n]*\]$/
/** imageContextBlock's sentence; the count says how many path lines follow. */
const CONTEXT_LINE_RE = /^The user attached (an image|(\d{1,2}) images)\. Read (?:this file|these files) for visual context:$/

export interface SplitAttachments {
  /** The words after the headers (unchanged when there is no header). */
  text: string
  images: string[]
  files: string[]
}

/** One block at line `i`: its kind, its paths and the line after it, or null. */
function blockAt(lines: string[], i: number): { kind: AttachmentKind; paths: string[]; next: number } | null {
  const header = HEADER_LINE_RE.exec(lines[i])
  if (header) {
    const paths: string[] = []
    let j = i + 1
    while (j < lines.length && lines[j].startsWith('- ') && lines[j].length > 2) {
      paths.push(lines[j].slice(2).trim())
      j++
    }
    // A header with no path line is not one Walnut wrote.
    return paths.length ? { kind: header[1] === 'Images' ? 'images' : 'files', paths, next: j } : null
  }
  const context = CONTEXT_LINE_RE.exec(lines[i])
  if (context) {
    const count = context[2] ? Number(context[2]) : 1
    const paths = lines.slice(i + 1, i + 1 + count)
    if (count < 1 || paths.length !== count || paths.some((p) => !p.trim() || p !== p.trim())) return null
    return { kind: 'images', paths, next: i + 1 + count }
  }
  return null
}

/**
 * Take the attachment header blocks off the front of a message (several, in any
 * order), with their paths. Only a block at the very start counts, with its path
 * lines: a person who types the header words mid-message keeps them.
 */
export function splitAttachmentHeaders(text: string): SplitAttachments {
  const images: string[] = []
  const files: string[] = []
  if (typeof text !== 'string' || !(text.startsWith('[') || text.startsWith('The user attached '))) return { text, images, files }
  const lines = text.split('\n')
  let i = 0
  let found = false
  for (let n = 0; n < 4 && i < lines.length; n++) {
    const block = blockAt(lines, i)
    if (!block) break
    ;(block.kind === 'images' ? images : files).push(...block.paths)
    found = true
    let j = block.next
    // One blank line ends the block.
    if (j < lines.length && lines[j] === '') j++
    i = j
  }
  if (!found) return { text, images, files }
  return { text: lines.slice(i).join('\n'), images, files }
}
