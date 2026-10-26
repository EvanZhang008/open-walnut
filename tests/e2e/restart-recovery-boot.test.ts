/**
 * E2E: a restart drill. The computer reboots with work running on it; Walnut
 * comes back, finds what was interrupted, resumes exactly that, and leaves the
 * rest where it was. Then the server restarts again in the middle of recovery.
 *
 * 2026-10-26: after a real reboot none of 42 sessions came back, and twelve
 * tasks with work in flight were shown as waiting on the user. Three things did
 * it, and this drill runs all three for real: the startup reconciler's
 * hand-back, the daemon's snapshot rewriting each record's status_reason 30 s
 * later, and the health monitor's drift rule handing back IN_PROGRESS tasks
 * whose sessions are all dead.
 *
 * Real: server boot, reconciler, restart recovery (classification, queue,
 * persisted loss and budget), snapshot apply, the health monitor's phase rule,
 * the task store and session store, the restart notice. Faked: process
 * liveness (every pid is dead), the daemon's fold answers, recovery ownership,
 * and the final send (no CLI may start); the fake send writes what a resumed
 * session's record would show and computes the notice the real send path adds.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-restart-drill'))
vi.mock('../../src/utils/session-liveness.js', () => ({ isSessionProcessAlive: async () => false }))

import { WALNUT_HOME, SESSIONS_FILE, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import * as autoRecover from '../../src/core/session-auto-recover.js'
import { getTask } from '../../src/core/task-manager.js'
import { getSessionByClaudeId, updateSessionRecord, listSessions } from '../../src/core/session-tracker.js'
import { applySnapshot } from '../../src/core/session-snapshot-apply.js'
import { _resetSnapshotGateForTests } from '../../src/core/session-snapshot-gate.js'
import { pendingRestartNotice } from '../../src/core/sessions/restart-notice.js'
import { RESUME_MESSAGE } from '../../src/core/sessions/restart-loss.js'
import type { SessionSnapshot } from '../../src/providers/daemon-fold.js'
import type { Task } from '../../src/core/types.js'

// Every case of the real reboot, one session each.
const S = {
  turn: 'drill-turn',          // IN_PROGRESS, mid-turn
  bg: 'drill-bg',              // IN_PROGRESS, turn ended waiting on 2 background commands
  idle: 'drill-idle',          // IN_PROGRESS, turn finished, nothing pending
  prompt: 'drill-prompt',      // IN_PROGRESS, a permission prompt open
  parked: 'drill-parked',      // WAITING on a clock/trigger
  parkedBg: 'drill-parked-bg', // WAITING, but on its own background command
  handed: 'drill-handed',      // NEED_ACTION before the reboot
} as const
const taskOf = (sid: string) => `task-${sid}`
const WAIT_UNTIL = '2099-01-01T00:00:00.000Z'

const folds: Record<string, Partial<SessionSnapshot>> = {
  [S.turn]: { turnActive: true, lastResult: null },
  [S.bg]: { detachedBgCount: 2 },
  [S.idle]: {},
  [S.prompt]: { turnActive: true, pendingPermission: { requestId: 'req-1', toolName: 'Bash' } },
  [S.parked]: {},
  [S.parkedBg]: { gatingBgCount: 1 },
  [S.handed]: { turnActive: true },
}

function snapshot(sid: string): SessionSnapshot {
  return {
    v: 4096, cliState: 'dead', turnActive: false, pendingPermission: null, gatingBgCount: 0, detachedBgCount: 0,
    teamActive: false, cronActive: false, wakeupAt: null, lastResult: { isError: false, endOffset: 4000 },
    pid: null, exitCode: null, streamEpoch: `epoch-${sid}`, ...folds[sid],
  }
}

let server: HttpServer
const sends: Array<{ sessionId: string; message: string; source: string; notice: string | null }> = []
const envBackup: Record<string, string | undefined> = {}
let cwd = ''
let liveV = 10_000

function setEnv(key: string, value: string): void {
  if (!(key in envBackup)) envBackup[key] = process.env[key]
  process.env[key] = value
}

function task(sid: string, phase: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: taskOf(sid), title: `Task ${sid}`, status: 'in_progress', phase, priority: 'none', project: 'Drill',
    session_ids: [sid], active_session_ids: [sid],
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', phase_changed_at: '2026-01-01T00:00:00Z',
    description: '', summary: '', note: '', subtasks: [], ...extra,
  }
}

/** Last activity well before this machine booted: the reboot killed them all. */
function session(sid: string, status: string): Record<string, unknown> {
  return {
    claudeSessionId: sid, taskId: taskOf(sid), project: 'Drill', type: 'interactive', provider: 'cli',
    engine: 'claude', process_status: status, mode: 'bypass', cwd, pid: 999_999_001,
    startedAt: '2020-01-01T00:00:00.000Z', lastActiveAt: '2020-01-01T00:10:00.000Z', messageCount: 4,
  }
}

async function boot(): Promise<void> {
  server = await startServer({ port: 0, dev: true })
}

async function phases(): Promise<Record<string, Task['phase']>> {
  const out: Record<string, Task['phase']> = {}
  for (const sid of Object.values(S)) out[sid] = (await getTask(taskOf(sid))).phase
  return out
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fs.mkdir(path.dirname(SESSIONS_FILE), { recursive: true })
  cwd = path.join(WALNUT_HOME, 'work', 'marina')
  await fs.mkdir(cwd, { recursive: true })

  await fs.writeFile(TASKS_FILE, JSON.stringify({
    version: 1,
    tasks: [
      task(S.turn, 'IN_PROGRESS'), task(S.bg, 'IN_PROGRESS'), task(S.idle, 'IN_PROGRESS'), task(S.prompt, 'IN_PROGRESS'),
      task(S.parked, 'WAITING', { wait_until: WAIT_UNTIL }), task(S.parkedBg, 'WAITING', { wait_until: WAIT_UNTIL }),
      task(S.handed, 'NEED_ACTION'),
    ],
  }))
  await fs.writeFile(SESSIONS_FILE, JSON.stringify({
    version: 2,
    sessions: [
      session(S.turn, 'running'), session(S.bg, 'running'), session(S.idle, 'idle'), session(S.prompt, 'running'),
      session(S.parked, 'idle'), session(S.parkedBg, 'running'), session(S.handed, 'idle'),
    ],
  }))

  // Long enough for the snapshot and the drift rule to run before any resume.
  setEnv('WALNUT_AUTO_RECOVER_DELAY_MS', '8000')
  setEnv('WALNUT_AUTO_RECOVER_STAGGER_MS', '0')
  setEnv('WALNUT_AUTO_RECOVER_CONCURRENCY', '1')
  setEnv('WALNUT_AUTO_RECOVER_SETTLE_MS', '5000')
  setEnv('WALNUT_AUTO_RECOVER_MAX_LOAD', '1000')

  const start = autoRecover.startSessionAutoRecover
  vi.spyOn(autoRecover, 'startSessionAutoRecover').mockImplementation((config) => start(config, {
    recoveryOwner: async () => 'server',
    fetchSnapshot: async (rec) => (rec.claudeSessionId in folds ? snapshot(rec.claudeSessionId) : null),
    send: async (sessionId, message, opts) => {
      // What the real send path adds in front of the message, once.
      const notice = await pendingRestartNotice(sessionId)
      if (notice) await notice.markTold()
      sends.push({ sessionId, message, source: opts.source, notice: notice?.text ?? null })
      // The resumed CLI is up: its daemon's snapshot says so (the only writer
      // of a covered session's status).
      liveV += 1000
      await applySnapshot(sessionId, { ...snapshot(sessionId), v: liveV, cliState: 'running', turnActive: true, pendingPermission: null, pid: 4242 }, 'daemon-push')
    },
  }))
  await boot()
}, 180_000)

afterAll(async () => {
  try { await stopServer() } catch { /* already down */ }
  vi.restoreAllMocks()
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
}, 60_000)

describe('restart drill', () => {
  it('right after boot: interrupted work keeps its phase through the snapshot and the drift rule', async () => {
    await vi.waitFor(async () => {
      const losses = (await listSessions()).filter((s) => s.restartLoss?.verdict)
      expect(losses).toHaveLength(Object.keys(S).length)
    }, { timeout: 20_000 })
    // The daemon's fold arrives and rewrites status_reason (what erased the fact in the incident).
    for (const sid of Object.values(S)) {
      await applySnapshot(sid, snapshot(sid), 'pull-30s')
      expect((await getSessionByClaudeId(sid))?.status_reason).toBe('snapshot_projection')
    }
    // The health monitor's drift rule: every primary session dead, task IN_PROGRESS.
    const { SessionHealthMonitor } = await import('../../src/core/session-health-monitor.js')
    const taskMap = new Map((await Promise.all(Object.values(S).map((sid) => getTask(taskOf(sid))))).map((t) => [t.id, { ...t, updated_at: '2026-01-01T00:00:00Z' }]))
    await (new SessionHealthMonitor() as unknown as {
      reconcileTaskPhases(s: unknown[], m: Map<string, Task>, alive: () => Promise<boolean>): Promise<void>
    }).reconcileTaskPhases(await listSessions(), taskMap, async () => false)

    expect(sends).toEqual([])  // nothing resumed yet
    expect(await phases()).toEqual({
      [S.turn]: 'IN_PROGRESS', [S.bg]: 'IN_PROGRESS', [S.parkedBg]: 'WAITING',  // interrupted, held
      [S.idle]: 'NEED_ACTION', [S.prompt]: 'NEED_ACTION',                        // handed back, truthfully
      [S.parked]: 'WAITING', [S.handed]: 'NEED_ACTION',                          // untouched
    })
    expect((await getTask(taskOf(S.parked))).wait_until).toBe(WAIT_UNTIL)
  }, 60_000)

  it('then resumes exactly the interrupted sessions, one at a time, open turns first, each told why', async () => {
    await vi.waitFor(() => expect(sends).toHaveLength(3), { timeout: 30_000 })
    expect(sends[0].sessionId).toBe(S.turn)
    expect(sends.map((s) => s.sessionId).sort()).toEqual([S.bg, S.parkedBg, S.turn].sort())
    for (const s of sends) {
      expect(s.source).toBe('auto-recover')
      expect(s.message).toBe(RESUME_MESSAGE)
      expect(s.notice).toContain('This computer rebooted')
      expect(s.notice).toContain('The reboot cleared /tmp')
      expect(s.notice).toContain(`Your working directory is ${cwd}.`)
      expect(s.notice).toContain('Your task directory on this host is ')
    }
    expect(sends.find((s) => s.sessionId === S.bg)!.notice).toContain('while 2 background commands you started were still running')
    await vi.waitFor(async () => {
      for (const sid of [S.turn, S.bg, S.parkedBg]) {
        expect((await getSessionByClaudeId(sid))?.restartLoss?.state).toBe('resumed')
      }
    }, { timeout: 15_000 })
    // Settled sessions on a rebooted machine still owe a notice for their next message.
    expect((await getSessionByClaudeId(S.idle))?.restartLoss).toMatchObject({ verdict: 'settled', told: false })
    for (const sid of [S.turn, S.bg, S.parkedBg]) expect((await getSessionByClaudeId(sid))?.autoRecover?.attempts).toBe(1)
  }, 60_000)

  it('a second restart mid-recovery: a resumed session that died again comes back once more, nothing else twice', async () => {
    await stopServer()
    // A new server process starts with no snapshot coverage in memory.
    _resetSnapshotGateForTests()
    // The second restart kills the resumed turn session again. The parked one
    // had finished its resumed turn and was reaped before it: nothing to do there.
    await updateSessionRecord(S.turn, { process_status: 'running', pid: 999_999_002 })
    await updateSessionRecord(S.parkedBg, { process_status: 'stopped', pid: undefined } as Parameters<typeof updateSessionRecord>[1])
    // And one loss was still queued when the server went down.
    const queued = await getSessionByClaudeId(S.bg)
    await updateSessionRecord(S.bg, {
      process_status: 'stopped', pid: undefined,
      restartLoss: { ...queued!.restartLoss!, state: 'queued', told: true },
    } as Parameters<typeof updateSessionRecord>[1])
    sends.length = 0
    await boot()
    await vi.waitFor(() => expect(sends.map((s) => s.sessionId).sort()).toEqual([S.bg, S.turn].sort()), { timeout: 30_000 })
    await new Promise((r) => setTimeout(r, 6000))
    expect(sends.map((s) => s.sessionId).sort()).toEqual([S.bg, S.turn].sort())
    expect((await getSessionByClaudeId(S.turn))?.autoRecover?.attempts).toBe(2)
    expect((await getSessionByClaudeId(S.bg))?.autoRecover?.attempts).toBe(2)
    // The already-told queued one is not told twice; the newly killed one is told again.
    expect(sends.find((s) => s.sessionId === S.bg)!.notice).toBeNull()
    expect(sends.find((s) => s.sessionId === S.turn)!.notice).toContain('[Walnut restart recovery]')
    expect((await getTask(taskOf(S.turn))).phase).toBe('IN_PROGRESS')
  }, 90_000)
})
