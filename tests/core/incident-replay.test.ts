/**
 * Four-incident replay fixtures — each 2026-07-08/09 incident's stream-file tail
 * reproduced as a fold/reconcile input, asserting the fixed pipeline converges
 * to the correct verdict. These are the permanent regression fence: if any
 * guard/fold rule regresses, the exact production wedge shape fails here.
 *
 * Incidents (see memory idle_running_mismatch_two_incidents / the v3 plan):
 *   A 6c8428ac — daemon tailer offset froze (empty catch); UI idle, CLI running.
 *     Fold-side assertion: a tail with NO terminal evidence must not converge
 *     (the daemon-side self-heal is tested by the parity suite).
 *   B ed81e36d — server restart landed in the result window; record stuck
 *     'running' while the stream tail has result+idle. Must converge.
 *   C 10e7df54 — resultEmitted seeded from a guessed task phase swallowed the
 *     real replayed result; record settled 'idle' but task wedged IN_PROGRESS.
 *     Phase-debt reconcile must advance the phase without touching the record.
 *   D 07fffbe5 — REAL sanitized event sequence from the incident stream file:
 *     an is_backgrounded full-disk grep (b60h9ag3m) never got a terminal event;
 *     the CLI ended the turn (result turns=16 + idle). gatingBgCount must be 0
 *     and the verdict turnEnded.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { foldSessionTail, reconcileProcessStatus } from '../../src/core/session-reconcile.js'
import {
  createSessionRecord,
  updateSessionRecord,
  getSessionByClaudeId,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'incident-replays')
const CWD = '/Users/test/incident-replay'

function user(sid: string): string {
  return JSON.stringify({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'text', text: 'go' }] } })
}
function assistant(sid: string): string {
  return JSON.stringify({
    type: 'assistant', session_id: sid,
    message: { id: 'm1', role: 'assistant', model: 'mock', content: [{ type: 'text', text: 'working...' }] },
  })
}
function result(sid: string, turns: number): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, num_turns: turns,
    duration_ms: 1000, result: 'done', session_id: sid, total_cost_usd: 0.01,
  })
}
function idle(sid: string): string {
  return JSON.stringify({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' })
}

let streamsDir: string
let savedStreamsEnv: string | undefined
let tmpDir: string

async function writeStream(sid: string, content: string): Promise<void> {
  await fsp.mkdir(streamsDir, { recursive: true })
  await fsp.writeFile(path.join(streamsDir, `${sid}.jsonl`), content)
}

beforeEach(async () => {
  tmpDir = WALNUT_HOME
  savedStreamsEnv = process.env.WALNUT_STREAMS_DIR
  streamsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-incident-replay-'))
  process.env.WALNUT_STREAMS_DIR = streamsDir
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(tmpDir, { recursive: true, force: true })
  await fsp.mkdir(tmpDir, { recursive: true })
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
})

afterEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(tmpDir, { recursive: true, force: true })
  await fsp.rm(streamsDir, { recursive: true, force: true })
  if (savedStreamsEnv === undefined) delete process.env.WALNUT_STREAMS_DIR
  else process.env.WALNUT_STREAMS_DIR = savedStreamsEnv
})

describe('incident A (6c8428ac) — frozen tailer: mid-turn tail must NOT converge', () => {
  it('a tail whose turn is visibly mid-flight (no result after anchor) refuses convergence', async () => {
    const sid = 'incident-a'
    // The CLI was actively working when the tailer froze — the stream tail shows
    // a live turn: user → assistant output, NO result, NO idle. The reconcile
    // channel must refuse (R1: no positive terminal evidence), leaving liveness
    // to decide — never manufacture completion for a running turn.
    await writeStream(sid, [user(sid), assistant(sid), assistant(sid)].join('\n') + '\n')
    await createSessionRecord(sid, '', 'proj', CWD, { pid: process.pid })
    const record = await updateSessionRecord(sid, {
      process_status: 'running',
      last_status_change: new Date(Date.now() - 3600_000).toISOString(),
    })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome).toEqual({ converged: false, reason: 'turn-not-terminal' })
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
  })
})

describe('incident B (ed81e36d) — restart ate the result: stuck running must converge', () => {
  it('record wedged running + stream tail proves result(turns=14)+idle → converged', async () => {
    const sid = 'incident-b'
    // The incident shape: turn completed overnight (result turns=14 + idle in the
    // stream), but the server restarted exactly in the result window — the record
    // stayed 'running' for 8.3h with nothing to pull it back.
    await writeStream(sid, [user(sid), assistant(sid), result(sid, 14), idle(sid)].join('\n') + '\n')
    await createSessionRecord(sid, '', 'proj', CWD)
    const record = await updateSessionRecord(sid, {
      process_status: 'running',
      last_status_change: new Date(Date.now() - 8.3 * 3600_000).toISOString(),
    })

    const outcome = await reconcileProcessStatus(record, { isAlive: false })
    expect(outcome).toEqual({ converged: true, from: 'running', to: 'stopped' })
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('stopped')
    expect(after?.status_reason).toBe('reconciled_authoritative')
  })
})

describe('incident C (10e7df54) — swallowed result: task wedged IN_PROGRESS behind a settled record', () => {
  it('phase debt converges the task to AGENT_COMPLETE without touching the idle record', async () => {
    const { addTaskFull, getTask } = await import('../../src/core/task-manager.js')
    const task = await addTaskFull({
      title: 'incident-c task', type: 'task', status: 'in_progress', phase: 'IN_PROGRESS',
      project: 'proj', source: 'local', created_at: new Date().toISOString(),
    } as any)

    const sid = 'incident-c'
    // Terminal state after the wedge: stream has the real turn-3 result (turns=46)
    // + idle; the session record settled to idle (companion idle landed in the
    // "already completed" branch); but the result event itself was swallowed by
    // the resultEmitted guard so the task phase never advanced.
    await writeStream(sid, [user(sid), assistant(sid), result(sid, 46), idle(sid)].join('\n') + '\n')
    await createSessionRecord(sid, task.id, 'proj', CWD)
    const record = await updateSessionRecord(sid, {
      process_status: 'idle',
      last_status_change: new Date(Date.now() - 3600_000).toISOString(),
    })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome.converged).toBe(true)
    expect((outcome as { phaseSynced?: boolean }).phaseSynced).toBe(true)
    expect((await getTask(task.id)).phase).toBe('AGENT_COMPLETE')
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('idle') // untouched
  })
})

describe('incident D (07fffbe5) — REAL event sequence: backgrounded grep must not gate turn-over', () => {
  it('fold of the actual incident tail: gatingBgCount=0, turnEnded, b60h9ag3m visible-but-backgrounded', async () => {
    const content = await fsp.readFile(
      path.join(FIXTURE_DIR, 'incident-d-backgrounded-grep.jsonl'), 'utf-8')
    const fold = foldSessionTail(content)

    expect(fold.foundTurnAnchor).toBe(true)
    // The full-disk grep: started + is_backgrounded, NO terminal event — ever.
    expect(fold.bgTasks['b60h9ag3m']).toBeDefined()
    expect(fold.bgTasks['b60h9ag3m'].status).toBe('running')
    expect(fold.bgTasks['b60h9ag3m'].isBackgrounded).toBe(true)
    // The other four local_bash tasks all reached terminal.
    for (const tid of ['byb6d9nfo', 'bakbiny4m', 'bloiq0ggt', 'b4j6j9nbm']) {
      expect(fold.bgTasks[tid]?.status).toBe('completed')
    }
    // THE incident assertion: the CLI ended the turn (result turns=16 + idle),
    // and the backgrounded task must not gate — pre-fix, hasActiveBackgroundWork()
    // counted it and held the session "Running" for the grep's 16-min lifetime.
    expect(fold.gatingBgCount).toBe(0)
    expect(fold.lastResult?.numTurns).toBe(16)
    expect(fold.trailingIdle).toBe(true)
    expect(fold.turnEnded).toBe(true)
    expect(fold.workStatus).toBe('agent_complete')
  })

  it('end-to-end: a record wedged running on the incident tail converges to idle', async () => {
    const sid = 'incident-d'
    const content = await fsp.readFile(
      path.join(FIXTURE_DIR, 'incident-d-backgrounded-grep.jsonl'), 'utf-8')
    await writeStream(sid, content)
    await createSessionRecord(sid, '', 'proj', CWD, { pid: process.pid })
    const record = await updateSessionRecord(sid, {
      process_status: 'running',
      last_status_change: new Date(Date.now() - 738_000).toISOString(), // staleMs at capture
    })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome).toEqual({ converged: true, from: 'running', to: 'idle' })
  })
})
