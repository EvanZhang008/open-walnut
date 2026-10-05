/**
 * The runner probe harness (runner-gate-probes.test.ts, runner-gate-r3-probes.test.ts).
 *
 * Real: SessionRunner, ClaudeCodeSession, the disk queue, line-consumption.
 * Faked: the transport (a script decides each write). No process is spawned: a
 * resume is recorded (session.send is replaced), never run. The importing test
 * file mocks src/constants.js before anything here loads.
 */
import { vi } from 'vitest'
import fs from 'node:fs/promises'
import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'
import { getQueue, resetCache } from '../../src/core/session-message-queue.js'
import { resetLineConsumption } from '../../src/providers/line-consumption.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

export const SID = '30000000-0000-4000-8000-0000000000a1'

export interface Write { message: string; uuid?: string; dedupe?: boolean; at: number }
export type Script = (message: string, o: { uuid?: string; dedupe?: boolean; onFate?: (f: { fate: string; state?: string }) => void }) => Promise<boolean>

export const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms))

export function harness(opts: { transport?: unknown; script?: Script; running?: boolean; sid?: string; task?: string; lifecycle?: boolean } = {}) {
  const sid = opts.sid ?? SID
  const task = opts.task ?? 'gate-task'
  const writes: Write[] = []
  const t0 = Date.now()
  const stop = vi.fn(async () => {})
  const fake = {
    writeMessage: async (message: string, o: { uuid?: string; dedupe?: boolean; onDispatch?: () => void; onFate?: (f: { fate: string; state?: string }) => void }) => {
      o?.onDispatch?.()
      writes.push({ message, uuid: o?.uuid, dedupe: o?.dedupe, at: Date.now() - t0 })
      return opts.script ? opts.script(message, o) : true
    },
    writeRaw: () => true,
    writeSyntheticUserEvent: () => {},
    deletePipe: () => {},
    stopTail: () => {},
    flushTail: () => {},
    kill: () => {},
    interrupt: async () => {},
    stop,
    hasPipe: true,
    fileSize: 0,
    pid: 12345,
  }
  const session = new ClaudeCodeSession(task, 'test', '/bin/true')
  const running = opts.running !== false
  Object.assign(session, {
    claudeSessionId: sid, _transport: opts.transport ?? fake, _active: true, pid: 12345,
    _processStatus: running ? 'running' : 'idle', resultEmitted: !running, _turnResultEmitted: !running,
    _sawCommandLifecycle: opts.lifecycle !== false,
  })
  // A resume would spawn a process: record it (and its settle callback) instead.
  const resumes: string[] = []
  const resumeSettles: Array<(ok: boolean, err?: Error) => void> = []
  ;(session as unknown as { send: (...a: unknown[]) => void }).send = (...args: unknown[]) => {
    resumes.push(String(args[0]))
    if (typeof args[13] === 'function') resumeSettles.push(args[13] as (ok: boolean, err?: Error) => void)
  }
  const runner = new SessionRunner('/bin/true')
  const internals = runner as unknown as {
    sessions: Map<string, ClaudeCodeSession>
    injectMidTurn(sid: string): Promise<void>
    processNext(sid: string): Promise<void>
    redeliverPendingForHost(host: string): Promise<void>
  }
  internals.sessions.set(task, session)
  const line = (obj: unknown) => (session as unknown as { handleStreamLine(l: string): void }).handleStreamLine(JSON.stringify(obj))
  const lifecycle = (uuid: string, state: string) => line({ type: 'command_lifecycle', command_uuid: uuid, state })
  const events: Array<{ name: string; data: Record<string, unknown>; at: number }> = []
  bus.subscribe(`gate-probe-${task}`, (e) => { events.push({ name: e.name, data: e.data as Record<string, unknown>, at: Date.now() - t0 }) }, { global: true })
  return { runner, internals, session, writes, stop, lifecycle, line, events, resumes, resumeSettles, t0 }
}
export type Harness = ReturnType<typeof harness>

/** The CLI ends the running turn: the real SESSION_RESULT path of the runner runs. */
export function turnEnds(h: Harness) {
  Object.assign(h.session, { _turnResultEmitted: true, resultEmitted: true, _processStatus: 'idle' })
  bus.emit(EventNames.SESSION_RESULT, { sessionId: SID, taskId: 'gate-task', result: 'ok', isError: false } as never, ['session-runner'], { source: 'gate-probe' })
}
export function turnStarts(h: Harness) {
  Object.assign(h.session, { _turnResultEmitted: false, resultEmitted: false, _processStatus: 'running' })
}
export function crash(h: Harness) {
  ;(h.session as unknown as { handleRemoteProcessExit(code: number, stderr?: string): void })
    .handleRemoteProcessExit(1, 'mock CLI crashed on purpose')
}

export const rows = async (sid = SID) => (await getQueue(sid)).map((m) => `${m.message}:${m.status}`)
export const named = (h: Harness, name: string, id?: string) =>
  h.events.filter((e) => e.name === name && (!id || (Array.isArray(e.data.messageIds) && (e.data.messageIds as string[]).includes(id))))

/** beforeEach: a fresh session record and empty registries. */
export async function probeSetup(): Promise<void> {
  closeDb()
  _resetSessionTrackerForTesting()
  resetLineConsumption()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await createSessionRecord(SID, 'gate-task', 'test', WALNUT_HOME, { initialProcessStatus: 'running' })
}

/** afterEach: drop everything the test left. */
export async function probeTeardown(): Promise<void> {
  bus.clear()
  resetLineConsumption()
  resetCache()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 })
}
