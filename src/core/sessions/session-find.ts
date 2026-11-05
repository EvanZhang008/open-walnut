/**
 * Find in a whole session (GET /api/sessions/:id/find?q=).
 *
 * The web console's Cmd+F walks the rendered chat, which is only the newest
 * turns: everything above "Load earlier turns" is not in the page at all. This
 * answers for the WHOLE transcript, so the find bar can count matches in rows
 * the client has not loaded and step to them (the client then loads that row
 * and its own walk takes over). Only what a reader sees without opening a card
 * is searched: the person's typed words, the assistant's replies and the header
 * line of each tool call (its name and summary), never tool output, which the
 * chat shows folded.
 *
 * Counts here are an estimate of what the row will show once rendered (the
 * markdown source differs a little from the rendered text): the client trusts
 * them only for rows it has not rendered.
 */
import { isHistorySentRow } from '../../lib/history-turn-window.js'
import { typedUserText } from '../../lib/history-injected-banner.js'
import { envelopeCardText, parseSessionEnvelopes } from '../../lib/history-session-envelope.js'
import { stripTurnMarker } from '../../lib/turn-end-marker.js'
import { splitLeadingRiders } from '../../lib/history-walnut-riders.js'
import { toolCardKind, toolHeaderText } from '../../lib/tool-header-text.js'
import type { SessionHistoryMessage } from '../session-history.js'
import type { SessionRecord } from '../types.js'
import { engineCaps } from '../agents/engine-registry.js'
import { log } from '../../logging/index.js'

/** One row holding the query: where it is and how many times. */
export interface SessionFindMatch {
  /** The id the client keys rows by (`msgId`, else `walnutMessageId`). */
  id: string
  role: 'user' | 'assistant'
  timestamp: string
  count: number
}

export interface SessionFindResult {
  /** Oldest first, the transcript's own order. */
  matches: SessionFindMatch[]
  /** Occurrences across every match (capped). */
  total: number
  /** More occurrences exist than were counted. */
  capped: boolean
  /** The transcript was only read in part (a very long file past the read budget). */
  partial?: boolean
}

/** Most occurrences counted for one query, the same bound the page find has. */
export const SESSION_FIND_CAP = 10_000
/** The query is one line from the find bar; longer text is not a query. */
export const SESSION_FIND_MAX_QUERY = 200

/**
 * What a row shows a reader, close enough to count: the person's typed words
 * and the cards of Walnut's notes riding in front of them (the chat shows those
 * as cards, in the bubble or the fold above it), a delivery's card text (its title, outcome
 * line and body, never the envelope's markup), the assistant's prose (without
 * the lines Walnut hides: the acknowledgement marker, an Org tasks line) and
 * its tool calls' header lines (tool-header-text.ts, the cards' own words); markdown
 * marks that never render as text removed and line breaks read as spaces (the
 * page find reads a soft break as a space too).
 */
export function findableText(row: Pick<SessionHistoryMessage, 'role' | 'text' | 'injected' | 'tools'> & { toolText?: string }): string {
  if (row.role === 'user') {
    if (!isHistorySentRow(row)) return ''
    const riders = (splitLeadingRiders(row.text)?.riders ?? []).map(envelopeCardText)
    const typed = typedUserText(row.text)
    const segments = parseSessionEnvelopes(typed.trim())
    const own = segments
      ? segments.map((seg) => seg.kind === 'text' ? seg.text : envelopeCardText(seg.envelope)).join(' ')
      : typed
    return plain([...riders, own].filter(Boolean).join(' '))
  }
  if (row.role === 'assistant') {
    const prose = plain(stripTurnMarker(row.text))
    const tools = row.toolText ?? toolsText(row.tools)
    return tools ? (prose ? `${prose} ${tools}` : tools) : prose
  }
  return ''
}

/** A row's tool header lines, in order (the cards render after the prose). */
function toolsText(tools: SessionHistoryMessage['tools']): string {
  if (!tools?.length) return ''
  return tools
    .map((t) => (toolCardKind(t) === 'plan' ? plain(toolHeaderText(t)) : toolHeaderText(t)))
    .filter(Boolean).join(' ').replace(/[\n\r\t]/g, ' ')
}

function plain(text: string): string {
  return text
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1') // [label](url) shows its label
    .replace(/\*\*|`/g, '')
    .replace(/[\n\r\t]/g, ' ')
}

/** Every row of `rows` holding `query`, oldest first. Pure. */
export function findInHistoryRows(
  rows: ReadonlyArray<SessionHistoryMessage>,
  query: string,
  opts: { caseSensitive?: boolean; cap?: number } = {},
): SessionFindResult {
  const cap = opts.cap ?? SESSION_FIND_CAP
  const needle = opts.caseSensitive ? query : query.toLowerCase()
  const matches: SessionFindMatch[] = []
  let total = 0
  if (!needle) return { matches, total, capped: false }
  const seen = new Set<string>()
  for (const row of rows) {
    const id = row.msgId ?? row.walnutMessageId
    // A row with no id cannot be found in the page again, and a row seen twice
    // (a fork's embedded prefix) is one row on screen.
    if (!id || seen.has(id)) continue
    const text = findableText(row)
    if (!text) continue
    const hay = opts.caseSensitive ? text : text.toLowerCase()
    let count = 0
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
      if (total + count >= cap) {
        if (count) matches.push({ id, role: row.role as 'user' | 'assistant', timestamp: row.timestamp, count })
        return { matches, total: total + count, capped: true }
      }
      count++
    }
    if (!count) continue
    seen.add(id)
    total += count
    matches.push({ id, role: row.role as 'user' | 'assistant', timestamp: row.timestamp, count })
  }
  return { matches, total, capped: false }
}

// ── Reading the whole transcript ────────────────────────────────────────────

/** Older windows read for one query at most (each page is up to 16 MB of file). */
const MAX_OLDER_PAGES = 16
/** Time budget for paging a very long file back to its start. */
const OLDER_PAGES_BUDGET_MS = 20_000
/** How long the older part of a very long file is kept between queries. */
const OLDER_CACHE_MS = 5 * 60_000
const OLDER_CACHE_SESSIONS = 8

/** The fields a find reads: a cached row keeps only these (tool calls and their
 *  output are most of a long file's bytes). */
type FindRow = Pick<SessionHistoryMessage, 'role' | 'text' | 'timestamp' | 'msgId' | 'walnutMessageId' | 'injected'> & {
  /** The tool calls' header lines, read once (the calls themselves are dropped). */
  toolText?: string
}

function slim(m: SessionHistoryMessage): SessionHistoryMessage {
  const row: FindRow = { role: m.role, text: m.text, timestamp: m.timestamp }
  const tools = toolsText(m.tools)
  if (tools) row.toolText = tools
  if (m.msgId) row.msgId = m.msgId
  if (m.walnutMessageId) row.walnutMessageId = m.walnutMessageId
  if (m.injected) row.injected = m.injected
  return row as SessionHistoryMessage
}

interface OlderCacheEntry {
  /** The tail's first timestamp the pages were read before. */
  before: string
  rows: SessionHistoryMessage[]
  reachedStart: boolean
  at: number
}

/** Older rows of very long sessions, so typing a query does not re-read 60 MB a keystroke. */
const olderCache = new Map<string, OlderCacheEntry>()
/** A read of the older part in progress, which a second query joins. */
const olderInflight = new Map<string, Promise<OlderCacheEntry>>()

/** Test seam. */
export function _resetSessionFindCacheForTests(): void {
  olderCache.clear()
  olderInflight.clear()
}

export interface FindHistoryDeps {
  readHistory: (sessionId: string, record: SessionRecord | null | undefined, host: string | null | undefined) => Promise<{ messages: SessionHistoryMessage[]; windowed: boolean }>
  readBefore: (sessionId: string, cwd: string | undefined, host: string | undefined, before: string) => Promise<{ messages: SessionHistoryMessage[]; reachedStart: boolean } | null>
  getSession: (sessionId: string) => Promise<SessionRecord | null | undefined>
  now?: () => number
}

/**
 * The transcript the history view would show, whole: a fork's ancestors first
 * (cut at a rewind point), then the session's own rows, with the older part of
 * a file too long for one read paged in. `partial` when that paging stopped
 * before the start (out of budget, or a window could not be read).
 */
export async function readFindableHistory(
  sessionId: string,
  record: SessionRecord | null | undefined,
  deps: FindHistoryDeps,
): Promise<{ rows: SessionHistoryMessage[]; partial: boolean }> {
  const own = await deps.readHistory(sessionId, record, record?.host)
  let rows = own.messages
  let partial = false
  if (own.windowed) {
    const pageable = !!record && !record.forkedFromSessionId && engineCaps(record.engine).historySource !== 'acp-journal'
    const head = rows.find((m) => m.timestamp)?.timestamp
    if (pageable && head && record) {
      const older = await readOlder(sessionId, record, head, deps)
      rows = [...older.rows, ...rows]
      partial = !older.reachedStart
    } else {
      partial = true
    }
  }
  if (record?.forkedFromSessionId) {
    const ancestors = await readAncestors(sessionId, record, deps)
    // A fork that ran a turn already holds its ancestors (the CLI copies the
    // resumed prefix): the per-id dedup in findInHistoryRows drops the copy.
    rows = [...ancestors.rows, ...rows]
    partial = partial || ancestors.partial
  }
  return { rows, partial }
}

function readOlder(
  sessionId: string, record: SessionRecord, head: string, deps: FindHistoryDeps,
): Promise<OlderCacheEntry> {
  const now = deps.now ?? Date.now
  for (const [key, entry] of olderCache) if (now() - entry.at >= OLDER_CACHE_MS) olderCache.delete(key)
  const cached = olderCache.get(sessionId)
  if (cached && cached.before === head) return Promise.resolve(cached)
  const key = `${sessionId}\u0000${head}`
  let running = olderInflight.get(key)
  if (!running) {
    running = pageOlder(sessionId, record, head, cached, deps)
      .then((entry) => {
        olderCache.delete(sessionId)
        olderCache.set(sessionId, entry)
        if (olderCache.size > OLDER_CACHE_SESSIONS) {
          const oldest = olderCache.keys().next().value
          if (oldest !== undefined) olderCache.delete(oldest)
        }
        return entry
      })
      .finally(() => olderInflight.delete(key))
    olderInflight.set(key, running)
  }
  return running
}

/**
 * Page back from `head`. A live session's tail slides forward as it grows, so a
 * kept read of an earlier head is still good for everything before that head:
 * only the stretch between the two is read, then the kept rows join it.
 */
async function pageOlder(
  sessionId: string, record: SessionRecord, head: string, kept: OlderCacheEntry | undefined, deps: FindHistoryDeps,
): Promise<OlderCacheEntry> {
  const now = deps.now ?? Date.now
  const started = now()
  const reuse = kept && kept.before < head ? kept : undefined
  let before = head
  let collected: SessionHistoryMessage[] = []
  let reachedStart = false
  for (let page = 0; page < MAX_OLDER_PAGES && now() - started < OLDER_PAGES_BUDGET_MS; page++) {
    let got: Awaited<ReturnType<FindHistoryDeps['readBefore']>>
    try {
      got = await deps.readBefore(sessionId, record.cwd, record.host, before)
    } catch (err) {
      log.web.warn('session find: an older window was unreadable, searching what was read', {
        sessionId, before, error: err instanceof Error ? err.message : String(err),
      })
      break
    }
    if (!got) break
    collected = [...got.messages.map(slim), ...collected]
    if (got.reachedStart) { reachedStart = true; break }
    const next = got.messages.find((m) => m.timestamp)?.timestamp
    // A page that moved nothing would ask the same question again.
    if (!next || next >= before) break
    before = next
    if (reuse && next <= reuse.before) {
      // Back to where the kept read starts: it holds the rest.
      collected = [...reuse.rows, ...collected.filter((m) => m.timestamp >= reuse.before)]
      reachedStart = reuse.reachedStart
      break
    }
  }
  return { before: head, rows: collected, reachedStart, at: now() }
}

const MAX_FORK_DEPTH = 5

async function readAncestors(
  sessionId: string, record: SessionRecord, deps: FindHistoryDeps,
): Promise<{ rows: SessionHistoryMessage[]; partial: boolean }> {
  const chain: SessionRecord[] = []
  const visited = new Set<string>([sessionId])
  let next = record.forkedFromSessionId
  while (next && !visited.has(next) && chain.length < MAX_FORK_DEPTH) {
    visited.add(next)
    const parent = await deps.getSession(next)
    if (!parent) break
    chain.push(parent)
    next = parent.forkedFromSessionId
  }
  try {
    const fetched = await Promise.all(chain.reverse().map((r) => deps.readHistory(r.claudeSessionId, r, r.host)))
    let rows = fetched.flatMap((f) => f.messages)
    if (record.rewoundAtMessageUuid) {
      const { cutAncestorHistoryAtRewindPoint } = await import('./session-rewind.js')
      rows = cutAncestorHistoryAtRewindPoint(rows, record.rewoundAtMessageUuid).messages
    }
    return { rows, partial: fetched.some((f) => f.windowed) }
  } catch (err) {
    log.web.warn('session find: fork ancestors unreadable, searching the session alone', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    })
    return { rows: [], partial: true }
  }
}
