/**
 * Every way a host's SESSION CHANNEL reaches this leader is held to one rule: a host speaks only of
 * sessions that are its own (src/core/session-channel/handed-sessions.ts), and of the task the
 * leader's row of each says, never of another. The ways in, enumerated from the source so a new
 * one fails here until it is classified and checked:
 *
 *   1. LeaderSideDeps (leader-side.ts): each member either applies what a host sent (rows, facts,
 *      live state, flow, renames, the judge of a session) or does not. Behaviour, through a real
 *      HostChannel and the real transaction (session-tracker applyHostChannelBatch): a record of
 *      every kind (CHANNEL_RECORD_KINDS) and every fact and flow event (SESSION_EVENT_CLASS)
 *      naming a session the host does not own reaches none of the applying members; the same
 *      records of the host's own session do, each fact saying the task of the leader's row, not
 *      the one the host wrote; and nothing at all of a revoked host applies.
 *   2. HostChannelBatch and HostRowChange (session-tracker.ts): each member of the batch the
 *      transaction applies is classified; the rows and renames are checked there
 *      (tests/core/session-channel/handed-sessions.test.ts), the task too.
 *   3. Every caller of judge-of.ts noteHostJudged (the leader's memory of whose a session is): only
 *      a row the transaction wrote, a seed the leader chose, or an answer settleAnswer checked.
 *   4. Every top-level key of every fact and flow payload (event-types.ts EventPayloadMap), in one
 *      table (fact-keys.ts FACT_KEYS): the session (checked), rewritten (task, host), scoped (queue
 *      rows and transfer attempts: only the ones the leader handed this session stand) or the
 *      session's own data. A fact or flow with no payload type fails until it is typed.
 *
 * The other ways a host's data reaches this leader, each held where it enters:
 *   - its journal, drained when the Mac comes back (offline-merge/apply-session.ts): a session record
 *     is adopted only for a task that host's own journal created (created_by_op), checked there and
 *     in tests/core/offline-merge/drain-session-adopt.test.ts; the sessions a host starts while the Mac is away come this way
 *     (tests/e2e/companion-host-listener-e2e.test.ts covers one end to end);
 *   - the gateway, its sessions' `walnut` calls relayed by its daemon: each runs with the origin
 *     `host:<key>` (peers/capability-router.ts), which a caller can only lower, under the op's own
 *     remote policy; a host's door is never revoked or allowed through it (routes/host-doors.ts,
 *     tests/web/routes/host-doors.test.ts);
 *   - the door's handshake (host-door.ts): a proof by the host's own key, checked there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-own-ratchet'))

import { FactLog } from '../../../src/core/session-channel/fact-log.js'
import { HostChannel, isChannelFrame } from '../../../src/core/session-channel/channel.js'
import { createLeaderSide, type LeaderSide, type LeaderSideDeps } from '../../../src/core/session-channel/leader-side.js'
import type { ChannelSocket } from '../../../src/core/session-channel/leader-links.js'
import { CHANNEL_RECORD_KINDS, SESSION_EVENT_CLASS } from '../../../src/core/session-channel/event-classes.js'
import { FACT_KEYS } from '../../../src/core/session-channel/fact-keys.js'
import type { SessionRecord } from '../../../src/core/types.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetSessionTrackerForTesting, applyHostChannelBatch, getSessionByClaudeId } from '../../../src/core/session-tracker.js'
import { closeDb, sessionTaskAndEngineInStore } from '../../../src/core/session-db.js'
import { handStart, linesNotOthers, noteLinesHanded } from '../../../src/core/session-channel/handed-sessions.js'
import { _resetJudgeOfForTesting, judgingHostOf, noteHostJudged } from '../../../src/core/sessions/judge-of.js'
import { _resetRefusedSessionsForTesting } from '../../../src/core/session-channel/refused-sessions.js'
import * as routeTable from '../../../src/replica/route-table.js'
import { hostRevokedNow, setRevokedHostResolver, setRevokedHosts } from '../../../src/core/session-channel/revoked-hosts.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** Members of an interface, by name, from its source. */
function membersOf(src: string, name: string): string[] {
  const start = src.indexOf(`export interface ${name} {`)
  expect(start, name).toBeGreaterThan(-1)
  let depth = 0
  let end = start
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  const body = src.slice(src.indexOf('{', start) + 1, end)
  return [...body.matchAll(/^ {2}(\w+)\??[(:]/gm)].map((m) => m[1]!)
}

/** LeaderSideDeps members that apply a host's data to this leader: each is reached only for the host's own sessions. */
const APPLIES: Record<string, string> = {
  applyBatch: 'rows, renames, drops: the transaction refuses a session that is not the host\'s (handed-sessions.ts)',
  emit: 'facts and flow on the bus: only of a session the host owns (ownerOf) or one this batch wrote',
  noteLive: 'live state: the same check',
  noteBorn: 'a born row the batch wrote',
  noteRename: 'a rename the batch applied',
  noteHostJudged: 'the rows the batch wrote',
}
/** The other members: they read, link, or report, and apply nothing a host sent. */
const OTHER = [
  'walnutId', 'permit', 'switchNow', 'openStream', 'dial', 'request', 'ownerOf', 'startsInFlight', 'leaderDrops', 'loadCursor',
  'onLinkLost', 'liveUnknownMs', 'onLinked', 'onCaughtUp', 'backoffMs', 'heldSayAgainMs', 'callTimeoutMs', 'startTimeoutMs', 'refused', 'log',
  // Reads: the leader's own task of a session (a fact says it), and whether the host is revoked.
  'taskOf', 'revoked',
  // Reads: which of the ids a fact names the leader handed this session (fact-keys.ts, scoped keys).
  'scopeIds',
]

/** HostChannelBatch members, and how the transaction holds each to the host's own sessions. */
const BATCH: Record<string, string> = {
  hostId: 'the link\'s host, never what the host says (leader-side.ts binds it)',
  rows: 'a row of another owner is skipped; a new one needs a hand (handForNewSession)',
  renames: 'from the host\'s own row, into a new unhanded id or its own row (mayRenameInto)',
  cursor: 'the channel position of this host only',
  drops: 'clears only this host\'s marks (clearLeaderDrops by host)',
  check: 'answers which of these the leader deleted; applies nothing',
  snapshot: 'deletes only this host\'s rows it names gone; new rows in it go through `rows`',
  turnEnds: 'a turn-end mark only on a row that is this host\'s own (host and judge), as the transaction checks',
}

/** HostRowChange members (one row of the batch), and how the transaction holds each. */
const ROW_CHANGE: Record<string, string> = {
  sid: 'the session: its row must be the host\'s, or a hand must name it',
  born: 'a whole row: still needs the hand for a new id',
  patch: 'the host\'s fields; a held row keeps its task (taskKept), the leader\'s fields are never taken (mergeHostFacts)',
  seq: 'order only',
  hand: 'the echo of an open hand: only that start\'s hand, of this host, takes it',
  keep: 'fields the host\'s log cut on disk: the leader keeps its own value of each (mergeHostFacts), never a host\'s cut one',
}

/** Callers of noteHostJudged, by file: how many, and why each is the host's session for sure. */
const NOTE_HOST_JUDGED: Record<string, { calls: number; why: string }> = {
  'src/providers/host-judged-runner.ts': { calls: 1, why: 'an answer settleAnswer checked' },
  'src/providers/host-handover.ts': { calls: 3, why: 'a session the leader hands over (handStartToHost: a seed it chose, a resume of its own row), and its hand-over marks on disk, read again (loadMarks, rearmHandOvers)' },
  'src/core/session-channel/leader-apply.ts': { calls: 2, why: 'the rows the transaction wrote (applyRecs, applyRows)' },
}

/**
 * Every caller of createSessionRecord (a new session id), by file, and why none of them can bring
 * the leader a session it did not hand when it runs on a host that runs its sessions (R2-N4). A
 * host's row reaches the channel only when it is its own (host = its key, judge 'host':
 * rowOwnedHere), and on a host replica only the own-row writer writes such a row; every write route
 * there goes to the leader, or into the journal while the Mac is away (checked below).
 */
const CREATES_SESSION: Record<string, { calls: number; why: string }> = {
  'src/providers/claude-code-session.ts': { calls: 2, why: 'the runner: on a host, a start the leader handed (its hand), through the host session port' },
  'src/providers/acp-session.ts': { calls: 1, why: 'the ACP runner: the same; a new provider id is a rename (mayRenameInto)' },
  'src/core/session-channel/host-port.ts': { calls: 2, why: 'the host session port the runners write through: gives the row the host\'s key' },
  'src/core/sessions/task-start.ts': { calls: 1, why: 'a start route: on a host replica a write, so the leader runs it, or the journal (away start)' },
  'src/core/sessions/quick-start.ts': { calls: 1, why: 'a start route: the same' },
  'src/core/sessions/session-controls.ts': { calls: 1, why: 'a fork route: the same' },
  'src/core/sessions/session-rewind.ts': { calls: 1, why: 'a rewind route: the same' },
  'src/core/sessions/side-thread-fork.ts': { calls: 1, why: 'a side thread route: the same' },
  'src/core/sessions/lane-fork.ts': { calls: 1, why: 'a chat fork route: the same' },
  'src/core/sessions/personal-ai-lane.ts': { calls: 1, why: 'the Personal AI lane: a route, the same; no host key (never an own row)' },
  'src/core/sessions/cloud-chat-lane.ts': { calls: 1, why: 'the companion\'s own chat lane: no host key (never an own row)' },
  'src/core/subagents/on-host.ts': { calls: 1, why: 'subagent_run on a host: the leader makes the row and starts it there, handed' },
  'src/core/ai/ai-agent.ts': { calls: 1, why: 'a plugin\'s AI call on the server it runs on: no host key (never an own row)' },
  'src/core/offline-merge/apply-session.ts': { calls: 2, why: 'the leader\'s journal drain: only for a task that host\'s own journal created (created_by_op)' },
}

/** The write routes a host replica runs itself (replica/route-table.ts `local`), and why none makes a session. */
const LOCAL_WRITES: Record<string, string> = {
  'POST /leader-witness/*': 'a leader switch witness\'s door (web/routes/witness-door.ts): a challenge and a vote on its own record, never a session',
}

/** Calls of `fn` per file under src/ (comments and declarations left out). */
function callersOf(fn: string, skip: string[] = []): Record<string, number> {
  const found: Record<string, number> = {}
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name)
      if (e.isDirectory()) walk(rel)
      else if (rel.endsWith('.ts') && !skip.includes(rel)) {
        const code = read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
        const n = (code.match(new RegExp(`\\b${fn}\\((?![^)]*:\\s*string)`, 'g')) ?? []).length
        if (n > 0) found[rel] = n
      }
    }
  }
  walk('src')
  return found
}

/** An interface's body in `src`, or null. */
function bodyOf(src: string, name: string): string | null {
  const start = src.indexOf(`export interface ${name} {`)
  if (start < 0) return null
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(src.indexOf('{', start) + 1, i) }
  }
  return null
}

describe('the ways a host\'s data reaches this leader are all classified', () => {
  it('every LeaderSideDeps member is either an applying one or not', () => {
    const members = membersOf(read('src/core/session-channel/leader-side.ts'), 'LeaderSideDeps')
    const known = new Set([...Object.keys(APPLIES), ...OTHER])
    expect(members.filter((m) => !known.has(m)), 'classify a new LeaderSideDeps member in this test (APPLIES or OTHER), and check ownership if it applies host data').toEqual([])
    expect([...known].filter((m) => !members.includes(m)), 'a member listed here is gone from LeaderSideDeps').toEqual([])
  })

  it('every HostChannelBatch member says how the transaction holds it to the host\'s own sessions', () => {
    const members = membersOf(read('src/core/session-tracker.ts'), 'HostChannelBatch')
    expect(members.filter((m) => !(m in BATCH)), 'a new member of the batch: hold it to the host\'s own sessions in applyHostChannelBatch, then list it here').toEqual([])
    expect(Object.keys(BATCH).filter((m) => !members.includes(m))).toEqual([])
    const row = membersOf(read('src/core/session-tracker.ts'), 'HostRowChange')
    expect(row.filter((m) => !(m in ROW_CHANGE)), 'a new member of a row change: hold it in applyHostChannelBatch, then list it here').toEqual([])
    expect(Object.keys(ROW_CHANGE).filter((m) => !row.includes(m))).toEqual([])
  })

  it('every top-level key of every fact and flow payload is classified in FACT_KEYS, and every one has a payload type', () => {
    const types = read('src/core/event-types.ts')
    const map = bodyOf(types, 'EventPayloadMap')!
    const payloadOf = new Map([...map.matchAll(/'([a-z:-]+)':\s*(\w+)/g)].map((m) => [m[1]!, m[2]!]))
    const untyped: string[] = []
    const unclassified: string[] = []
    const used = new Set<string>()
    for (const [name, cls] of Object.entries(SESSION_EVENT_CLASS)) {
      if (cls !== 'fact' && cls !== 'flow') continue
      const type = payloadOf.get(name)
      // An interface that extends another hides keys from this read: it fails too, until it is flattened.
      const body = type && !new RegExp(`export interface ${type} extends`).test(types) ? bodyOf(types, type) : null
      if (!body) { untyped.push(`${name}${type ? ` (${type})` : ''}`); continue }
      for (const m of body.matchAll(/^ {2}(\w+)\??:/gm)) {
        used.add(m[1]!)
        if (!(m[1]! in FACT_KEYS)) unclassified.push(`${name}.${m[1]}`)
      }
    }
    expect(untyped, 'a fact or flow with no payload interface in EventPayloadMap: type it, so its keys are read here').toEqual([])
    expect(unclassified, 'a fact or flow key: classify it in fact-keys.ts FACT_KEYS (and hold it in factAsLeaderSays if it names a leader object)').toEqual([])
    expect(Object.keys(FACT_KEYS).filter((k) => !used.has(k)), 'a FACT_KEYS entry no payload has any more').toEqual([])
  })

  it('the transaction checks a hand before a new row and before a rename into a new id', () => {
    const src = read('src/core/session-tracker.ts')
    const body = src.slice(src.indexOf('export async function applyHostChannelBatch'), src.indexOf('export { loadChannelCursor }'))
    expect(body).toMatch(/handForNewSession\(handle, hostId, change\.sid, \{ echo: change\.hand, taskId: next\.taskId \?\? '' \}\)/)
    // A held row keeps the task it was born for.
    expect(body).toMatch(/if \(before && \(next\.taskId \?\? ''\) !== \(before\.taskId \?\? ''\)\) \{ next\.taskId = before\.taskId/)
    expect(body).toMatch(/mayRenameInto\(handle, hostId, to\)/)
    // Every row write in it is one of the three known ones (a row change, a rename, a snapshot's orphan mark).
    expect(body.match(/writeSessionRowSqlite\(/g)?.length, 'a new write in applyHostChannelBatch: hold it to the host\'s own sessions, then count it here').toBe(3)
  })

  it('every maker of a new session id is classified: none brings the leader a session it did not hand (R2-N4)', () => {
    expect(callersOf('createSessionRecord'), 'a new caller of createSessionRecord: say in CREATES_SESSION why, on a host that runs its sessions, its row is handed or never the host\'s own').toEqual(
      Object.fromEntries(Object.entries(CREATES_SESSION).map(([f, v]) => [f, v.calls])))
    // A host replica runs no write route itself: each goes to the leader, or the journal while it is away.
    const { ROUTE_TABLE } = routeTable
    const localWrites = ROUTE_TABLE.filter((r) => (r.cls === 'local' || r.cls === 'feature') && r.method !== 'GET' && r.method !== 'HEAD')
    expect(localWrites.map((r) => `${r.method} ${r.pattern}`).sort(), 'a write route a host replica runs itself could make a session the leader never handed: list it in LOCAL_WRITES with why it makes none').toEqual(Object.keys(LOCAL_WRITES).sort())
  })

  it('noteHostJudged is called only where the session is known to be the host\'s', () => {
    // Calls only (a declaration names its parameters' types).
    const found = callersOf('noteHostJudged', ['src/core/sessions/judge-of.ts'])
    expect(found).toEqual(Object.fromEntries(Object.entries(NOTE_HOST_JUDGED).map(([f, v]) => [f, v.calls])))
    // The answer's id is taken only after settleAnswer said it is the host's.
    const runner = read('src/providers/host-judged-runner.ts')
    expect(runner.indexOf('settleAnswer(')).toBeGreaterThan(-1)
    expect(runner.indexOf('noteHostJudged(a.sessionId')).toBeGreaterThan(runner.indexOf('settleAnswer('))
  })
})

// ── Behaviour: a real HostChannel over an in-memory socket and the real transaction, every record kind ──

let dir = ''
let side: LeaderSide | null = null
let log: FactLog | null = null
beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetJudgeOfForTesting()
  _resetRefusedSessionsForTesting()
  attempts.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-own-ratchet-'))
})
afterEach(async () => {
  side?.stop()
  side = null
  setRevokedHosts([])
  setRevokedHostResolver(null)
  await log?.close().catch(() => {})
  log = null
  await fsp.rm(dir, { recursive: true, force: true })
  closeDb()
  _resetSessionTrackerForTesting()
})

/** A host-dialed socket whose other end is `channel`, each frame delivered on a later turn. */
function socketTo(channel: HostChannel): { sock: ChannelSocket; open(): void; closed: () => boolean } {
  let toLeader: ((t: string) => void) | null = null
  const queued: string[] = []
  let hostEnd: ReturnType<HostChannel['attach']> | null = null
  let closed = false
  const later = (fn: () => void) => setImmediate(fn)
  const sock: ChannelSocket = {
    kind: 'host-dialed',
    send: (t) => later(() => { const f = JSON.parse(t); if (isChannelFrame(f)) hostEnd?.onFrame(f) }),
    close: () => { closed = true; later(() => hostEnd?.onClose()) },
    onMessage: (fn) => { toLeader = fn; for (const t of queued.splice(0)) fn(t) },
    onClose: () => {},
  }
  return {
    sock,
    closed: () => closed,
    open() {
      hostEnd = channel.attach({ send: (f) => { const t = JSON.stringify(f); later(() => (toLeader ? toLeader(t) : queued.push(t))) }, close: () => {} })
    },
  }
}

const until = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)) }
}

const ownRow = (sid: string): Record<string, unknown> => ({
  claudeSessionId: sid, taskId: 't-own', project: 'P', process_status: 'running', mode: 'default', host: 'devbox', judge: 'host',
  startedAt: '2026-11-23T00:00:00.000Z', lastActiveAt: '2026-11-23T00:00:00.000Z', messageCount: 0,
})

/** The transfer attempts the leader started on `devbox` in this test (host-judged-runner.ts attemptStartedOn). */
const attempts = new Set<string>()

interface Rig { applied: Array<{ via: string; sids: string[]; data?: unknown }>; link: ReturnType<typeof socketTo>; channel: HostChannel; revoked: { now: boolean } }

/** The leader side with the real transaction, store and judge memo, linked to a host channel of `devbox`. */
async function rig(o: { revoked?: (hostKey: string) => boolean } = {}): Promise<Rig> {
  log = await FactLog.open({ dir, walnutId: 'w1', flushMs: 1, durable: false })
  const channel = new HostChannel({ log, walnutId: 'w1', hostId: 'devbox', ownRows: async () => [] })
  const applied: Rig['applied'] = []
  const revoked = { now: false }
  const note = (via: string, data: unknown, ...sids: unknown[]) => applied.push({ via, data, sids: sids.filter((s): s is string => typeof s === 'string') })
  const sidOfData = (d: unknown) => { const x = d as { sessionId?: unknown; claudeSessionId?: unknown; actualId?: unknown } | null; return x?.sessionId ?? x?.claudeSessionId ?? x?.actualId }
  const deps: LeaderSideDeps = {
    walnutId: async () => 'w1',
    permit: () => ({ permitNumber: 0, epoch: 1 }),
    switchNow: async () => () => true,
    openStream: async () => { throw new Error('no daemon link in this test') },
    applyBatch: async (b) => { const r = await applyHostChannelBatch(b); note('applyBatch', null, ...r.written); return r },
    loadCursor: async () => null,
    emit: (name, data) => note(`emit:${name}`, data, sidOfData(data)),
    noteLive: (sid) => note('noteLive', null, sid),
    noteBorn: (sid) => note('noteBorn', null, sid),
    noteRename: (from, to) => note('noteRename', null, from, to),
    noteHostJudged: (sid, host) => { note('noteHostJudged', null, sid); noteHostJudged(sid, host) },
    ownerOf: judgingHostOf,
    taskOf: (sid) => sessionTaskAndEngineInStore(sid)?.taskId,
    revoked: o.revoked ?? (() => revoked.now),
    scopeIds: (_host, sid, key, ids) => (key === 'attemptId' ? ids.filter((a) => attempts.has(a)) : linesNotOthers(sid, ids)),
    backoffMs: () => 20,
    log: () => {},
  }
  side = createLeaderSide(deps)
  const link = socketTo(channel)
  expect(side.adopt('devbox', link.sock)).toBe(true)
  link.open()
  // Caught up: the host streams what it appends from now on (a flow reaches only a caught-up reader).
  await until(() => channel.leaderLive())
  return { applied, link, channel, revoked }
}

const facts = Object.entries(SESSION_EVENT_CLASS).filter(([, c]) => c === 'fact').map(([n]) => n)
const flows = Object.entries(SESSION_EVENT_CLASS).filter(([, c]) => c === 'flow').map(([n]) => n)
const recordData: Record<string, (sid: string) => unknown> = {
  row: (sid) => ({ born: true, patch: ownRow(sid) }),
  // From a row nobody has: applies to neither session (a rename of the host's own row is in handed-sessions.test.ts).
  rename: (sid) => ({ from: `${sid}-old`, to: sid }),
  drop: () => ({}),
  'turn-summary': () => ({ facts: 1 }),
  live: () => ({ state: { turnGen: 1 } }),
}
/** Every record kind, a whole row again, every fact (each naming a task the session is not for) and every flow event of `sid`. */
function sendAll(r: Rig, sid: string): void {
  for (const kind of CHANNEL_RECORD_KINDS) log!.append(sid, kind, recordData[kind]!(sid))
  log!.append(sid, 'row', { resync: true, patch: ownRow(sid) })
  for (const name of facts) log!.append(sid, name, name === 'transfer:fork-init' ? { actualId: sid } : { sessionId: sid, taskId: 't-not-its', host: 'elsewhere' })
  for (const name of flows) r.channel.flow(sid, name, { sessionId: sid, taskId: 't-not-its', delta: 'x' })
}

it('a record of every kind naming a session the host does not own reaches nothing that applies; the host\'s own session\'s do, saying the leader\'s task', async () => {
  expect(Object.keys(recordData).sort(), 'a new channel record kind: give it data here, so this test sends it').toEqual([...CHANNEL_RECORD_KINDS].sort())
  await handStart('devbox', 'mine', { taskId: 't-own' })
  const r = await rig()
  sendAll(r, 'foreign')
  sendAll(r, 'mine')
  await until(() => r.applied.some((a) => a.via === `emit:${facts[facts.length - 1]}` && a.sids.includes('mine')))
  await side!.idle('devbox')

  expect(await getSessionByClaudeId('foreign')).toBeNull()
  const touchesForeign = r.applied.filter((a) => a.sids.some((s) => s.startsWith('foreign')))
  expect(touchesForeign, JSON.stringify(touchesForeign.slice(0, 10))).toEqual([])
  // The host's own session went through every applying way.
  const viaMine = new Set(r.applied.filter((a) => a.sids.includes('mine')).map((a) => a.via.split(':')[0]))
  expect([...viaMine].sort()).toEqual(['applyBatch', 'emit', 'noteBorn', 'noteHostJudged', 'noteLive'])
  for (const name of facts) expect(r.applied.some((a) => a.via === `emit:${name}` && a.sids.includes('mine')), name).toBe(true)
  // Every fact and flow event of it says the task of the leader's row, and the link's host (S1).
  for (const a of r.applied.filter((x) => x.via.startsWith('emit:') && x.sids.includes('mine'))) {
    const d = a.data as { taskId?: unknown; host?: unknown }
    if (a.via !== 'emit:transfer:fork-init') expect(d.taskId, a.via).toBe('t-own')
    if (d.host !== undefined) expect(d.host, a.via).toBe('devbox')
  }
  expect(r.applied.some((a) => a.via.startsWith('emit:') && JSON.stringify(a.data).includes('t-not-its'))).toBe(false)
})

it('a fact of the host\'s own session naming another session in one of its keys is not said', async () => {
  await handStart('devbox', 'mine', { taskId: 't-own' })
  const r = await rig()
  log!.append('mine', 'row', { born: true, patch: ownRow('mine') })
  log!.append('mine', 'session:result', { sessionId: 'mine', claudeSessionId: 'someone-else', taskId: 't-own' })
  log!.append('mine', 'session:ended', { sessionId: 'mine' })
  await until(() => r.applied.some((a) => a.via === 'emit:session:ended'))
  await side!.idle('devbox')
  expect(r.applied.some((a) => a.via === 'emit:session:result')).toBe(false)
})

it('a fact names no queue row of another session, and only a transfer attempt started on this host (R2-S1)', async () => {
  await handStart('devbox', 'mine', { taskId: 't-own' })
  await handStart('devbox', 'other', { taskId: 't-own' })
  await noteLinesHanded('mine', ['qm-mine-1', 'qm-mine-2'])
  await noteLinesHanded('other', ['qm-other-1'])
  attempts.add('att-mine')
  const r = await rig()
  log!.append('mine', 'row', { born: true, patch: ownRow('mine') })
  // Another session's reply, and a row nobody handed, ride beside its own.
  log!.append('mine', 'session:queued-cancelled', { sessionId: 'mine', messageIds: ['qm-mine-1', 'qm-other-1', 'qm-nobody'], messages: [] })
  log!.append('mine', 'session:messages-delivered', { sessionId: 'mine', count: 2, messageIds: ['qm-other-1', 'qm-mine-2'] })
  log!.append('mine', 'session:message-queued', { sessionId: 'mine', messageId: 'qm-other-1', message: 'x' })
  log!.append('mine', 'session:message-queued', { sessionId: 'mine', messageId: 'qm-mine-2', message: 'y' })
  // A row that left the host's queue (session-queue-exits.ts): said only for its own session's rows.
  log!.append('mine', 'session:queue-left', { sessionId: 'mine', messageIds: ['qm-mine-1', 'qm-other-1'], exits: { 'qm-mine-1': { step: 'removed', why: 'left the queue unsent (it was parked)' }, 'qm-other-1': { step: 'read' } } })
  // A fork-init of another transfer's attempt is not said; of the one started here it is.
  log!.append('mine', 'transfer:fork-init', { attemptId: 'att-other', preassignedId: null, actualId: 'mine', renamed: false })
  log!.append('mine', 'transfer:fork-init', { attemptId: 'att-mine', preassignedId: null, actualId: 'mine', renamed: false })
  log!.append('mine', 'session:ended', { sessionId: 'mine' })
  await until(() => r.applied.some((a) => a.via === 'emit:session:ended'))
  await side!.idle('devbox')
  const said = (name: string) => r.applied.filter((a) => a.via === `emit:${name}`).map((a) => a.data as Record<string, unknown>)
  // A row the leader never made (the phone's line through the companion while the Mac was away) stands.
  expect(said('session:queued-cancelled').map((d) => d.messageIds)).toEqual([['qm-mine-1', 'qm-nobody']])
  expect(said('session:messages-delivered').map((d) => d.messageIds)).toEqual([['qm-mine-2']])
  expect(said('session:message-queued').map((d) => d.messageId)).toEqual([undefined, 'qm-mine-2'])
  expect(said('session:queue-left').map((d) => d.messageIds)).toEqual([['qm-mine-1']])
  expect(said('transfer:fork-init').map((d) => d.attemptId)).toEqual(['att-mine'])
  expect(JSON.stringify(r.applied)).not.toContain('qm-other-1')
})

it('nothing of a revoked host applies: its link closes, and a socket it dials is not taken (S3)', async () => {
  await handStart('devbox', 'mine', { taskId: 't-own' })
  await handStart('devbox', 'later', { taskId: 't-own' })
  const r = await rig()
  log!.append('mine', 'row', { born: true, patch: ownRow('mine') })
  await until(() => r.applied.some((a) => a.via === 'noteBorn' && a.sids.includes('mine')))
  await side!.idle('devbox')
  // Revoked while its records are on their way: the apply refuses them and the link closes.
  r.revoked.now = true
  const before = r.applied.length
  sendAll(r, 'later')
  await until(() => r.link.closed())
  // The link closed because its apply refused them: what it was applying has ended.
  await side!.idle('devbox')
  expect(r.applied.slice(before)).toEqual([])
  expect(await getSessionByClaudeId('later')).toBeNull()
  // A new socket of it is closed, never adopted.
  const again = socketTo(r.channel)
  expect(side!.adopt('devbox', again.sock)).toBe(false)
  expect(again.closed()).toBe(true)
})

it('a ban of another name of the host\'s machine holds on its channel: its facts are not applied, its link closes, its socket is not taken', async () => {
  await handStart('devbox', 'later', { taskId: 't-own' })
  // The leader side reads the real ban (leader-boot.ts hands it hostRevokedNow); `devbox`'s hello names machine m-devbox.
  const r = await rig({ revoked: hostRevokedNow })
  setRevokedHostResolver({ machineOf: (k) => (k === 'devbox' ? 'm-devbox' : null), aliasesOf: () => [] })
  // Revoked as `devbox-net`, the machine's other row, while `devbox`'s records are on their way.
  setRevokedHosts([{ hostKey: 'devbox-net', machineId: 'm-devbox' }])
  const before = r.applied.length
  sendAll(r, 'later')
  await until(() => r.link.closed())
  await side!.idle('devbox')
  expect(r.applied.slice(before)).toEqual([])
  expect(await getSessionByClaudeId('later')).toBeNull()
  const again = socketTo(r.channel)
  expect(side!.adopt('devbox', again.sock)).toBe(false)
})

it('a revoke of another name of the machine cuts this name\'s link at once (noteRevoked judges every link)', async () => {
  const r = await rig({ revoked: hostRevokedNow })
  setRevokedHostResolver({ machineOf: () => null, aliasesOf: (k) => (k === 'devbox' ? ['devbox-net'] : []) })
  setRevokedHosts([{ hostKey: 'devbox-net' }])
  side!.noteRevoked('devbox-net')
  expect(r.link.closed()).toBe(true)
  expect(side!.linked('devbox')).toBe(false)
})

it('a revoke made now closes the host\'s link at once (leader-issue.ts calls noteRevoked)', async () => {
  const r = await rig()
  r.revoked.now = true
  side!.noteRevoked('devbox')
  expect(r.link.closed()).toBe(true)
  expect(side!.linked('devbox')).toBe(false)
})

it('an alias learned while a ban stands is cut at the next recheck with nothing changed (N2: leader-boot.ts passes "")', async () => {
  const r = await rig({ revoked: hostRevokedNow })
  setRevokedHosts([{ hostKey: 'devbox-net' }])
  side!.noteRevoked('')
  expect(r.link.closed()).toBe(false)
  // The twin snapshot (or a hello) now ties `devbox` to the banned key; the ban itself did not change.
  setRevokedHostResolver({ machineOf: () => null, aliasesOf: (k) => (k === 'devbox' ? ['devbox-net'] : []) })
  side!.noteRevoked('')
  expect(r.link.closed()).toBe(true)
})
