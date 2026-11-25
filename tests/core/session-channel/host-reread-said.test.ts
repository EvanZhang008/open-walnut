/**
 * A new read of a session's CLI output says no transcript detail twice (host-emitter.ts header,
 * fact-log.ts saidLine). 2026-11-25: after a daemon update the host's runner attached again from the
 * told line, which a withheld result held 10 MB back, and 119 tool calls reached the leader twice.
 *
 *   - the fact log keeps the furthest line a fact was READ from (`saidLine`), past the told line a
 *     withheld result holds back, across a reopen, also rebuilt from the records alone;
 *   - an attach's read below it (host-judged-lines.ts openSaidWindow, lineInSaidWindow) marks each
 *     line it handles (readingLine): the emitter keeps no detail fact said in one, while its turn
 *     ends, what is said after the line's handling, and the facts of lines past it are kept;
 *   - the window is the attach's own read of one file: it ends at the said line and at a line that
 *     goes back (another file), and opens only for the file the said line is of;
 *   - every fact class is placed: a new fact name fails until it is put in TURN_DETAIL_FACTS (not
 *     said again by a re-read) or in RE_JUDGED below (the runner judges it again from the lines).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventBus } from '../../../src/core/event-bus.js'
import { FactLog, foldSaid } from '../../../src/core/session-channel/fact-log.js'
import { createHostEmitter, type HostEmitter } from '../../../src/core/session-channel/host-emitter.js'
import { lineBeingRead, lineInSaidWindow, openSaidWindow, readingLine, type SaidWindow } from '../../../src/core/session-channel/host-judged-lines.js'
import { SESSION_EVENT_CLASS, TURN_DETAIL_FACTS } from '../../../src/core/session-channel/event-classes.js'
import type { SessionRecord } from '../../../src/core/types.js'

const HOST = 'marina-box'
const OWN = '11111111-1111-4111-8111-111111111111'

let dir = ''
let log: FactLog
let bus: EventBus
let emitter: HostEmitter | null = null
/** The told offset the runner reports (held back at a withheld result). */
let offset = 0

function row(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId: OWN, taskId: 'task-marina-1', project: 'Marina', process_status: 'running', mode: 'default',
    startedAt: '2026-11-25T00:00:00.000Z', lastActiveAt: '2026-11-25T00:00:00.000Z', last_status_change: '2026-11-25T00:00:00.000Z',
    messageCount: 1, host: HOST, judge: 'host', streamEpoch: 'ep1', ...over,
  } as SessionRecord
}

async function start(own: SessionRecord = row()): Promise<number> {
  emitter = createHostEmitter({
    log, channel: { flow: () => {} } as never, hostKey: HOST,
    ownRows: async () => [own],
    offsetOf: () => offset,
    lineOf: (sid) => lineBeingRead(sid),
    bus, rowListener: () => {}, liveListener: () => {}, liveMs: 30,
  })
  await emitter.start()
  await log.flush()
  return log.head
}

/**
 * One line handled as the runner does (claude-code-session.ts handleStreamLine): inside readingLine,
 * marked said when the attach's window holds it. The told offset stays held at `held`.
 */
function read(w: { window?: SaidWindow }, v: number, held: number, name: string, data: Record<string, unknown> = {}): void {
  const said = lineInSaidWindow(w.window, v)
  if (!said) w.window = undefined
  offset = Math.min(v, held)
  readingLine(OWN, v, said, () => bus.emit(name, { sessionId: OWN, ...data }, ['main-ai']))
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-reread-'))
  log = await FactLog.open({ dir, walnutId: 'w1', flushMs: 1, durable: false })
  bus = new EventBus()
  offset = 0
})
afterEach(async () => {
  emitter?.stop()
  emitter = null
  await log.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('the fact log keeps the line a fact was read from', () => {
  it('past the told line a withheld result holds back, across a reopen and from the records alone', async () => {
    log.append(OWN, 'session:tool-use', { sessionId: OWN }, { line: { epoch: 'ep1', v: 100 }, src: 900 })
    log.append(OWN, 'session:tool-use', { sessionId: OWN }, { line: { epoch: 'ep1', v: 100 }, src: 950 })
    await log.flush()
    expect(log.toldLine(OWN)).toEqual({ epoch: 'ep1', v: 100 })
    expect(log.saidLine(OWN)).toEqual({ epoch: 'ep1', v: 950 })
    await log.close()
    // The state was saved only at open: the reopen rebuilds it from the records' `src`.
    log = await FactLog.open({ dir, walnutId: 'w1', flushMs: 1, durable: false })
    expect(log.saidLine(OWN)).toEqual({ epoch: 'ep1', v: 950 })
    expect(log.toldLine(OWN)).toEqual({ epoch: 'ep1', v: 100 })
  })

  it('folds a new stream file in as its first line, never compares lines of two files', () => {
    expect(foldSaid({ epoch: 'ep1', v: 950 }, { line: { epoch: 'ep2', v: 10 } })).toEqual({ epoch: 'ep2', v: 10 })
    expect(foldSaid({ epoch: 'ep1', v: 950 }, { line: { epoch: 'ep1', v: 10 }, src: 20 })).toEqual({ epoch: 'ep1', v: 950 })
    expect(foldSaid(undefined, {})).toBeUndefined()
  })
})

describe('an attach that reads again lines already said', () => {
  it('keeps no detail of them, keeps their turn end, what is said later, and every line past them', async () => {
    const head = await start()
    const first: { window?: SaidWindow } = {}
    // The first read: a result withheld at 100 holds the told line there; tool calls go on to 300.
    read(first, 100, 100, 'session:tool-use', { toolUseId: 'tu-1' })
    read(first, 200, 100, 'session:tool-use', { toolUseId: 'tu-2' })
    read(first, 300, 100, 'session:tool-result', { toolUseId: 'tu-2' })
    await log.flush()
    expect(log.toldLine(OWN)?.v).toBe(100)
    expect(log.saidLine(OWN)?.v).toBe(300)
    // The runner attaches again and reads on from the told line, 100.
    const again: { window?: SaidWindow } = { window: openSaidWindow(log.saidLine(OWN), { epoch: 'ep1', size: 10_000 }, 100) }
    expect(again.window).toEqual({ upTo: 300, last: 100 })
    read(again, 200, 100, 'session:tool-use', { toolUseId: 'tu-2' })
    read(again, 250, 100, 'session:usage-update', { inputTokens: 5 })
    read(again, 255, 100, 'session:background-tasks', { tasks: [] })
    read(again, 260, 100, 'session:result', { result: 'done' })
    // What a replayed line's handling says later (a promise, a timer) is new: kept.
    bus.emit('session:usage-update', { sessionId: OWN, inputTokens: 9 }, ['main-ai'])
    read(again, 300, 100, 'session:tool-result', { toolUseId: 'tu-2' })
    read(again, 400, 400, 'session:tool-use', { toolUseId: 'tu-3' })
    await log.flush()
    const recs = (await log.read(head)).map((r) => `${r.name}:${(r.data as { toolUseId?: string }).toolUseId ?? ''}`)
    expect(recs).toEqual([
      'session:tool-use:tu-1', 'session:tool-use:tu-2', 'session:tool-result:tu-2',
      // The re-read: its turn end is judged again; the said line itself (300) goes again, the detail
      // below it does not; a line past it goes as ever.
      // A snapshot goes as ever (the newest stands for every earlier one).
      'session:background-tasks:', 'session:result:', 'session:usage-update:', 'session:tool-result:tu-2', 'session:tool-use:tu-3',
    ])
    expect(again.window).toBeUndefined()
  })

  it('a read that restarts with the service sees the line its log kept', async () => {
    let head = await start()
    read({}, 500, 100, 'session:tool-use', { toolUseId: 'tu-1' })
    await log.flush()
    emitter!.stop()
    await log.close()
    log = await FactLog.open({ dir, walnutId: 'w1', flushMs: 1, durable: false })
    head = await start()
    const w = { window: openSaidWindow(log.saidLine(OWN), { epoch: 'ep1', size: 10_000 }, 100) }
    read(w, 300, 100, 'session:tool-use', { toolUseId: 'tu-1' })
    read(w, 600, 600, 'session:tool-use', { toolUseId: 'tu-2' })
    await log.flush()
    const ids = (await log.read(head)).filter((r) => r.name === 'session:tool-use').map((r) => (r.data as { toolUseId: string }).toolUseId)
    expect(ids).toEqual(['tu-2'])
  })

  it('opens only for a said line inside its own file and past the floor; ends for good at a line that goes back', () => {
    const f = { epoch: 'ep1', size: 1_000 }
    expect(openSaidWindow({ epoch: 'ep1', v: 300 }, { epoch: 'ep2', size: 1_000 }, 100)).toBeUndefined()
    expect(openSaidWindow({ epoch: 'ep1', v: 300 }, { size: 1_000 }, 100)).toBeUndefined()
    expect(openSaidWindow({ epoch: 'ep1', v: 300 }, undefined, 100)).toBeUndefined()
    expect(openSaidWindow({ v: 300 }, f, 100)).toBeUndefined()
    expect(openSaidWindow({ epoch: 'ep1', v: 100 }, f, 100)).toBeUndefined()
    expect(openSaidWindow(undefined, f, 100)).toBeUndefined()
    // A said line past the file's end is of another file (a line not written yet was never said).
    expect(openSaidWindow({ epoch: 'ep1', v: 1_001 }, f, 100)).toBeUndefined()
    expect(openSaidWindow({ epoch: 'ep1', v: 1_000 }, f, 100)).toEqual({ upTo: 1_000, last: 100 })
    // A file rotated mid-read starts again near 0: its lines are new.
    const w: { window?: SaidWindow } = { window: openSaidWindow({ epoch: 'ep1', v: 300 }, { epoch: 'ep1', size: 1_000 }, 100) }
    const step = (v: number): boolean => { const said = lineInSaidWindow(w.window, v); if (!said) w.window = undefined; return said }
    expect([step(150), step(120), step(200)]).toEqual([true, false, false])
  })

  it('a line handled outside any attach window is never marked said', async () => {
    const head = await start()
    readingLine(OWN, 5, false, () => bus.emit('session:tool-use', { sessionId: OWN, toolUseId: 'tu-1' }, ['main-ai']))
    expect(lineBeingRead(OWN)).toBeUndefined()
    await log.flush()
    expect((await log.read(head)).map((r) => r.name)).toEqual(['session:tool-use'])
  })
})

/**
 * Facts a re-read says again, on purpose: the runner judges each again from the lines it reads (turn
 * ends, deliveries, permissions, settings), and the leader acts on each once (leader-apply.ts
 * actedOnAlready, its own ids). A new fact name goes here or in TURN_DETAIL_FACTS.
 */
const RE_JUDGED = new Set([
  'session:started', 'session:ended', 'session:result', 'session:error', 'transfer:fork-init', 'session:will-reap',
  'session:usage-limit', 'session:messages-delivered', 'session:queued-cancelled', 'session:batch-completed',
  'session:batch-failed', 'session:delivery-held', 'session:message-queued', 'session:settings-applied',
  'session:controls-changed', 'session:turn-settled', 'session:retry-over', 'session:model-catalog',
  'session:permission-request', 'session:permission-resolved', 'session:cron-fired', 'session:side-question-done',
  'session:side-thread-renamed', 'session:side-question-error',
])

describe('every fact is placed for a re-read', () => {
  it('is transcript detail (not said again) or judged again, never neither nor both', () => {
    const facts = Object.entries(SESSION_EVENT_CLASS).filter(([, c]) => c === 'fact').map(([n]) => n)
    const unplaced = facts.filter((n) => !TURN_DETAIL_FACTS.has(n) && !RE_JUDGED.has(n))
    const both = facts.filter((n) => TURN_DETAIL_FACTS.has(n) && RE_JUDGED.has(n))
    expect(unplaced).toEqual([])
    expect(both).toEqual([])
    expect([...RE_JUDGED].filter((n) => !facts.includes(n))).toEqual([])
  })
})
