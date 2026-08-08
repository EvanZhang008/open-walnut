/**
 * Wiring test for SessionHealthMonitor.reconcileStuckRunningSessions() — proves
 * the 30s tick actually drives reconcileProcessStatus end-to-end:
 *
 *   stuck 'running' record + daemon STREAM file with result+idle on disk
 *     → monitor.check()
 *     → record converged (idle/stopped) with status_reason='reconciled_authoritative'
 *     → session:status-changed delivered on the real bus
 *
 * FIXTURE NOTE: the evidence source is the daemon stream file
 * (WALNUT_STREAMS_DIR/<sid>.jsonl) — NOT the canonical ~/.claude/projects JSONL,
 * which contains zero result/session_state events on real data.
 *
 * Distinct from tests/core/session-reconcile.test.ts (unit tests of the pure
 * function): this exercises the MONITOR path — the activity gate, the pass-through
 * into the reconcile call, and the negative case (fresh stream activity = skip).
 * If reconcileStuckRunningSessions is reverted, the convergence assertions fail
 * (the monitor's per-session loop sees alive=true and leaves 'running' alone).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

// No registered session manager → the monitor's lastEventAt activity gate is
// skipped and liveness falls through to the local PID check.
vi.mock('../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}))
vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  probeDaemonSession: async () => null,
}))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ session: {} }),
}))
// Task manager: enough surface for the monitor's phase lookups + the reconcile
// module's phase sync (no task linked in these tests → getTask never resolves one).
vi.mock('../../src/core/task-manager.js', () => ({
  clearSessionSlot: async (taskId: string, sessionId: string) => ({
    task: { id: taskId, session_id: sessionId, title: 'mock task' },
  }),
  listTasks: async () => [],
  getTask: async () => { throw new Error('no task') },
}))

import {
  createSessionRecord,
  updateSessionRecord,
  getSessionByClaudeId,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { SessionHealthMonitor } from '../../src/core/session-health-monitor.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import type { BusEvent } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR, TASKS_FILE } from '../../src/constants.js'

const CWD = '/Users/test/hm-reconcile-project'

function jsonlTurnComplete(sid: string): string[] {
  return [
    JSON.stringify({
      type: 'system', subtype: 'init', session_id: sid,
      cwd: CWD, model: 'mock-model', tools: [], mcp_servers: [], permissionMode: 'default',
    }),
    JSON.stringify({
      type: 'user', session_id: sid,
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    }),
    JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      duration_ms: 1000, num_turns: 1, result: 'Done', session_id: sid, total_cost_usd: 0.01,
    }),
    JSON.stringify({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' }),
  ]
}

let streamsDir: string
let savedStreamsEnv: string | undefined

/** Write the DAEMON STREAM fixture — the file reconcile actually reads.
 *  Aged by default: a genuinely STUCK session's stream stopped long ago (the
 *  result line was the last write). Since the directory-split fix,
 *  isLocalJsonlFresh sees this same file, so a fresh mtime correctly trips the
 *  activity gate ("events just flowed — skip the reconcile read this tick"). */
async function writeStreamFile(sid: string, lines: string[], ageMs = 10 * 60 * 1000): Promise<void> {
  await fsp.mkdir(streamsDir, { recursive: true })
  const p = path.join(streamsDir, `${sid}.jsonl`)
  await fsp.writeFile(p, lines.join('\n') + '\n')
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000
    await fsp.utimes(p, t, t)
  }
}

/** Stuck-'running' record: alive PID (this process) so the orphan dead-pool
 *  drain doesn't claim it, old last_status_change so the minAge gate passes. */
async function stuckRunning(sid: string) {
  await createSessionRecord(sid, '', 'proj', CWD, { pid: process.pid })
  return updateSessionRecord(sid, {
    process_status: 'running',
    last_status_change: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  })
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = WALNUT_HOME
  savedStreamsEnv = process.env.WALNUT_STREAMS_DIR
  streamsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-hm-reconcile-streams-'))
  process.env.WALNUT_STREAMS_DIR = streamsDir
  closeDb()
  _resetSessionTrackerForTesting()
  bus.clear()
  await fsp.rm(tmpDir, { recursive: true, force: true })
  await fsp.mkdir(tmpDir, { recursive: true })
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
})

afterEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  bus.clear()
  await fsp.rm(tmpDir, { recursive: true, force: true })
  await fsp.rm(streamsDir, { recursive: true, force: true })
  if (savedStreamsEnv === undefined) delete process.env.WALNUT_STREAMS_DIR
  else process.env.WALNUT_STREAMS_DIR = savedStreamsEnv
})

describe('health monitor → reconcileStuckRunningSessions wiring', () => {
  it('converges a stuck running record whose stream file proves the turn ended', async () => {
    const sid = 'hm-stuck-running'
    await writeStreamFile(sid, jsonlTurnComplete(sid))
    await stuckRunning(sid)

    const events: BusEvent[] = []
    bus.subscribe('hm-test-listener', (e) => {
      if (e.name === EventNames.SESSION_STATUS_CHANGED) events.push(e)
    })

    const monitor = new SessionHealthMonitor()
    await monitor.check()

    const after = await getSessionByClaudeId(sid)
    // PID (this test process) is alive → converge to 'idle', the between-turns state.
    expect(after?.process_status).toBe('idle')
    expect(after?.status_reason).toBe('reconciled_authoritative')
    expect(after?.status_changed_by).toBe('reconciler')

    const converged = events.filter(e =>
      (e.data as { sessionId?: string }).sessionId === sid
      && (e.data as { process_status?: string }).process_status === 'idle')
    expect(converged.length).toBe(1)
  })

  it('does NOT touch a running session with fresh stream activity (activity gate)', async () => {
    const sid = 'hm-fresh-activity'
    // Fresh mtime on the DAEMON stream file (the dir local sessions actually
    // write — directory-split fix) = the session is visibly producing output
    // right now, even though the file content happens to end in a result.
    await writeStreamFile(sid, jsonlTurnComplete(sid), 0)
    await stuckRunning(sid)

    const monitor = new SessionHealthMonitor()
    await monitor.check()

    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
  })

  it('activity gate also honors a fresh LEGACY streams-capture file (old writers)', async () => {
    const sid = 'hm-fresh-legacy'
    await writeStreamFile(sid, jsonlTurnComplete(sid)) // aged daemon file
    await stuckRunning(sid)
    await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
    await fsp.writeFile(path.join(SESSION_STREAMS_DIR, `${sid}.jsonl`), '{"type":"assistant"}\n')

    const monitor = new SessionHealthMonitor()
    await monitor.check()

    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
  })

  it('does NOT converge when the stream shows the turn still in progress', async () => {
    const sid = 'hm-live-turn'
    const lines = jsonlTurnComplete(sid)
    // Trailing user message = resumed turn → the fold re-anchors and finds no result.
    lines.push(JSON.stringify({
      type: 'user', session_id: sid,
      message: { role: 'user', content: [{ type: 'text', text: 'follow-up' }] },
    }))
    await writeStreamFile(sid, lines)
    await stuckRunning(sid)

    const monitor = new SessionHealthMonitor()
    await monitor.check()

    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
  })

  it('second tick within the retry window skips the tail re-read (backoff)', async () => {
    const sid = 'hm-backoff'
    // No stream file at all → first attempt returns no-stream-file and records the attempt ts.
    await stuckRunning(sid)

    const monitor = new SessionHealthMonitor()
    await monitor.check()
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')

    // NOW the stream file appears — but the 5min backoff must suppress the re-read.
    await writeStreamFile(sid, jsonlTurnComplete(sid))
    await monitor.check()
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
  })
})
