/**
 * Taken is not answered (line-answer-v1), on the server side.
 *
 * 2026-11-04 (release rehearsal binary-restart): Claude Code said `started` for a
 * line and was killed 0.1 s later. `started` counted as delivered (the rows left
 * the queue at the frame, and the resume took the daemon's "ran" as delivered),
 * so nothing ever sent the message again and it was never answered.
 *
 * With a transport whose daemon judges answers, a taken line's rows are reported
 * delivered but stay queued until the process that took it answers (an assistant
 * message on the main thread or a result); when it ends first they go back to
 * pending for the daemon to judge; `unanswered` sends them once more under a new
 * uuid, and a second time parks them as "Not answered". Without the capability,
 * the old rule.
 *
 * Also the class guard: every place in the server that settles a taken line goes
 * through settleTakenLine. A new path that removes a started line's rows as
 * delivered fails the source pin below and must be routed there.
 *
 * What's real: SessionRunner (processNext, injectMidTurn), ClaudeCodeSession
 * (writeMessage, the stream handler, the exit and stop paths), the disk queue.
 * What's mocked: the transport (no process, no daemon).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-line-answer-hold'))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { ClaudeCodeSession, SessionRunner, LINE_ENDED_UNANSWERED_REASON, LINE_NOT_ANSWERED_REASON } from '../../src/providers/claude-code-session.js'
import { deleteMessage, enqueueMessage, getQueue, resetCache, unparkMessage } from '../../src/core/session-message-queue.js'
import { awaitLine, noteLineState, resetLineConsumption } from '../../src/providers/line-consumption.js'
import { parkMeansNeverRan, parkByStop } from '../../src/core/sessions/undelivered-requests.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

const SID = '10000000-0000-4000-8000-000000000b01'

interface Write { message: string; uuid?: string; dedupe?: boolean }
type Fate = { fate: string; state?: string; answer?: 'yes' | 'pending' }

function harness(opts: { judges?: boolean } = {}) {
  const writes: Write[] = []
  let fate: Fate | null = null
  const transport = {
    writeMessage: async (message: string, o?: { uuid?: string; dedupe?: boolean; onDispatch?: () => void; onFate?: (f: Fate) => void }) => {
      o?.onDispatch?.()
      writes.push({ message, uuid: o?.uuid, dedupe: o?.dedupe })
      // A daemon that knows the line's fate writes nothing and says what it knows.
      if (fate && o?.dedupe) o.onFate?.(fate)
      return true
    },
    writeRaw: () => true,
    writeSyntheticUserEvent: () => {},
    deletePipe: () => {},
    stopTail: () => {},
    flushTail: () => {},
    kill: () => {},
    stop: async () => {},
    interrupt: async () => {},
    hasPipe: true,
    fileSize: 0,
    pid: 12345,
    judgesAnswers: opts.judges !== false,
  }
  const session = new ClaudeCodeSession('hold-task', 'test', '/bin/true')
  Object.assign(session, {
    claudeSessionId: SID, _transport: transport, _processStatus: 'running', _active: true, pid: 12345,
    _sawCommandLifecycle: true,
  })
  const runner = new SessionRunner('/bin/true')
  const internals = runner as unknown as {
    sessions: Map<string, ClaudeCodeSession>
    injectMidTurn(sid: string): Promise<void>
    processNext(sid: string): Promise<void>
  }
  internals.sessions.set('hold-task', session)
  const events: Array<{ name: string; data: Record<string, unknown> }> = []
  bus.subscribe('line-answer-hold-test', (e) => { events.push({ name: e.name, data: e.data as Record<string, unknown> }) }, { global: true })
  const line = (ev: Record<string, unknown>) => (session as unknown as { handleStreamLine(l: string): void }).handleStreamLine(JSON.stringify(ev))
  const lifecycle = (uuid: string, state: string) => line({ type: 'command_lifecycle', command_uuid: uuid, state })
  const answer = (extra: Record<string, unknown> = {}) => line({ type: 'assistant', parent_tool_use_id: null, message: { id: `m-${Math.random()}`, role: 'assistant', content: [{ type: 'text', text: 'the answer' }] }, ...extra })
  const crash = () => (session as unknown as { handleRemoteProcessExit(code: number, stderr?: string): void }).handleRemoteProcessExit(1, 'killed on purpose')
  /** The resumed process: a new pid, idle, ready for the next line. */
  const respawn = (pid: number) => Object.assign(session, { _processStatus: 'running', _active: true, pid, resultEmitted: false, _turnResultEmitted: false, _processEnded: false })
  return {
    internals, session, writes, events, line, lifecycle, answer, crash, respawn,
    daemonKnows: (f: Fate | null) => { fate = f },
  }
}

const rows = async () => (await getQueue(SID)).map((m) => ({ id: m.id, status: m.status }))
const settle = () => new Promise((r) => setTimeout(r, 50))

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  resetLineConsumption()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await createSessionRecord(SID, 'hold-task', 'test', WALNUT_HOME, { initialProcessStatus: 'running' })
})

afterEach(async () => {
  bus.unsubscribe('line-answer-hold-test')
  bus.clear()
  resetLineConsumption()
  resetCache()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 })
})

describe('a line the CLI took waits for its answer', () => {
  it('started: reported delivered, still queued; the answer removes it', async () => {
    const h = harness()
    await enqueueMessage(SID, 'question')
    const id = (await getQueue(SID))[0].id
    await h.internals.injectMidTurn(SID)
    h.lifecycle(h.writes[0].uuid!, 'started')
    await settle()
    expect(await rows()).toEqual([{ id, status: 'processing' }])
    expect(h.events.some((e) => e.name === EventNames.SESSION_MESSAGES_DELIVERED && (e.data.messageIds as string[])?.includes(id))).toBe(true)
    // Not answers: a subagent's message, an API error, thinking only, a replayed frame of history.
    h.answer({ parent_tool_use_id: 'toolu_1' })
    h.answer({ error: 'server_error' })
    h.line({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }] } })
    await settle()
    expect(await rows()).toEqual([{ id, status: 'processing' }])
    h.answer()
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
  })

  it('a result answers it too; completed always does', async () => {
    for (const end of ['result', 'completed'] as const) {
      const h = harness()
      await enqueueMessage(SID, `q ${end}`)
      await h.internals.injectMidTurn(SID)
      const uuid = h.writes[h.writes.length - 1].uuid!
      h.lifecycle(uuid, 'started')
      await settle()
      expect(await rows()).toHaveLength(1)
      if (end === 'result') h.line({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
      else h.lifecycle(uuid, 'completed')
      await vi.waitFor(async () => expect(await rows()).toEqual([]))
      bus.unsubscribe('line-answer-hold-test')
    }
  })

  it('killed after started: back to the queue, the daemon says unanswered, sent once more under a new uuid', async () => {
    const h = harness()
    await enqueueMessage(SID, 'killed before a word')
    const id = (await getQueue(SID))[0].id
    await h.internals.injectMidTurn(SID)
    const uuid = h.writes[0].uuid!
    h.lifecycle(uuid, 'started')
    h.crash()
    await vi.waitFor(async () => expect(await rows()).toEqual([{ id, status: 'pending' }]))

    // The resumed process: the resend asks first, the daemon read that nobody answered.
    h.respawn(12346)
    h.daemonKnows({ fate: 'unanswered', state: 'started' })
    await h.internals.injectMidTurn(SID)
    expect(h.writes[1]).toMatchObject({ uuid, dedupe: true })
    // Pending again, under a fresh uuid (the CLI would skip the old one), sent once more.
    await vi.waitFor(async () => expect((await getQueue(SID))[0]).toMatchObject({ status: 'pending', unansweredResent: true }))
    expect((await getQueue(SID))[0].lineUuid).not.toBe(uuid)
    h.daemonKnows(null)
    await h.internals.injectMidTurn(SID)
    await vi.waitFor(() => expect(h.writes).toHaveLength(3))
    expect(h.writes[2].uuid).not.toBe(uuid)
    expect(h.writes[2].dedupe).toBe(false)
    expect(h.writes[2].message).toBe('killed before a word')
    const row = (await getQueue(SID))[0]
    expect(row).toMatchObject({ id, status: 'processing', unansweredResent: true, lineUuid: h.writes[2].uuid })
    h.lifecycle(h.writes[2].uuid!, 'started')
    h.answer()
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    expect(h.writes).toHaveLength(3)
  })

  it('unanswered a second time: parked as not answered, sender told, never a third write', async () => {
    const h = harness()
    await enqueueMessage(SID, 'killed twice')
    const id = (await getQueue(SID))[0].id
    h.daemonKnows({ fate: 'unanswered', state: 'started' })
    for (const pid of [12346, 12347]) {
      await h.internals.injectMidTurn(SID)
      const last = h.writes[h.writes.length - 1]
      h.lifecycle(last.uuid!, 'started')
      h.crash()
      await vi.waitFor(async () => expect((await rows())[0]?.status).toBe('pending'))
      h.respawn(pid)
      await h.internals.injectMidTurn(SID)
      await settle()
      if (pid === 12346) {
        await vi.waitFor(async () => expect((await getQueue(SID))[0]).toMatchObject({ status: 'pending', unansweredResent: true }))
      }
    }
    await vi.waitFor(async () => expect(await rows()).toEqual([{ id, status: 'parked' }]))
    const row = (await getQueue(SID))[0]
    expect(row.parkedReason).toBe(LINE_NOT_ANSWERED_REASON)
    // The asker hears it was never answered; a Retry goes out as a new line.
    expect(parkMeansNeverRan(row.parkedReason)).toBe(true)
    const failed = h.events.find((e) => e.name === EventNames.SESSION_BATCH_FAILED && (e.data.messageIds as string[]).includes(id))
    expect(String(failed?.data.error)).toMatch(/^Not answered:/)
    // Two takes and their two resend questions, nothing more.
    expect(h.writes.filter((w) => !w.dedupe)).toHaveLength(2)
  })

  it('the daemon read an answer (ran, answer yes) or the process still running it (pending)', async () => {
    const h = harness()
    await enqueueMessage(SID, 'answered before the restart')
    await h.internals.injectMidTurn(SID)
    h.crash()
    await vi.waitFor(async () => expect((await rows())[0]?.status).toBe('pending'))
    h.respawn(12346)
    h.daemonKnows({ fate: 'ran', state: 'started', answer: 'yes' })
    await h.internals.injectMidTurn(SID)
    await vi.waitFor(async () => expect(await rows()).toEqual([]))

    await enqueueMessage(SID, 'still thinking')
    Object.assign(h.session, { _processStatus: 'idle', resultEmitted: true, _turnResultEmitted: true })
    h.daemonKnows(null)
    await h.internals.processNext(SID)
    h.crash()
    await vi.waitFor(async () => expect((await rows())[0]?.status).toBe('pending'))
    h.respawn(12347)
    h.daemonKnows({ fate: 'ran', state: 'started', answer: 'pending' })
    await h.internals.injectMidTurn(SID)
    await settle()
    // Held for the answer of the process that has it, not counted delivered yet.
    expect((await rows())[0]?.status).toBe('processing')
    // Read lag: the daemon's word is not ordered against the stream this object
    // reads. An answer read before the line's own started frame is an earlier
    // turn's, never this line's.
    h.answer()
    await settle()
    expect((await rows())[0]?.status).toBe('processing')
    h.lifecycle(h.writes[h.writes.length - 1].uuid!, 'started')
    await settle()
    expect((await rows())[0]?.status).toBe('processing')
    h.answer()
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
  })

  it('pending with no started frame ever read: its turn\'s completed, or the process\'s end (then the daemon judges)', async () => {
    const h = harness()
    await enqueueMessage(SID, 'completed ends it')
    await h.internals.injectMidTurn(SID)
    const uuid = h.writes[0].uuid!
    h.crash()
    await vi.waitFor(async () => expect((await rows())[0]?.status).toBe('pending'))
    h.respawn(12346)
    h.daemonKnows({ fate: 'ran', state: 'started', answer: 'pending' })
    await h.internals.injectMidTurn(SID)
    await settle()
    expect((await rows())[0]?.status).toBe('processing')
    h.lifecycle(uuid, 'completed')
    await vi.waitFor(async () => expect(await rows()).toEqual([]))

    await enqueueMessage(SID, 'the process ends first')
    const id = (await getQueue(SID))[0].id
    h.daemonKnows(null)
    await h.internals.injectMidTurn(SID)
    h.crash()
    await vi.waitFor(async () => expect((await rows())[0]?.status).toBe('pending'))
    h.respawn(12347)
    h.daemonKnows({ fate: 'ran', state: 'started', answer: 'pending' })
    await h.internals.injectMidTurn(SID)
    await settle()
    h.crash()
    // Back to pending for the daemon, never counted delivered on its own.
    await vi.waitFor(async () => expect(await rows()).toEqual([{ id, status: 'pending' }]))
  })

  it('two lines taken in one turn: one answer answers both', async () => {
    const h = harness()
    await enqueueMessage(SID, 'first')
    await h.internals.injectMidTurn(SID)
    await enqueueMessage(SID, 'second')
    await h.internals.injectMidTurn(SID)
    expect(h.writes).toHaveLength(2)
    h.lifecycle(h.writes[0].uuid!, 'started')
    h.lifecycle(h.writes[1].uuid!, 'started')
    await settle()
    expect(await rows()).toHaveLength(2)
    h.answer()
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
  })

  it('a started word another process said is no word on a write into this one (line-answer-v1)', () => {
    const row = { id: 'r1', sessionId: SID } as never
    noteLineState(SID, 'u-stale', 'started', 111)
    // Into process 222: not settled by 111's start, registered to wait for its own word.
    expect(awaitLine(SID, 'u-stale', [row], 222)).toBeUndefined()
    noteLineState(SID, 'u-same', 'started', 222)
    expect(awaitLine(SID, 'u-same', [row], 222)).toBe('started')
    // An unknown pid on either side keeps the old reading.
    noteLineState(SID, 'u-unknown', 'started')
    expect(awaitLine(SID, 'u-unknown', [row], 222)).toBe('started')
  })

  it('a Stop during the turn that took it: removed, never sent again, never back in the composer', async () => {
    const h = harness()
    await enqueueMessage(SID, 'stopped mid-turn')
    await h.internals.injectMidTurn(SID)
    h.lifecycle(h.writes[0].uuid!, 'started')
    await settle()
    await h.session.interrupt().catch(() => {})
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    expect(h.events.some((e) => e.name === EventNames.SESSION_QUEUED_CANCELLED)).toBe(false)
  })

  it('the user\'s own teardown parks worded as a stop; one Walnut chose parks as not answered (the asker told)', async () => {
    for (const [reason, stop] of [['user_terminated', true], ['task_completed', true], ['idle_reap', false], ['capacity_eviction', false]] as const) {
      const h = harness()
      await enqueueMessage(SID, `torn down mid-turn by ${reason}`)
      const id = (await getQueue(SID))[0].id
      await h.internals.injectMidTurn(SID)
      const uuid = h.writes[0].uuid!
      h.lifecycle(uuid, 'started')
      h.session.markExpectedTeardown(reason)
      h.crash()
      await vi.waitFor(async () => expect(await rows()).toEqual([{ id, status: 'parked' }]))
      const row = (await getQueue(SID))[0]
      if (stop) {
        expect(row.parkedReason).toBe(LINE_ENDED_UNANSWERED_REASON)
        expect(parkByStop(row.parkedReason)).toBe(true)
      } else {
        expect(row.parkedReason).toMatch(new RegExp(`^Not answered: Walnut ended this session \\(${reason}\\)`))
        expect(parkMeansNeverRan(row.parkedReason)).toBe(true)
      }
      // The CLI's transcript holds the old uuid: a Retry goes out under a new one.
      expect(row.lineUuid).toBeTruthy()
      expect(row.lineUuid).not.toBe(uuid)
      bus.unsubscribe('line-answer-hold-test')
      for (const m of await getQueue(SID)) await deleteMessage(SID, m.id)
    }
  })

  it('a Retry of a line parked as not answered goes out under a new uuid, even a row with its own userUuid, and gets its one resend again', async () => {
    const h = harness()
    const userUuid = '20000000-0000-4000-8000-0000000000aa'
    await enqueueMessage(SID, 'asked with an anchor', { userUuid })
    const id = (await getQueue(SID))[0].id
    h.daemonKnows({ fate: 'unanswered', state: 'started' })
    for (const pid of [12346, 12347]) {
      await h.internals.injectMidTurn(SID)
      h.lifecycle(h.writes[h.writes.length - 1].uuid!, 'started')
      h.crash()
      await vi.waitFor(async () => expect((await rows())[0]?.status).toBe('pending'))
      h.respawn(pid)
      await h.internals.injectMidTurn(SID)
      await settle()
      if (pid === 12346) await vi.waitFor(async () => expect((await getQueue(SID))[0]).toMatchObject({ unansweredResent: true }))
    }
    await vi.waitFor(async () => expect(await rows()).toEqual([{ id, status: 'parked' }]))
    const taken = new Set(h.writes.map((w) => w.uuid))
    const parked = (await getQueue(SID))[0]
    // Under userUuid (in the transcript) Claude Code would skip the Retry and ack it completed.
    expect(parked.lineUuid).toBeTruthy()
    expect(taken.has(parked.lineUuid)).toBe(false)
    expect(parked.lineUuid).not.toBe(userUuid)
    expect(await unparkMessage(SID, id)).toBe(true)
    const retried = (await getQueue(SID))[0]
    expect(retried).toMatchObject({ status: 'pending', lineUuid: parked.lineUuid })
    expect(retried.unansweredResent).toBeUndefined()
  })

  it('a daemon without line-answer-v1: the old rule, the rows leave at started', async () => {
    const h = harness({ judges: false })
    await enqueueMessage(SID, 'old daemon')
    await h.internals.injectMidTurn(SID)
    h.lifecycle(h.writes[0].uuid!, 'started')
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
  })
})

describe('class guard: every server path that settles a taken line goes through settleTakenLine', () => {
  const src = readFileSync(path.resolve(__dirname, '../../src/providers/claude-code-session.ts'), 'utf8')
  const calls = (re: RegExp) => [...src.matchAll(re)].map((m) => m[0].replace(/\s+/g, ' ').trim())
  /** Every `name(` call in the file, its arguments balanced to the closing parenthesis. */
  const callsOf = (name: string): string[] => {
    const out: string[] = []
    for (let i = src.indexOf(name + '('); i !== -1; i = src.indexOf(name + '(', i + 1)) {
      let depth = 0
      let j = i + name.length
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++
        else if (src[j] === ')' && --depth === 0) break
      }
      out.push(src.slice(i, j + 1).replace(/\s+/g, ' '))
    }
    return out
  }

  it('releaseLineRows (rows leave the queue as delivered) is called only from the known places', () => {
    // A line the CLI only STARTED must not reach releaseLineRows except through
    // settleTakenLine (which holds it for the answer) or a Stop. Adding a call here
    // means a new path settles a taken line: route it through settleTakenLine and
    // pin it with the reason it can never be a started-but-unanswered line.
    expect(callsOf('this.releaseLineRows').sort()).toEqual([
      // settleTakenLine: answered, no uuid, or a daemon that cannot judge.
      'this.releaseLineRows(rows, state)',
      // noteLineAnswered: the process answered.
      "this.releaseLineRows(line.rows, 'answered')",
      // completed frame: the turn ended.
      "this.releaseLineRows([...rows, ...takeAnswering(this.claudeSessionId, lc.command_uuid)], 'completed')",
      // a Stop cancelled or stopped them (not delivered).
      "this.releaseLineRows(rows, 'cancelled')",
      "this.releaseLineRows(takeLine(this.claudeSessionId, uuid), 'cancelled')",
      "this.releaseLineRows(untaken, 'stopped')",
      // a Stop during the turn that took them: the user's choice.
      "this.releaseLineRows(unansweredLines(this.claudeSessionId).flatMap((line) => line.rows), 'started')",
      // awaitLineAnswer: past the registry's bound, the oldest by the old rule (else stranded).
      "this.releaseLineRows(evicted, 'started')",
    ].sort())
  })

  it('every other way rows leave the queue as delivered is pinned, with why it never takes a started-but-unanswered line', () => {
    // A new call to any of these is a new settle path: show it can never see a
    // line the CLI only started, or route it through settleTakenLine.
    expect(callsOf('removeProcessed').filter((c) => !c.startsWith('removeProcessed(sessionId')).sort()).toEqual([
      // removeWrittenRows (the old rule, a CLI that reports no lifecycle) and a resume
      // line that is not read-but-unanswered (releaseResumeLine, pinned below).
      'removeProcessed(sid, rows.map((m) => m.id))',
      'removeProcessed(sid, rows.map((m) => m.id))',
      // ACP sessions: no stdin lines, no lifecycle (the ACP prompt fact owns recovery).
      'removeProcessed(deliverySessionId, [message.id])',
      'removeProcessed(deliverySessionId, [message.id])',
    ].sort())
    // removeWrittenRows: only for a CLI that reports no lifecycle (or past the
    // waiting list's bound, where no word would ever come).
    expect(callsOf('this.removeWrittenRows').sort()).toEqual([
      'this.removeWrittenRows(settled)', 'this.removeWrittenRows(evicted)', 'this.removeWrittenRows(evicted)',
      'this.removeWrittenRows(rows)', 'this.removeWrittenRows(rows)', 'this.removeWrittenRows(rows)',
    ].sort())
    // removeTaken is releaseLineRows' own body (its callers are pinned above).
    expect(callsOf('removeTaken')).toEqual(["removeTaken(sid, ids, { ran: why !== 'cancelled' && why !== 'stopped' })"])
    // settleTakenLine's `answered` is only ever the CLI's or the daemon's proof of an answer.
    expect(callsOf('this.settleTakenLine').sort()).toEqual([
      "this.settleTakenLine(uuid, rows, known.state ?? 'ran', known.state !== 'started' || known.answer === 'yes')",
      "this.settleTakenLine(lc.command_uuid, rows, 'started', false, this._answerCount)",
    ].sort())
  })

  it('every lifecycle word or daemon fate of ran goes to settleLineFate or settleTakenLine', () => {
    // The places that turn `started` into `ran` hand it to settleLineFate.
    const toRan = calls(/const fate = reported === 'started' \|\| reported === 'completed' \? 'ran'[^\n]*\n[^\n]*/g)
    expect(toRan).toHaveLength(2)
    for (const c of toRan) expect(c).toMatch(/this\.settleLineFate\(/)
    // settleLineFate's only handling of ran is settleTakenLine.
    const ran = src.slice(src.indexOf('private settleLineFate('), src.indexOf('private settleLineFate(') + 2000)
    expect(ran).toMatch(/if \(known\.fate === 'ran'\) \{[\s\S]*?this\.settleTakenLine\(/)
    expect(ran).toMatch(/if \(known\.fate === 'unanswered'\) \{ this\.resendUnanswered\(/)
    // The live `started` frame goes to settleTakenLine, never straight to release.
    const frame = src.slice(src.indexOf("case 'command_lifecycle': {"), src.indexOf("case 'stream_event': {"))
    expect(frame).toMatch(/this\.settleTakenLine\(lc\.command_uuid, rows, 'started', false, this\._answerCount\)/)
  })

  it('removeProcessed (rows leave as delivered) of a resumed first line waits for the answer', () => {
    // The resume's first line is read at init or `started`: held like a taken line.
    const release = src.slice(src.indexOf('private releaseResumeLine('), src.indexOf('private releaseResumeLine(') + 1500)
    expect(release).toMatch(/how === 'read'[\s\S]*?this\.awaitLineAnswer\(/)
    expect(src).not.toMatch(/eager removeProcessed failed after --resume spawn/)
  })
})
