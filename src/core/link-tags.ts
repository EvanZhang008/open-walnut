/**
 * Link tags: a task's external links (an issue, a pull request, a code review, a ticket) kept as
 * ordinary key:value tags whose value is the URL (`pr:https://github.com/acme/app/pull/12`).
 * Browser-safe (imports only tag-model.ts): the web draws the short label and opens the URL.
 *
 * Two ways a link becomes a tag (link-tags-apply.ts): a URL a person sends into the session that
 * a link pattern recognises, and the LINKS field of the session's turn-end self-report, which
 * names the kind of every link no pattern knows. A link pattern is a regex over the text whose
 * whole match is the link's canonical URL, under a tag key. Walnut ships patterns for public
 * forges and trackers; the user's config (`link_tags`, key to regex) adds its own, and a user
 * entry replaces Walnut's for the same key (`''` turns that key off).
 */

import { LINK_KEY, MAX_TAG_LENGTH, isTagKey, parseTag } from './tag-model.js'

export interface LinkPattern {
  key: string
  /** A regex source; its whole match is the link's URL. */
  match: string
}

export const DEFAULT_LINK_PATTERNS: readonly LinkPattern[] = [
  { key: 'pr', match: String.raw`https?://github\.com/[\w.-]+/[\w.-]+/pull/\d+` },
  { key: 'issue', match: String.raw`https?://github\.com/[\w.-]+/[\w.-]+/issues/\d+` },
  { key: 'mr', match: String.raw`https?://gitlab\.com/[\w.-]+(?:/[\w.-]+)+/-/merge_requests/\d+` },
  { key: 'issue', match: String.raw`https?://gitlab\.com/[\w.-]+(?:/[\w.-]+)+/-/issues/\d+` },
  { key: 'ticket', match: String.raw`https?://[\w-]+\.atlassian\.net/browse/[A-Z][A-Z0-9]+-\d+` },
  { key: 'ticket', match: String.raw`https?://linear\.app/[\w-]+/issue/[A-Z][A-Z0-9]+-\d+` },
  { key: 'thread', match: String.raw`https?://[\w-]+(?:\.enterprise)?\.slack\.com/archives/[A-Z0-9]+/p\d+` },
]

/** The key a link gets when nothing names its kind. */
export const LINK_FALLBACK_KEY = LINK_KEY
const MAX_LINK_URL = 190
const URL_RE = /^https?:\/\/[^\s]+$/i
const TRAILING_NOISE_RE = /[.,;:!?'"`*_)\]}>]+$/

/** The patterns in force: Walnut's, with a user entry replacing Walnut's for its key. */
export function effectiveLinkPatterns(user: Record<string, string> | undefined): LinkPattern[] {
  const overridden = new Set<string>()
  const own: LinkPattern[] = []
  for (const [rawKey, rawMatch] of Object.entries(user ?? {})) {
    const key = rawKey.trim().toLowerCase()
    if (!isTagKey(key)) continue
    overridden.add(key)
    if (typeof rawMatch === 'string' && rawMatch.trim()) own.push({ key, match: rawMatch.trim() })
  }
  return [...own, ...DEFAULT_LINK_PATTERNS.filter((p) => !overridden.has(p.key))]
}

/** A URL in the form two mentions of one link share: no fragment, no trailing slash or
 *  sentence punctuation, lowercase scheme and host. Undefined for text that is not an
 *  http(s) URL short enough to be a tag. */
export function canonicalLinkUrl(raw: string): string | undefined {
  let text = raw.trim().replace(/^<|>$/g, '')
  for (let prev = ''; prev !== text;) { prev = text; text = text.replace(TRAILING_NOISE_RE, '') }
  if (!URL_RE.test(text)) return undefined
  let url: URL
  try { url = new URL(text) } catch { return undefined }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  url.hash = ''
  const out = url.toString().replace(/\/+$/, '').replace(/\/(?=\?)/, '')
  return out.length <= MAX_LINK_URL ? out : undefined
}

interface CompiledPattern { key: string; re: RegExp }

const compileCache = new Map<string, CompiledPattern | null>()

/** A pattern anchored at the start of one URL candidate (never run over the whole text). */
function compile(pattern: LinkPattern): CompiledPattern | null {
  const id = `${pattern.key}\u0000${pattern.match}`
  let hit = compileCache.get(id)
  if (hit === undefined) {
    try { hit = { key: pattern.key, re: new RegExp(`^(?:${pattern.match})`, 'i') } } catch { hit = null }
    if (compileCache.size > 200) compileCache.clear()
    compileCache.set(id, hit)
  }
  return hit
}

/** Text scanned per call: a pasted log is cut, never a stall. */
const MAX_SCAN = 100_000
/** A URL candidate: everything from the scheme up to whitespace or a quote, at most this long.
 *  Patterns only ever see one short candidate, so a slow user regex stays bounded. */
const CANDIDATE_RE = /https?:\/\/[^\s<>"'`]+/gi
const MAX_CANDIDATE = 400

/** The URL candidates in the text, in order. */
function urlCandidates(text: string): string[] {
  const body = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text
  return [...body.matchAll(CANDIDATE_RE)].map((m) => m[0].slice(0, MAX_CANDIDATE))
}

/** The link tag a pattern makes of one URL candidate, or undefined when none recognises it.
 *  The pattern's match, not the whole candidate, is the URL, so `…/pull/7/files` and
 *  `…/pull/7?x=1` are the same link as `…/pull/7` wherever they were mentioned. */
function patternTag(candidate: string, patterns: readonly LinkPattern[]): { tag: string; url: string } | undefined {
  for (const pattern of patterns) {
    const m = compile(pattern)?.re.exec(candidate)
    const url = m && m[0] ? canonicalLinkUrl(m[0]) : undefined
    if (url) return { tag: `${pattern.key}:${url}`, url }
  }
  return undefined
}

/** Every link the patterns recognise in the text, as tags, first mention first, each URL once. */
export function linkTagsInText(text: string, patterns: readonly LinkPattern[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const candidate of urlCandidates(text)) {
    const hit = patternTag(candidate, patterns)
    if (!hit || seen.has(hit.url)) continue
    seen.add(hit.url)
    out.push(hit.tag)
  }
  return out
}

/** Keys that say a link exists but not what it is: a file type or the word for a link. A link
 *  tag under one of them is renamed when a better kind for the same target arrives. */
const GENERIC_LINK_KEYS: ReadonlySet<string> = new Set(['file', 'link', 'path', 'url', 'html', 'htm', 'md', 'txt', 'pdf', 'json'])

export function isGenericLinkKey(key: string): boolean {
  return GENERIC_LINK_KEYS.has(key)
}

/** The kind a session named, as a tag key of one or two words (`design doc` becomes
 *  `design-doc`), or undefined when it is longer or not a key. */
export function linkKind(named: string): string | undefined {
  const words = named.trim().toLowerCase().split(/[\s_-]+/).filter(Boolean)
  if (words.length === 0 || words.length > 2) return undefined
  const key = words.join('-')
  return key.length <= 24 && isTagKey(key) ? key : undefined
}

/** Whether a file is a document a person comes back to review (an HTML explainer, a design doc,
 *  a plan, a report). Only these become link tags: a screenshot, a log, a script, a config or a
 *  data file is something the work used along the way, not what it is about. */
export function isReviewablePath(path: string): boolean {
  return /\.(?:html?|md|markdown|pdf|docx)$/i.test(path)
}

/** What a file most likely is, from its name, for a file nobody named well: one or two words,
 *  never `file` unless the name says nothing at all. */
export function pathKind(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (/design/.test(name)) return 'design-doc'
  if (/plan|roadmap/.test(name)) return 'plan'
  if (/report|result|summary|explainer|review/.test(name)) return 'report'
  if (/^(?:claude|agents|readme)\.md$|note/.test(name)) return 'notes'
  if (/\.html?$/.test(name)) return 'report'
  if (/\.(?:png|jpe?g|gif|webp|svg)$/.test(name)) return 'image'
  if (/\.(?:mp4|mov|webm)$/.test(name)) return 'video'
  if (/\.(?:py|sh|ts|js|mjs|rb|go)$/.test(name)) return 'script'
  if (/\.(?:ya?ml|json|toml|ini|plist)$/.test(name)) return 'config'
  if (/\.log$/.test(name)) return 'log'
  if (/\.(?:csv|tsv|xlsx?)$/.test(name)) return 'data'
  if (/\.(?:md|txt|pdf|docx?)$/.test(name)) return 'doc'
  return 'file'
}

/** The key a link pill shows: the tag's own, except a file under a generic key, which reads as
 *  what the file is (`file:/…/plan.md` shows `plan`). */
export function linkTagKey(tag: string): string | undefined {
  if (!isLinkTag(tag)) return undefined
  const key = tag.slice(0, tag.indexOf(':'))
  const path = linkPathOfTag(tag)
  return path && isGenericLinkKey(key) ? pathKind(path) : key
}

/** The links a self-report's LINKS field names (`- <kind>: <url or absolute path> (<name>)` per
 *  line), as tags with the name the session gave each (1 to 3 words, optional). A pattern's key
 *  and URL win over the kind and the exact URL the session wrote, so a link reads the same however
 *  it reached the task. */
export function linkEntriesFromField(field: string, patterns: readonly LinkPattern[]): { tag: string; name?: string }[] {
  const out: { tag: string; name?: string }[] = []
  const seen = new Set<string>()
  const named = (rest: string) => normalizeLinkName(rest.replace(/^[\s)\]]*(?:[-–—:=,]\s*)?/, ''))
  for (const rawLine of field.split('\n')) {
    const line = rawLine.replace(/^[\s>*+-]*(?:\d+[.)]\s*)?/, '').trim()
    const urlAt = line.search(/https?:\/\//i)
    if (urlAt < 0) {
      // A file to open (`- html: /tmp/run/result.html (Run result)`): its kind before the colon,
      // the path after, then its name.
      const clean = line.replace(/[*`[\]<>]/g, '')
      // The path runs to the first space; a name in parentheses right after it is the name.
      const m = /^([^:]{1,40}?)\s*[:=]\s*(\/\S+?|~\/\S+?)(?=\s|\((?=[^)]*\)\s*$)|$)/.exec(clean)
      const path = m ? canonicalLinkPath(m[2]!) : undefined
      if (!m || !path || !isReviewablePath(path) || seen.has(path)) continue
      seen.add(path)
      // `plan (v2)` is a plan: what follows the kind in parentheses is not part of it.
      const kind = linkKind(m[1]!.replace(/\(.*$/, ''))
      const name = named(clean.slice(m.index + m[0].length))
      out.push({ tag: `${kind && !isGenericLinkKey(kind) ? kind : pathKind(path)}:${path}`, ...(name ? { name } : {}) })
      continue
    }
    const candidate = urlCandidates(line.slice(urlAt))[0]
    if (!candidate) continue
    const bare = candidate.replace(/[)\]]+.*$/, '')
    const hit = patternTag(candidate, patterns)
    const url = hit?.url ?? canonicalLinkUrl(bare)
    if (!url || seen.has(url)) continue
    const kindText = line.slice(0, urlAt).replace(/[*`[\]()<>]/g, '').replace(/[:=\-\s]+$/, '')
    seen.add(url)
    const name = named(line.slice(urlAt + bare.length).replace(/[*`[\]<>]/g, ''))
    out.push({ tag: hit?.tag ?? `${linkKind(kindText) ?? LINK_FALLBACK_KEY}:${url}`, ...(name ? { name } : {}) })
  }
  return out
}

/** The link tags a LINKS field names (linkEntriesFromField without the names). */
export function linkTagsFromField(field: string, patterns: readonly LinkPattern[]): string[] {
  return linkEntriesFromField(field, patterns).map((entry) => entry.tag)
}

/** The URL a tag holds as its value, or undefined when its value is not a link. */
export function linkUrlOfTag(tag: string): string | undefined {
  const parts = parseTag(tag)
  if (!parts || !/^https?:\/\//i.test(parts.value)) return undefined
  return canonicalLinkUrl(parts.value) ?? parts.value
}

/** An absolute file path a person opens to see the work (`html:/tmp/run/result.html`), in the
 *  form it is stored: `/…` or `~/…`, no whitespace, no `..` segment. */
export function canonicalLinkPath(raw: string): string | undefined {
  const text = raw.trim().replace(/^[`'"<]+|[`'">.,;:)]+$/g, '')
  if (!/^(?:\/|~\/)\S/.test(text) || /[\s\u0000-\u001f\u007f]/.test(text)) return undefined
  if (text.split('/').some((seg) => seg === '..')) return undefined
  return text.length > 1 ? text.replace(/\/+$/, '') : undefined
}

/** The file path a tag holds as its value, or undefined when its value is not one. */
export function linkPathOfTag(tag: string): string | undefined {
  const parts = parseTag(tag)
  return parts ? canonicalLinkPath(parts.value) : undefined
}

/** What a link tag points at, a URL or a file path; the identity link tags dedupe on. */
export function linkTargetOfTag(tag: string): string | undefined {
  return linkUrlOfTag(tag) ?? linkPathOfTag(tag)
}

/** True for a link tag (a URL or a file path as its value). */
export function isLinkTag(tag: string): boolean {
  return linkTargetOfTag(tag) !== undefined
}

/** The short label a link tag's pill reads after its key: a URL's label, a path's file name. */
/** Kinds whose id is how a person tells two of them apart (`ticket:ENG-12`, `pr:app#7`). Every
 *  other link pill shows its kind alone (`report`, `design-doc`); the tooltip has the target. */
const ID_LINK_KEYS: ReadonlySet<string> = new Set(['ticket', 'issue', 'cr', 'pr', 'mr'])

export function linkTagShowsId(tag: string): boolean {
  return ID_LINK_KEYS.has(linkTagKey(tag) ?? '')
}

export function linkTagLabel(tag: string): string | undefined {
  const url = linkUrlOfTag(tag)
  if (url) return linkLabel(url)
  const path = linkPathOfTag(tag)
  return path ? clipLabel(path.split('/').filter(Boolean).at(-1) ?? path) : undefined
}

const TRACKER_ID_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/
/** Path tails that name a view of a page, not the page (`…/d/<id>/edit`). */
const GENERIC_SEGMENT_RE = /^(?:edit|view|preview|index\.html?|files|comments)$/i
const MAX_LABEL = 16
/** An opaque id (a UUID, a long hex or base64-ish token): only its head is worth reading. */
const OPAQUE_ID_RE = /^(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{17,}$/
const OPAQUE_HEAD = 8

function decode(segment: string): string {
  try { return decodeURIComponent(segment) } catch { return segment }
}

/** The few characters a link's pill reads after its key: `app#12` for a forge issue or pull
 *  request, `ABC-123` for a tracker id, a short id, the head of an opaque id (`e6f56131` of a
 *  UUID), else the last meaningful path segment, else the host. At most 16 characters. */
export function linkLabel(rawUrl: string): string {
  let url: URL
  try { url = new URL(rawUrl) } catch { return rawUrl.slice(0, MAX_LABEL) }
  const segments = url.pathname.split('/').filter(Boolean).map(decode)
  const forge = /^(?:pull|pulls|issues|merge_requests)$/
  for (let i = segments.length - 2; i >= 1; i--) {
    if (forge.test(segments[i]!) && /^\d+$/.test(segments[i + 1]!)) {
      const repo = segments[i - 1] === '-' ? segments[i - 2] : segments[i - 1]
      return clipLabel(`${repo ?? url.host}#${segments[i + 1]}`)
    }
  }
  // A chat permalink's ids (`archives/C0123/p1726…`) mean nothing to read: name the workspace.
  if (/(?:^|\.)slack\.com$/.test(url.host) && segments[0] === 'archives') return clipLabel(url.host.split('.')[0]!)
  const tracker = [...segments].reverse().find((s) => TRACKER_ID_RE.test(s))
  if (tracker) return clipLabel(tracker)
  const meaningful = segments.filter((seg) => !GENERIC_SEGMENT_RE.test(seg))
  const withDigit = [...meaningful].reverse().find((s) => /\d/.test(s) && s.length <= MAX_LABEL)
  if (withDigit) return withDigit
  const last = meaningful.at(-1)
  if (last && OPAQUE_ID_RE.test(last)) return last.slice(0, OPAQUE_HEAD)
  return clipLabel(last ?? url.host.replace(/^www\./, ''))
}

function clipLabel(text: string): string {
  return text.length <= MAX_LABEL ? text : `${text.slice(0, MAX_LABEL - 1)}…`
}

/** URLs a task remembers having been tagged by Walnut (Task.auto_links), newest kept. */
export const MAX_AUTO_LINKS = 200
/** Link tags a task holds before Walnut stops adding more on its own: only the few that matter
 *  (the user, 2026-10-23: "only most important, max 3"). */
export const MAX_LINK_TAGS = 3

/** The candidates worth adding to a task: a URL the task already holds under any key, or one
 *  Walnut tagged before (the user may have removed or relabelled it), is skipped. */
export function newLinkTags(
  task: { tags?: readonly string[]; auto_links?: readonly string[] },
  candidates: readonly string[],
): string[] {
  const held = new Set<string>(task.auto_links ?? [])
  let count = 0
  for (const tag of task.tags ?? []) {
    const target = linkTargetOfTag(tag)
    if (target) { held.add(target); count++ }
  }
  const out: string[] = []
  for (const tag of candidates) {
    const target = linkTargetOfTag(tag)
    // A tag past the stored length would be clipped, and a clipped URL opens the wrong page.
    if (!target || tag.length > MAX_TAG_LENGTH || held.has(target) || count >= MAX_LINK_TAGS) continue
    const path = linkPathOfTag(tag)
    if (path && !isReviewablePath(path)) continue
    held.add(target)
    count++
    out.push(tag)
  }
  return out
}

/** Link tags Walnut added under a generic key (`file:/…/plan.md`) that a candidate now names
 *  better (`plan:/…/plan.md`): each as the tag to drop and the one to put in its place. A key the
 *  user gave (a target Walnut never tagged) is never renamed. */
export function relabelLinkTags(
  task: { tags?: readonly string[]; auto_links?: readonly string[] },
  candidates: readonly string[],
): { from: string; to: string }[] {
  const byTarget = new Map(genericLinkTags(task).map((tag) => [linkTargetOfTag(tag)!, tag]))
  const out: { from: string; to: string }[] = []
  for (const tag of candidates) {
    const target = linkTargetOfTag(tag)
    const from = target ? byTarget.get(target) : undefined
    if (!from || tag.length > MAX_TAG_LENGTH || isGenericLinkKey(tag.slice(0, tag.indexOf(':')))) continue
    byTarget.delete(target!)
    out.push({ from, to: tag })
  }
  return out
}

/** The task's link tags Walnut added under a generic key, for the self-report to name better. */
export function genericLinkTags(task: { tags?: readonly string[]; auto_links?: readonly string[] }): string[] {
  const auto = new Set(task.auto_links ?? [])
  return (task.tags ?? []).filter((tag) => {
    const target = linkTargetOfTag(tag)
    return !!target && auto.has(target) && isGenericLinkKey(tag.slice(0, tag.indexOf(':')))
  })
}

// ── Names: what a link pill reads ─────────────────────────────────────────────
// A pill that reads only its kind ("plan", "plan", "plan") tells three links apart by nothing
// (the user, 2026-10-25: "it need 1-3 word to describe, descriptive"). Every link tag reads a
// name of one to three words that says which one it is: the name the session gave it in its
// LINKS field (Task.link_names), else one made from the target (`FIX-PLAN-r5b.md` reads
// "Fix plan r5b"), else the kind; a ticket or a pull request reads its id. The pill's icon says
// the kind. Names on one task never repeat (linkTagNames). The phone reads the same names
// from the task detail (`links`, linkTagViews) rather than a second copy of these rules.

/** Agent-given names Walnut keeps per task, newest kept. */
export const MAX_LINK_NAMES = 20
const MAX_NAME_WORDS = 3
const MAX_NAME_CHARS = 28

/** Text cut to `max` characters with an ellipsis, by code point: a cut never splits an emoji
 *  into half a surrogate pair, which a strict JSON decoder (the phone's) refuses. */
function clipName(text: string, max = MAX_NAME_CHARS): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}
/** Acronyms that keep their capitals when a file name is turned into words. */
const KEEP_CAPS: ReadonlySet<string> = new Set(['api', 'ui', 'ux', 'cli', 'ios', 'pr', 'cr', 'mr', 'mcp', 'sdk', 'html', 'css', 'url', 'e2e', 'qa', 'ai', 'acp', 'ci', 'stt', 'llm', 'aws', 'ec2', 'sql', 'json', 'pdf', 'id'])
/** File names that say what kind of file it is but not which one: the folder says that. */
const GENERIC_STEMS: ReadonlySet<string> = new Set(['index', 'readme', 'notes', 'note', 'result', 'results', 'report', 'summary', 'plan', 'design', 'explainer', 'review', 'output', 'out', 'main', 'draft', 'doc', 'docs', 'final', 'page', 'view', 'tmp', 'temp'])

const URL_PLACE_SEGMENT_RE = /^(?:archives?|documents?|spreadsheets|presentation|forms|file|wiki|display|pages|browse|blob|tree|main|master|issues|pull|pulls|merge_requests|discussions|projects?)$/i

/** The word a site is known by: `docs.google.com` is google; a workspace on a shared host
 *  (`acme.slack.com`) is its workspace. */
function siteWord(url: string): string | undefined {
  let host: string
  try { host = new URL(url).host.replace(/^www\./, '').replace(/:\d+$/, '') } catch { return undefined }
  const labels = host.split('.')
  if (labels.length < 2) return labels[0]
  if (labels.length >= 3 && /^(?:slack|atlassian|notion|sharepoint|zendesk|github|gitlab|vercel|netlify)$/.test(labels.at(-2)!)) return labels[0]
  return labels.at(-2)
}

/** The kind of thing a link is, for its pill's icon. */
export type LinkKindGroup = 'doc' | 'review' | 'ticket' | 'thread' | 'link'

export function linkKindGroup(kind: string): LinkKindGroup {
  if (/^(?:pr|mr|cr|review|code-review|diff|commit)$/.test(kind)) return 'review'
  if (/^(?:ticket|issue|incident|bug|sim|task)$/.test(kind)) return 'ticket'
  if (/^(?:thread|chat|slack|message|email|mail)$/.test(kind)) return 'thread'
  if (/^(?:link|url|site|page|dashboard)$/.test(kind)) return 'link'
  return 'doc'
}

/** A name a session gave, in stored form: at most three words and 28 characters, no markup;
 *  undefined when nothing readable is left. */
export function normalizeLinkName(raw: string): string | undefined {
  const text = raw.replace(/[\u0000-\u001f\u007f*`[\]()<>"]/g, ' ').replace(/^[\s:=,;–—-]+|[\s:=,;.–—-]+$/g, '').replace(/\s+/g, ' ')
  if (!text || /^(?:https?:\/\/|\/|~\/)/i.test(text)) return undefined
  const words = text.split(' ').slice(0, MAX_NAME_WORDS)
  const name = clipName(words.join(' '))
  return /[\p{L}\p{N}]/u.test(name) ? name : undefined
}

/** The words of a file or path segment name: `FIX-PLAN-r5b` is fix, plan, r5b; `linkTagsDesign`
 *  is link, tags, design. */
function nameWords(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z][a-z])/g, '$1 $2')
    .split(/[\s._+-]+/)
    .filter((w) => w && /[\p{L}\p{N}]/u.test(w))
}

/** Words as a name: sentence case, acronyms kept, at most `max` words. */
function wordsAsName(words: readonly string[], max = MAX_NAME_WORDS): string {
  const out = words.slice(0, max).map((w, i) => {
    const lower = w.toLowerCase()
    if (KEEP_CAPS.has(lower)) return lower === 'ios' ? 'iOS' : lower.toUpperCase()
    // A word already in mixed case (`iPhone`, `macOS`) is kept as written.
    const cased = /[a-z]/.test(w) && /[A-Z]/.test(w.slice(1)) ? w : lower
    return i === 0 ? cased.charAt(0).toUpperCase() + cased.slice(1) : cased
  })
  return clipName(out.join(' '))
}

/** The words a link's target names it by, most telling first, and the words that tell it from a
 *  sibling (the folder above), or undefined when the target says nothing readable. */
function targetWords(tag: string): { words: string[]; context: string[]; verbatim?: boolean } | undefined {
  const path = linkPathOfTag(tag)
  if (path) {
    const segs = path.split('/').filter(Boolean)
    const file = segs.at(-1) ?? ''
    const stem = file.includes('.') ? file.slice(0, file.lastIndexOf('.')) : file
    let words = nameWords(stem)
    const dirs = segs.slice(0, -1).filter((s) => s !== '~' && !/^(?:tmp|private|var|users|home|workplace)$/i.test(s))
    const parent = nameWords(dirs.at(-1) ?? '')
    // A repo's instructions read with the repo's name: `Walnut CLAUDE.md`.
    if (/^(?:claude|agents|readme)\.md$/i.test(file)) return { words: [...parent.slice(0, 2), file], context: parent, verbatim: true }
    // `…/run-42/result.html` is "Run 42 result", not "Result".
    if (words.length === 1 && GENERIC_STEMS.has(words[0]!.toLowerCase()) && parent.length) words = [...parent.slice(0, 2), ...words]
    if (!words.length) return undefined
    return { words, context: parent }
  }
  const url = linkUrlOfTag(tag)
  if (!url) return undefined
  let parsed: URL
  try { parsed = new URL(url) } catch { return undefined }
  // Ids (`C01`, `p1726…`, a document id) and the words for a place in a site (`archives`,
  // `document`) say nothing about which page it is.
  const segs = parsed.pathname.split('/').filter(Boolean).map(decode)
    .filter((s) => s.length >= 3 && !GENERIC_SEGMENT_RE.test(s) && !URL_PLACE_SEGMENT_RE.test(s) && !OPAQUE_ID_RE.test(s) && !/^[A-Za-z]{0,2}\d/.test(s))
  const last = segs.at(-1)
  const words = last ? nameWords(last.replace(/\.[a-z0-9]{1,5}$/i, '')) : []
  if (!words.length) return undefined
  return { words, context: nameWords(segs.at(-2) ?? '') }
}

/** The name one link tag reads on its own (linkTagNames makes the names of one task distinct). */
export function linkTagName(tag: string, names?: Readonly<Record<string, string>>): string | undefined {
  const target = linkTargetOfTag(tag)
  if (!target) return undefined
  if (linkTagShowsId(tag)) return linkTagLabel(tag)
  const given = names?.[target]
  if (given) return normalizeLinkName(given) ?? given
  const words = targetWords(tag)
  if (words) return words.verbatim ? words.words.join(' ').replace(/^./, (c) => c.toUpperCase()) : wordsAsName(words.words)
  // Nothing in the target reads (a chat permalink, an opaque document id): the site and the kind.
  const kind = linkTagKey(tag)!
  const url = linkUrlOfTag(tag)
  const site = url ? siteWord(url) : undefined
  return wordsAsName([...(site ? [site] : []), ...nameWords(kind)])
}

/** The names a task's link tags read, each distinct, keyed by tag. Two that would read the same
 *  keep their first two words and add the first word that tells them apart (`Session link v1`,
 *  `Session link v2`), else the folder that does (`Alpha result`, `Beta result`), else a number. */
export function linkTagNames(tags: readonly string[], names?: Readonly<Record<string, string>>): Map<string, string> {
  const out = new Map<string, string>()
  for (const tag of tags) if (isLinkTag(tag)) out.set(tag, linkTagName(tag, names)!)
  const groups = new Map<string, string[]>()
  for (const [tag, name] of out) groups.set(name.toLowerCase(), [...(groups.get(name.toLowerCase()) ?? []), tag])
  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (const tag of group) {
      const own = targetWords(tag)
      if (!own || names?.[linkTargetOfTag(tag)!]) continue
      const others = group.filter((t) => t !== tag).map(targetWords)
      const lower = (ws: readonly string[]) => ws.map((w) => w.toLowerCase())
      const words = lower(own.words)
      const differs = (i: number, pick: (w: { words: string[]; context: string[] }) => string[]) =>
        others.every((o) => !o || lower(pick(o))[i] !== lower(pick(own))[i])
      const at = words.findIndex((_, i) => i >= 2 && differs(i, (w) => w.words))
      const ctx = own.context.length - 1
      if (at >= 0) out.set(tag, wordsAsName([...own.words.slice(0, 2), own.words[at]!]))
      else if (ctx >= 0 && others.every((o) => !o || lower(o.context).at(-1) !== own.context[ctx]!.toLowerCase())) {
        out.set(tag, wordsAsName([own.context[ctx]!, ...own.words.slice(0, 2)]))
      }
    }
  }
  // Whatever still reads the same as an earlier link on the task (across groups too: a folder or
  // a number added above can meet another link's name) takes the next free number.
  const seen = new Set<string>()
  for (const [tag, name] of out) {
    let next = name
    for (let n = 2; seen.has(next.toLowerCase()); n++) next = `${name} ${n}`
    seen.add(next.toLowerCase())
    out.set(tag, next)
  }
  return out
}

/** The task's link names with the new ones added: a name for a link the task holds and has not
 *  named yet (a name, once shown, stays put across turns), names of links it no longer holds
 *  dropped. Undefined when nothing changes. */
export function mergeLinkNames(
  task: { tags?: readonly string[]; link_names?: Readonly<Record<string, string>> },
  incoming: Readonly<Record<string, string>>,
): Record<string, string> | undefined {
  const held = new Set((task.tags ?? []).map((tag) => linkTargetOfTag(tag)).filter((t): t is string => !!t))
  const out: Record<string, string> = {}
  for (const [target, name] of Object.entries(task.link_names ?? {})) if (held.has(target)) out[target] = name
  let changed = Object.keys(out).length !== Object.keys(task.link_names ?? {}).length
  for (const [target, raw] of Object.entries(incoming)) {
    const name = typeof raw === 'string' ? normalizeLinkName(raw) : undefined
    if (!name || !held.has(target) || out[target]) continue
    out[target] = name
    changed = true
  }
  const keys = Object.keys(out)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_LINK_NAMES))) delete out[key]
  return changed ? out : undefined
}

/** One link tag as a client draws it: its name (distinct on the task), its kind and the icon
 *  group, and the whole target. The task detail serves these (`links`) so the phone reads the
 *  same names as the console without a second copy of these rules. */
export interface LinkTagView {
  tag: string
  name: string
  kind: string
  group: LinkKindGroup
  target: string
  /** The target is a file path (else a URL). */
  file: boolean
  /** The file is no longer there (set by whoever checked; absent when unknown). */
  gone?: boolean
}

export function linkTagViews(tags: readonly string[] | undefined, names?: Readonly<Record<string, string>>): LinkTagView[] {
  const named = linkTagNames(tags ?? [], names)
  return [...named].map(([tag, name]) => {
    const kind = linkTagKey(tag)!
    return { tag, name, kind, group: linkKindGroup(kind), target: linkTargetOfTag(tag)!, file: !linkUrlOfTag(tag) }
  })
}
