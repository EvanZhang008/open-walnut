/**
 * The tag model, shared by the server and the web (browser-safe: no imports).
 *
 * A tag is always a key:value pair: `ticket:V1234567890`, `sev:2`, `team:marina`. The key is the
 * text before the first colon (lowercase letters, digits, `.`, `_`, `-`), the value everything
 * after it. Every write stores tags in this form (normalizeTags), and every read does the same, so
 * a plain word from an older client, an agent or a sync plugin keeps its meaning as a label:
 * `oncall` becomes `label:oncall`.
 *
 * Two keys are Walnut's own and never stored: `created:` and `updated:`, the task's creation and
 * last-update dates in local time (`created:2026-10-01`). They are worked out from the task when
 * asked for (dateTags), hidden on the pills by default like any tag a rule hides, and a filter or
 * a search names them like any other tag. A write naming one keeps the text as a label instead.
 */

/** The key a tag written without one gets. */
export const LABEL_KEY = 'label'
/** The keys Walnut derives from the task itself; never stored. */
export const DERIVED_TAG_KEYS = ['created', 'updated'] as const
export type DerivedTagKey = typeof DERIVED_TAG_KEYS[number]

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_TAG_LENGTH = 200

export interface TagParts {
  key: string
  value: string
}

/** A stored tag's key and value; undefined for text that is not a key:value pair. */
export function parseTag(tag: string): TagParts | undefined {
  const colon = tag.indexOf(':')
  if (colon <= 0 || colon === tag.length - 1) return undefined
  const key = tag.slice(0, colon)
  return KEY_RE.test(key) ? { key, value: tag.slice(colon + 1) } : undefined
}

export function isDerivedTagKey(key: string): key is DerivedTagKey {
  return (DERIVED_TAG_KEYS as readonly string[]).includes(key)
}

/** True for `created:…` / `updated:…`: a date Walnut works out, never a stored tag. */
export function isDerivedTag(tag: string): boolean {
  const parts = parseTag(tag)
  return !!parts && isDerivedTagKey(parts.key)
}

/** A key a person may type before the colon. */
export function isTagKey(key: string): boolean {
  return KEY_RE.test(key)
}

export interface NormalizeTagOptions {
  /** Keep `created:` / `updated:` as they are: a filter or a search may name them, a write may
   *  not (it would store a date Walnut works out). */
  derived?: boolean
}

/** A tag in stored form, or undefined for text with nothing in it. Whitespace runs fold to one
 *  space, the key is lowercased, and text with no usable key (or a derived one) becomes a label. */
export function normalizeTag(raw: unknown, options: NormalizeTagOptions = {}): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  const colon = text.indexOf(':')
  if (colon > 0) {
    const key = text.slice(0, colon).trim().toLowerCase()
    const value = text.slice(colon + 1).trim()
    if (value && KEY_RE.test(key) && (options.derived || !isDerivedTagKey(key))) return clip(`${key}:${value}`)
  }
  const label = text.replace(/^[:\s]+|[:\s]+$/g, '')
  return label ? clip(`${LABEL_KEY}:${label}`) : undefined
}

/** Cut to the stored length, never through an emoji's surrogate pair, never leaving a space. */
function clip(tag: string): string {
  return tag.length <= MAX_TAG_LENGTH ? tag : tag.slice(0, MAX_TAG_LENGTH).replace(/[\s\uD800-\uDBFF]+$/, '')
}

// Plain printable ASCII with a lowercase key: certainly in stored form (the common case, checked
// without rebuilding the tag). Anything else is checked by normalizing it.
const FAST_NORMAL_RE = /^(?!.* {2})[a-z0-9][a-z0-9._-]{0,63}:[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

/** True for a tag already in stored form. */
export function isNormalTag(tag: unknown): boolean {
  if (typeof tag !== 'string') return false
  if (tag.length <= MAX_TAG_LENGTH && FAST_NORMAL_RE.test(tag)) return !isDerivedTagKey(tag.slice(0, tag.indexOf(':')))
  return normalizeTag(tag) === tag
}

/** Tags in stored form, in order, each once. */
export function normalizeTags(raw: readonly unknown[] | undefined, options: NormalizeTagOptions = {}): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const one of raw ?? []) {
    const tag = normalizeTag(one, options)
    if (tag && !seen.has(tag)) { seen.add(tag); out.push(tag) }
  }
  return out
}

/** True when every tag is already in stored form (no rewrite needed). */
export function tagsAreNormal(raw: readonly unknown[] | undefined): boolean {
  if (!raw) return true
  if (!raw.every(isNormalTag)) return false
  return raw.length < 2 || new Set(raw).size === raw.length
}

/** Why a tag someone typed cannot be kept as typed, or undefined when it can. A person is told
 *  (`oncall` needs a key); a program writing a plain word gets a label instead. */
export function tagInputProblem(raw: string): string | undefined {
  const text = raw.trim()
  if (!text) return undefined
  const colon = text.indexOf(':')
  if (colon <= 0 || colon === text.length - 1) {
    const word = text.replace(/^[:\s]+|[:\s]+$/g, '')
    return word ? `A tag is key:value, like team:marina, or ${LABEL_KEY}:${word} for a plain word.` : 'A tag is key:value, like team:marina or sev:2.'
  }
  const key = text.slice(0, colon).trim().toLowerCase()
  if (isDerivedTagKey(key)) return `${key}: is the task's own date; it is searchable already.`
  if (!KEY_RE.test(key)) return 'A tag key is letters, digits, ".", "_" or "-", like team or sev.'
  return undefined
}

const dayFormats = new Map<string, Intl.DateTimeFormat>()

/** `YYYY-MM-DD` of an ISO time in a time zone (the local one when none is given). */
export function localDay(iso: string | undefined, timeZone?: string): string | undefined {
  const at = Date.parse(iso ?? '')
  if (!Number.isFinite(at)) return undefined
  const zone = timeZone ?? ''
  let format = dayFormats.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone ? { timeZone } : {}) })
    dayFormats.set(zone, format)
  }
  return format.format(at)
}

/** The task's derived date tags: `created:<day>`, `updated:<day>`. */
export function dateTags(task: { created_at?: string; updated_at?: string }, timeZone?: string): string[] {
  const out: string[] = []
  const created = localDay(task.created_at, timeZone)
  if (created) out.push(`created:${created}`)
  const updated = localDay(task.updated_at, timeZone)
  if (updated) out.push(`updated:${updated}`)
  return out
}

/** Stored tags plus the derived date tags: what a filter or a search matches against. */
export function effectiveTags(task: { tags?: readonly string[]; created_at?: string; updated_at?: string }, timeZone?: string): string[] {
  return [...(task.tags ?? []), ...dateTags(task, timeZone)]
}

/** True when any of these tags names a derived key (a query that needs effectiveTags). */
export function namesDerivedTag(tags: readonly string[] | undefined): boolean {
  return !!tags?.some(isDerivedTag)
}
