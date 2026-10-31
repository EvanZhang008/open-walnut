/**
 * Running "@" sources (registry.ts) so a slow or broken one costs only its own rows.
 *
 *   searchMentionSource  one source, one query: a deadline (the source's timeoutMs), a
 *                        result cache (60 s, keyed by source + query + limit) and a shared
 *                        in-flight promise, so the browser's keystrokes and a second open
 *                        picker never ask a plugin the same thing twice at once.
 *   describeSourceRef    the source label and row kind core itself knows for a tag id
 *                        (the card's head, the same for every source).
 *   resolveSourceRefs    the refs of one outgoing message, in parallel, under ONE deadline
 *                        for all of them (a send never waits on a plugin longer than that).
 *                        A resolved text is cached for 2 minutes.
 *
 * Neither throws: a failure is an answer (`error` on the search, a missing entry on the
 * resolve), because both run inside a picker and a send path.
 */

import { log } from '../../logging/index.js'
import { getMentionSource, listMentionSources, type MentionSourceItem, type RegisteredMentionSource } from './registry.js'
import { ensureCoreMentionSources } from './notes-source.js'

export interface MentionSearchAnswer {
  items: MentionSourceItem[]
  /** The source did not answer in time, or failed; `items` is then empty. */
  error?: 'timeout' | 'failed' | 'unknown_source'
  message?: string
  cached?: boolean
  tookMs: number
}

const SEARCH_TTL_MS = 60_000
const SEARCH_CACHE_CAP = 300
const RESOLVE_TTL_MS = 2 * 60_000
const RESOLVE_CACHE_CAP = 300
/** Longest a resolved text may run, in code points. */
export const RESOLVE_TEXT_LIMIT = 1200
const MAX_LIMIT = 30

const REF_KIND_CAP = 2000

const searchCache = new Map<string, { at: number; items: MentionSourceItem[] }>()
/** Tag id → the kind its row had when a search offered it, so the card can say
 *  "Slack channel" for a row picked from a source with several kinds. */
const refKinds = new Map<string, string>()
const inFlight = new Map<string, Promise<MentionSearchAnswer>>()
const resolveCache = new Map<string, { at: number; text: string }>()

function remember<V>(map: Map<string, V>, cap: number, key: string, value: V): void {
  map.delete(key)
  if (map.size >= cap) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

/** Keep only well-formed rows, with bounded strings, and at most `limit` of them. */
function cleanItems(raw: unknown, limit: number): MentionSourceItem[] {
  if (!Array.isArray(raw)) return []
  const out: MentionSourceItem[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const row = r as Record<string, unknown>
    const ref = typeof row.ref === 'string' ? row.ref.trim() : ''
    const title = typeof row.title === 'string' ? row.title.replace(/\s+/g, ' ').trim() : ''
    if (!ref || !title || ref.length > 512 || seen.has(ref)) continue
    seen.add(ref)
    const item: MentionSourceItem = { ref, title: title.slice(0, 200) }
    if (typeof row.subtitle === 'string' && row.subtitle.trim()) item.subtitle = row.subtitle.replace(/\s+/g, ' ').trim().slice(0, 240)
    if (typeof row.kind === 'string' && row.kind.trim()) item.kind = row.kind.trim().slice(0, 24)
    if (Array.isArray(row.keys)) {
      const keys = row.keys.filter((k): k is string => typeof k === 'string' && !!k.trim()).map((k) => k.trim().slice(0, 120)).slice(0, 6)
      if (keys.length) item.keys = keys
    }
    out.push(item)
    if (out.length >= limit) break
  }
  return out
}

function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; timeout: boolean; message: string }> {
  const controller = new AbortController()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      controller.abort()
      resolve({ ok: false, timeout: true, message: `no answer in ${ms} ms` })
    }, ms)
    Promise.resolve()
      .then(() => run(controller.signal))
      .then((value) => { clearTimeout(timer); resolve({ ok: true, value }) })
      .catch((err) => {
        clearTimeout(timer)
        resolve({ ok: false, timeout: false, message: err instanceof Error ? err.message : String(err) })
      })
  })
}

function rememberKinds(sourceId: string, items: readonly MentionSourceItem[]): void {
  for (const item of items) if (item.kind) remember(refKinds, REF_KIND_CAP, `${sourceId}:${item.ref}`, item.kind)
}

export async function searchMentionSource(sourceId: string, rawQ: string, rawLimit = 12): Promise<MentionSearchAnswer> {
  const started = Date.now()
  ensureCoreMentionSources()
  const source = getMentionSource(sourceId)
  if (!source) return { items: [], error: 'unknown_source', tookMs: 0 }
  const q = rawQ.replace(/\s+/g, ' ').trim().slice(0, 200)
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit) || 12))
  if (q.length < source.minChars) return { items: [], tookMs: 0 }
  const key = `${sourceId}\u0000${limit}\u0000${q.toLowerCase()}`
  const hit = searchCache.get(key)
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) {
    rememberKinds(sourceId, hit.items)
    return { items: hit.items, cached: true, tookMs: 0 }
  }
  const pending = inFlight.get(key)
  if (pending) return pending
  const run = (async (): Promise<MentionSearchAnswer> => {
    const answer = await withDeadline(source.timeoutMs, (signal) => source.spec.search(q, { limit, signal }))
    const tookMs = Date.now() - started
    if (!answer.ok) {
      log.web.debug('mention source search failed', { sourceId, timeout: answer.timeout, error: answer.message, tookMs })
      return { items: [], error: answer.timeout ? 'timeout' : 'failed', message: answer.message.slice(0, 200), tookMs }
    }
    const items = cleanItems(answer.value, limit)
    remember(searchCache, SEARCH_CACHE_CAP, key, { at: Date.now(), items })
    rememberKinds(sourceId, items)
    return { items, tookMs }
  })()
  inFlight.set(key, run)
  try { return await run } finally { inFlight.delete(key) }
}

/** Code-point-safe cut, every whitespace run (newlines too) collapsed: a card is one
 *  line, so a source's text can never start a line that reads as another card. */
function condense(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const points = [...flat]
  return points.length <= RESOLVE_TEXT_LIMIT ? flat : `${points.slice(0, RESOLVE_TEXT_LIMIT).join('')}…`
}

/** Split a tag id (`slack:user:U1`) into its source and the source's own ref. */
export function splitSourceRefId(id: string): { sourceId: string; ref: string } | null {
  const i = id.indexOf(':')
  if (i <= 0 || i === id.length - 1) return null
  return { sourceId: id.slice(0, i), ref: id.slice(i + 1) }
}

/**
 * Resolve the source refs of one message. Returns tag id → text for the ones that
 * resolved; a ref missing from the map gets the fallback card (its label and id).
 */
export async function resolveSourceRefs(ids: string[], deadlineMs = 2500): Promise<Map<string, string>> {
  ensureCoreMentionSources()
  const out = new Map<string, string>()
  const todo: Array<{ id: string; sourceId: string; ref: string }> = []
  for (const id of new Set(ids)) {
    const parts = splitSourceRefId(id)
    if (!parts || !getMentionSource(parts.sourceId)) continue
    const hit = resolveCache.get(id)
    if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) { out.set(id, hit.text); continue }
    todo.push({ id, ...parts })
  }
  if (todo.length === 0) return out
  await Promise.all(todo.map(async ({ id, sourceId, ref }) => {
    const source = getMentionSource(sourceId)
    if (!source) return
    const answer = await withDeadline(deadlineMs, (signal) => source.spec.resolve(ref, { signal }))
    if (!answer.ok) {
      log.web.debug('mention source resolve failed', { sourceId, ref, timeout: answer.timeout, error: answer.message })
      return
    }
    if (typeof answer.value !== 'string' || !answer.value.trim()) return
    const text = condense(answer.value)
    remember(resolveCache, RESOLVE_CACHE_CAP, id, { at: Date.now(), text })
    out.set(id, text)
  }))
  return out
}

/**
 * What core itself knows about a tag id, for the head of its card: the source's label
 * ("Slack") and the row's kind ("channel"). From the row a search offered, else the
 * source's `kindOf`, else its one kind when it has only one. A source no longer
 * registered (its plugin turned off) gives its id and no kind.
 */
export function describeSourceRef(id: string): { source: string; kind?: string } {
  ensureCoreMentionSources()
  const parts = splitSourceRefId(id)
  if (!parts) return { source: id }
  const source = getMentionSource(parts.sourceId)
  if (!source) return { source: parts.sourceId }
  let kind = refKinds.get(id)
  if (!kind && typeof source.spec.kindOf === 'function') {
    try {
      const k = source.spec.kindOf(parts.ref)
      if (typeof k === 'string' && k.trim()) kind = k.trim().slice(0, 24)
    } catch { /* a plugin's throw costs the kind word, not the card */ }
  }
  const kinds = Array.isArray(source.spec.kinds) ? source.spec.kinds.filter((k) => typeof k === 'string' && k) : []
  if (!kind && kinds.length === 1) kind = kinds[0]
  return { source: source.spec.label.trim() || parts.sourceId, ...(kind ? { kind } : {}) }
}

/** The sources the picker shows, core ones included. */
export function mentionSourcesNow(): RegisteredMentionSource[] {
  ensureCoreMentionSources()
  return listMentionSources()
}

/** Test-only reset. */
export function __resetMentionSourceCaches(): void {
  searchCache.clear()
  inFlight.clear()
  resolveCache.clear()
  refKinds.clear()
}
