/**
 * On a host that runs its sessions, the task side of those sessions is the leader's
 * (session-channel/leader-tasks.ts and the leader's turn-end handlers on the facts it re-emits):
 * the host's task store is a read-only copy, so a write of it was tried and failed there with
 * "attempt to write a readonly database" (the session-result handler, a daemon snapshot, every
 * link). Outside the session classes (their port answers it, host-port.ts), every such write goes
 * through one of three gates, each asking judge-of.ts taskSideOnLeader: applySessionPhase
 * (phase.ts), the task-manager's session-link writer, and the session hooks (their note, summary,
 * title and cwd writes name no session, so their dispatcher asks: the leader runs them).
 *
 * Real: a host replica's guarded task and session stores, its own-row writer, the funnels.
 * Guards for the class:
 *   - an own session's phase edge and each session-link write changes nothing and raises nothing;
 *     the same write for a session that is not this host's own is still tried (the copy refuses
 *     it), so the gate is what decides, not a swallowed error;
 *   - every exported task-manager writer that names a session goes through the one link writer
 *     (or is listed), and every applySessionPhase call names its session (or is listed: a write no
 *     session of a host makes).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-task-side', { CLOUD_MODE: false }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'
import * as sessionDb from '../../../src/core/session-db.js'
import * as tracker from '../../../src/core/session-tracker.js'
import * as taskDb from '../../../src/core/task-db.js'
import * as tm from '../../../src/core/task-manager.js'
import { applySessionPhase, handBackTaskOnSessionEnd } from '../../../src/core/phase.js'
import { taskSideOnLeader } from '../../../src/core/sessions/judge-of.js'
import { SessionHookDispatcher } from '../../../src/core/session-hooks/dispatcher.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { log } from '../../../src/logging/index.js'

const KEY = 'devbox'
const OWN = 'host-own-1'
const COPY = 'leader-copy-1'
let taskId = ''

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  for (const k of ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER', 'WALNUT_HOST_KEY']) delete process.env[k]
  _resetServerRoleForTesting()
  // The leader's copy, as it reaches the host: one task, one row of the leader's.
  const { task } = await tm.addTask({ title: 'Run on the host', project: 'Marina' })
  taskId = task.id
  await tm.updateTask(taskId, { phase: 'TODO' })
  sessionDb.applySessionCopy({ rows: [{ claudeSessionId: COPY, taskId: '', project: 'p', process_status: 'idle', mode: 'default', startedAt: 'x', lastActiveAt: 'x', messageCount: 0 } as never] })
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  taskDb.closeDb()
  tm._dropTaskStoreCacheForTesting()
  // Now a host replica that runs its sessions: its own row of the task.
  process.env.WALNUT_ROLE = 'replica'
  process.env.WALNUT_HOST_KEY = KEY
  _resetServerRoleForTesting()
  sessionDb.allowOwnRowWrites(KEY)
  await tracker.createSessionRecord(OWN, taskId, 'Marina', '/tmp', { host: KEY, judge: 'host' } as never)
})

afterAll(async () => {
  sessionDb.allowOwnRowWrites(null)
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  taskDb.closeDb()
  tm._dropTaskStoreCacheForTesting()
  for (const k of ['WALNUT_ROLE', 'WALNUT_HOST_KEY']) delete process.env[k]
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a host that runs its sessions writes no task side of them', () => {
  it('knows its own sessions, and only them', () => {
    expect(taskSideOnLeader(OWN)).toBe(true)
    expect(taskSideOnLeader(COPY)).toBe(false)
    expect(taskSideOnLeader('no-such-row')).toBe(false)
    expect(taskSideOnLeader(undefined)).toBe(false)
  })

  it('a phase edge of its own session moves nothing and tries no write; one of another session is still tried', async () => {
    const said: string[] = []
    const warn = vi.spyOn(log.session, 'warn').mockImplementation((msg: string) => { said.push(msg) })
    const error = vi.spyOn(log.session, 'error').mockImplementation((msg: string) => { said.push(msg) })
    try {
      for (const trigger of ['session:turn-start', 'session:result', 'session:error', 'session:streaming', 'session:awaiting-human'] as const) {
        await expect(applySessionPhase(taskId, trigger, 'test', { sessionId: OWN })).resolves.toEqual({ changed: false })
      }
      await expect(handBackTaskOnSessionEnd(taskId, OWN, 'test', { turnEnd: true })).resolves.toBe(false)
      expect(said).toEqual([])
      expect((await tm.getTask(taskId)).phase).toBe('TODO')
      // The gate decides, not a swallowed error: the same edge for a session not its own is tried.
      await applySessionPhase(taskId, 'session:turn-start', 'test', { sessionId: COPY }).catch(() => {})
      expect(said.some((m) => /phase update/i.test(m)), said.join('\n')).toBe(true)
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })

  it('each session-link write of its own session answers the task as it is', async () => {
    const before = await tm.getTask(taskId)
    for (const write of [
      () => tm.linkSessionSlot(taskId, OWN, 'exec'), () => tm.linkSession(taskId, OWN), () => tm.addSessionToHistory(taskId, OWN),
      () => tm.clearSessionSlot(taskId, OWN), () => tm.clearSession(taskId, OWN), () => tm.replaceSessionIdLinks(taskId, OWN, 'host-own-2'),
    ]) {
      const { task } = await write()
      expect(task.id).toBe(taskId)
    }
    expect(await tm.getTask(taskId)).toEqual(before)
  })

  it('the same write for a session that is not its own is still tried, and the copy refuses it', async () => {
    await expect(tm.clearSessionSlot(taskId, COPY)).rejects.toThrow(/readonly|read only|query_only/i)
  })

  it('its session hooks run on the leader, not here; a hook of another session still runs', async () => {
    const handler = vi.fn()
    const dispatcher = new SessionHookDispatcher()
    dispatcher.init([{ id: 'test-turn-end', name: 'Turn end', hooks: ['onTurnComplete'], handler, source: 'builtin', enabled: true }])
    try {
      bus.emit(EventNames.SESSION_RESULT, { sessionId: OWN, taskId, result: 'done' }, ['*'], { source: 'session' })
      bus.emit(EventNames.SESSION_RESULT, { sessionId: COPY, taskId: '', result: 'done' }, ['*'], { source: 'session' })
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
      await new Promise((r) => setTimeout(r, 50))
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler.mock.calls[0]![0]).toMatchObject({ sessionId: COPY })
    } finally {
      dispatcher.destroy()
      bus.unsubscribe('session-hooks')
    }
  })
})

const ROOT = path.resolve(import.meta.dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** applySessionPhase calls that name no session, with why no session a host runs makes them. */
const NO_SESSION_PHASE_CALLS: Record<string, string> = {
  'src/core/router/service.ts': 'the router\'s start of a task, on the leader',
  'src/core/offline-merge/apply-session.ts': 'the leader applying what a host ran while it was away',
}

/** Task-manager writers that name a session and are no session link, with what keeps a host's own session off them. */
const NAMED_NOT_LINKS: Record<string, string> = {
  updateSummary: 'a summary its caller wrote: a route (on a host the follower\'s route table takes it) or the turn-end hook (the dispatcher\'s gate: the leader runs it)',
}

describe('the funnels hold the whole class', () => {
  it('every exported session-link writer of task-manager.ts goes through the one writer', () => {
    const src = read('src/core/task-manager.ts')
    const writers = [...src.matchAll(/export async function (\w+)\(([^)]*)\)[^{]*\{([\s\S]*?)\n\}/g)]
      .filter((m) => /\b(?:sessionId|oldSessionId)\??:/.test(m[2]!) && /writeStore\(|writeSessionLink\(/.test(m[3]!))
      .filter((m) => !(m[1]! in NAMED_NOT_LINKS))
    expect(writers.map((m) => m[1]).sort()).toEqual(['addSessionToHistory', 'clearSession', 'clearSessionSlot', 'linkSession', 'linkSessionSlot', 'replaceSessionIdLinks'])
    for (const m of writers) expect(m[3], `${m[1]}: write it through writeSessionLink, which skips a host's own session, or list it in NAMED_NOT_LINKS with why`).toMatch(/\n\s*return writeSessionLink\(/)
    for (const m of writers) expect(m[3], m[1]).not.toMatch(/writeStore\(/)
    expect(src).toMatch(/async function writeSessionLink\([\s\S]{0,200}\{\n\s*if \(sessionIds\.some\(\(sid\) => taskSideOnLeader\(sid\)\)\)/)
    // The hooks' gate stands before any hook point is derived.
    const hooks = read('src/core/session-hooks/dispatcher.ts')
    expect(hooks.indexOf('if (taskSideOnLeader(sessionOfEvent(event))) return;')).toBeGreaterThan(0)
    expect(hooks.indexOf('if (taskSideOnLeader(sessionOfEvent(event))) return;')).toBeLessThan(hooks.indexOf('const hookPoints = deriveSessionHookPoints('))
  })

  it('every applySessionPhase call names its session, so the gate can see it', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name)
        if (e.isDirectory()) walk(rel)
        else if (/\.ts$/.test(e.name)) files.push(rel)
      }
    }
    walk('src')
    const unnamed: string[] = []
    for (const f of files) {
      const code = read(f).split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
      for (const m of code.matchAll(/\bapplySessionPhase\(([^()]|\([^()]*\))*\)/g)) {
        if (/export async function applySessionPhase/.test(code.slice(Math.max(0, m.index! - 30), m.index! + 20))) continue
        if (!/sessionId|\.\.\.opts/.test(m[0])) unnamed.push(f)
      }
    }
    expect([...new Set(unnamed)].filter((f) => !(f in NO_SESSION_PHASE_CALLS)).sort(), 'name the session in its opts (sessionId), or list the file with why no session a host runs makes it').toEqual([])
    expect(phaseGate(read('src/core/phase.ts'))).toBe(true)
  })
})

/** movePhase asks the gate before it reads the task. */
function phaseGate(src: string): boolean {
  const body = src.slice(src.indexOf('async function movePhase('))
  return body.indexOf('taskSideOnLeader(opts?.sessionId)') > 0 && body.indexOf('taskSideOnLeader(opts?.sessionId)') < body.indexOf('await getTask(taskId)')
}
