/**
 * Reads of a session's transcript where its host runs and judges it (docs/plan/one-service-every-host.md,
 * phase 2, Done-when 2: "the Mac's main thread parses no line of a session on another host").
 * Host-local work runs on the host and only the small result crosses: the host's own service
 * reads its transcript, parses it with the same code (session-history.ts, history-parse.ts), and
 * answers the parsed result at the size its reader takes (rows, a plan's text, a search body).
 * The host's side is sessions/host-history-answer.ts.
 *
 * Each reader (session-history.ts and the others named in HOST_CALL_ALLOWLIST.history) starts with
 * viaJudgingHost. A read of a session on another host goes one of three ways:
 *
 *   host      the session's judge is that host and its service answers reads (its report names
 *             SESSION_HISTORY_CAP): one `history` call (POST /host-api/sessions/call), under the
 *             legacy remote read's deadline. The answer is kept here by its version, per reader and
 *             arguments, and the version is sent with the next read of the same: an unchanged
 *             transcript answers `same` with no body (a poll of an idle session moves a few bytes).
 *             Concurrent reads of the same share one call. A large answer comes in pages of rows
 *             (a host with its parking full answers `busy`: this read fails as its reader's failed read).
 *   stale     the session's judge is that host, the host has answered reads before (on disk, so a
 *             restart remembers it), but its service is not running now (a restart, a stand-down,
 *             no link) or did not answer in time: the session is NEVER parsed here. The read
 *             answers the last answer kept here; the whole history throws HistoryReadFailedError,
 *             so its callers serve that copy marked stale (getCachedSessionHistory finds it, then
 *             the disk copy); with none kept, the reader's own failed read. The next read once the
 *             host is back goes to the host again, so the console recovers by itself.
 *             Right after a leader restart, until the host's first report (a few seconds), a host
 *             known on disk reads this way too.
 *   here      anything else (a legacy session, a host never seen answering reads: an older one, or
 *             one whose own host_runs_sessions switch is off, so its report has no SESSION_HISTORY_CAP;
 *             arguments JSON cannot carry): read here, as before, and its parsed lines count for
 *             the session (providers/line-parse-count.ts transcript lines), so `lineParsesOf(sid)
 *             === 0` covers these reads too.
 *
 * A host that refuses a read as not its own (it gave the session back) or does not know the
 * member is read here; the not-own refusal also tells the leader (session-channel/leader-boot.ts).
 */
import { inTranscriptReadOf } from '../../providers/line-parse-count.js'
import type { HostHistoryRead } from '../session-channel/host-calls.js'
import type { HistoryReadFailedError, SessionHistoryMessage } from '../session-history.js'
import type { HistoryAnswer, HistoryReadTag, HistoryWire } from './host-history-answer.js'
import { thisHostKey } from './session-row-owner.js'

export type { HostHistoryRead }
export { HOST_HISTORY_ANSWERED, answerHistoryRead } from './host-history-answer.js'

/** How long a leader waits for one answer (or one page): the legacy remote read's budget (session-file-reader.ts READ_TIMEOUT). */
export const HOST_HISTORY_DEADLINE_MS = 120_000
/**
 * The kept answers share the budget of this server's parsed history cache (session-history.ts
 * shares it through shareHistoryBudget): a host-judged session's rows are held here instead of
 * there, so one budget bounds the parsed history this server holds, whichever end parsed it.
 */
let budgetNow: () => { budget: number; other: number } = () => ({ budget: 64 * 1024 * 1024, other: 0 })

type CallBody = { sid: string; target: 'history'; member: string; args: unknown[]; read?: HistoryReadTag }
type Caller = (host: string, body: CallBody, timeoutMs: number) => Promise<unknown>

let caller: Caller | null = null
/** Hosts whose service answers reads now (their report says running and names the capability). */
const answering = new Set<string>()
/** Hosts whose service has answered reads (kept on disk): their sessions are never parsed here. */
let known: Set<string> | null = null
let knownLoad: Promise<Set<string>> | null = null
let forceHere = false
let deadlineMs = HOST_HISTORY_DEADLINE_MS

/** The answers kept here: key (sid, reader, arguments) -> the host's version and the decoded value. Oldest first. */
const kept = new Map<string, { sid: string; member: HostHistoryRead; version: string; value: unknown; chars: number }>()
let keptChars = 0
const inflight = new Map<string, Promise<unknown>>()

/** Installed by the leader side (session-channel/leader-boot.ts); null when it stops. */
export function setHostHistoryCaller(fn: Caller | null): void {
  caller = fn
  if (!fn) answering.clear()
}

/**
 * What a host's report says of its service: running and naming SESSION_HISTORY_CAP (`answers`),
 * running without it (`old`: an older service, read here as before), or not running (`down`).
 */
export function noteHostReadsHistory(host: string, state: 'answers' | 'old' | 'down'): void {
  if (state === 'answers') answering.add(host)
  else answering.delete(host)
  if (state === 'down') return
  void knownHosts().then((k) => {
    if ((state === 'answers') === k.has(host)) return
    if (state === 'answers') k.add(host)
    else k.delete(host)
    void writeKnown(k)
  })
}

export function hostReadsHistory(host: string): boolean {
  return answering.has(host)
}

async function knownFile(): Promise<string> {
  const [{ WALNUT_HOME }, path] = await Promise.all([import('../../constants.js'), import('node:path')])
  return path.join(WALNUT_HOME, 'host-history-readers.json')
}

function knownHosts(): Promise<Set<string>> {
  if (known) return Promise.resolve(known)
  knownLoad ??= (async () => {
    let hosts: unknown = []
    try { hosts = (JSON.parse(await (await import('node:fs/promises')).readFile(await knownFile(), 'utf8')) as { hosts?: unknown }).hosts } catch { /* none yet */ }
    known = new Set(Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === 'string' && h !== '') : [])
    return known
  })()
  return knownLoad
}

let writing: Promise<void> = Promise.resolve()
function writeKnown(k: Set<string>): Promise<void> {
  writing = writing.then(async () => {
    const fsp = await import('node:fs/promises')
    const file = await knownFile()
    const tmp = `${file}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify({ hosts: [...k].sort() }) + '\n', { mode: 0o600 })
    await fsp.rename(tmp, file)
  }).catch(() => { /* kept in memory; the next change writes again */ })
  return writing
}

const isRemote = (host: string | null | undefined): host is string => !!host && host !== '__local__'

/** Values JSON carries as they are: a Set, a Map, a function or a class instance does not cross. */
function plain(v: unknown, depth = 0): boolean {
  if (v === null || v === undefined) return true
  const t = typeof v
  if (t === 'string' || t === 'number' || t === 'boolean') return true
  if (t !== 'object' || depth > 6) return false
  if (Array.isArray(v)) return v.every((x) => plain(x, depth + 1))
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) return false
  return Object.values(v as Record<string, unknown>).every((x) => plain(x, depth + 1))
}

/** Which way a read of `sid` on `host` goes (see the header). */
async function wayOf(sid: string, host: string, extra: unknown[]): Promise<'host' | 'stale' | 'here'> {
  if (forceHere || !plain(extra)) return 'here'
  if (!answering.has(host) && !(await knownHosts()).has(host)) return 'here'
  const { judgingHostOf } = await import('./judge-of.js')
  if (judgingHostOf(sid) !== host) return 'here'
  return caller && answering.has(host) ? 'host' : 'stale'
}

/** A host's refusal that means "read it where you are" (not a failure of the read). */
const READ_HERE = /: (not_own_session|not_allowed|no_such_member|no_row)$/

/**
 * One transcript read of `sid` on `host`: answered by the host that judges it, or `here()` (the
 * reader's own body). `extra`: the reader's arguments past the session's own (its path and host).
 */
export function viaJudgingHost<T>(sid: string, host: string | null | undefined, member: HostHistoryRead, extra: unknown[], here: () => Promise<T>): Promise<T> {
  // A local read (or this host's own) is the reader's own promise, untouched: its in-flight sharing holds.
  if (!isRemote(host) || !sid || thisHostKey()) return here()
  return viaHost(sid, host, member, extra, here)
}

async function viaHost<T>(sid: string, host: string, member: HostHistoryRead, extra: unknown[], here: () => Promise<T>): Promise<T> {
  const way = await wayOf(sid, host, extra)
  if (way === 'here') return inTranscriptReadOf(sid, here)
  const key = `${sid}\u0000${member}\u0000${JSON.stringify(extra)}`
  if (way === 'stale') return await unavailable(key, member, `the host ${host} does not answer reads now`) as T
  const shared = inflight.get(key)
  if (shared) return await shared as T
  const run = readOnHost(sid, host, member, extra, key)
  inflight.set(key, run)
  try {
    const got = await run
    return (got === READ_HERE_MARK ? await inTranscriptReadOf(sid, here) : got) as T
  } finally {
    if (inflight.get(key) === run) inflight.delete(key)
  }
}

const READ_HERE_MARK = Symbol('read here')

async function readOnHost(sid: string, host: string, member: HostHistoryRead, extra: unknown[], key: string): Promise<unknown> {
  const crypto = await import('node:crypto')
  const id = crypto.randomBytes(9).toString('hex')
  const held = kept.get(key)
  const call = (m: string, args: unknown[], read?: HistoryReadTag) =>
    withDeadline(caller!(host, { sid, target: 'history', member: m, args, ...(read ? { read } : {}) }, deadlineMs), deadlineMs) as Promise<HistoryAnswer>
  let answer: HistoryAnswer
  try {
    answer = await call(member, extra, { id, ...(held ? { known: held.version } : {}) })
    if (answer.k === 'same' && !kept.has(key)) answer = await call(member, extra, { id })
    if (answer.k === 'paged') answer = await takePages(answer, call)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (READ_HERE.test(msg)) return READ_HERE_MARK
    // Gave up: the host drops what it still makes or holds of this read, and nothing late is parsed here.
    void caller?.(host, { sid, target: 'history', member: 'cancelRead', args: [id] }, 10_000).catch(() => {})
    return unavailable(key, member, `the host ${host} did not answer the read of ${sid}: ${msg}`)
  }
  if (answer.k === 'same') {
    const entry = kept.get(key)!
    kept.delete(key)
    kept.set(key, entry)
    return entry.value
  }
  if (answer.k !== 'full') return unavailable(key, member, `the host ${host} answered ${answer.k}`)
  const value = await fromWire(answer.wire)
  keep(key, { sid, member, version: answer.version, value, chars: answer.chars })
  // The last whole conversation the host answered: what a later failed read shows after a restart (history-disk-cache.ts).
  if (member === 'readSessionHistory' && answer.wire.k === 'rows' && !answer.wire.meta?.windowed && Array.isArray(value) && value.length > 0) {
    void import('../history-disk-cache.js').then(({ writeHistoryCache }) => writeHistoryCache(sid, value as SessionHistoryMessage[], undefined, answer.wire.k === 'rows' ? answer.wire.meta?.orphans : undefined)).catch(() => {})
  }
  return value
}

/** The pages of a parked answer, joined: one `full` answer (rows page by page, or a value's JSON in pieces). */
async function takePages(first: Extract<HistoryAnswer, { k: 'paged' }>, call: (m: string, args: unknown[]) => Promise<HistoryAnswer>): Promise<HistoryAnswer> {
  const rows: SessionHistoryMessage[] = [...(first.rows ?? [])]
  const text = [first.text ?? '']
  for (let n = 1; n < first.pages; n++) {
    const page = await call('readNextPage', [first.id, n])
    if (page.k !== 'page') throw new Error(`page ${n} of ${first.pages}: ${page.k}`)
    if (page.rows) for (const row of page.rows) rows.push(row)
    text.push(page.text ?? '')
  }
  const wire = (first.head.k === 'v' ? { k: 'v', value: JSON.parse(text.join('')) } : { ...first.head, rows }) as HistoryWire
  return { k: 'full', version: first.version, chars: first.chars, wire }
}

function keep(key: string, entry: { sid: string; member: HostHistoryRead; version: string; value: unknown; chars: number }): void {
  const old = kept.get(key)
  if (old) { kept.delete(key); keptChars -= old.chars }
  kept.set(key, entry)
  keptChars += entry.chars
  evict(key)
}

/** Drop the oldest kept answers (never `spare`) until this and the parse cache fit their one budget. */
function evict(spare?: string): void {
  const { budget, other } = budgetNow()
  for (const [k, e] of kept) {
    if (keptChars + other <= budget) break
    if (k === spare) continue
    kept.delete(k)
    keptChars -= e.chars
  }
}

/** session-history.ts: the budget its parse cache and these answers share, and what its cache holds. */
export function shareHistoryBudget(read: () => { budget: number; other: number }): void {
  budgetNow = read
}

/** The host's answer, or a rejection once the deadline passed (the call's own timer may be longer). */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms) })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

/**
 * The host cannot answer now: the last answer kept here, else the reader's failed read. The whole
 * history always throws, so its callers say "stale" over the copy they find (getCachedSessionHistory).
 */
async function unavailable(key: string, member: HostHistoryRead, why: string): Promise<unknown> {
  const { log } = await import('../../logging/index.js')
  log.session.warn('host history read degraded', { member, why, kept: kept.has(key) })
  if (member !== 'readSessionHistory' && kept.has(key)) return kept.get(key)!.value
  switch (member) {
    case 'readSessionHistoryTailWindow': case 'extractPlanContent': case 'reconstructWorkflowProgress': case 'readHistoryReachingAnchor':
      return null
    case 'readSessionRowToolResult':
      return undefined
    case 'readSessionBody':
      return { body: null }
    case 'readPlanFromSession':
      return { error: 'The plan could not be read: its host did not answer.' }
    default: {
      const { HistoryReadFailedError: Failed } = await import('../session-history.js')
      throw new Failed(why) as HistoryReadFailedError
    }
  }
}

async function fromWire(wire: HistoryWire): Promise<unknown> {
  if (!wire || typeof wire !== 'object') return null
  if (wire.k === 'v') return wire.value
  const { markHistoryRows } = await import('../session-history.js')
  const rows = Array.isArray(wire.rows) ? wire.rows : []
  markHistoryRows(rows, wire.meta)
  return wire.k === 'rows' ? rows : { ...wire.value, messages: rows }
}

/** The newest whole history the host answered for `sid` (a stale copy for a failed read's caller), if kept. */
export function keptHostHistoryOf(sid: string): SessionHistoryMessage[] | undefined {
  let found: SessionHistoryMessage[] | undefined
  for (const e of kept.values()) if (e.sid === sid && e.member === 'readSessionHistory' && Array.isArray(e.value)) found = e.value as SessionHistoryMessage[]
  return found
}

/** Memory pressure (session-history.ts setHistoryCacheShedding lowered the shared budget): fit it, the newest kept. */
export function shedKeptHostHistory(): void {
  evict([...kept.keys()].at(-1))
}

/** What is kept now (the memory ledger reads it). */
export function keptHostHistoryState(): { entries: number; chars: number } {
  return { entries: kept.size, chars: keptChars }
}

/** Tests: every read runs here (true) or is routed again (false). */
export function _readHistoryHereForTesting(on: boolean): void {
  forceHere = on
}

/** Tests: a shorter deadline (null: the default). */
export function _setHostHistoryDeadlineForTesting(ms: number | null): void {
  deadlineMs = ms ?? HOST_HISTORY_DEADLINE_MS
}

/** Tests: forget the kept answers, the hosts known to answer, and the switches above. */
export async function _resetHostHistoryReadsForTesting(): Promise<void> {
  await writing
  kept.clear()
  keptChars = 0
  inflight.clear()
  answering.clear()
  known = null
  knownLoad = null
  forceHere = false
  deadlineMs = HOST_HISTORY_DEADLINE_MS
}
