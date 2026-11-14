/** Recorded CLI streams through the real adapter, daemon fold, server and stores.
 * Only the provider transport and storage locations are substituted. No sleeps:
 * drain actual subscriber/hook promises before checking committed state.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
import { replayControlTracker } from '../helpers/incident-replay-control.js'
import { getUsageLimitWaiter } from '../../src/core/sessions/usage-limit-wait.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-incident-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { ClaudeCodeSession, sessionRunner } from '../../src/providers/claude-code-session.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import * as tracker from '../../src/core/session-tracker.js'
import * as workerQuestion from '../../src/core/sessions/worker-question.js'
import { applySnapshot } from '../../src/core/session-snapshot-apply.js'
import { initialFoldState, foldLine, assembleSnapshot, type FoldState } from '../../src/providers/daemon-fold.js'
import { getSnapshotStatusMode, setSnapshotModeForTests, _resetSnapshotGateForTests } from '../../src/core/session-snapshot-gate.js'
import { createSessionRequest, getSessionRequest } from '../../src/core/session-requests.js'
import { SessionHookDispatcher } from '../../src/core/session-hooks/dispatcher.js'
import { __setReportGraceForTest, flushSettleAfterReport, __resetRequestProgress } from '../../src/core/sessions/request-progress.js'
import { UsageLimitWaiter } from '../../src/core/sessions/usage-limit-wait.js'
import { settleUserStatusSync } from '../../src/core/user-status-sync.js'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/incident-replays')
const sessions = new Map<string, ClaudeCodeSession>()
const pending = new Set<Promise<unknown>>()
const events: Array<{ name: string; data: any }> = []
const originalMode = getSnapshotStatusMode()
let server: Server
let port: number
let sequence = 0

function track<T>(promise: Promise<T>): Promise<T> {
  pending.add(promise)
  void promise.finally(() => pending.delete(promise)).catch(() => {})
  return promise
}

async function drain(): Promise<void> {
  // Dynamic imports in the adapter schedule writes one microtask later. A turn
  // of the event loop admits those writes; completion still waits on their work.
  do {
    await new Promise<void>(resolve => setImmediate(resolve))
    if (pending.size) await Promise.all([...pending])
    await flushSettleAfterReport()
    await settleUserStatusSync()
  } while (pending.size)
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const subscribe = bus.subscribe.bind(bus)
  vi.spyOn(bus, 'subscribe').mockImplementation((name, handler, ...args) => subscribe(name, event => {
    const result = handler(event)
    return result && typeof result.then === 'function' ? track(result) : result
  }, ...args))
  const dispatch = SessionHookDispatcher.prototype as unknown as { handleEvent: (event: unknown) => Promise<void> }
  const handle = dispatch.handleEvent
  vi.spyOn(dispatch, 'handleEvent').mockImplementation(function (this: SessionHookDispatcher, event) {
    return track(handle.call(this, event))
  })
  const route = workerQuestion.routeWorkerQuestion
  vi.spyOn(workerQuestion, 'routeWorkerQuestion').mockImplementation((...args) => track(route(...args)))
  const update = tracker.updateSessionRecord
  vi.spyOn(tracker, 'updateSessionRecord').mockImplementation((...args) => track(update(...args)))
  const adapter = ClaudeCodeSession.prototype as unknown as { persistSessionRecord: (...args: unknown[]) => Promise<void> }
  const persist = adapter.persistSessionRecord
  vi.spyOn(adapter, 'persistSessionRecord').mockImplementation(function (this: ClaudeCodeSession, ...args) {
    return track(persist.apply(this, args))
  })
  const limited = UsageLimitWaiter.prototype as unknown as { onLimited: (...args: unknown[]) => Promise<void>; end: (...args: unknown[]) => Promise<void> }
  for (const name of ['onLimited', 'end'] as const) {
    const original = limited[name]
    vi.spyOn(limited, name).mockImplementation(function (this: UsageLimitWaiter, ...args) {
      return track(original.apply(this, args))
    })
  }
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockImplementation(sid => sessions.get(sid))
  bus.subscribe('incident-observer', event => { events.push({ name: event.name, data: event.data }) }, { global: true })
  __setReportGraceForTest(0)
  setSnapshotModeForTests('enforce')
  await drain()
})

afterAll(async () => {
  await drain()
  for (const session of sessions.values()) session.markProcessDead()
  await drain()
  await stopServer()
  vi.restoreAllMocks()
  _resetSnapshotGateForTests()
  setSnapshotModeForTests(originalMode)
  __resetRequestProgress()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

async function linesOf(name: string): Promise<string[]> {
  const local = path.isAbsolute(name)
  const source = await fs.readFile(local ? name : path.join(FIXTURES, name), 'utf8')
  // Private recordings use the identical pipeline after in-memory conversion.
  // Their free text never reaches test logs, assertions, or saved artifacts.
  const content = local ? (await import('../../scripts/incident-replay/production.js')).toShapeOnly(source) : source
  return content.trim().split('\n')
}

async function replay(name: string) {
  const sid = `incident-replay-${++sequence}`
  const { task } = await addTask({ title: 'Recorded stream target', project: 'replay' })
  await updateTaskRaw(task.id, { phase: 'IN_PROGRESS', session_id: sid, phase_changed_at: '2026-01-01T00:00:00Z' })
  await createSessionRecord(sid, task.id, 'replay')
  await updateSessionRecord(sid, { process_status: 'running' })
  const control = replayControlTracker()
  const session = new ClaudeCodeSession(task.id, 'replay')
  Object.assign(session, {
    claudeSessionId: sid, _active: true, _processStatus: 'running',
    _transport: { isRemote: true, hasPipe: true, pid: null, host: null, outputFile: null,
      imageCache: new Map(), writeMessage: async () => true,
      deletePipe: () => {} },
  })
  sessions.set(sid, session)
  // Transport-only responses for model control reads. The report parser,
  // phase decision and request settlement still run for real.
  const internals = session as unknown as { handleStreamLine: (line: string) => void }
  Object.assign((session as unknown as { _transport: object })._transport, {
    renameForSession: () => {}, processInbound: (text: string) => text,
    stopTail: () => {}, detach: () => {},
    writeRaw: (raw: string) => {
      const request = JSON.parse(raw)
      control.delivered(raw)
      if (request.type === 'control_request') queueMicrotask(() => internals.handleStreamLine(JSON.stringify({
        type: 'control_response', response: { subtype: 'success', request_id: request.request_id,
          response: { response: 'FOR_USER_STATE: needs\nFOR_USER_ASK: Review the recorded reply.' } },
      })))
      return true
    },
  })
  const { task: asker } = await addTask({ title: 'Recorded stream asker', project: 'replay' })
  const askerSid = `${sid}-asker`
  await createSessionRecord(askerSid, asker.id, 'replay')
  await updateSessionRecord(askerSid, { process_status: 'running' })
  const askerSession = new ClaudeCodeSession(asker.id, 'replay')
  Object.assign(askerSession, { claudeSessionId: askerSid, _active: true, _processStatus: 'running',
    _transport: { isRemote: true, hasPipe: true, pid: null, host: null, imageCache: new Map(),
      writeMessage: async () => true, writeRaw: () => true, deletePipe: () => {}, stopTail: () => {}, detach: () => {} } })
  sessions.set(askerSid, askerSession)
  const registry = (sessionRunner as unknown as { sessions: Map<string, ClaudeCodeSession> }).sessions
  registry.set(task.id, session)
  registry.set(asker.id, askerSession)
  const request = await createSessionRequest({ fromSessionId: askerSid, toSessionId: sid, toTaskId: task.id, text: 'Reply after the recorded turn' })
  let state: FoldState = initialFoldState()
  let offset = 0
  const lines = (await linesOf(name)).map(line => {
    const event = JSON.parse(line)
    if ('session_id' in event) event.session_id = sid
    return JSON.stringify(event)
  })
  async function feed(line: string, adapter = true) {
    offset += Buffer.byteLength(line) + 1
    state = foldLine(state, line, offset)
    const event = JSON.parse(line)
    control.inbound(event)
    if (adapter) (session as unknown as { handleStreamLine: (line: string, v: number) => void }).handleStreamLine(line, offset)
    await drain()
    const snapshot = assembleSnapshot({ foldState: state, pendingCtrl: control.pending(), dead: false, pid: null, exitCode: null, streamEpoch: sid })
    await applySnapshot(sid, snapshot, 'incident-replay')
    await drain()
    return snapshot
  }
  async function view() {
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}`)
    expect(response.ok).toBe(true)
    return (await response.json() as { task: any }).task
  }
  return { sid, taskId: task.id, session, request, askerSid, lines, feed, view,
    snapshot: (dead = false) => assembleSnapshot({ foldState: state, pendingCtrl: dead ? null : control.pending(), dead, pid: null, exitCode: dead ? 0 : null, streamEpoch: sid }) }
}

function notices(sid: string) {
  return events.filter(event => event.name === EventNames.SESSION_MESSAGE_QUEUED && event.data.sessionId === sid && event.data.source === 'walnut-notify')
}

async function noticeRows(sid: string) {
  // The asker may consume the real durable row immediately through its mock
  // transport. Observe the enqueue event, not a guessed delay before delivery.
  return notices(sid)
}

const LOCAL_REPLAYS = process.env.WALNUT_LOCAL_REPLAYS_DIR || path.join(os.homedir(), '.local/state/open-walnut/incident-replays')

describe('recorded stream end-to-end replay', () => {
  it('runs both real daemon control reducers and ignores an unrelated response', () => {
    const control = replayControlTracker()
    control.inbound({ type: 'control_request', request_id: 'control-test', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } })
    control.delivered(JSON.stringify({ type: 'control_response', response: { request_id: 'unrelated' } }))
    expect(control.pending()?.requestId).toBe('control-test')
    control.inbound({ type: 'control_cancel_request', request_id: 'control-test' })
    expect(control.pending()).toBeNull()
  })
  it.skipIf(!existsSync(path.join(LOCAL_REPLAYS, 'question-turn.jsonl')))('replays the optional private local recording through the same real pipeline', async () => {
    const r = await replay(path.join(LOCAL_REPLAYS, 'question-turn.jsonl'))
    for (const line of r.lines) {
      await r.feed(line)
      const event = JSON.parse(line)
      if (event.type === 'control_request') await r.session.resolvePermissionRequest(event.request_id, true)
    }
    await drain()
    expect((await r.view()).phase).toBe('NEED_ACTION')
    expect((await getSessionRequest(r.request.id))?.status).toBe('notified')
    expect(await noticeRows(r.askerSid)).toHaveLength(1)
  })
  it('uses the existing mock CLI for shape-only transport replay and rejects raw text', async () => {
    const run = promisify(execFile)
    const mock = path.join(import.meta.dirname, '../providers/mock-claude-replay.mjs')
    const fixture = path.join(FIXTURES, 'completed-turn.shape.jsonl')
    const { stdout } = await run(process.execPath, [mock, '-p', '--resume', 'transport-replay'], {
      env: { ...process.env, MOCK_REPLAY_FILE: fixture, MOCK_REPLAY_COUNT: '2' },
      timeout: 10_000,
    })
    const output = stdout.trim().split('\n').map(line => JSON.parse(line))
    expect(output.filter(e => e.type === 'result')).toHaveLength(1)
    expect(output.filter(e => e.type === 'assistant')).toHaveLength(2)
    expect(output.find(e => e.type === 'result').session_id).toBe('transport-replay')
    const unsafe = path.join(WALNUT_HOME, 'unsafe-recording.jsonl')
    await fs.writeFile(unsafe, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'private fixture must be rejected' }] } }) + '\n')
    await expect(run(process.execPath, [mock, '-p'], { env: { ...process.env, MOCK_REPLAY_FILE: unsafe }, timeout: 10_000 })).rejects.toThrow()
  })

  it('shows a real question, clears it, settles one request and queues one notice', async () => {
    const r = await replay('question-turn.shape.jsonl')
    for (const line of r.lines) {
      await r.feed(line)
      if (JSON.parse(line).type === 'control_request') {
        expect((await getSessionByClaudeId(r.sid))?.pendingPermission).toMatchObject({ toolName: 'AskUserQuestion' })
        expect((await r.view()).user_status.state).toBe('needs')
        const event = JSON.parse(line)
        const question = event.request.input.questions[0]
        expect(await r.session.resolvePermissionRequest(event.request_id, true, undefined, {
          answers: { [question.question]: question.options[0].label },
        })).toBe(true)
        await drain()
      }
    }
    expect((await getSessionByClaudeId(r.sid))?.process_status).toBe('idle')
    expect((await getSessionByClaudeId(r.sid))?.pendingPermission).toBeFalsy()
    expect((await r.view()).phase).toBe('NEED_ACTION')
    expect((await getSessionRequest(r.request.id))?.status).toBe('notified')
    expect(await noticeRows(r.askerSid)).toHaveLength(1)
    const oldPrompt = r.lines.find(line => JSON.parse(line).type === 'control_request')!
    ;(r.session as unknown as { handleStreamLine: (line: string) => void }).handleStreamLine(oldPrompt)
    await drain()
    expect(r.session.hasPendingPermission).toBe(false)
    expect((await getSessionByClaudeId(r.sid))?.pendingPermission).toBeFalsy()
    await applySnapshot(r.sid, r.snapshot(), 'incident-replay-duplicate')
    await drain()
    expect(await noticeRows(r.askerSid)).toHaveLength(1)
  })

  it('withdraws a real permission on interrupt without leaving a Waiting badge', async () => {
    const r = await replay('permission-interrupt.shape.jsonl')
    for (const line of r.lines) {
      await r.feed(line)
      if (JSON.parse(line).type === 'control_request') expect((await getSessionByClaudeId(r.sid))?.pendingPermission?.toolName).toBe('Bash')
    }
    expect((await getSessionByClaudeId(r.sid))?.pendingPermission).toBeFalsy()
    expect(r.session.hasPendingPermission).toBe(false)
    expect(events.some(e => e.name === EventNames.SESSION_PERMISSION_RESOLVED && e.data.sessionId === r.sid && e.data.cancelled)).toBe(true)
    // The CLI marks an intentional abort is_error, but the real fold recognizes
    // aborted_tools and the interrupted user line as a stop, not a failure.
    expect(r.snapshot().lastResult?.isError).toBe(false)
    // This recording ends before an idle/death frame. Missing terminal
    // evidence must not manufacture completion; an actual stop is a daemon
    // liveness fact, not another invented stdout event.
    expect(r.snapshot().turnActive).toBe(true)
    await applySnapshot(r.sid, r.snapshot(true), 'recorded-interrupt-death')
    await drain()
    expect((await getSessionByClaudeId(r.sid))?.process_status).toBe('stopped')
    expect((await r.view()).phase).toBe('NEED_ACTION')
  })

  it('repairs a restart in the result window without a normal result notification', async () => {
    const r = await replay('completed-turn.shape.jsonl')
    let resultWindow = false
    for (const line of r.lines) {
      if (JSON.parse(line).type === 'result') resultWindow = true
      await r.feed(line, !resultWindow)
    }
    expect(events.filter(e => e.name === EventNames.SESSION_RESULT && e.data.sessionId === r.sid)).toHaveLength(0)
    expect((await r.view()).phase).toBe('NEED_ACTION')
    expect((await getSessionByClaudeId(r.sid))?.process_status).toBe('idle')
    expect((await getSessionRequest(r.request.id))?.status).toBe('notified')
    expect(await noticeRows(r.askerSid)).toHaveLength(1)
    await Promise.all([0, 1, 2].map(n => applySnapshot(r.sid, r.snapshot(), `restart-duplicate-${n}`)))
    await drain()
    expect(await noticeRows(r.askerSid)).toHaveLength(1)
    await updateTaskRaw(r.taskId, { phase: 'IN_PROGRESS', phase_changed_at: '2099-01-01T00:00:00Z' })
    await applySnapshot(r.sid, r.snapshot(), 'restart-after-human-choice')
    await drain()
    expect((await r.view()).phase).toBe('IN_PROGRESS')
  })

  it('holds a synthetic usage-limit variation without settling its request, then recovers', async () => {
    // No real limit stop was available locally. This is labeled synthetic,
    // never presented as a recording of a limit incident.
    const r = await replay('usage-limit.synthetic.shape.jsonl')
    for (const line of r.lines) await r.feed(line)
    const record = await getSessionByClaudeId(r.sid)
    expect(record?.usageLimit?.state).toBe('waiting')
    expect((await r.view()).phase).toBe('IN_PROGRESS')
    expect((await r.view()).user_status.state).toBe('waiting')
    expect((await r.view()).user_status.limit).toBeTruthy()
    expect((await getSessionRequest(r.request.id))?.status).toBe('pending')
    expect(await noticeRows(r.askerSid)).toHaveLength(0)
    expect(events.find(e => e.name === EventNames.SESSION_RESULT && e.data.sessionId === r.sid)?.data.usageLimit?.engine).toBe('claude')
    const resume = await getUsageLimitWaiter()!.act(r.sid, 'continue')
    expect(resume.ok).toBe(true)
    await drain()
    expect(events.some(event => event.name === EventNames.SESSION_MESSAGE_QUEUED && event.data.sessionId === r.sid && event.data.source === 'auto-continue')).toBe(true)
    for (const line of await linesOf('completed-turn.shape.jsonl')) {
      const event = JSON.parse(line)
      if ('session_id' in event) event.session_id = r.sid
      // A new model turn has new message identities and cumulative cost.
      // This recovery variation is explicitly synthetic, not stale replay.
      if (event.message?.id) event.message.id += '-continued'
      if (event.type === 'result') event.total_cost_usd += 0.01
      await r.feed(JSON.stringify(event))
    }
    expect((await getSessionByClaudeId(r.sid))?.usageLimit).toBeFalsy()
    expect((await r.view()).phase).toBe('NEED_ACTION')
  })

  it('settles the foreground but keeps a never-ending background task Working', async () => {
    const r = await replay('incident-d-backgrounded-grep.shape.jsonl')
    // This historical recording spans several turns. The request belongs to
    // the final turn, not to an earlier clean foreground completion.
    const lastStart = r.lines.findLastIndex(line => {
      const event = JSON.parse(line)
      return event.type === 'system' && event.subtype === 'session_state_changed' && event.state === 'running'
    })
    for (const line of r.lines.slice(lastStart)) await r.feed(line)
    expect(r.snapshot().turnActive).toBe(false)
    expect(r.snapshot().detachedBgCount).toBe(1)
    expect(events.some(event => event.name === EventNames.SESSION_RESULT && event.data.sessionId === r.sid && event.data.detachedBgActive === true)).toBe(true)
    expect(r.session.consumedOffset).toBeGreaterThan(0)
    expect((await getSessionByClaudeId(r.sid))?.process_status).toBe('running')
    expect((await r.view()).phase).toBe('IN_PROGRESS')
    expect((await r.view()).user_status.state).toBe('working')
    expect((await getSessionRequest(r.request.id))?.status).toBe('pending')
    expect(await noticeRows(r.askerSid)).toHaveLength(0)
  })
})
