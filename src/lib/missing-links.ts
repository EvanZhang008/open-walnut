/**
 * Ids the user would have to look up: a code review, a ticket, a pull request or a commit named in
 * text written for the user with no link to open it, and the one note that tells the writer.
 *
 * Why (2026-11-20, the user, of a report thread: "when u send this thread pelase make sure u have all
 * the necesary info, like link i cna just lcick ... make sure we shoudl do this from now one"): every
 * thread, letter and question to him carries what he needs, and everything it names is a full URL
 * he can click, never an id he must search for. The rule rides the prompt (team-charter.ts, the
 * decision line in sessions/session-context.ts); this check reminds the writer at the moment it
 * slips. It only reminds and never refuses: the text has already gone out.
 *
 * Where it runs: a session's Walnut op that hands the user words (LINK_NOTE_OPS, ops/executor.ts adds
 * the note to the op's answer) and a Claude Code AskUserQuestion (the PreToolUse hook in
 * providers/ask-links-hook.ts, through the link_check op). Class guard:
 * tests/lib/missing-links.test.ts (every op that hands the user words is listed or exempt).
 *
 * What counts as named (few false alarms on purpose):
 *   - a code review: CR-1234 and longer;
 *   - a ticket: V or P and 8 to 11 digits (V1234567890);
 *   - a pull request: "PR #12", "PR 12" (two digits or more), "pull request #12", owner/repo#12;
 *   - a commit: a bare lowercase hex run with a digit and a letter in it, not glued to a path, an
 *     id or a word: 40 characters always; 7 to 12 only after a word that says it is one ("commit",
 *     "landed", "sha", "hash", a Chinese "commit" or "version") a few words before it, so a short
 *     task or session id ("task a9b9810d") stays quiet, as do UUIDs, rq-.../lt-... ids, sha256 sums
 *     and paths.
 * Text in fenced code blocks and inside URLs is not read. An id counts as linked when it is the
 * text of a Markdown or HTML link, when an http(s) URL follows it on its line ("CR-1: <url>",
 * "**CR-1** (<url>") or comes right before it ("<url> (PR 12)"), or when any URL in the text
 * carries it (the review or ticket id, /pull/<n>, the commit's hash or a prefix of it).
 * Linear in the text, and it reads at most MAX_SCAN characters (a letter's HTML can be megabytes,
 * and a gateway call runs this on the server's event loop).
 */

export type LinkRefKind = 'code review' | 'ticket' | 'pull request' | 'commit'

export interface MissingLink {
  kind: LinkRefKind
  /** The id as written ("CR-123456", "PR #12", "0e72622de"). */
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
/** A word a few words before a short hash that says it is a commit (the escapes: Chinese "commit", "version", "goes live"). */
const COMMIT_WORD_RE = /(?:\b(?:commit(?:ted)?|land(?:ed)?|merged|revert(?:ed|s)?|cherry-picked|sha|hash|head)|\u63d0\u4ea4|\u7248\u672c|\u4e0a\u7ebf)\W{0,3}(?:\S+\s+){0,2}\S*$/i

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
  for (const m of text.matchAll(/(?<![\w./#:@=-])([0-9a-f]{7,40})(?![\w/-]|\.\w)/g)) {
    const h = m[1]
    if (!/\d/.test(h) || !/[a-f]/.test(h)) continue
    if (h.length !== 40 && (h.length > 12 || !COMMIT_WORD_RE.test(text.slice(Math.max(0, m.index! - 40), m.index!).split('\n').pop()!))) continue
    push('commit', h, h, m.index!)
  }
  return out
}

/** What the text's URLs carry, read once: the ids in them, pull request numbers, commit hashes. */
function indexUrls(urls: readonly string[]): { text: string; pulls: Set<string>; hashes: string[] } {
  const text = urls.join(' ').toLowerCase()
  const pulls = new Set<string>()
  for (const m of text.matchAll(/\/(?:pulls?|merge_requests|pull-requests)\/(\d{1,7})(?!\d)/g)) pulls.add(m[1])
  const hashes = [...new Set([...text.matchAll(/[0-9a-f]{7,40}/g)].map((m) => m[0]))].slice(0, 2000)
  return { text, pulls, hashes }
}

function urlCarries(f: Found, idx: ReturnType<typeof indexUrls>): boolean {
  switch (f.kind) {
    case 'code review':
    case 'ticket':
      return idx.text.includes(f.key.toLowerCase())
    case 'pull request':
      return idx.pulls.has(f.key)
    case 'commit':
      return idx.hashes.some((h) => h.startsWith(f.key) || f.key.startsWith(h))
  }
}

/**
 * The ids the text names with no link to open them, each once, in the order they first appear.
 */
export function findMissingLinks(input: string): MissingLink[] {
  if (!input || !/\d/.test(input)) return []
  const raw = input.length > MAX_SCAN ? input.slice(0, MAX_SCAN) : input
  const unfenced = raw.replace(FENCE_RE, spaces)
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
    .replace(TAG_RE, spaces)
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
  commit: 'the commit page (for a GitHub repository: https://github.com/<owner>/<repo>/commit/<hash>)',
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
 * The Walnut ops whose words the user reads as they are, each with the fields that hold them
 * (a dotted path reads inside an object; an array is read item by item) and how to correct a slip.
 * The class guard (tests/lib/missing-links.test.ts) fails on a new op that hands the user words
 * until it is listed here or in LINK_NOTE_EXEMPT.
 */
export const LINK_NOTE_OPS: Readonly<Record<string, { fields: readonly string[]; what: string; fix: string }>> = {
  thread_update: { fields: ['reply'], what: 'Your thread summary (thread_update reply)', fix: 'Write the summary again with the links (thread_update with reply).' },
  thread_create: { fields: ['text'], what: 'Your new thread\'s first post (thread_create)', fix: 'Put the links in the thread\'s summary (thread_update with reply).' },
  human_inbox_send: { fields: ['subject', 'markdown', 'html', 'text', 'actions.label', 'actions.description'], what: 'Your letter (human_inbox_send)', fix: 'Do not send the letter again: reply to it with the links (human_inbox_reply with its letter id).' },
  human_inbox_reply: { fields: ['markdown', 'html', 'text'], what: 'Your reply in the letter (human_inbox_reply)', fix: 'Reply once more with the links (human_inbox_reply).' },
  task_report_set: { fields: ['report.ask', 'report.ask_more', 'report.next'], what: 'Your task report (task_report_set)', fix: 'Set the report again with the links (task_report_set; a Needs you ask carries them in ask_more).' },
  task_update: { fields: ['report.ask', 'report.ask_more', 'report.next'], what: 'Your task report (task_update report)', fix: 'Set the report again with the links (task_report_set; a Needs you ask carries them in ask_more).' },
  brief_write: { fields: ['content', 'edits.new'], what: 'Your Brief (brief_write)', fix: 'Write the Brief again with the links (brief_write).' },
}

/** Ops that hand the user words but are not checked, with why (the class guard reads this list). */
export const LINK_NOTE_EXEMPT: Readonly<Record<string, string>> = {
  human_inbox_mark: 'read, pin and archive flags only',
  human_inbox_answer: 'records the user\'s own answer, in his words',
  thread_file: 'files the user\'s own words under a thread',
  thread_split: 'moves the user\'s own message to a thread of its own',
  thread_move: 'hands a thread to another node; its why goes to that node',
}

function at(v: unknown, path: string[], out: string[]): void {
  if (Array.isArray(v)) { for (const x of v) at(x, path, out); return }
  if (!path.length) { if (typeof v === 'string') out.push(v); return }
  if (v && typeof v === 'object') at((v as Record<string, unknown>)[path[0]], path.slice(1), out)
}

/** The note for a session's op whose words for the user name ids with no link, or null. */
export function opMissingLinksNote(op: string, args: unknown): string | null {
  const spec = LINK_NOTE_OPS[op]
  if (!spec || !args || typeof args !== 'object') return null
  const parts: string[] = []
  for (const f of spec.fields) at(args, f.split('.'), parts)
  const missing = findMissingLinks(parts.join('\n\n'))
  return missingLinksNote(missing, spec.what, spec.fix)
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
