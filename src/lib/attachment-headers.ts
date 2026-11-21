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
 * A video recorded with the composer's camera also carries its stills (frames
 * taken while it was recorded: Claude reads pictures, not video) and what was said
 * in it, each block naming the video file it belongs to:
 *
 *   [Video stills <dash> frames of camera-1416.webm (0:42), time in each name; use the Read tool to view them]
 *   - /path/to/camera-1416-still-0m06s.jpg
 *
 *   [Video narration <dash> what was said in camera-1416.webm]
 *   - so the request goes into the queue here
 *
 * Every producer builds the block with `attachmentHeaderBlock` (`videoClipBlocks`
 * for a video's two), and every
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

/** What a video's two blocks start with: the rest of each line names the video. */
export const VIDEO_STILLS_PREFIX = '[Video stills \u2014 '
export const VIDEO_NARRATION_PREFIX = '[Video narration \u2014 '

export interface VideoClipHeader {
  /** The video's file name, as it was saved (its path is in the files block). */
  name: string
  durationMs: number
  /** The stills' saved paths, in time order. */
  stills: readonly string[]
  /** What was said in it, as one line ('' or absent: nothing). */
  narration?: string
}

/** "0:42", "1:05": minutes and seconds. */
export function clipClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** A header line names the video in a bracket: keep its name to one safe line. */
/** A video's name as its blocks' headers write it (one safe line): match a file's name to its blocks with it. */
export function clipHeaderName(name: string): string {
  return name.replace(/[\]\n\r]/g, ' ').slice(0, 120)
}

/**
 * The stills block and the narration block of one video, '' for a video with
 * neither. They go after the files block that names the video itself.
 */
export function videoClipBlocks(clip: VideoClipHeader): string {
  const name = clipHeaderName(clip.name)
  let out = ''
  const stills = clip.stills.filter((p) => p.trim())
  if (stills.length) {
    out += `${VIDEO_STILLS_PREFIX}frames of ${name} (${clipClock(clip.durationMs)}), time in each name; use the Read tool to view them]\n${stills.map((p) => `- ${p}`).join('\n')}\n\n`
  }
  const said = (clip.narration ?? '').replace(/\s+/g, ' ').trim()
  if (said) out += `${VIDEO_NARRATION_PREFIX}what was said in ${name}]\n- ${said}\n\n`
  return out
}

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
const HEADER_LINE_RE = /^\[(Images|Files|Large text) attached\b[^\]\n]*\]$/
/** A video's stills or narration block (videoClipBlocks). */
const VIDEO_LINE_RE = /^\[Video (stills|narration) \u2014 [^\]\n]*\]$/
/** imageContextBlock's sentence; the count says how many path lines follow. */
const CONTEXT_LINE_RE = /^The user attached (an image|(\d{1,2}) images)\. Read (?:this file|these files) for visual context:$/

export interface SplitAttachments {
  /** The words after the headers (unchanged when there is no header). */
  text: string
  images: string[]
  files: string[]
  /** A recorded video's stills (their paths): the files block names the video itself. */
  stills: string[]
  /** What was said in each recorded video, one line each. */
  narration: string[]
  /** The same stills and words, by the video they belong to (named in each block's header). */
  clips: VideoClipRead[]
}

/** One recorded video's blocks as read back: its name, its stills' paths and what was said. */
export interface VideoClipRead {
  name: string
  stills: string[]
  narration?: string
}

const STILLS_NAME_RE = /^\[Video stills \u2014 frames of (.+) \(\d+:\d\d\), time in each name\b/
const NARRATION_NAME_RE = /^\[Video narration \u2014 what was said in (.+)\]$/

/** A block's kind: a spilled paste (`[Large text attached …]`) is read only where asked (it is the person's words). */
export type HeaderBlockKind = AttachmentKind | 'paste' | 'stills' | 'narration'

/** One header block at the top of a message: its kind, its `- ` lines' values, the line after it. */
export interface HeaderBlock {
  kind: HeaderBlockKind
  /** Paths (a narration block: its one line of words). */
  paths: string[]
  /** The line of its first `- ` line. */
  first: number
  next: number
  /** A recorded video's block: the video's name. */
  clip?: string
}

/** One block at line `i`, or null. A CRLF message reads the same (the CR is not part of a line's value). */
function blockAt(lines: string[], i: number, paste: boolean): HeaderBlock | null {
  const at = (k: number) => lines[k].replace(/\r$/, '')
  const list = (from: number, one: boolean) => {
    const paths: string[] = []
    let j = from
    while (j < lines.length && at(j).startsWith('- ') && at(j).length > 2 && !(one && paths.length)) paths.push(at(j++).slice(2).trim())
    return { paths, next: j }
  }
  const head = at(i)
  const video = VIDEO_LINE_RE.exec(head)
  if (video) {
    const kind = video[1] === 'stills' ? 'stills' : 'narration'
    const clip = (kind === 'stills' ? STILLS_NAME_RE : NARRATION_NAME_RE).exec(head)?.[1] ?? ''
    // The words of a video are one line, never paths.
    const { paths, next } = list(i + 1, kind === 'narration')
    return paths.length ? { kind, paths, first: i + 1, next, clip } : null
  }
  const header = HEADER_LINE_RE.exec(head)
  if (header && (paste || header[1] !== 'Large text')) {
    const { paths, next } = list(i + 1, false)
    // A header with no path line is not one Walnut wrote.
    const kind = header[1] === 'Images' ? 'images' : header[1] === 'Files' ? 'files' : 'paste'
    return paths.length ? { kind, paths, first: i + 1, next } : null
  }
  const context = CONTEXT_LINE_RE.exec(head)
  if (context) {
    const count = context[2] ? Number(context[2]) : 1
    const paths = lines.slice(i + 1, i + 1 + count)
    if (count < 1 || paths.length !== count || paths.some((p) => !p.trim() || p !== p.trim())) return null
    return { kind: 'images', paths, first: i + 1, next: i + 1 + count }
  }
  return null
}

/** How many blocks the top of a message may hold: images, files, a paste, two per recorded video (a message holds up to ten files). */
const MAX_BLOCKS = 24

/**
 * The header blocks at the top of a message's lines, in order, and the line
 * where the words start. `paste`: a spilled paste's block counts as one (the
 * shipping lane copies its file); a reader of the person's words leaves it.
 */
export function readAttachmentBlocks(lines: readonly string[], opts: { paste?: boolean } = {}): { blocks: HeaderBlock[]; end: number } {
  const blocks: HeaderBlock[] = []
  let i = 0
  while (blocks.length < MAX_BLOCKS && i < lines.length) {
    const block = blockAt(lines as string[], i, !!opts.paste)
    if (!block) break
    blocks.push(block)
    i = block.next
    // One blank line ends the block.
    if (i < lines.length && lines[i].replace(/\r$/, '') === '') i++
  }
  return { blocks, end: i }
}

/**
 * Take the attachment header blocks off the front of a message (several, in any
 * order), with their paths. Only a block at the very start counts, with its path
 * lines: a person who types the header words mid-message keeps them.
 */
export function splitAttachmentHeaders(text: string): SplitAttachments {
  const images: string[] = []
  const files: string[] = []
  const stills: string[] = []
  const narration: string[] = []
  const clips: VideoClipRead[] = []
  const none = (): SplitAttachments => ({ text, images, files, stills, narration, clips })
  if (typeof text !== 'string' || !(text.startsWith('[') || text.startsWith('The user attached '))) return none()
  const lines = text.split('\n')
  const { blocks, end } = readAttachmentBlocks(lines)
  if (blocks.length === 0) return none()
  const into: Record<Exclude<HeaderBlockKind, 'paste'>, string[]> = { images, files, stills, narration }
  for (const block of blocks) {
    if (block.kind === 'paste') continue
    into[block.kind].push(...block.paths)
    if (block.clip === undefined) continue
    let clip = clips.find((c) => c.name === block.clip)
    if (!clip) { clip = { name: block.clip, stills: [] }; clips.push(clip) }
    if (block.kind === 'stills') clip.stills.push(...block.paths)
    else clip.narration = block.paths[0]
  }
  return { text: lines.slice(end).join('\n'), images, files, stills, narration, clips }
}
