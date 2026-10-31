/**
 * The take marker (`session:user-line`) names the queue rows its line carries,
 * whichever way the line went out.
 *
 * The chat places a sent message at the marker of the line that carried it
 * (web/src/stream/chat-order.ts), matched by the bubble's queue row id: a bubble
 * never knows the line's uuid. The marker read its rows only from a write's own
 * registrations (awaitLine, a line queued behind a turn), so the first line of a
 * cold --resume, written by the spawn, got a marker with no rows, and its message
 * sat below the whole answer for the turn (2026-10-31, review of the step-group
 * fold fix). The queue now notes a line's rows where it gives the batch its uuid
 * (markProcessing), and the marker reads them there.
 *
 * What's real in the resume case: SessionRunner.processNext and its cold resume,
 * ClaudeCodeSession, RemoteSessionManager, the disk queue. Scripted: the daemon
 * connection (the cold-resume-cut-hold.test.ts harness).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-user-line-marker-rows'))

const h = vi.hoisted(() => ({ make: null as null | ((tmpId: string) => unknown) }))
vi.mock('../../src/providers/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/session-manager.js')>()),
  createSessionManager: (tmpId: string) => h.make!(tmpId),
  ensureLocalDaemon: async () => {},
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { enqueueMessage, markProcessing, resetCache, revertToPending } from '../../src/core/session-message-queue.js'
import { resetLineConsumption } from '../../src/providers/line-consumption.js'
import { resetLineCarriesForTesting } from '../../src/providers/batch-uuid.js'
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js'

const ROOT = join(__dirname, '..', '..')
let seq = 0
let SID = ''
let markers: Array<{ uuid: string; rowIds?: string[] }> = []

/** A daemon connection that answers from a script and can push stream lines. */
function scriptedDaemon(replies: Record<string, Array<Record<string, unknown>>>) {
  const sent: Array<{ cmd: string; payload: Record<string, unknown> }> = []
  const listeners = new Set<(event: Record<string, unknown>) => void>()
  const fallback: Record<string, Record<string, unknown>> = { stop: { ok: true, stopped: true }, status: { ok: true, exists: false } }
  const conn = {
    connected: true,
    hasCapability: (c: string) => ['send-markers-v1', 'send-dedupe-v1', 'owner-home-v1'].includes(c),
    onEvent: (fn: (event: Record<string, unknown>) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    send: vi.fn(async (cmd: string, payload: Record<string, unknown>) => {
      sent.push({ cmd, payload })
      return replies[cmd]?.shift() ?? fallback[cmd] ?? { ok: true }
    }),
  }
  const emitLine = (o: Record<string, unknown>) => { for (const fn of listeners) fn({ ev: 'jsonl', sid: SID, line: JSON.stringify(o) }) }
  return { conn, sent, emitLine }
}

/** A process that has just started: nothing registered for its first line. */
function bareProcess(sid: string) {
  const session = new ClaudeCodeSession(`marker-task-${sid}`, 'test', '/bin/true')
  Object.assign(session, { claudeSessionId: sid, _processStatus: 'running', _active: true, pid: 6161 })
  const line = (o: Record<string, unknown>) => (session as unknown as { handleStreamLine(l: string): void })
    .handleStreamLine(JSON.stringify(o))
  return { started: (uuid: string) => line({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' }) }
}

beforeEach(async () => {
  SID = `30000000-0000-4000-8000-0000000a2${String(++seq).padStart(3, '0')}`
  closeDb()
  _resetSessionTrackerForTesting()
  resetLineConsumption()
  resetLineCarriesForTesting()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await createSessionRecord(SID, `marker-task-${SID}`, 'test', WALNUT_HOME, { initialProcessStatus: 'stopped' })
  markers = []
  bus.subscribe('main-ai', (e: BusEvent) => {
    if (e.name === EventNames.SESSION_USER_LINE) markers.push(e.data as { uuid: string; rowIds?: string[] })
  })
})

afterEach(async () => {
  h.make = null
  bus.clear()
  resetCache()
  resetLineConsumption()
  resetLineCarriesForTesting()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 })
})

describe('the take marker names the rows its line carries', () => {
  it('the first line of a cold resume, written by the spawn', async () => {
    const daemon = scriptedDaemon({
      start: [{ ok: true, pid: 4747, outputFile: '/nonexistent/marker-rows.jsonl', offset: 0 }],
      send: [{ ok: true }],
    })
    h.make = (tmpId: string) => {
      const mgr = new RemoteSessionManager(tmpId, '__local__', null)
      Object.assign(mgr as unknown as Record<string, unknown>, { conn: daemon.conn, ensureConnected: async () => daemon.conn })
      return mgr
    }
    const a = await enqueueMessage(SID, 'first message')
    const b = await enqueueMessage(SID, 'second message')
    const runner = new SessionRunner('/bin/true')
    await (runner as unknown as { processNext(sid: string): Promise<void> }).processNext(SID)
    await vi.waitFor(() => expect(daemon.sent.filter((s) => s.cmd === 'send')).toHaveLength(1), { timeout: 10_000 })
    const uuid = daemon.sent.find((s) => s.cmd === 'send')!.payload.uuid as string
    expect(uuid).toBeTruthy()
    // The CLI takes the line as its turn starts, before its init.
    daemon.emitLine({ type: 'command_lifecycle', command_uuid: uuid, state: 'started', session_id: SID })
    daemon.emitLine({ type: 'system', subtype: 'init', session_id: SID, cwd: WALNUT_HOME, tools: [], model: 'test' })
    await vi.waitFor(() => expect(markers).toHaveLength(1), { timeout: 10_000 })
    expect(markers[0].uuid).toBe(uuid)
    expect(new Set(markers[0].rowIds)).toEqual(new Set([a.id, b.id]))
    runner.destroyAndKill()
  }, 30_000)

  it('a resend of the same rows goes out under the same uuid and is named by it again', async () => {
    const a = await enqueueMessage(SID, 'only message')
    const first = await markProcessing(SID)
    // The process died before taking it: the row is pending again with its uuid.
    await revertToPending(first)
    const again = await markProcessing(SID)
    expect(again[0].lineUuid).toBe(first[0].lineUuid)
    bareProcess(SID).started(again[0].lineUuid!)
    await vi.waitFor(() => expect(markers).toHaveLength(1))
    expect(markers[0].rowIds).toEqual([a.id])
  })

  it('a line names only its own rows, never another session\'s or another line\'s', async () => {
    const OTHER = SID.replace(/.$/, 'f')
    const a = await enqueueMessage(SID, 'mine')
    const [line] = await markProcessing(SID)
    const b = await enqueueMessage(SID, 'next')
    const [next] = await markProcessing(SID)
    expect(next.lineUuid).not.toBe(line.lineUuid)
    await enqueueMessage(OTHER, 'elsewhere')
    const [other] = await markProcessing(OTHER)
    const p = bareProcess(SID)
    p.started(line.lineUuid!)
    p.started(next.lineUuid!)
    p.started(other.lineUuid!)
    await vi.waitFor(() => expect(markers).toHaveLength(3))
    expect(markers.map((m) => m.rowIds ?? [])).toEqual([[a.id], [b.id], []])
  })
})

/** Production source files under src/. */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx|mjs|cjs)$/.test(name)) out.push(p)
  }
  return out
}

describe('ratchet: a queue row goes out only through markProcessing, which notes what its line carries', () => {
  it('every write that marks queue rows as being delivered is listed', () => {
    // A row is "out" once it is marked processing. Each place that does so is listed
    // with how the take marker learns the line's rows.
    const OUT: Record<string, string> = {
      'src/core/session-message-queue.ts#markProcessing': 'noteLineCarries',
      // ACP engines take one prompt per turn and report no command_lifecycle, so no marker.
      'src/core/session-message-queue.ts#markNextProcessing': 'acp, no marker',
    }
    const WRITES = /status\s*[:=]\s*'processing'/
    const found: string[] = []
    for (const file of walk(join(ROOT, 'src'))) {
      // Comments blanked (same length, so positions hold): a doc line names the status too.
      const src = readFileSync(file, 'utf8').replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, (l) => ' '.repeat(l.length))
      if (!WRITES.test(src)) continue
      const rel = relative(ROOT, file)
      // The function each assignment sits in: the nearest declaration above it.
      for (const m of src.matchAll(new RegExp(WRITES.source, 'g'))) {
        const before = src.slice(0, m.index)
        const fn = [...before.matchAll(/(?:^|\n)(?:export )?(?:async )?function (\w+)/g)].pop()?.[1] ?? '?'
        found.push(`${rel}#${fn}`)
      }
    }
    expect([...new Set(found)].sort(), `A new place marks queue rows as being delivered. Route it through markProcessing,
or note the rows its line carries (noteLineCarries in src/providers/batch-uuid.ts) and list it here: otherwise the
take marker of that line names no rows and the chat draws its message after the whole answer.`).toEqual(Object.keys(OUT).sort())
    const queue = readFileSync(join(ROOT, 'src/core/session-message-queue.ts'), 'utf8')
    const body = queue.slice(queue.indexOf('export async function markProcessing('), queue.indexOf('export async function markNextProcessing('))
    expect(body).toMatch(/noteLineCarries\(sessionId, pending\[0\]\.lineUuid, pending\.map\(\(m\) => m\.id\)\)/)
    // And the marker reads them.
    const session = readFileSync(join(ROOT, 'src/providers/claude-code-session.ts'), 'utf8')
    expect(session).toMatch(/rowsCarriedBy\(this\.claudeSessionId, lc\.command_uuid\)[\s\S]{0,400}bus\.emit\(EventNames\.SESSION_USER_LINE/)
  })
})
