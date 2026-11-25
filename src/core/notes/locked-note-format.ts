/**
 * The locked-note file format (docs/reference/locked-notes.md), parsed and built with string
 * operations only: no I/O and no Node import, so the web reads a note by the same rule
 * (web/src/components/notes/locked-note.ts), and no regex ever runs over the whole text (a
 * backtracking one froze every route on a CRLF note).
 *
 *   ---
 *   id: n_abc
 *   walnut_locked: 1
 *   ---
 *   **Locked note.** ...what it is, for any reader...
 *
 *   <!-- walnut-locked-note v1 {"key":"<vault item id>","iv":"<base64>","ct":"<base64>"} -->
 *
 * One definition, two strengths:
 *  - the MARK: the first frontmatter block (the block parseFrontmatter splits off, after a BOM) has
 *    the line `walnut_locked: 1` (`"1"` and `'1'` too). Writers refuse on the mark alone
 *    (looksLockedNoteText): a file an outside editor bent (text after the envelope, a re-indented
 *    line) still keeps its ciphertext.
 *  - LOCKED: the mark, and the last non-blank line is an envelope line. Readers answer the stub
 *    only then (isLockedNoteText).
 * A note that only quotes the format (this doc page, an envelope line in a code block) has neither
 * the mark at its top nor the envelope as its last line, so it is plain.
 *
 * A HIDDEN note (docs/reference/locked-notes.md, "Hidden notes") is plain text on disk whose first
 * frontmatter block has the line `walnut_hidden: 1` (the same value forms). Every reader but the
 * person gets that block and the hidden stub (readableNoteText), and every writer but the person
 * refuses it (looksProtectedNoteText). A text with both marks is a locked note: the lock wins.
 */

export const LOCKED_FRONTMATTER_KEY = 'walnut_locked'
export const HIDDEN_FRONTMATTER_KEY = 'walnut_hidden'
export const LOCKED_ENVELOPE_VERSION = 1

/** How the stub opens. */
export const LOCKED_STUB_LEAD = '**Locked note.**'

/** The paragraph every reader but the person sees. Plain words: an agent reads it as the note. */
export const LOCKED_NOTE_STUB =
  '**Locked note.** Its owner marked it private: it is written by hand and is very sensitive. ' +
  'Its text is encrypted with the Walnut master password, so agents, search and sync see only this paragraph. ' +
  'Open it in Walnut and press Show to read it. ' +
  // An older Walnut or an outside editor has none of the lock checks: this asks it to keep the file as it is.
  'Do not edit or rewrite this file anywhere else: the encrypted text is the line below, and changing it loses the note.'

/** How the hidden stub opens. */
export const HIDDEN_STUB_LEAD = '**Hidden note.**'

/** The paragraph every reader but the person sees of a hidden note, below its frontmatter. */
export const HIDDEN_NOTE_STUB =
  '**Hidden note.** Its owner keeps it away from agents: it is written by hand and private. ' +
  'Agents, search and sync see only this paragraph. Open it in Walnut and press Show to read it.'

/** Which protected kind a note is: locked (its text is ciphertext) or hidden (plain, shown only to the person). */
export type NoteProtection = 'locked' | 'hidden'

export interface LockedEnvelope {
  /** The vault item that holds the key (core/vault/locked-notes-key.ts). */
  key: string
  /** base64 nonce */
  iv: string
  /** base64 AES-256-GCM ciphertext with its tag */
  ct: string
}

export interface ParsedLockedNote {
  /** The outer frontmatter and the stub, no envelope line: what every reader but the person may see. */
  stub: string
  envelope: LockedEnvelope
  /** The id the outer frontmatter carries, when it has one. */
  id?: string
}

const ENVELOPE_OPEN = '<!-- walnut-locked-note v'
const ENVELOPE_CLOSE = ' -->'
/** A reader never gets a line naming the envelope, whatever an outside editor made of it. */
const ENVELOPE_NAME = 'walnut-locked-note'
const BOM = '\uFEFF'
// Each of these runs on one line or one value, never on the whole text, and none nests a quantifier
// (tests/core/notes/locked-note.test.ts checks both).
const MARK_LINE_RE = /^(["']?)walnut_(locked|hidden)\1[ \t]*:[ \t]*(["']?)1\3[ \t]*(?:#|$)/
const ID_LINE_RE = /^id[ \t]*:[ \t]*(["']?)([A-Za-z0-9_-]+)\1[ \t]*(?:#|$)/
const CLOSE_FENCE_RE = /^---[ \t]*$/
const VERSION_RE = /^\d+$/
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/** The line at `pos` without its `\r\n`/`\n`, and where the next one starts (-1: it was the last). */
function lineAt(text: string, pos: number): { line: string; next: number } {
  const nl = text.indexOf('\n', pos)
  const end = nl < 0 ? text.length : nl
  const line = text.slice(pos, end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end)
  return { line, next: nl < 0 ? -1 : nl + 1 }
}

interface Head {
  /** Where the text starts after a BOM. */
  start: number
  /** The lock mark. */
  mark: boolean
  /** The hidden mark. */
  hidden: boolean
  id?: string
  /** Where the line below the opening fence starts. */
  inner: number
  /** Where the closing fence line starts, and where the line after it starts (text.length: none). */
  close: number
  end: number
  /** The opening fence's line end. */
  eol: '\n' | '\r\n'
}

/**
 * The first frontmatter block, as parseFrontmatter splits it (parse-frontmatter.ts FRONTMATTER_RE):
 * a `---` line at the very top (after a BOM), closed by the first `---` line after the one below
 * it. Null when the text has no such block.
 */
function scanHead(text: string): Head | null {
  const start = text.startsWith(BOM) ? 1 : 0
  const open = lineAt(text, start)
  if (open.line !== '---' || open.next < 0) return null
  const eol = text.charCodeAt(open.next - 2) === 13 ? '\r\n' : '\n'
  let mark = false
  let hidden = false
  let id: string | undefined
  let pos = open.next
  for (let n = 0; pos >= 0 && pos <= text.length; n++) {
    const { line, next } = lineAt(text, pos)
    // The line right below the opening fence is always inside (parseFrontmatter's `\n---`).
    if (n > 0 && CLOSE_FENCE_RE.test(line)) {
      return { start, mark, hidden, ...(id ? { id } : {}), inner: open.next, close: pos, end: next < 0 ? text.length : next, eol }
    }
    const m = MARK_LINE_RE.exec(line.trim())
    if (m) {
      if (m[2] === 'locked') mark = true
      else hidden = true
    } else if (id === undefined) {
      const idm = ID_LINE_RE.exec(line)
      if (idm) id = idm[2]
    }
    pos = next
  }
  return null
}

/** The envelope line `<!-- walnut-locked-note v<N> {json} -->` (surrounding spaces aside), or null. */
function envelopeLine(line: string): { version: number; json: string } | null {
  const t = line.trim()
  if (t.length < ENVELOPE_OPEN.length + ENVELOPE_CLOSE.length + 3) return null
  if (!t.startsWith(ENVELOPE_OPEN) || !t.endsWith(ENVELOPE_CLOSE)) return null
  const inner = t.slice(ENVELOPE_OPEN.length, t.length - ENVELOPE_CLOSE.length)
  const sp = inner.indexOf(' ')
  if (sp <= 0 || !VERSION_RE.test(inner.slice(0, sp))) return null
  const json = inner.slice(sp + 1)
  if (!json.startsWith('{') || !json.endsWith('}')) return null
  return { version: Number(inner.slice(0, sp)), json }
}

/** The last non-blank line of the text. */
function lastLine(text: string): string {
  const t = text.trimEnd()
  return t.slice(t.lastIndexOf('\n') + 1)
}

/** The mark: the first frontmatter block has `walnut_locked: 1`. What every writer refuses on. */
export function hasLockMark(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || !text.includes(LOCKED_FRONTMATTER_KEY)) return false
  return scanHead(text)?.mark === true
}

/** The hidden mark: the first frontmatter block has `walnut_hidden: 1`. */
export function hasHiddenMark(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || !text.includes(HIDDEN_FRONTMATTER_KEY)) return false
  return scanHead(text)?.hidden === true
}

/** Which mark the text carries ('locked' when it has both: the lock wins), or null for a plain note. */
export function noteProtection(text: string | null | undefined): NoteProtection | null {
  if (typeof text !== 'string' || !text.includes('walnut_')) return null
  const head = scanHead(text)
  return head?.mark ? 'locked' : head?.hidden ? 'hidden' : null
}

/**
 * Fail-closed, for every writer: the text carries the lock mark or the hidden mark, whatever state
 * its envelope is in. Only the person writes a hidden note, and nobody but Lock a locked one.
 */
export function looksProtectedNoteText(text: string | null | undefined): boolean {
  return noteProtection(text) !== null
}

/** A hidden note and not a locked one: the person reads it in full, everyone else its stub. */
export function isHiddenNoteText(text: string | null | undefined): boolean {
  return noteProtection(text) === 'hidden'
}

/** The lock mark alone, whatever state its envelope is in (the store's own checks; writers use looksProtectedNoteText). */
export function looksLockedNoteText(text: string | null | undefined): boolean {
  return hasLockMark(text)
}

/** Strict, for readers: the mark, and the last non-blank line is an envelope line. */
export function isLockedNoteText(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || !text.includes(ENVELOPE_OPEN)) return false
  return hasLockMark(text) && envelopeLine(lastLine(text)) !== null
}

/**
 * The text without any envelope line, the BOM and trailing blank lines: the outer frontmatter and
 * the stub. Every line that names the envelope goes, not only the last (a second copy of the line
 * an outside editor left must never reach a reader).
 */
function stubOf(text: string, start: number): string {
  let out = ''
  for (let pos = start; pos >= 0 && pos < text.length;) {
    const nl = text.indexOf('\n', pos)
    const end = nl < 0 ? text.length : nl + 1
    const raw = text.slice(pos, end)
    if (!raw.includes(ENVELOPE_NAME)) out += raw
    pos = nl < 0 ? -1 : end
  }
  return `${out.trimEnd()}\n`
}

/**
 * The envelope and stub of a locked note, or null for any other text. A last line that names a
 * version this Walnut does not know, or does not parse, still counts as locked (`envelope` null):
 * such a note is never written over as if it were plain, and never shown.
 */
export function parseLockedNote(text: string): ParsedLockedNote | { stub: string; envelope: null; id?: string } | null {
  if (!isLockedNoteText(text)) return null
  const head = scanHead(text)!
  const line = envelopeLine(lastLine(text))!
  const stub = stubOf(text, head.start)
  const withId = <T extends object>(o: T) => (head.id ? { ...o, id: head.id } : o)
  if (line.version !== LOCKED_ENVELOPE_VERSION) return withId({ stub, envelope: null })
  let raw: unknown
  try { raw = JSON.parse(line.json) } catch { return withId({ stub, envelope: null }) }
  const e = raw as Partial<LockedEnvelope> | null
  if (!e || typeof e.key !== 'string' || !e.key || typeof e.iv !== 'string' || typeof e.ct !== 'string'
    || !B64_RE.test(e.iv) || !B64_RE.test(e.ct)) return withId({ stub, envelope: null })
  return withId({ stub, envelope: { key: e.key, iv: e.iv, ct: e.ct } })
}

/** A hidden note's first frontmatter block (no BOM) and the hidden stub: no line of its body. */
function hiddenStubOf(text: string, head: Head): string {
  const block = text.slice(head.start, head.end)
  return `${block}${block.endsWith('\n') ? '' : head.eol}${HIDDEN_NOTE_STUB}${head.eol}`
}

/**
 * What a reader that is not the person gets of a note, and which kind it is: the stub of a locked
 * note, the frontmatter and stub of a hidden one (any text with the hidden mark that is not a
 * readable locked note, so a bent locked file with both marks shows no body either), the text
 * itself otherwise.
 */
export function noteForReader(text: string): { content: string; locked?: true; hidden?: true } {
  const locked = parseLockedNote(text)
  if (locked) return { content: locked.stub, locked: true }
  if (text.includes(HIDDEN_FRONTMATTER_KEY)) {
    const head = scanHead(text)
    if (head?.hidden) return { content: hiddenStubOf(text, head), hidden: true }
  }
  return { content: text }
}

/** What a reader that is not the person gets: the stub for a locked or hidden note, the text itself otherwise. */
export function readableNoteText(text: string): string {
  return noteForReader(text).content
}

/**
 * The text with `walnut_hidden: 1` as the last line of its first frontmatter block (a new block
 * when it has none), everything else byte for byte. A text already hidden comes back as it is.
 */
export function withHiddenMark(text: string): string {
  const head = scanHead(text)
  if (head?.hidden) return text
  if (!head) {
    const start = text.startsWith(BOM) ? 1 : 0
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    return `${text.slice(0, start)}---${eol}${HIDDEN_FRONTMATTER_KEY}: 1${eol}---${eol}${text.slice(start)}`
  }
  return `${text.slice(0, head.close)}${HIDDEN_FRONTMATTER_KEY}: 1${head.eol}${text.slice(head.close)}`
}

/**
 * The text without the hidden mark's lines in its first frontmatter block; a block left with no
 * line goes too (an empty block would read its closing fence as its first line).
 */
export function withoutHiddenMark(text: string): string {
  const head = scanHead(text)
  if (!head?.hidden) return text
  let kept = ''
  for (let pos = head.inner; pos >= 0 && pos < head.close;) {
    const { line, next } = lineAt(text, pos)
    const end = next < 0 || next > head.close ? head.close : next
    const m = MARK_LINE_RE.exec(line.trim())
    if (!m || m[2] !== 'hidden') kept += text.slice(pos, end)
    pos = next
  }
  if (!kept) return text.slice(0, head.start) + text.slice(head.end)
  return text.slice(0, head.inner) + kept + text.slice(head.close)
}

/** The file for a locked note: outer frontmatter (the note's id and the mark), the stub, the envelope. */
export function buildLockedNoteText(p: { id?: string; envelope: LockedEnvelope }): string {
  const { key, iv, ct } = p.envelope
  if (!B64_RE.test(iv) || !B64_RE.test(ct) || /[\n"\\]/.test(key)) throw new Error('bad locked-note envelope')
  const fm = ['---', ...(p.id ? [`id: ${p.id}`] : []), `${LOCKED_FRONTMATTER_KEY}: 1`, '---'].join('\n')
  return `${fm}\n${LOCKED_NOTE_STUB}\n\n${ENVELOPE_OPEN}${LOCKED_ENVELOPE_VERSION} ${JSON.stringify({ key, iv, ct })}${ENVELOPE_CLOSE}\n`
}

/** The additional-data string every locked note's ciphertext is sealed with (crypto.ts seal). */
export function lockedNoteAad(keyItemId: string): string {
  return `walnut-locked-note:v${LOCKED_ENVELOPE_VERSION}:${keyItemId}`
}
