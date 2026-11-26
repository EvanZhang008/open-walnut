/**
 * An effort picked while the session's CLI is still spawning is the session's
 * effort once the spawn lands (holdEffortForSpawn / adoptEffortHeldForSpawn in
 * src/providers/claude-code-session.ts).
 *
 * The bug (CI 2026-10-02): the session panel takes a pick the moment the id is
 * minted, before any CLI exists. applySessionEffortChange persisted it, found no
 * live session to tell, and the spawning instance's first record write put the
 * launch effort back: an Ask Walnut session set to low read medium a moment
 * later, and its CLI ran the launch effort for its whole life.
 *
 * What's real: ClaudeCodeSession.send(), applySessionEffortChange, SQLite
 * persistence. What's mocked: the transport (the test controls when the spawn
 * lands and captures what is written to the CLI), the cwd pre-flight and the
 * launch-mode read (it reads this machine's Claude settings through the daemon).
 *
 * The spawn's arrival is awaited as the event it is (spawnStarted), never on a
 * clock: the pre-spawn steps import modules cold, and on a loaded runner they
 * outlast vi.waitFor's 1 s default (2026-11-25: 5.5 s here, the mode read alone
 * timing out at its own 4 s, so both tests failed on clean main).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-effort-spawn'))

const writes: string[] = []
let releaseStart: (() => void) | null = null
/** Resolved by the transport's start: the spawn reached the CLI's door. */
let spawnStarted: Promise<void>
let markStarted: () => void
function armStart(): void {
  spawnStarted = new Promise<void>((resolve) => { markStarted = resolve })
}

vi.mock('../../src/providers/session-manager.js', () => ({
  createSessionManager: () => ({
    start: async () => {
      markStarted()
      await new Promise<void>((resolve) => { releaseStart = resolve })
      return { pid: 4343, outputFile: '/tmp/effort-spawn.jsonl', fileSize: 0 }
    },
    writeMessage: async (_message: string, opts?: { onDispatch?: () => void }) => { opts?.onDispatch?.(); return true },
    writeRaw: async (json: string) => { writes.push(json); return true },
    writeSyntheticUserEvent: () => {},
    renameForSession: () => {},
    deletePipe: () => {},
    detach: () => {},
    stop: async () => {},
    kill: () => {},
    flushTail: () => {},
    stopTail: () => {},
    hasPipe: true,
    fileSize: 0,
    pid: 4343,
    outputFile: '/tmp/effort-spawn.jsonl',
  }),
  registerSessionManager: () => {},
  unregisterSessionManager: () => {},
  getRegisteredSessionManager: () => null,
}))

vi.mock('../../src/utils/cwd-check.js', () => ({
  checkCwdExists: async () => ({ ok: true }),
}))

vi.mock('../../src/providers/claude-launch-mode.js', () => ({
  resolveClaudeLaunchMode: async () => ({ mode: 'default', source: 'engine' }),
}))

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { applySessionEffortChange } from '../../src/core/sessions/session-controls.js'
import * as tracker from '../../src/core/session-tracker.js'
// What the spawn's scope step imports lazily (applySpawnClaudeScope), loaded with the test file:
// imported cold inside the first spawn they took 6.5 s of a 15 s test on a loaded runner.
import '../../src/core/task-manager.js'
import '../../src/core/config-manager.js'
import '../../src/core/sessions/claude-plugins-off.js'
import '../../src/providers/claude-scope-settings.js'

/** The effort levels this CLI was told over the control channel. */
function flagEfforts(): unknown[] {
  return writes
    .map((w) => JSON.parse(w) as { request?: { subtype?: string; settings?: { effortLevel?: unknown } } })
    .filter((m) => m.request?.subtype === 'apply_flag_settings')
    .map((m) => m.request!.settings!.effortLevel)
}

/** Start a fresh session on `sid` with the launch effort; the spawn stays in flight. */
async function launch(sid: string, effort: 'medium' | 'low'): Promise<ClaudeCodeSession> {
  await tracker.createSessionRecord(sid, `task-${sid}`, 'Proj', undefined, {
    initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn', cliModel: 'opus', effort,
  } as never)
  const session = new ClaudeCodeSession(`task-${sid}`, 'Proj', 'claude')
  session.send(
    'first turn', '/tmp', undefined, undefined, 'opus', undefined,
    undefined, undefined, undefined, false, undefined, undefined, effort,
    undefined, { preassignedSessionId: sid },
  )
  await spawnStarted
  return session
}

beforeEach(() => {
  writes.length = 0
  releaseStart = null
  armStart()
})

describe('an effort picked while the CLI is spawning', () => {
  it('survives the spawn landing and reaches the CLI', async () => {
    const sid = '21111111-2222-4333-8444-555555555555'
    const session = await launch(sid, 'medium')
    const res = await applySessionEffortChange(sid, 'low')
    expect(res).toMatchObject({ effort: 'low', appliedLive: false })
    expect((await tracker.getSessionByClaudeId(sid))?.effort).toBe('low')

    releaseStart!()
    await session.sessionReady
    // The spawn's own record write carries the pick, not the launch effort.
    await vi.waitFor(async () => expect((await tracker.getSessionByClaudeId(sid))?.pid).toBe(4343))
    expect((await tracker.getSessionByClaudeId(sid))?.effort).toBe('low')
    // The CLI was spawned with --effort medium, so it is told.
    await vi.waitFor(() => expect(flagEfforts()).toEqual(['low']))
    session.detach()
  })

  it('tells the CLI nothing when there was no pick, or the pick was the launch effort', async () => {
    const quiet = '31111111-2222-4333-8444-555555555555'
    let session = await launch(quiet, 'medium')
    releaseStart!()
    await session.sessionReady
    await new Promise((r) => setTimeout(r, 50))
    expect(flagEfforts()).toEqual([])
    expect((await tracker.getSessionByClaudeId(quiet))?.effort).toBe('medium')
    session.detach()

    armStart()
    const same = '41111111-2222-4333-8444-555555555555'
    session = await launch(same, 'low')
    await applySessionEffortChange(same, 'low')
    releaseStart!()
    await session.sessionReady
    await new Promise((r) => setTimeout(r, 50))
    expect(flagEfforts()).toEqual([])
    expect((await tracker.getSessionByClaudeId(same))?.effort).toBe('low')
    session.detach()
  })
})
