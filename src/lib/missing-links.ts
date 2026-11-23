/**
 * Ids the user would have to look up: a code review, a ticket or a pull request named in text
 * written for the user with no link to open it, and the one note that tells the writer.
 *
 * Why (2026-11-20, the user, of a report thread: "when u send this thread pelase make sure u have all
 * the necesary info, like link i cna just lcick ... make sure we shoudl do this from now one"): every
 * thread, letter and question to him carries what he needs, and everything it names is a full URL
 * he can click, never an id he must search for. The rule rides the prompt (the user's profile, the
 * decision line in sessions/session-context.ts); this check reminds the writer at the moment it
 * slips. It only reminds and never refuses: the text has already gone out.
 * Commits are not asked for (2026-11-20, the user: no one reads a commit, so give him the rest and
 * no commit links): a hash with no link stays quiet.
 *
 * Where it runs: a session's Walnut op that hands the user words (an entry of lib/user-text-ops.ts with `links`, ops/executor.ts adds
 * the note to the op's answer) and a Claude Code AskUserQuestion (the PreToolUse hook in
 * providers/ask-links-hook.ts, through the link_check op). Class guard:
 * tests/lib/missing-links.test.ts (every op that hands the user words is listed or exempt).
 *
 * What counts as named (few false alarms on purpose):
 *   - a code review: CR-1234 and longer;
 *   - a ticket: V or P and 8 to 11 digits (V1234567890);
 *   - a pull request: "PR #12", "PR 12" (two digits or more), "pull request #12", owner/repo#12.
 * Text in fenced code blocks and inside URLs is not read. An id counts as linked when it is the
 * text of a Markdown or HTML link, when an http(s) URL follows it on its line ("CR-1: <url>",
 * "**CR-1** (<url>") or comes right before it ("<url> (PR 12)"), or when any URL in the text
 * carries it (the review or ticket id, /pull/<n>).
 * Linear in the text, and it reads at most MAX_SCAN characters (a letter's HTML can be megabytes,
 * and a gateway call runs this on the server's event loop).
 */

import { deadCommitLinksNote, findDeadCommitLinks } from './github-commit-check.js'
import { USER_TEXT_OPS, at, opUserText } from './user-text-ops.js'

export type LinkRefKind = 'code review' | 'ticket' | 'pull request'

export interface MissingLink {
  kind: LinkRefKind
  /** The id as written ("CR-123456", "PR #12"). */
  ref: string
}

/** Characters read; text past it is not checked. */
export const MAX_SCAN = 200_000
/** Ids judged per text; a text naming more is a log, not a message. */
const MAX_REFS = 300

const URL_RE = /https?:\/\/[^\s<>()"'`\]]+/gi
const FENCE_RE = /```[\s\S]*?(?:```|$)/g
const MD_LINK_RE = /\[([^\]\n]{1,300})\]\(\s*(https?:\/\/[^)\s]+)[^)]*\)/gi
const A_TAG_RE = /<a\b[^>]{0,2000}?\bhref\s*=\s*["']?(https?:\/\/[^"'\s>]+)[^>]{0,2000}>([^<]{0,400})<\/a>/gi
const TAG_RE = /<[^>\n]{1,2000}>/g
interface Found { kind: LinkRefKind; ref: string; key: string; at: number; end: number }

const spaces = (m: string): string => ' '.repeat(m.length)

function refsIn(text: string): Found[] {
  const out: Found[] = []
  const push = (kind: LinkRefKind, ref: string, key: string, at: number) => {
    if (out.length < MAX_REFS) out.push({ kind, ref, key, at, end: at + ref.length })
  }
  for (const m of text.matchAll(/\bCR-(\d{4,})\b/gi)) push('code review', m[0], `CR-${m[1]}`, m.index!)
  for (const m of text.matchAll(/(?<![\w-])([VP]\d{8,11})(?![\w-])/g)) push('ticket', m[0], m[1], m.index!)
  for (const m of text.matchAll(/\b(?:PR|pull request)(?:[ \t]?#[ \t]?(\d{1,7})|[ \t](\d{2,7}))\b/gi)) push('pull request', m[0], m[1] ?? m[2], m.index!)
  for (const m of text.matchAll(/(?<![\w/.-])[A-Za-z0-9][\w.-]{0,38}\/[\w.-]{1,100}(?<!\.(?:md|mdx|txt|html?|json|ya?ml|tsx?|jsx?|py|rs|go|sh))#(\d{1,7})\b/g)) push('pull request', m[0], m[1], m.index!)
  return out
}

/** What the text's URLs carry, read once: the ids in them and pull request numbers. */
function indexUrls(urls: readonly string[]): { text: string; pulls: Set<string> } {
  const text = urls.join(' ').toLowerCase()
  const pulls = new Set<string>()
  for (const m of text.matchAll(/\/(?:pulls?|merge_requests|pull-requests)\/(\d{1,7})(?!\d)/g)) pulls.add(m[1])
  return { text, pulls }
}

function urlCarries(f: Found, idx: ReturnType<typeof indexUrls>): boolean {
  switch (f.kind) {
    case 'code review':
    case 'ticket':
      return idx.text.includes(f.key.toLowerCase())
    case 'pull request':
      return idx.pulls.has(f.key)
  }
}

/**
 * The ids the text names with no link to open them, each once, in the order they first appear.
 */
export function findMissingLinks(input: string): MissingLink[] {
  if (!input || !/\d/.test(input)) return []
  const raw = input.length > MAX_SCAN ? input.slice(0, MAX_SCAN) : input
  const unfenced = raw.replace(FENCE_RE, (m) => spaces(m))
  const urls: string[] = []
  const linked: Array<[number, number]> = []
  // Link texts first: an id inside one is linked whatever its URL says.
  for (const m of unfenced.matchAll(A_TAG_RE)) {
    urls.push(m[1])
    const inner = m.index! + m[0].length - m[2].length - 4
    linked.push([inner, inner + m[2].length])
  }
  for (const m of unfenced.matchAll(MD_LINK_RE)) {
    urls.push(m[2])
    linked.push([m.index! + 1, m.index! + 1 + m[1].length])
  }
  // URLs themselves and markup are never read for ids (blanked in one pass, offsets kept).
  const urlSpans: Array<[number, number]> = []
  const text = unfenced
    .replace(URL_RE, (m, at: number) => { urls.push(m); urlSpans.push([at, at + m.length]); return spaces(m) })
    .replace(TAG_RE, (m) => spaces(m))
  const refs = refsIn(text)
  if (!refs.length) return []
  const idx = indexUrls(urls)

  const seen = new Set<string>()
  const out: MissingLink[] = []
  for (const f of refs) {
    const id = `${f.kind}:${f.key}`
    if (seen.has(id)) continue
    if (linked.some(([a, b]) => f.at >= a && f.end <= b)) continue
    if (urlCarries(f, idx)) continue
    // A URL right beside it on its line: "CR-123: https://...", "**CR-1** (https://...", "(https://...) PR 12".
    const after = /^[*_`]*[ \t]*[:(]?[ \t]*/.exec(raw.slice(f.end, f.end + 12))![0].length + f.end
    const beforeGap = /[ \t]*\(?[*_`]*$/.exec(raw.slice(Math.max(0, f.at - 12), f.at))![0].length
    const beside = urlSpans.some(([a, b]) => a === after || b === f.at - beforeGap)
    if (beside) continue
    seen.add(id)
    out.push({ kind: f.kind, ref: f.ref })
  }
  return out
}

/** What to add for each kind, in the note. */
const WHAT_URL: Record<LinkRefKind, string> = {
  'code review': 'the code review page',
  ticket: 'the ticket page',
  'pull request': 'the pull request page',
}

/**
 * The one note a writer hears: `what` names the text ("Your thread summary (thread_update)"), `fix`
 * the way to correct it. Null when nothing is missing.
 */
export function missingLinksNote(missing: readonly MissingLink[], what: string, fix: string): string | null {
  if (!missing.length) return null
  const refs = missing.slice(0, 8).map((m) => `${m.ref} (${m.kind})`)
  const more = missing.length > 8 ? ` and ${missing.length - 8} more` : ''
  const kinds = [...new Set(missing.map((m) => m.kind))].map((k) => WHAT_URL[k])
  return `Walnut note: ${what} names ${refs.join(', ')}${more} for the user with no link to open it. `
    + 'The user asked (2026-11-20) that every thread, letter and question to them carry everything they need, '
    + 'with each thing it names as a full URL they can click, never an id to look up. '
    + `Add ${kinds.join('; ')}, as a full https:// URL in the same text. ${fix}`
}

/**
 * The ops whose words get the link note: the entries of the one list of words the user reads
 * (user-text-ops.ts) that carry a `links` fix. Read when called, so an entry added later counts.
 */
export function linkNoteOps(): Record<string, { fields: readonly string[]; what: string; fix: string }> {
  const out: Record<string, { fields: readonly string[]; what: string; fix: string }> = {}
  for (const [name, spec] of Object.entries(USER_TEXT_OPS)) if (spec.links) out[name] = { fields: spec.fields, what: spec.what, fix: spec.links }
  return out
}

/** The words of a link-noted op the user reads, joined; null for any other op. */
function opLinkText(op: string, args: unknown): { text: string; what: string; fix: string } | null {
  const t = opUserText(op, args)
  return t?.spec.links ? { text: t.text, what: t.spec.what, fix: t.spec.links } : null
}

/** The note for a session's op whose words for the user name ids with no link, or null. */
export function opMissingLinksNote(op: string, args: unknown): string | null {
  const t = opLinkText(op, args)
  return t ? missingLinksNote(findMissingLinks(t.text), t.what, t.fix) : null
}

/**
 * Both notes for a text for the user: ids with no link, and GitHub commit links that open
 * nothing (github-commit-check.ts, which asks GitHub). Never throws.
 */
export async function linkNotes(text: string, what: string, fix: string): Promise<string[]> {
  const notes: string[] = []
  try {
    const missing = missingLinksNote(findMissingLinks(text), what, fix)
    if (missing) notes.push(missing)
  } catch { /* a note never fails the call */ }
  try {
    const dead = deadCommitLinksNote(await findDeadCommitLinks(text), what, fix)
    if (dead) notes.push(dead)
  } catch { /* a note never fails the call */ }
  return notes
}

/** linkNotes for a session's op: nothing for an op whose words the user does not read. */
export async function opLinkNotes(op: string, args: unknown): Promise<string[]> {
  const t = opLinkText(op, args)
  return t ? linkNotes(t.text, t.what, t.fix) : []
}


/** The words of a Claude Code AskUserQuestion call's input (its questions, headers and options). */
export function askUserQuestionText(toolInput: unknown): string {
  const parts: string[] = []
  at(toolInput, ['questions', 'question'], parts)
  at(toolInput, ['questions', 'header'], parts)
  at(toolInput, ['questions', 'options', 'label'], parts)
  at(toolInput, ['questions', 'options', 'description'], parts)
  return parts.join('\n\n')
}

export const ASK_LINKS_WHAT = 'Your question to the user (AskUserQuestion)'
export const ASK_LINKS_FIX = 'Give the user the links in your next words to them.'
