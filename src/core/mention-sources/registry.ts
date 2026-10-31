/**
 * "@" sources: who can offer rows to the composer's "@" picker beyond tasks and files.
 *
 * Core registers its own (notes, notes-source.ts) at server start; a plugin registers
 * through `walnut.registry.mentionSource(...)` and the handle it gets back withdraws it,
 * so a plugin that is turned off takes its tab with it. A source is two calls:
 *
 *   search(q)    → rows for the picker (title, subtitle, an opaque `ref` the source owns)
 *   resolve(ref) → the text the model receives for a picked row (one short paragraph)
 *
 * Walnut runs both (run.ts): debounced in the browser, under a deadline here, and cached,
 * so a slow or broken source costs its own tab, never the picker. The picked row travels in
 * the message as `<source-ref id="<source id>:<ref>" label="…"/>` (utils/entity-refs.ts)
 * and is resolved at send time into the reference cards (sessions/reference-cards.ts).
 *
 * One id, one source; one keyword, one source. A second registration of an id is refused;
 * a keyword or alias already taken is dropped from the newcomer (it keeps its tab).
 */

import type { Disposable } from '../plugins/disposable.js'

/** One row a source offers. */
export interface MentionSourceItem {
  /** The source's own handle for the row (`user:U123`, a message id, a note path). */
  ref: string
  title: string
  /** One line under the title: who, where, when. */
  subtitle?: string
  /** What the row is (`person`, `channel`, `message`, `note`); drives the icon. */
  kind?: string
  /** Other exact names the row answers to (a handle, an address, a channel name). The
   *  mixed "All" view shows a source's row only when the query equals its title or one
   *  of these, so a plugin never crowds out tasks and files on a loose match. */
  keys?: string[]
}

export interface MentionSearchContext {
  /** Most rows wanted. */
  limit: number
  /** Aborted when the deadline passes or the caller goes away. */
  signal: AbortSignal
}

export interface MentionSourceSpec {
  /** Unique id, also the prefix of every ref this source issues (`slack:user:U1`). */
  id: string
  /** Tab label: "Slack". */
  label: string
  /** "@<keyword> " jumps straight to this source's tab. Lowercase letters and digits. */
  keyword: string
  aliases?: string[]
  /** What the source returns (`person`, `channel`, ...), for the picker's empty states. */
  kinds?: string[]
  /** Tab order: lower first. Core's notes is 10; plugins default to 50. */
  order?: number
  /** Shortest query the source searches. 0 = an empty query asks for its defaults
   *  (frequent people, the newest inbox mail, recently edited notes). Default 0. */
  minChars?: number
  /** Search deadline in ms (200..8000, default 3000). */
  timeoutMs?: number
  /** Also ask this source while the user types in the mixed "All" view (exact matches
   *  only are shown there). Default true; a source whose every search costs a remote
   *  call and whose exact matches are rare (a mail subject) says false. */
  inAll?: boolean
  search(q: string, ctx: MentionSearchContext): Promise<MentionSourceItem[]>
  /** The text the model gets for a picked row, or null when the ref no longer resolves. */
  resolve(ref: string, ctx: { signal: AbortSignal }): Promise<string | null>
}

export interface RegisteredMentionSource {
  spec: MentionSourceSpec
  owner: string
  order: number
  minChars: number
  timeoutMs: number
  /** Keyword plus aliases this source actually owns (taken ones dropped). */
  keywords: string[]
  inAll: boolean
}

// Wide enough for every plugin id (`[a-z0-9._-]`, up to 64) plus `-<local id>`; never ':',
// which separates the source from its ref in a tag id.
export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,95}$/
const KEYWORD_RE = /^[a-z0-9]{1,24}$/
const DEFAULT_ORDER = 50
const DEFAULT_TIMEOUT_MS = 3000

const sources = new Map<string, RegisteredMentionSource>()

function validate(spec: MentionSourceSpec): void {
  if (!spec || typeof spec !== 'object') throw new Error('mention source: a spec object is required')
  if (typeof spec.id !== 'string' || !SOURCE_ID_RE.test(spec.id)) {
    throw new Error(`mention source: id "${String(spec.id)}" must be lowercase letters, digits, ".", "_" and "-"`)
  }
  if (typeof spec.label !== 'string' || !spec.label.trim()) throw new Error(`mention source "${spec.id}": label is required`)
  if (typeof spec.keyword !== 'string' || !KEYWORD_RE.test(spec.keyword)) {
    throw new Error(`mention source "${spec.id}": keyword must be lowercase letters and digits`)
  }
  if (typeof spec.search !== 'function') throw new Error(`mention source "${spec.id}": search(q) is required`)
  if (typeof spec.resolve !== 'function') throw new Error(`mention source "${spec.id}": resolve(ref) is required`)
}

function takenKeywords(exceptId: string): Set<string> {
  const out = new Set<string>()
  for (const s of sources.values()) if (s.spec.id !== exceptId) for (const k of s.keywords) out.add(k)
  return out
}

export function registerMentionSource(owner: string, spec: MentionSourceSpec): Disposable {
  validate(spec)
  const existing = sources.get(spec.id)
  if (existing && existing.owner === owner && owner === 'core') {
    // Core re-registers on every server start in one process (tests): replace in place.
    sources.delete(spec.id)
  } else if (existing) {
    throw new Error(`mention source "${spec.id}" is already registered by ${existing.owner}`)
  }
  const taken = takenKeywords(spec.id)
  const wanted = [spec.keyword, ...(Array.isArray(spec.aliases) ? spec.aliases : [])]
    .map((k) => String(k).toLowerCase())
    .filter((k) => KEYWORD_RE.test(k))
  const keywords = [...new Set(wanted)].filter((k) => !taken.has(k))
  const timeout = typeof spec.timeoutMs === 'number' && Number.isFinite(spec.timeoutMs)
    ? Math.max(200, Math.min(8000, spec.timeoutMs)) : DEFAULT_TIMEOUT_MS
  const entry: RegisteredMentionSource = {
    spec,
    owner,
    order: typeof spec.order === 'number' && Number.isFinite(spec.order) ? spec.order : DEFAULT_ORDER,
    minChars: typeof spec.minChars === 'number' && spec.minChars > 0 ? Math.min(8, Math.floor(spec.minChars)) : 0,
    timeoutMs: timeout,
    keywords,
    inAll: spec.inAll !== false,
  }
  sources.set(spec.id, entry)
  return {
    dispose() {
      if (sources.get(spec.id) === entry) sources.delete(spec.id)
    },
  }
}

/** Every source, in tab order (then label, so the order is stable). */
export function listMentionSources(): RegisteredMentionSource[] {
  return [...sources.values()].sort((a, b) => a.order - b.order || a.spec.label.localeCompare(b.spec.label))
}

export function getMentionSource(id: string): RegisteredMentionSource | undefined {
  return sources.get(id)
}

/** Drop every source of one owner (plugin teardown) or all (tests). */
export function clearMentionSources(owner?: string): void {
  for (const [id, s] of sources) if (owner === undefined || s.owner === owner) sources.delete(id)
}
