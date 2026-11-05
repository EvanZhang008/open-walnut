/**
 * E2E: this computer shuts down (a logout, a reboot) while local sessions are
 * mid-turn. The OS sends SIGTERM to every process of the user's session, the
 * CLIs, the local daemon and the server, roughly together, so the server is
 * often still alive when the CLIs (or the daemon) are already gone. Every death
 * it learns of in that window must be taken on by restart recovery before it is
 * written: the task never reads NEED_ACTION, and the next boot resumes the work.
 *
 * 2026-11-03: the Mac rebooted at 16:43Z after hanging from about 16:36Z. Four
 * local sessions were mid-turn. When the new server booted their records were
 * already 'stopped' or 'error' and their tasks NEED_ACTION: the previous server
 * had written each death and handed the task back. The startup reconciler only
 * checks records that still read live, so restart recovery never saw them.
 *
 * The orders a shutdown can take, one session each:
 *   A  a CLI dies first, its daemon and the server live: the daemon reaps it and
 *      pushes the dead snapshot (a signal exit is `code ?? 1` in reapSession),
 *      then the runner's exit edge follows.
 *   B  the daemon dies first: the runner's liveness tick declares an attached CLI
 *      dead once the link has been down 5 awake minutes (the hang), and the health
 *      monitor's liveness loop finds an unattached one's pid gone.
 *   B' the daemon dies first and a respawned daemon reports the CLI dead on the
 *      reconnect pull (covered since 2026-11-04: a control).
 *   C  the server dies with or before them: nothing is written, the next boot's
 *      reconciler marks the record (covered: a control).
 * Plus a negative control: a CLI that crashed (exit 1, no signal) before the
 * shutdown began keeps its ordinary hand-back and is never resumed.
 *
 * Real: server boot (twice, same data dir), snapshot apply, the runner's bus edges
 * as the server consumes them, the health monitor's liveness loop and drift rule,
 * applySessionPhase, restart recovery (classification, persisted loss, queue,
 * notice), the task and session stores. Faked: process liveness, the daemon's fold
 * answers, the local daemon link's down time, recovery ownership, the reattach at
 * the first boot (no daemon runs here), and the final send (no CLI may start). The
 * runner's death edges are emitted as the runner emits them (claude-code-session.ts
 * handleRemoteProcessExit / handleProcessDeath), since no CLI runs.
 *
 * The A snapshots carry `exitSignal: 'SIGTERM'`, the fact a fix needs and the
 * daemon drops today (`proc.on('exit', (code) => ...)` ignores the signal); the
 * crash's snapshot carries none.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-local-shutdown'))

/** Sessions whose process is gone now. */
const dead = new Set<string>()
vi.mock('../../src/utils/session-liveness.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/utils/session-liveness.js')>()
  return { ...orig, isSessionProcessAlive: async (s: { claudeSessionId: string }) => !dead.has(s.claudeSessionId) }
})

/** When the server's link to this computer's daemon went down (null: up). */
let localDownSince: number | null = null
vi.mock('../../src/providers/daemon-connection.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/providers/daemon-connection.js')>()
  return {
    ...orig,
    daemonLinkLostSince: (hostKey: string) => hostKey === '__local__' ? localDownSince : orig.daemonLinkLostSince(hostKey),
    getDaemonDisconnectedSince: (hostKey: string) => hostKey === '__local__' ? localDownSince : orig.getDaemonDisconnectedSince(hostKey),
    getDaemonDisconnectedAwakeMs: (hostKey: string) => hostKey === '__local__'
      ? (localDownSince == null ? 0 : Date.now() - localDownSince) : orig.getDaemonDisconnectedAwakeMs(hostKey),
  }
})

import { WALNUT_HOME, SESSIONS_FILE, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import * as autoRecover from '../../src/core/session-auto-recover.js'
import { getTask } from '../../src/core/task-manager.js'
import { getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { applySnapshot } from '../../src/core/session-snapshot-apply.js'
import { _resetSnapshotGateForTests } from '../../src/core/session-snapshot-gate.js'
import { pendingRestartNotice } from '../../src/core/sessions/restart-notice.js'
import { RESUME_MESSAGE } from '../../src/core/sessions/restart-loss.js'
import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { log } from '../../src/logging/index.js'
import type { SessionSnapshot } from '../../src/providers/daemon-fold.js'
import type { Task } from '../../src/core/types.js'

const S = {
  snapErr: 'sd-snap-err',     // A: SIGTERM, exit code 1; snapshot push, then the runner's session:error
  snapZero: 'sd-snap-zero',   // A: SIGTERM handled, exit code 0; snapshot push
  linkDown: 'sd-link-down',   // B: attached runner, link down 6 awake minutes: liveness tick death
  health: 'sd-health',        // B: no runner bound, pid gone: the health monitor's liveness loop
  respawned: 'sd-respawned',  // B': a respawned daemon's reconnect pull (control)
  together: 'sd-together',    // C: the server went down with it, nothing written (control)
  crash: 'sd-crash',          // negative control: crashed before the shutdown, no signal
} as const
const INTERRUPTED = [S.snapErr, S.snapZero, S.linkDown, S.health, S.respawned, S.together]
const MIN = 60_000
const CHECK_MS = 5_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const taskOf = (sid: string) => `task-${sid}`

function snapshot(sid: string, extra: Record<string, unknown> = {}): SessionSnapshot {
  return {
    v: 4096, cliState: 'dead', turnActive: true, pendingPermission: null, gatingBgCount: 0, detachedBgCount: 0,
    teamActive: false, cronActive: false, wakeupAt: null, lastResult: null,
    pid: null, exitCode: 1, streamEpoch: `epoch-${sid}`, ...extra,
  } as SessionSnapshot
}

let cwd = ''
let bootAt = Date.now() - 24 * 60 * MIN
const resumed = new Set<string>()
const sends: Array<{ sessionId: string; message: string; source: string; notice: string | null }> = []
/** Every hand-back to NEED_ACTION, with the writer that made it. */
const handBacks: Array<{ sid: string; trigger: string; source: string }> = []
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

/** A local session mid-turn, last seen 20 seconds ago. */
function session(sid: string, n: number): Record<string, unknown> {
  return {
    claudeSessionId: sid, taskId: taskOf(sid), project: 'Drill', type: 'interactive', provider: 'cli',
    engine: 'claude', process_status: 'running', mode: 'bypass', cwd, pid: 999_999_100 + n,
    startedAt: ago(60 * MIN), lastActiveAt: ago(20_000), last_status_change: ago(20_000), messageCount: 4,
  }
}

async function phases(): Promise<Record<string, Task['phase']>> {
  const out: Record<string, Task['phase']> = {}
  for (const sid of Object.values(S)) out[sid] = (await getTask(taskOf(sid))).phase
  return out
}

/** What the runner emits when its CLI's exit reaches it (handleRemoteProcessExit, code != 0). */
function runnerExitError(sid: string): void {
  bus.emit(EventNames.SESSION_ERROR, { sessionId: sid, taskId: taskOf(sid), error: 'Session process exited with code 1' },
    ['main-ai', 'session-runner'], { source: 'session-runner' })
}

/** What the runner does when its liveness tick finds the process gone (handleProcessDeath, no result). */
async function runnerLivenessDeath(sid: string): Promise<void> {
  await updateSessionRecord(sid, { process_status: 'stopped', last_status_change: new Date().toISOString() } as Parameters<typeof updateSessionRecord>[1])
  bus.emit(EventNames.SESSION_RESULT, { sessionId: sid, taskId: taskOf(sid), result: '', isError: false, processDied: true },
    ['main-ai', 'session-runner'], { source: 'session-runner' })
}

const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fs.mkdir(path.dirname(SESSIONS_FILE), { recursive: true })
  cwd = path.join(WALNUT_HOME, 'work', 'marina')
  await fs.mkdir(cwd, { recursive: true })
  await fs.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: Object.values(S).map(task) }))
  await fs.writeFile(SESSIONS_FILE, JSON.stringify({ version: 2, sessions: Object.values(S).map(session) }))

  // The first server must not resume anything before the shutdown kills it.
  setEnv('WALNUT_AUTO_RECOVER_DELAY_MS', String(60 * MIN))
  setEnv('WALNUT_AUTO_RECOVER_STAGGER_MS', '0')
  setEnv('WALNUT_AUTO_RECOVER_CONCURRENCY', '1')
  setEnv('WALNUT_AUTO_RECOVER_SETTLE_MS', '5000')
  setEnv('WALNUT_AUTO_RECOVER_MAX_LOAD', '1000')
  // A death waits this long for its host's shutdown to show before it is a crash.
  setEnv('WALNUT_SHUTDOWN_CHECK', '1')
  setEnv('WALNUT_SHUTDOWN_CHECK_MS', String(CHECK_MS))

  // No daemon runs here: the first boot's reattach of the live sessions is refused.
  vi.spyOn(ClaudeCodeSession, 'attachToExisting').mockRejectedValue(new Error('no daemon in this drill'))

  const info = log.session.info.bind(log.session)
  vi.spyOn(log.session, 'info').mockImplementation((msg: string, meta?: Record<string, unknown>) => {
    if (msg === 'phase transition' && meta?.newPhase === 'NEED_ACTION') {
      const sid = String(meta.taskId ?? '').replace(/^task-/, '')
      handBacks.push({ sid, trigger: String(meta.trigger), source: String(meta.source) })
    }
    return info(msg, meta)
  })

  const start = autoRecover.startSessionAutoRecover
  vi.spyOn(autoRecover, 'startSessionAutoRecover').mockImplementation((config) => start(config, {
    recoveryOwner: async () => 'server',
    fetchSnapshot: async (rec) => resumed.has(rec.claudeSessionId)
      ? { ...snapshot(rec.claudeSessionId), cliState: 'running', pid: 4242, exitCode: null }
      : dead.has(rec.claudeSessionId) ? snapshot(rec.claudeSessionId) : null,
    cwdExists: async () => true,
    taskDir: async () => null,
    bootTimeMs: () => bootAt,
    send: async (sessionId, message, opts) => {
      const notice = await pendingRestartNotice(sessionId)
      if (notice) await notice.markTold()
      sends.push({ sessionId, message, source: opts.source, notice: notice?.text ?? null })
      resumed.add(sessionId)
      dead.delete(sessionId)  // the resumed CLI lives
      liveV += 1000
      await applySnapshot(sessionId, { ...snapshot(sessionId), v: liveV, cliState: 'running', pid: 4242, exitCode: null }, 'daemon-push')
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

describe('this computer shuts down under running local sessions', () => {
  it('no death the shutdown causes hands its task back while the server still runs', async () => {
    // The boot reconciler found every session alive.
    for (const sid of Object.values(S)) expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')

    // Before the shutdown: an ordinary crash on a working host (exit 1, no signal).
    // Nothing says the host is going down within the check, so it is handed back.
    dead.add(S.crash)
    await applySnapshot(S.crash, snapshot(S.crash), 'daemon-push')
    runnerExitError(S.crash)
    await settle(500)
    expect((await getTask(taskOf(S.crash))).phase).toBe('IN_PROGRESS')  // held while it is checked
    await vi.waitFor(async () => expect((await getTask(taskOf(S.crash))).phase).toBe('NEED_ACTION'), { timeout: CHECK_MS + 8_000 })

    // A: the logout's SIGTERM reaches two CLIs first; the daemon reaps each and pushes its death.
    dead.add(S.snapErr)
    await applySnapshot(S.snapErr, snapshot(S.snapErr, { exitSignal: 'SIGTERM' }), 'daemon-push')
    runnerExitError(S.snapErr)
    dead.add(S.snapZero)
    await applySnapshot(S.snapZero, snapshot(S.snapZero, { exitCode: 0, exitSignal: 'SIGTERM' }), 'daemon-push')

    // B: the daemon went first; the machine hung for minutes with the link down.
    // The link drops a moment after the CLIs (the drill emits the runner's death at
    // once; a real one waits 5 awake minutes, over a hang that stretched it).
    localDownSince = Date.now() - 1_000
    dead.add(S.linkDown)
    await runnerLivenessDeath(S.linkDown)
    dead.add(S.health)
    const { SessionHealthMonitor } = await import('../../src/core/session-health-monitor.js')
    await new SessionHealthMonitor().check()

    // B': a respawned daemon reports the CLI dead on its reconnect pull (covered: control).
    dead.add(S.respawned)
    await applySnapshot(S.respawned, snapshot(S.respawned), 'reconnect-pull')
    await settle(3000)

    expect(sends).toEqual([])
    expect(handBacks).toEqual([{ sid: S.crash, trigger: expect.any(String), source: expect.any(String) }])
    expect(await phases()).toEqual({
      [S.snapErr]: 'IN_PROGRESS', [S.snapZero]: 'IN_PROGRESS', [S.linkDown]: 'IN_PROGRESS',
      [S.health]: 'IN_PROGRESS', [S.respawned]: 'IN_PROGRESS', [S.together]: 'IN_PROGRESS',
      [S.crash]: 'NEED_ACTION',
    })
    for (const sid of [S.snapErr, S.snapZero, S.linkDown, S.health, S.respawned]) {
      expect((await getSessionByClaudeId(sid))?.restartLoss, sid).toMatchObject({ phaseAtLoss: 'IN_PROGRESS' })
    }
    expect((await getSessionByClaudeId(S.crash))?.restartLoss).toMatchObject({ state: 'skipped' })
  }, 120_000)

  it('the next boot resumes every interrupted session and the crash stays handed back', async () => {
    // C: the server goes down with the rest; the last session's CLI dies with it.
    await stopServer()
    _resetSnapshotGateForTests()
    for (const sid of Object.values(S)) dead.add(sid)
    localDownSince = null
    bootAt = Date.now()
    setEnv('WALNUT_AUTO_RECOVER_DELAY_MS', '3000')
    handBacks.length = 0
    await startServer({ port: 0, dev: true })

    await vi.waitFor(() => expect(sends.map((s) => s.sessionId).sort()).toEqual([...INTERRUPTED].sort()), { timeout: 45_000 })
    for (const s of sends) {
      expect(s.source).toBe('auto-recover')
      expect(s.message).toBe(RESUME_MESSAGE)
      expect(s.notice).toContain('[Walnut restart recovery]')
    }
    for (const sid of INTERRUPTED) expect((await getTask(taskOf(sid))).phase, sid).toBe('IN_PROGRESS')
    expect((await getTask(taskOf(S.crash))).phase).toBe('NEED_ACTION')
    expect(handBacks.filter((h) => h.sid !== S.crash)).toEqual([])
  }, 120_000)
})
