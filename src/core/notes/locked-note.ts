/**
 * A locked note on disk (docs/reference/locked-notes.md): a note the person locked with the Walnut
 * master password, so its text is ciphertext in the file and every reader that is not the person
 * (agents, the search index, embeddings, replicas, git, backups, an older client) sees only the
 * stub, a short paragraph saying what the note is.
 *
 *   ---
 *   id: n_abc
 *   walnut_locked: 1
 *   ---
 *   **Locked note.** ...what it is, for any reader...
 *
 *   <!-- walnut-locked-note v1 {"key":"<vault item id>","iv":"<base64>","ct":"<base64>"} -->
 *
 * The ciphertext holds the note's whole text as it was (its own frontmatter included). The envelope
 * is one HTML comment line, so Obsidian and every Markdown renderer hide it, and base64 never holds
 * `-->`. The outer frontmatter keeps the note's id, so links, favorites, moves and the index follow
 * the note as before. No key access here (locked-note-store.ts), and nothing heavier than a file
 * read, so every write path can load the guards at start.
 */
import fsp from 'node:fs/promises'

export const LOCKED_FRONTMATTER_KEY = 'walnut_locked'
export const LOCKED_ENVELOPE_VERSION = 1

/** The paragraph every reader but the person sees. Plain words: an agent reads it as the note. */
/** How the stub opens: the index and the web read a note as locked by its mark and this lead. */
export const LOCKED_STUB_LEAD = '**Locked note.**'

export const LOCKED_NOTE_STUB =
  '**Locked note.** Its owner marked it private: it is written by hand and is very sensitive. ' +
  'Its text is encrypted with the Walnut master password, so agents, search and sync see only this paragraph. ' +
  'Open it in Walnut and press Show to read it.'

/** What an agent is told when it reads, writes or deletes a locked note. */
export const LOCKED_NOTE_AGENT_TEXT =
  'This note is locked by the user: it is private, hand-written and very sensitive. Its text is encrypted ' +
  'with their master password, and Walnut does not show it to agents or let agents change it. ' +
  'Do not try to read or decrypt the file. If the task truly needs it, ask the user.'

export interface LockedEnvelope {
  /** The vault item that holds the key (core/vault/locked-notes-key.ts). */
  key: string
  /** base64 nonce */
  iv: string
  /** base64 AES-256-GCM ciphertext with its tag */
  ct: string
}

export interface ParsedLockedNote {
  /** The file without the envelope line: what every reader but the person may see. */
  stub: string
  envelope: LockedEnvelope
  /** The id the outer frontmatter carries, when it has one. */
  id?: string
}

/**
 * A locked note is what buildLockedNoteText writes: an outer frontmatter block at the very top that
 * carries the mark, and an envelope line after it. A note that only mentions the format (a copy of
 * the doc, an envelope line in a code block) has no mark at its top, so it is a plain note.
 */
const MARK_RE = /^---\r?\n(?:[^\n]*\r?\n)*?walnut_locked:[ \t]*1[ \t]*\r?\n(?:[^\n]*\r?\n)*?---[ \t]*(?:\r?\n|$)/
/** One envelope line, anchored at a line start; `[^\n]` keeps it to that line. */
const ENVELOPE_RE = /^<!-- walnut-locked-note v(\d+) (\{[^\n]*\}) -->[ \t]*(?:\r?\n|$)/m
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const ID_LINE_RE = /^---\r?\n(?:[\s\S]*?\r?\n)?id:[ \t]*["']?([A-Za-z0-9_-]+)["']?[ \t]*\r?\n[\s\S]*?---/

/** Cheap check, for every reader: does this text hold a locked note's envelope? */
export function isLockedNoteText(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes('<!-- walnut-locked-note v') && MARK_RE.test(text) && ENVELOPE_RE.test(text)
}

/**
 * The envelope and stub of a locked note, or null for any other text. A line that names a version
 * this Walnut does not know, or does not parse, still counts as locked (`envelope` null): such a
 * note is never written over as if it were plain, and never shown.
 */
export function parseLockedNote(text: string): ParsedLockedNote | { stub: string; envelope: null; id?: string } | null {
  if (!isLockedNoteText(text)) return null
  const m = ENVELOPE_RE.exec(text)
  if (!m) return null
  const stub = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\n{3,}$/, '\n\n').replace(/\s+$/, '') + '\n'
  const idMatch = ID_LINE_RE.exec(text)
  const id = idMatch?.[1]
  const withId = <T extends object>(o: T) => (id ? { ...o, id } : o)
  if (Number(m[1]) !== LOCKED_ENVELOPE_VERSION) return withId({ stub, envelope: null })
  let raw: unknown
  try { raw = JSON.parse(m[2]) } catch { return withId({ stub, envelope: null }) }
  const e = raw as Partial<LockedEnvelope> | null
  if (!e || typeof e.key !== 'string' || !e.key || typeof e.iv !== 'string' || typeof e.ct !== 'string'
    || !B64_RE.test(e.iv) || !B64_RE.test(e.ct)) return withId({ stub, envelope: null })
  return withId({ stub, envelope: { key: e.key, iv: e.iv, ct: e.ct } })
}

/** What a reader that is not the person gets: the stub for a locked note, the text itself otherwise. */
export function readableNoteText(text: string): string {
  if (!isLockedNoteText(text)) return text
  return parseLockedNote(text)?.stub ?? text
}

/** The file for a locked note: outer frontmatter (the note's id and the mark), the stub, the envelope. */
export function buildLockedNoteText(p: { id?: string; envelope: LockedEnvelope }): string {
  const { key, iv, ct } = p.envelope
  if (!B64_RE.test(iv) || !B64_RE.test(ct) || /[\n"\\]/.test(key)) throw new Error('bad locked-note envelope')
  const fm = ['---', ...(p.id ? [`id: ${p.id}`] : []), `${LOCKED_FRONTMATTER_KEY}: 1`, '---'].join('\n')
  return `${fm}\n${LOCKED_NOTE_STUB}\n\n<!-- walnut-locked-note v${LOCKED_ENVELOPE_VERSION} ${JSON.stringify({ key, iv, ct })} -->\n`
}

/** The additional-data string every locked note's ciphertext is sealed with (crypto.ts seal). */
export function lockedNoteAad(keyItemId: string): string {
  return `walnut-locked-note:v${LOCKED_ENVELOPE_VERSION}:${keyItemId}`
}

export class LockedNoteError extends Error {
  constructor(message: string, public status: number, public code: string, public extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'LockedNoteError'
  }
}

/**
 * Every ordinary write of a note's file calls this with the bytes there now (null: none): a locked
 * note is written only through this module. 423 `note_locked`, with words an agent can act on.
 */
export function assertNotLocked(current: string | null | undefined, what = 'change', next?: string | null): void {
  if (isLockedNoteText(current)) {
    throw new LockedNoteError(`This note is locked, so it cannot ${what} here. ${LOCKED_NOTE_AGENT_TEXT}`, 423, 'note_locked')
  }
  assertNotLockedText(next)
}

/**
 * New text for an ordinary write must not itself be a locked note's file: only lockNote writes one
 * (a copied file would read as locked and could never be edited again). 400 `locked_note_text`.
 */
export function assertNotLockedText(next: string | null | undefined): void {
  if (!isLockedNoteText(next)) return
  throw new LockedNoteError('This text is a locked note\'s file (its mark and envelope): only Walnut\'s Lock writes one. Write the note\'s own text.', 400, 'locked_note_text')
}

/** The same check for a file by its absolute path (a missing file is not locked). */
export async function assertFileNotLocked(absFile: string, what = 'change'): Promise<void> {
  let current: string | null = null
  try { current = await fsp.readFile(absFile, 'utf-8') } catch { return }
  assertNotLocked(current, what)
}
