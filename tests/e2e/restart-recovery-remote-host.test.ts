/**
 * E2E: a remote host reboots while sessions run on it. When its daemon is back
 * and says each CLI is gone, Walnut must resume the work that was in flight,
 * and no hand-back may move the task to NEED_ACTION before restart recovery
 * has decided.
 *
 * 2026-11-04: a remote host rebooted with 8 running sessions. The reconnect
 * pull applied each dead snapshot and that same apply handed the task back
 * ("task handed back after out-of-band session end"); restart recovery was
 * asked a second later, read NEED_ACTION and resumed none ("task was
 * NEED_ACTION"). The fix (src/core/sessions/restart-death.ts) notes the loss
 * before the death is written, and every death edge of applySessionPhase asks
 * restart recovery first.
 *
 * Real: server boot, snapshot apply (reconnect pull, the 30 s pull, a daemon
 * push), restart recovery (classification, queue, notice), the health monitor's
 * drift rule, applySessionPhase, the task and session stores. Faked: process
 * liveness (the boot reconciler cannot reach the host, so it keeps them alive,
 * as in the incident), the daemon's fold answers, the host's daemon start time,
 * recovery ownership, and the final send (no CLI may start).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-remote-reboot'))
vi.mock('../../src/utils/session-liveness.js', () => ({ isSessionProcessAlive: async () => true }))

const HOST = 'devbox'
/** When the rebooted host's daemon started; set right before the pull that reads it. */
let daemonStartedAt: number | null = null
vi.mock('../../src/providers/daemon-connection.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/providers/daemon-connection.js')>()
  return {
    ...orig,
    // Only applySnapshot's daemon-start witness reads this; every other caller gets a link that answers nothing.
    getPooledSnapshotConnection: (host: string | null | undefined) => host === HOST
      ? { get daemonStartedAt() { return daemonStartedAt }, connected: true, supportsSnapshots: true, host: HOST,
        hasCapability: () => false, send: async () => ({ ok: false }) }
      : null,
  }
})

import { WALNUT_HOME, SESSIONS_FILE, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import * as autoRecover from '../../src/core/session-auto-recover.js'
import { getTask } from '../../src/core/task-manager.js'
import { getSessionByClaudeId, listSessions } from '../../src/core/session-tracker.js'
import { applySnapshot } from '../../src/core/session-snapshot-apply.js'
import { applySessionPhase } from '../../src/core/phase.js'
import { pendingRestartNotice } from '../../src/core/sessions/restart-notice.js'
import { RESUME_MESSAGE } from '../../src/core/sessions/restart-loss.js'
import type { SessionSnapshot } from '../../src/providers/daemon-fold.js'
import type { Task } from '../../src/core/types.js'

const S = {
  turn: 'rr-turn',        // mid-turn when the host went down; reconnect pull
  bg: 'rr-bg',            // its turn ended around a background command; reconnect pull
  pulled: 'rr-pulled',    // mid-turn; the 30 s pull reaches it before the reconnect pull does
  idle: 'rr-idle',        // its last turn had finished; reconnect pull
  lost: 'rr-lost',        // mid-turn, already marked "connection lost" during the outage; reconnect pull
  crash: 'rr-crash',      // a CLI that died on a host Walnut never lost, and whose daemon never restarted
} as const
const MIN = 60_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const taskOf = (sid: string) => `task-${sid}`

const folds: Record<string, Partial<SessionSnapshot>> = {
  [S.turn]: { turnActive: true, lastResult: null },
  [S.bg]: { detachedBgCount: 1 },
  [S.pulled]: { turnActive: true, lastResult: null },
  [S.idle]: {},
  [S.lost]: { turnActive: true, lastResult: null },
  [S.crash]: { turnActive: true, lastResult: null },
}

function snapshot(sid: string): SessionSnapshot {
  return {
    v: 4096, cliState: 'dead', turnActive: false, pendingPermission: null, gatingBgCount: 0, detachedBgCount: 0,
    teamActive: false, cronActive: false, wakeupAt: null, lastResult: { isError: false, endOffset: 4000 },
    pid: null, exitCode: null, streamEpoch: `epoch-${sid}`, ...folds[sid],
  }
}

/** Sessions the fake send brought back: their host now reports them running. */
const resumed = new Set<string>()
const sends: Array<{ sessionId: string; message: string; source: string; notice: string | null }> = []
const envBackup: Record<string, string | undefined> = {}
let liveV = 10_000

function setEnv(key: string, value: string): void {
  if (!(key in envBackup)) envBackup[key] = process.env[key]
  process.env[key] = value
}

function task(sid: string): Record<string, unknown> {
  return {
    id: taskOf(sid), title: `Task ${sid}`, status: 'in_progress', phase: 'IN_PROGRESS', priority: 'none', project: 'Drill',
    session_ids: [sid], active_session_ids: [sid],
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', phase_changed_at: '2026-01-01T00:00:00Z',
    description: '', summary: '', note: '', subtasks: [],
  }
}

function session(sid: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claudeSessionId: sid, taskId: taskOf(sid), project: 'Drill', type: 'interactive', provider: 'cli',
    engine: 'claude', process_status: status, mode: 'bypass', cwd: '/home/dev/marina', host: HOST, pid: 999_999_001,
    startedAt: ago(60 * MIN), lastActiveAt: ago(8 * MIN), last_status_change: ago(8 * MIN), messageCount: 4, ...extra,
  }
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
  await fs.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: Object.values(S).map(task) }))
  await fs.writeFile(SESSIONS_FILE, JSON.stringify({
    version: 2,
    sessions: [
      session(S.turn, 'running'), session(S.bg, 'running'), session(S.pulled, 'running'), session(S.idle, 'idle'),
      // The outage lasted 25 minutes, and Walnut marked the link lost meanwhile.
      session(S.lost, 'error', {
        status_reason: 'remote_unreachable', errorMessage: 'Connection lost: unable to reach remote host',
        status_changed_by: 'daemon', last_status_change: ago(25 * MIN),
      }),
      session(S.crash, 'running'),
    ],
  }))

  // Long enough for every hand-back path below to run before any resume.
  setEnv('WALNUT_AUTO_RECOVER_DELAY_MS', '6000')
  setEnv('WALNUT_AUTO_RECOVER_STAGGER_MS', '0')
  setEnv('WALNUT_AUTO_RECOVER_CONCURRENCY', '1')
  setEnv('WALNUT_AUTO_RECOVER_SETTLE_MS', '5000')
  setEnv('WALNUT_AUTO_RECOVER_MAX_LOAD', '1000')
  const start = autoRecover.startSessionAutoRecover
  vi.spyOn(autoRecover, 'startSessionAutoRecover').mockImplementation((config) => start(config, {
    recoveryOwner: async () => 'server',
    fetchSnapshot: async (rec) => resumed.has(rec.claudeSessionId)
      ? { ...snapshot(rec.claudeSessionId), cliState: 'running', turnActive: true, pid: 4242 }
      : rec.claudeSessionId in folds ? snapshot(rec.claudeSessionId) : null,
    cwdExists: async () => true,
    taskDir: async () => null,
    send: async (sessionId, message, opts) => {
      const notice = await pendingRestartNotice(sessionId)
      if (notice) await notice.markTold()
      sends.push({ sessionId, message, source: opts.source, notice: notice?.text ?? null })
      resumed.add(sessionId)
      liveV += 1000
      await applySnapshot(sessionId, { ...snapshot(sessionId), v: liveV, cliState: 'running', turnActive: true, pendingPermission: null, pid: 4242 }, 'daemon-push')
    },
  }))
  await startServer({ port: 0, dev: true })
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

describe('a remote host reboots under running sessions', () => {
  it('no hand-back reaches the task before restart recovery decides', async () => {
    // The boot reconciler could not reach the host and kept every session alive.
    for (const sid of Object.values(S)) expect((await getSessionByClaudeId(sid))?.restartLoss).toBeUndefined()

    // The 30 s pull reaches one session first: its daemon started after the session was last seen.
    daemonStartedAt = Date.parse((await getSessionByClaudeId(S.pulled))!.lastActiveAt!) + 2 * MIN
    await applySnapshot(S.pulled, snapshot(S.pulled), 'pull-30s')
    daemonStartedAt = null
    expect((await getTask(taskOf(S.pulled))).phase).toBe('IN_PROGRESS')
    // The host is back: the reconnect pull finds every other CLI dead.
    for (const sid of [S.turn, S.bg, S.idle, S.lost]) {
      await applySnapshot(sid, snapshot(sid), 'reconnect-pull')
      expect((await getSessionByClaudeId(sid))?.restartLoss?.cause).toBe('host_restart')
      // Right after the apply, in the same tick the incident's hand-back ran (the
      // settled one may already be handed back by its own verdict).
      if (sid !== S.idle) expect((await getTask(taskOf(sid))).phase).toBe('IN_PROGRESS')
    }
    // A CLI that died on a host that never went away keeps its usual hand-back.
    await applySnapshot(S.crash, snapshot(S.crash), 'daemon-push')
    expect((await getSessionByClaudeId(S.crash))?.restartLoss).toBeUndefined()
    expect((await getTask(taskOf(S.crash))).phase).toBe('NEED_ACTION')
    // The health monitor's re-check pull of that dead record is no restart either.
    await applySnapshot(S.crash, { ...snapshot(S.crash), v: 5000 }, 'pull-30s')
    expect((await getSessionByClaudeId(S.crash))?.restartLoss).toBeUndefined()

    // Every other death edge: a session error, a process-death result, the drift rule.
    for (const sid of [S.turn, S.bg, S.pulled, S.lost]) {
      await applySessionPhase(taskOf(sid), 'session:error', 'test:session-error', { sessionId: sid })
      await applySessionPhase(taskOf(sid), 'session:result', 'test:process-death', { sessionId: sid, processAlive: false })
    }
    const { SessionHealthMonitor } = await import('../../src/core/session-health-monitor.js')
    const taskMap = new Map((await Promise.all(Object.values(S).map((sid) => getTask(taskOf(sid))))).map((t) => [t.id, { ...t, updated_at: '2026-01-01T00:00:00Z' }]))
    await (new SessionHealthMonitor() as unknown as {
      reconcileTaskPhases(s: unknown[], m: Map<string, Task>, alive: () => Promise<boolean>): Promise<void>
    }).reconcileTaskPhases(await listSessions(), taskMap, async () => false)

    await vi.waitFor(async () => {
      for (const sid of [S.turn, S.bg, S.pulled, S.idle, S.lost]) expect((await getSessionByClaudeId(sid))?.restartLoss?.verdict).toBeTruthy()
    }, { timeout: 15_000 })
    expect(sends).toEqual([])
    expect(await phases()).toEqual({
      [S.turn]: 'IN_PROGRESS', [S.bg]: 'IN_PROGRESS', [S.pulled]: 'IN_PROGRESS', [S.lost]: 'IN_PROGRESS',  // interrupted, held
      [S.idle]: 'NEED_ACTION',                                                     // its turn had ended: handed back, truthfully
      [S.crash]: 'NEED_ACTION',
    })
    for (const sid of [S.turn, S.bg, S.pulled, S.lost]) {
      expect((await getSessionByClaudeId(sid))?.restartLoss).toMatchObject({ verdict: 'resume', phaseAtLoss: 'IN_PROGRESS' })
    }
  }, 60_000)

  it('then resumes the interrupted sessions, each told that its host restarted', async () => {
    await vi.waitFor(() => expect(sends).toHaveLength(4), { timeout: 50_000 })
    expect(sends.map((s) => s.sessionId).sort()).toEqual([S.bg, S.lost, S.pulled, S.turn].sort())
    for (const s of sends) {
      expect(s.source).toBe('auto-recover')
      expect(s.message).toBe(RESUME_MESSAGE)
      expect(s.notice).toContain(`The host ${HOST} or its session daemon restarted`)
    }
    await vi.waitFor(async () => {
      for (const sid of [S.turn, S.bg, S.pulled, S.lost]) expect((await getSessionByClaudeId(sid))?.restartLoss?.state).toBe('resumed')
    }, { timeout: 30_000 })
    // The crash on a working link was never told it was a restart.
    expect((await getSessionByClaudeId(S.crash))?.restartLoss).toBeUndefined()
    for (const sid of [S.turn, S.bg, S.pulled, S.lost]) expect((await getTask(taskOf(sid))).phase).toBe('IN_PROGRESS')
  }, 60_000)
})
