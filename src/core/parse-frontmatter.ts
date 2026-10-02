/**
 * Tolerant YAML frontmatter parser for notes (gray-matter-style, no new dep).
 *
 * Contract (IMPL-CONTRACT §2.1):
 * - Splits a note's bytes into `{ data, body, raw }` where `raw` is the verbatim
 *   frontmatter block (between the leading `---` fences) preserved byte-for-byte.
 * - Malformed YAML must NEVER throw: the whole file is treated as body, `data={}`.
 *   One bad note can't break the vault index.
 *
 * Also owns the id contract helpers:
 * - `generateNoteId()` → `n_` + base36(time) + 3 random chars (matches qm-/sess- style).
 * - `stampId(bytes, id)` → splice an `id:` line into existing frontmatter, or prepend
 *   a new minimal block, preserving the rest byte-for-byte (no reformat).
 */
import yaml from 'js-yaml'

export interface ParsedFrontmatter {
  /** Parsed YAML object (always an object; `{}` when absent/malformed). */
  data: Record<string, unknown>
  /** Markdown body WITHOUT the frontmatter block. */
  body: string
  /** Verbatim frontmatter block including the `---` fences, or '' when absent. */
  raw: string
  /** True when a leading `---\n…\n---` fence was present (even if YAML was empty). */
  hasFrontmatter: boolean
}

// Leading `---\n … \n---\n?` block. The body starts immediately after the closing fence.
// We capture the inner YAML separately so callers can re-attach `raw` verbatim.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * Parse note bytes into frontmatter data + body. Never throws.
 */
export function parseFrontmatter(bytes: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(bytes)
  if (!match) {
    return { data: {}, body: bytes, raw: '', hasFrontmatter: false }
  }
  const raw = match[0]
  const inner = match[1]
  const body = bytes.slice(raw.length)

  let data: Record<string, unknown> = {}
  try {
    const parsed = yaml.load(inner)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>
    }
    // Non-object YAML (scalar/array) → treat as no usable data, keep body split.
  } catch {
    // Malformed YAML — keep the fence split but expose empty data. Never throw.
    data = {}
  }
  return { data, body, raw, hasFrontmatter: true }
}

/**
 * Generate a stable, opaque note id: `n_` + base36(time) + 3 random base36 chars.
 * Mirrors the project's `qm-`/`sess-` id style.
 */
export function generateNoteId(): string {
  const time = Date.now().toString(36)
  let rand = ''
  for (let i = 0; i < 3; i++) {
    rand += Math.floor(Math.random() * 36).toString(36)
  }
  return `n_${time}${rand}`
}

/** Read the frontmatter `id` from already-parsed data (string or undefined). */
export function readId(data: Record<string, unknown>): string | undefined {
  const id = data.id
  return typeof id === 'string' && id.trim() ? id.trim() : undefined
}

/**
 * Decode the create-time encoded in an `n_<base36-time><3 rand>` id.
 * Returns the epoch-ms timestamp, or NaN for a non-conforming id. Used by the
 * earliest-created-wins merge tie-break (§8.3) when a frontmatter `created`
 * field is absent or equal — the id's own timestamp is the deterministic
 * fallback so two machines always agree on the winner.
 */
export function idTimestamp(id: string): number {
  const m = /^n_([0-9a-z]+)$/.exec(id)
  if (!m) return NaN
  const body = m[1]
  if (body.length <= 3) return NaN
  const timePart = body.slice(0, -3) // strip the 3 random chars
  const t = parseInt(timePart, 36)
  return Number.isFinite(t) ? t : NaN
}

/**
 * Splice an `id:` line into a note's frontmatter, preserving the rest byte-for-byte.
 *
 * - If a frontmatter block exists: insert `id: <id>\n` as the FIRST line inside the
 *   fence (kept stable + greppable). The remaining YAML lines are untouched.
 * - If no frontmatter exists: prepend a minimal `---\nid: <id>\n---\n` block, leaving
 *   the original body unchanged.
 *
 * This is the ONLY transform the indexer applies to a note's bytes (id back-write,
 * §2.4 / §8.3). It does not reformat existing YAML.
 */
export function stampId(bytes: string, id: string): string {
  const match = FRONTMATTER_RE.exec(bytes)
  if (!match) {
    // No frontmatter — prepend a minimal block. Preserve original body verbatim.
    return `---\nid: ${id}\n---\n${bytes}`
  }
  const raw = match[0]
  const inner = match[1]
  const body = bytes.slice(raw.length)
  // Detect the EOL style of the original fence so we don't mix \n and \r\n.
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const newInner = inner.length > 0 ? `id: ${id}${eol}${inner}` : `id: ${id}`
  const newRaw = `---${eol}${newInner}${eol}---${eol}`
  return newRaw + body
}

/**
 * The bytes a note write puts on disk, and the note's id. Content that carries an
 * id is written as sent. Otherwise it gets the id of the note already on disk
 * (`current`), and a NEW id only when there is no such note or it has none
 * (IMPL-CONTRACT §1.2 #3): inbound links key on the id, so a body saved without
 * its frontmatter must not re-identify the note.
 */
export function withNoteId(content: string, current: string | null): { content: string; id: string } {
  const own = readId(parseFrontmatter(content).data)
  if (own) return { content, id: own }
  const id = (current !== null ? readId(parseFrontmatter(current).data) : undefined) ?? generateNoteId()
  return { content: stampId(content, id), id }
}
