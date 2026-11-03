/**
 * Only a real ask reaches Needs you, and an agent never takes a summary for the live ask
 * (2026-11-02, the user through Main). Main told the user two things waited on him that he had
 * answered in the task chats, because it read the tasks' `summary`; and two finished triage runs, a
 * finished Interview task and a Q&A answer sat in Needs you on Walnut's own sentences ("It
 * finished: read the result and close it", "Its turn ended ...").
 *
 * Guards for the class:
 *  - every input with nothing asked (no ask of its own, no letter, choice, prompt or failure) reads
 *    as something to read, never Needs you, in every phase, lead, session state, clock and trigger;
 *  - every Needs you the derive can return comes from a real ask, by the source scan below: a new
 *    one with Walnut's own sentence fails;
 *  - a routine run whose turn ended with nothing for the user closes itself, whichever path saw
 *    its end (triage/runs.ts keyed off one bus event the 13:38 run never sent);
 *  - every row of an agent's task read carries the live status, and a summary its time.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-only-real-asks'))

import { WALNUT_HOME } from '../../src/constants.js'
import {
  agentStatusView, deriveUserStatus, RESULT_TO_READ, TURN_TO_READ,
  type StatusReport, type UserStatusInput,
} from '../../src/core/user-status.js'
import { routineRunToClose } from '../../src/core/routines/run-close.js'
import { syncUserStatuses, stopUserStatusSync, HANDBACK_SETTLE_MS } from '../../src/core/user-status-sync.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { BULK_GET_FIELDS, bulkGetFromTasks } from '../../src/core/task-bulk-get.js'
import { leanTaskRow } from '../../src/ops/tasks.js'
import { taskView } from '../../src/ops/task-execution.js'
import { startTriageRuns } from '../../src/core/triage/runs.js'
import { TRIAGE_PROJECT } from '../../src/core/triage/bootstrap.js'
import { TRIAGE_AGENT_ID } from '../../src/core/triage/types.js'
import type { Task } from '../../src/core/types.js'

const NOW = Date.parse('2026-11-02T05:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const at = iso(NOW - 60_000)

// Reports that ask the user nothing: none, finished, working, a needs-you with no ask, an ask with
// no kind of the user's own, and turns that answered the user's message.
const NO_ASK: (StatusReport | null)[] = [
  null,
  { state: 'done', at, now: 'Shipped the seed planner.' },
  { state: 'working', at },
  { state: 'needs', at },
  { state: 'waiting', at, waiting_kind: 'lead', waiting_on: 'Pick the watering time?', kindless_ask: true },
  { state: 'waiting', at, waiting_kind: 'outside', waiting_on: 'The nursery reply', answered_person: true },
  { state: 'needs', at, answered_person: true },
  { state: 'waiting', at, answered_person: true },
]

function* noAskInputs(): Generator<UserStatusInput> {
  for (const phase of ['NEED_ACTION', 'WAITING', 'IN_PROGRESS', 'TODO']) {
    for (const report of NO_ASK) {
      for (const hasLeader of [false, true]) {
        for (const processStatus of ['idle', 'stopped']) {
          for (const lastWords of [null, 'The seed order is in.']) {
            for (const triggers of [[], ['Nursery mail watch']]) {
              for (const waitUntil of [null, iso(NOW + 3_600_000)]) {
                yield { phase, report, hasLeader, processStatus, lastWords, triggers, waitUntil, hasSession: true, phaseChangedAt: iso(NOW - 120_000) }
              }
            }
          }
        }
      }
    }
  }
}

describe('nothing asked is never Needs you', () => {
  it('in any phase, lead, session state, clock, trigger or last words', () => {
    let n = 0
    for (const input of noAskInputs()) {
      const s = deriveUserStatus(input, NOW)
      expect(s.state, JSON.stringify({ input, s })).not.toBe('needs')
      n++
    }
    expect(n).toBeGreaterThan(1000)
  })

  it('reads what there is to read, in plain words', () => {
    const base = { phase: 'NEED_ACTION', hasSession: true, processStatus: 'stopped', phaseChangedAt: iso(NOW - 120_000) }
    expect(deriveUserStatus({ ...base, report: NO_ASK[1] }, NOW)).toMatchObject({ state: 'read', toRead: 'result', waitingOn: RESULT_TO_READ, now: 'Shipped the seed planner.' })
    expect(deriveUserStatus({ ...base, report: NO_ASK[4] }, NOW)).toMatchObject({ toRead: 'result' })
    expect(deriveUserStatus({ ...base, report: NO_ASK[6] }, NOW)).toMatchObject({ toRead: 'answer' })
    expect(deriveUserStatus({ ...base, lastWords: 'The seed order is in.' }, NOW)).toMatchObject({ toRead: 'turn', waitingOn: `${TURN_TO_READ}; its last words: "The seed order is in."` })
  })

  it('a real ask still is: its own ask, a wait on the user, a letter, a choice, a prompt, a failure', () => {
    const base = { phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', phaseChangedAt: iso(NOW - 120_000) }
    const asks: Partial<UserStatusInput>[] = [
      { report: { state: 'needs', at, ask: 'Plant roses on Friday or Sunday?' } },
      { report: { state: 'waiting', at, waiting_kind: 'you', waiting_on: 'Your call on the fence colour' } },
      { openLetter: 'Approve the seed order' },
      { openChoice: 'Which bed?' },
      { phase: 'IN_PROGRESS', pendingPermissionTool: 'Bash' },
      { processStatus: 'error', errorMessage: 'The CLI exited' },
      { hasSession: false },
      { report: { state: 'done', at }, owedHold: { ask: 'Left for you when this task was closed: 1) You: resubmit the form', at } },
    ]
    for (const a of asks) expect(deriveUserStatus({ ...base, ...a }, NOW).state, JSON.stringify(a)).toBe('needs')
  })
})

describe('guard: every Needs you the derive returns is a real ask', () => {
  // Each `state: 'needs'` site in user-status.ts, by what gives its ask.
  const REAL = [
    /source: 'prompt'/, /source: 'letter'/, /source: 'choice'/, /source: 'error'/,
    /ask: clean\(report\.ask\)/, /ask: clean\(report!\.waiting_on\)/, /ask: reported\b/, /ask: MARKED_ASK/,
    /heading: 'Needs you'/,
    // What a session's close left for the user (sessions/owed-to-user.ts).
    /ask: heldAsk\b/,
  ]
  it('no other site', async () => {
    const src = await fs.readFile(path.join(__dirname, '../../src/core/user-status.ts'), 'utf8')
    const sites = src.split('\n').map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /state: 'needs'/.test(l) && !REAL.some((re) => re.test(l)))
      .map(([n, l]) => `${n}: ${l.trim().slice(0, 140)}`)
    expect(sites, 'A Needs you with no real ask behind it: read it as something to read (toRead), or name its real source here').toEqual([])
  })
})

describe('a routine run that ended with nothing for the user closes itself', () => {
  const run = { routine_start: { job_id: 'job-1', job_name: 'Garden digest', run_at: at, attempt: 1 as const, attempt_at: at, state: 'started' as const }, phase: 'NEED_ACTION' }
  it('the rule', () => {
    expect(routineRunToClose(run, { state: 'waiting', toRead: 'result' })).toBe(true)
    // A turn with no report closes only a triage run (its asks are letters); another may have asked in prose.
    expect(routineRunToClose(run, { state: 'waiting', toRead: 'turn' }, true)).toBe(true)
    expect(routineRunToClose(run, { state: 'waiting', toRead: 'turn' })).toBe(false)
    // A person took the conversation over, or it asks something: it stays.
    expect(routineRunToClose(run, { state: 'waiting', toRead: 'answer' })).toBe(false)
    expect(routineRunToClose(run, { state: 'needs' })).toBe(false)
    expect(routineRunToClose(run, { state: 'working' })).toBe(false)
    // Not a run, a run still starting, one under a leader, a parked one.
    expect(routineRunToClose({ ...run, routine_start: undefined }, { state: 'waiting', toRead: 'result' })).toBe(false)
    expect(routineRunToClose({ ...run, routine_start: { ...run.routine_start, state: 'starting' } }, { state: 'waiting', toRead: 'result' })).toBe(false)
    expect(routineRunToClose({ ...run, parent_task_id: 'p' }, { state: 'waiting', toRead: 'result' })).toBe(false)
    expect(routineRunToClose({ ...run, phase: 'WAITING' }, { state: 'waiting', toRead: 'result' })).toBe(false)
  })

  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    stopUserStatusSync()
  })
  afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {}) })

  /** A run task whose session's turn ended, with this report (or none). */
  async function endedRun(title: string, sid: string, report: StatusReport | null, extra: Partial<Task> = {}, project = 'Routines'): Promise<string> {
    const id = (await addTask({ title, project })).task.id
    await createSessionRecord(sid, id, project, WALNUT_HOME)
    await updateSessionRecord(sid, { process_status: 'stopped' } as never)
    const ended = iso(Date.now() - 5 * 60_000)
    await updateTaskRaw(id, { session_id: sid, phase: 'NEED_ACTION' } as never, { source: 'test' })
    // The phase write stamps its own time; the turn ended five minutes ago, its report after that.
    await updateTaskRaw(id, {
      phase_changed_at: ended,
      routine_start: { ...run.routine_start, run_at: ended, attempt_at: ended },
      ...(report ? { status_report: { ...report, at: iso(Date.now() - 60_000) } } : {}),
      ...extra,
    } as never, { source: 'test' })
    return id
  }

  it('a finished run completes; a run handed back with no report stays to be read, unless it is a triage run', async () => {
    const done = await endedRun('Garden digest · 13:38', '11111111-2222-4333-8444-555555555555', { state: 'done', at })
    const bare = await endedRun('Garden digest · 16:38', '21111111-2222-4333-8444-555555555555', null)
    await syncUserStatuses(new Set([done, bare]), Date.now() + HANDBACK_SETTLE_MS + 1_000)
    expect((await getTask(done)).phase).toBe('COMPLETE')
    expect((await getTask(bare)).phase).toBe('NEED_ACTION')
    expect((await getTask(bare)).user_status).toMatchObject({ state: 'read', toRead: 'turn' })
  })

  it('a run that asks, or answered a person, stays open', async () => {
    const asks = await endedRun('Garden digest · 17:38', '31111111-2222-4333-8444-555555555555', { state: 'needs', at, ask: 'Order the tulip bulbs?' })
    const answered = await endedRun('Garden digest · 18:38', '41111111-2222-4333-8444-555555555555', { state: 'needs', at, answered_person: true })
    await syncUserStatuses(new Set([asks, answered]), Date.now() + HANDBACK_SETTLE_MS + 1_000)
    expect((await getTask(asks)).phase).toBe('NEED_ACTION')
    expect((await getTask(asks)).user_status).toMatchObject({ state: 'needs', ask: 'Order the tulip bulbs?' })
    expect((await getTask(answered)).phase).toBe('NEED_ACTION')
  })

  it('a triage run handed back with no report (seen only by a snapshot) closes through its own bookkeeping, so its journal line is written', async () => {
    const journal = vi.fn(async () => 'Walnut/Triage/Runs.md')
    const handle = startTriageRuns({ appendJournal: journal, recordOutcome: async () => {}, withdrawSuperseded: async () => ({ withdrawn: [], kept: 0, failed: 0 }), home: WALNUT_HOME })
    try {
      const id = await endedRun('Triage · 13:38 · 1 items', '51111111-2222-4333-8444-555555555555', null, { agent_id: TRIAGE_AGENT_ID } as never, TRIAGE_PROJECT)
      await syncUserStatuses(new Set([id]), Date.now() + HANDBACK_SETTLE_MS + 1_000)
      expect((await getTask(id)).phase).toBe('COMPLETE')
      expect(journal).toHaveBeenCalledTimes(1)
      expect(handle.stats().settled).toBe(1)
    } finally {
      handle.stop()
    }
  })

  it('an ordinary task with the same status is never closed', async () => {
    const id = (await addTask({ title: 'Interview practice', project: 'Garden' })).task.id
    await updateTask(id, { phase: 'NEED_ACTION' })
    await updateTaskRaw(id, { status_report: { state: 'done', at: iso(Date.now() + 1_000) } } as never, { source: 'test' })
    await syncUserStatuses(new Set([id]))
    expect((await getTask(id)).phase).toBe('NEED_ACTION')
    expect((await getTask(id)).user_status).toMatchObject({ state: 'read', toRead: 'result' })
  })
})

describe('every agent task read carries the live status, and a summary its time', () => {
  const task = {
    id: 'garden-1', title: 'Garden planner', phase: 'NEED_ACTION', status: 'in_progress', project: 'Garden',
    summary: 'Waiting on the user to open the nursery port.', note: '', description: '', priority: 'none',
    created_at: iso(NOW - 9 * 86_400_000), updated_at: at, tags: [], depends_on: [],
    field_at: { summary: iso(NOW - 3 * 86_400_000) },
    user_status: { state: 'waiting', kind: 'other', toRead: 'result', waitingOn: RESULT_TO_READ, now: 'Port opened.', at, line: { text: 'x' } },
  } as unknown as Task

  it('the view: what it asks now and since when, and Done for a completed task', () => {
    expect(agentStatusView(task)).toEqual({ state: 'waiting', kind: 'other', toRead: 'result', waitingOn: RESULT_TO_READ, now: 'Port opened.', at })
    expect(agentStatusView({ ...task, phase: 'COMPLETE' })).toEqual({ state: 'done' })
    expect(agentStatusView({ phase: 'NEED_ACTION' })).toEqual({ state: 'needs' })
  })

  it('task_get_bulk: on every row whatever fields are named, the summary with its summary_at', () => {
    const sets: (readonly string[] | undefined)[] = [undefined, ['title'], ['summary'], ['phase', 'summary'], ...BULK_GET_FIELDS.filter((f) => f !== 'user_status').map((f) => [f])]
    for (const fields of sets) {
      const [row] = bulkGetFromTasks([task.id], [task], fields as string[] | undefined).items
      expect(row.user_status, JSON.stringify(fields)).toEqual(agentStatusView(task))
      if (row.summary) expect(row.summary_at, JSON.stringify(fields)).toBe(iso(NOW - 3 * 86_400_000))
    }
    // Naming user_status gives the whole stored status.
    expect(bulkGetFromTasks([task.id], [task], ['user_status']).items[0].user_status).toEqual(task.user_status)
  })

  it('task_list rows and task_get', () => {
    expect((leanTaskRow(task) as Record<string, unknown>).user_status).toEqual(agentStatusView(task))
    expect((leanTaskRow(task) as Record<string, unknown>).user_state).toBe('waiting')
    expect(taskView(task as never).summary_at).toBe(iso(NOW - 3 * 86_400_000))
  })
})
