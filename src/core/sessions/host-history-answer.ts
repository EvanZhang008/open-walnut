/**
 * The host's side of the transcript reads its leader asks of the sessions it runs and judges
 * (sessions/host-history-reads.ts is the leader's side; the `history` call target of
 * session-channel/host-calls.ts, dispatched by session-channel/host-routes.ts after its ownership
 * check). The host runs the reader on its OWN row (its cwd, host and output file; no path the leader
 * names) with the same code the leader runs for its own sessions, so there is one parser.
 *
 *   version   each answer carries a version: a hash of the answer as JSON, row by row. The leader
 *             sends back the version it holds (`read.known`); when the answer is unchanged the host
 *             answers `same` with no body, so a poll of an idle session moves a few bytes. The
 *             host's own caches make the read cheap, and the version (with each row's size) is
 *             memoized by the rows array the reader handed back, so a cache hit is not written as
 *             JSON again. Only the version is kept, never the JSON. The memo's premise: a cached
 *             rows array is not changed in place once a reader handed it out (the readers build a
 *             fresh array for every change: an append, a rewind, a marks change); a consumer that
 *             edited one in place would be answered `same` with the old rows.
 *   pages     an answer is never sent in one piece larger than PAGE_CHARS: a larger one is parked
 *             (a reference to its rows, no copy) under the read's id and the leader takes it page
 *             by page (`readNextPage`, whole rows a page), so one big history never fills or stalls
 *             the channel socket every session of this host shares (the door takes 64 MiB a frame
 *             and closes the socket past it). A parked answer being taken is never dropped: each
 *             page renews it, and only one left untaken for PARK_TTL_MS goes. With PARK_MAX_ANSWERS
 *             parked, or PARK_MAX_TOTAL_CHARS (two answers at the cap), a new large read is refused
 *             (`busy`): it fails as that reader's failed read, and its next try is served.
 *   size      MAX_CHARS is the legacy whole read's ceiling (DaemonFileReader 32 MiB): a whole read
 *             or a tail whose answer is larger answers the same last-4-MiB window the legacy path
 *             falls back to past its ceiling (marked windowed), never a failure the legacy path
 *             did not have.
 *   cancel    a leader that gave up sends `cancelRead`: an answer still being made is dropped (the
 *             reply is `cancelled`, a few bytes), and its parked pages go.
 */
import crypto from 'node:crypto'
import type { HistoryRowsMeta, SessionHistoryMessage } from '../session-history.js'
import type { SessionRecord } from '../types.js'
import type { HostHistoryRead } from '../session-channel/host-calls.js'
import { registerMemoryHolder } from '../observability/memory-ledger.js'
import { getSessionByClaudeId } from '../session-tracker.js'

/** The wire of a read's result: rows carry their parse's marks; anything else crosses as it is. */
export type HistoryWire =
  | { k: 'rows'; rows: SessionHistoryMessage[]; meta?: HistoryRowsMeta }
  | { k: 'with'; value: Record<string, unknown>; rows: SessionHistoryMessage[]; meta?: HistoryRowsMeta }
  | { k: 'v'; value: unknown }

/** A parked answer's wire without its rows (they come page by page). */
export type HistoryWireHead = { k: 'rows'; meta?: HistoryRowsMeta } | { k: 'with'; value: Record<string, unknown>; meta?: HistoryRowsMeta } | { k: 'v' }

/**
 * One read's answer. `chars`: the length of the answer as JSON (what the leader keeps, by its
 * budget). A `paged` answer of rows carries its first page's rows; one of a value (`k: 'v'`)
 * carries the first piece of the value's JSON as `text`.
 */
export type HistoryAnswer =
  | { k: 'same'; version: string }
  | { k: 'full'; version: string; chars: number; wire: HistoryWire }
  | { k: 'paged'; version: string; chars: number; id: string; pages: number; head: HistoryWireHead; rows?: SessionHistoryMessage[]; text?: string }
  | { k: 'page'; rows?: SessionHistoryMessage[]; text?: string }
  | { k: 'gone' }
  | { k: 'busy' }
  | { k: 'cancelled' }
  | { k: 'too_large'; chars: number }

/** What a leader sends beside the arguments of one read: its id (for a cancel and its pages), and the version it holds. */
export interface HistoryReadTag { id: string; known?: string }

const DEFAULTS = { pageChars: 4 * 1024 * 1024, maxChars: 32 * 1024 * 1024, maxAnswers: 8 }
let PAGE_CHARS = DEFAULTS.pageChars
let MAX_CHARS = DEFAULTS.maxChars
let PARK_MAX_ANSWERS = DEFAULTS.maxAnswers
/** The tail window past the ceiling (undefined: the reader's own, the legacy 4 MiB). */
let TAIL_BYTES: number | undefined
/** A parked answer untaken this long is dropped. */
const PARK_TTL_MS = 2 * 60_000
/** The JSON text parked for values (rows are parked by reference): past it a new park is refused. */
const PARK_MAX_TEXT_CHARS = 16 * 1024 * 1024
/** All parked answers together, two at the cap: past it a new park is refused (what parked rows keep alive). */
const PARK_MAX_TOTAL_CHARS = 2 * DEFAULTS.maxChars

interface Parked { until: number; rows?: SessionHistoryMessage[]; bounds?: number[]; text?: string[]; chars: number; textChars: number }
const parked = new Map<string, Parked>()
let parkedText = 0
let parkedTotal = 0
/** Reads the leader gave up on (id -> until). */
const cancelled = new Map<string, number>()
// Parked rows are references to arrays the reader's own caches hold; only parked value text is a copy.
registerMemoryHolder({ name: 'host-history.parked', budgetBytes: PARK_MAX_TEXT_CHARS * 2, read: () => ({ entries: parked.size, chars: parkedText }) })

/** An agent id as Claude Code names its subagent files (agent-<id>.jsonl): no path in it. */
const AGENT_ID = /^[A-Za-z0-9_@.-]{1,200}$/

const sh = () => import('../session-history.js')
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Each read as the host runs it: on its own row, with the leader's extra arguments. */
const READS: Record<HostHistoryRead, (row: SessionRecord, extra: unknown[]) => Promise<unknown>> = {
  readSessionHistory: async (r, [options]) => (await sh()).readSessionHistory(r.claudeSessionId, r.cwd, r.host, r.outputFile, options as never),
  readSessionHistoryTail: async (r, [maxTailBytes, opts]) =>
    (await sh()).readSessionHistoryTail(r.claudeSessionId, r.cwd, r.host, r.outputFile, num(maxTailBytes), opts as never),
  readSessionHistoryTailWindow: async (r, [maxTailBytes, parseOpts]) =>
    (await sh()).readSessionHistoryTailWindow(r.claudeSessionId, r.cwd, r.host, num(maxTailBytes), parseOpts as never),
  readSessionHistoryRange: async (r, [start, end]) => (await sh()).readSessionHistoryRange(r.claudeSessionId, r.cwd, r.host, Number(start) || 0, Number(end) || 0),
  readSessionRowToolResult: async (r, [toolUseId, maxChars]) =>
    (await sh()).readSessionRowToolResult(r.claudeSessionId, str(toolUseId), Number(maxChars) || 0, r.cwd, r.host),
  extractPlanContent: async (r) => (await sh()).extractPlanContent(r.claudeSessionId, r.cwd, r.host),
  readSingleSubagentHistory: async (r, [agentId, workflow]) => {
    if (!AGENT_ID.test(str(agentId))) throw Object.assign(new Error('agentId is not an agent id'), { code: 'bad_request' })
    return (await sh()).readSingleSubagentHistory(r.claudeSessionId, str(agentId), r.cwd, r.host, workflow === true)
  },
  reconstructWorkflowProgress: async (r) => (await sh()).reconstructWorkflowProgress(r.claudeSessionId, r.cwd, r.host),
  readHistoryReachingAnchor: async (r, [anchorMsgId]) =>
    (await import('../history-anchor-reach.js')).readHistoryReachingAnchor(r.claudeSessionId, r.cwd, r.host, str(anchorMsgId)),
  readAcpSessionHistoryState: async (r, [options]) =>
    (await import('../../providers/acp-session-history.js')).readAcpSessionHistoryState(r, { ...((options as object | undefined) ?? {}), reader: undefined }),
  readSessionBody: async (r, [tailBytes]) => (await import('../search/build.js')).readSessionBody(r, num(tailBytes)),
  readPlanFromSession: async (r) => (await import('../../utils/plan-message.js')).readPlanFromSession(r.claudeSessionId),
  readActiveContext: async (r) => (await import('./engine-switch-context.js')).readActiveContext(r),
}

/** The reads a host answers (the ratchet holds them equal to the readers of HOST_CALL_ALLOWLIST.history). */
export const HOST_HISTORY_ANSWERED: readonly string[] = Object.keys(READS)

/** The version and size of an answer, memoized by its rows array (see the header's premise). */
interface Encoded { key: string; version: string; chars: number; head: HistoryWireHead; rows?: SessionHistoryMessage[]; bounds?: number[]; json?: string }
const versions = new WeakMap<object, Omit<Encoded, 'rows' | 'head' | 'json'> & { page: number }>()

async function encode(value: unknown): Promise<Encoded> {
  const { historyRowsMeta } = await sh()
  let head: HistoryWireHead
  let rows: SessionHistoryMessage[] | undefined
  if (Array.isArray(value)) {
    rows = value as SessionHistoryMessage[]
    head = { k: 'rows', meta: historyRowsMeta(value) }
  } else if (value && typeof value === 'object' && Array.isArray((value as { messages?: unknown }).messages)) {
    const { messages, ...rest } = value as Record<string, unknown> & { messages: SessionHistoryMessage[] }
    rows = messages
    head = { k: 'with', value: rest, meta: historyRowsMeta(messages) }
  } else {
    const json = JSON.stringify(value ?? null)
    return { key: '', head: { k: 'v' }, json, chars: json.length, version: crypto.createHash('sha1').update(json).digest('base64url').slice(0, 22) }
  }
  // The marks and the rest of a `with` answer can change while the rows array stays: they are the memo's key.
  const key = JSON.stringify(head)
  const memo = versions.get(rows)
  if (memo && memo.key === key && memo.page === PAGE_CHARS) return { ...memo, head, rows }
  const hash = crypto.createHash('sha1').update(key)
  const bounds = [0]
  let chars = key.length + 2
  let pageChars = 0
  rows.forEach((row, i) => {
    const one = JSON.stringify(row)
    hash.update('\n').update(one)
    chars += one.length + 1
    if (pageChars > 0 && pageChars + one.length > PAGE_CHARS) { bounds.push(i); pageChars = 0 }
    pageChars += one.length + 1
  })
  bounds.push(rows.length)
  const out = { key, version: hash.digest('base64url').slice(0, 22), chars, bounds, page: PAGE_CHARS }
  versions.set(rows, out)
  return { ...out, head, rows }
}

function sweep(now: number): void {
  for (const [id, p] of parked) if (p.until <= now) dropParked(id)
  for (const [id, until] of cancelled) if (until <= now) cancelled.delete(id)
}

function dropParked(id: string): void {
  const p = parked.get(id)
  if (!p) return
  parked.delete(id)
  parkedText -= p.textChars
  parkedTotal -= p.chars
}

/** Park a large answer under the read's id, or null when the parking is full (the read is refused `busy`). */
function park(id: string, e: Encoded, now: number): Parked | null {
  dropParked(id)
  if (parked.size >= PARK_MAX_ANSWERS || parkedTotal + e.chars > PARK_MAX_TOTAL_CHARS) return null
  let p: Parked
  if (e.rows) {
    p = { until: now + PARK_TTL_MS, rows: e.rows, bounds: e.bounds, chars: e.chars, textChars: 0 }
  } else {
    if (parkedText + e.chars > PARK_MAX_TEXT_CHARS) return null
    const text: string[] = []
    for (let at = 0; at < e.json!.length; at += PAGE_CHARS) text.push(e.json!.slice(at, at + PAGE_CHARS))
    p = { until: now + PARK_TTL_MS, text, chars: e.chars, textChars: e.chars }
  }
  parked.set(id, p)
  parkedText += p.textChars
  parkedTotal += p.chars
  return p
}

const pagesOf = (p: Parked): number => (p.text ? p.text.length : p.bounds!.length - 1)
const pageOf = (p: Parked, n: number): { rows?: SessionHistoryMessage[]; text?: string } =>
  p.text ? { text: p.text[n] } : { rows: p.rows!.slice(p.bounds![n], p.bounds![n + 1]) }

/** Members whose answer past MAX_CHARS is the legacy path's over-ceiling tail window. */
const TAIL_PAST_CEILING = new Set<string>(['readSessionHistory', 'readSessionHistoryTail'])

/**
 * The host's answer to one `history` call for a session this host owns (the route checked):
 * a read, a page of a parked one, or a cancel.
 */
export async function answerHistoryRead(sid: string, member: string, args: readonly unknown[], tag?: HistoryReadTag): Promise<{ ok: true; value: HistoryAnswer } | { ok: false; error: string }> {
  const now = Date.now()
  sweep(now)
  if (member === 'readNextPage') {
    const id = str(args[0])
    const p = parked.get(id)
    const n = Number(args[1])
    if (!p || !Number.isInteger(n) || n < 1 || n >= pagesOf(p)) return { ok: true, value: { k: 'gone' } }
    p.until = now + PARK_TTL_MS
    const page = pageOf(p, n)
    if (n === pagesOf(p) - 1) dropParked(id)
    return { ok: true, value: { k: 'page', ...page } }
  }
  if (member === 'cancelRead') {
    const id = str(args[0])
    if (id) cancelled.set(id, now + PARK_TTL_MS)
    dropParked(id)
    return { ok: true, value: { k: 'cancelled' } }
  }
  if (!Object.hasOwn(READS, member)) return { ok: false, error: 'no_such_member' }
  const row = await getSessionByClaudeId(sid)
  if (!row) return { ok: false, error: 'no_row' }
  // JSON writes an absent argument as null: each reader takes it as absent again.
  let value: unknown
  try {
    value = await READS[member as HostHistoryRead](row, args.map((a) => (a === null ? undefined : a)))
  } catch (err) {
    if ((err as { code?: unknown })?.code === 'bad_request') return { ok: false, error: 'bad_request' }
    throw err
  }
  let e = await encode(value)
  if (e.chars > MAX_CHARS && TAIL_PAST_CEILING.has(member)) {
    // Past the legacy whole read's ceiling: the legacy path's own fallback, its last 4 MiB, marked windowed.
    e = await encode(await (await sh()).readSessionHistoryTailWindow(row.claudeSessionId, row.cwd, row.host, TAIL_BYTES) ?? [])
  }
  if (tag?.id && cancelled.delete(tag.id)) return { ok: true, value: { k: 'cancelled' } }
  if (tag?.known && tag.known === e.version) return { ok: true, value: { k: 'same', version: e.version } }
  // Past the ceiling with no window to fall back to (a value is parked as text, so its own smaller cap).
  if (e.chars > (e.rows ? MAX_CHARS : PARK_MAX_TEXT_CHARS)) return { ok: true, value: { k: 'too_large', chars: e.chars } }
  if (e.chars <= PAGE_CHARS) {
    const wire = (e.rows ? { ...e.head, rows: e.rows } : { k: 'v', value: value ?? null }) as HistoryWire
    return { ok: true, value: { k: 'full', version: e.version, chars: e.chars, wire } }
  }
  const id = tag?.id || crypto.randomBytes(12).toString('hex')
  const p = park(id, e, now)
  if (!p) return { ok: true, value: { k: 'busy' } }
  return { ok: true, value: { k: 'paged', version: e.version, chars: e.chars, id, pages: pagesOf(p), head: e.head, ...pageOf(p, 0) } }
}

/** Tests: smaller pages, cap, parking and tail window (null: the defaults). */
export function _setHistoryPagingForTesting(o: { pageChars?: number; maxChars?: number; maxAnswers?: number; tailBytes?: number } | null): void {
  TAIL_BYTES = o?.tailBytes
  PAGE_CHARS = o?.pageChars ?? DEFAULTS.pageChars
  MAX_CHARS = o?.maxChars ?? DEFAULTS.maxChars
  PARK_MAX_ANSWERS = o?.maxAnswers ?? DEFAULTS.maxAnswers
  if (!o) { parked.clear(); parkedText = 0; parkedTotal = 0; cancelled.clear() }
}

/** Tests: what is parked now. */
export function _parkedHistoryForTesting(): { answers: number; chars: number } {
  return { answers: parked.size, chars: parkedText }
}
