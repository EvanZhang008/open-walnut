/**
 * A turn that answered a message the user sent never parks its task (2026-10-31, the user: "wait
 * should be wait external ... the human replied, I have not even read it, and it is put into
 * wait"; incident: a walkthrough he had asked for went to WAITING 10 s after it ended, because the
 * task also waited on a CR approval). The answer is his to read first: the task stays on his list
 * (NEED_ACTION) until he writes again or a later turn of its own (a trigger's fire, a peer) parks it.
 * Its status reads the answer as something to read, never as Needs you (2026-11-02, the user through
 * Main: "only a real ask reaches Needs you"; a Q&A session whose answer was complete sat there).
 *
 * Guard for the class: every path that lands WAITING after a turn is listed in
 * tests/core/park-gate-ratchet.test.ts with how it keeps this rule; here, each gate's behaviour on
 * real data: the turn's report (report-phase.ts) and the status the user reads (user-status.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-answered-turn'))

import { WALNUT_HOME } from '../../src/constants.js'
import { phaseForReport, turnAnsweredPerson } from '../../src/core/sessions/report-phase.js'
import { ANSWER_TO_READ, deriveUserStatus, type StatusReport, type WaitKind } from '../../src/core/user-status.js'
import { applyStatusAnswer } from '../../src/core/sessions/status-question.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'

const T = Date.parse('2026-10-31T21:47:10Z')
const iso = (ms: number) => new Date(ms).toISOString()
const KINDS: (WaitKind | undefined)[] = ['outside', 'task', 'lead', 'machine', 'other', undefined]

describe('which turn answered a person', () => {
  it('a message after the previous report\'s turn and before this turn\'s end', () => {
    const prev = { at: iso(T - 50 * 60_000), turn_ended_at: iso(T - 60 * 60_000) }
    expect(turnAnsweredPerson(iso(T - 5 * 60_000), T, prev)).toBe(true)
    // Before the previous turn ended: that turn's, not this one's.
    expect(turnAnsweredPerson(iso(T - 2 * 60 * 60_000), T, prev)).toBe(false)
    // After this turn ended: the next turn's.
    expect(turnAnsweredPerson(iso(T + 60_000), T, prev)).toBe(false)
    expect(turnAnsweredPerson(undefined, T, prev)).toBe(false)
    // No previous report: unknown reads as answered, so the task stays on the user's list.
    expect(turnAnsweredPerson(iso(T - 3 * 24 * 60 * 60_000), T, null)).toBe(true)
    // Asked again for the same turn (the reconcile loop): what the first ask found.
    expect(turnAnsweredPerson(iso(T - 60_000), T, { at: iso(T + 5_000), turn_ended_at: iso(T), answered_person: true })).toBe(true)
    expect(turnAnsweredPerson(iso(T - 60_000), T, { at: iso(T + 5_000), turn_ended_at: iso(T) })).toBe(false)
    // A lead's task_report_set covers no turn: it is no boundary (2026-10-31 review).
    expect(turnAnsweredPerson(iso(T - 5 * 60_000), T, { at: iso(T - 60_000) })).toBe(true)
  })
})

describe('its report never parks it', () => {
  it('every waiting kind, armed or not, for a top-level task and a worker', () => {
    for (const task of [{}, { parent_task_id: 'lead' }]) {
      for (const kind of KINDS) {
        for (const armed of [true, false, 'unknown'] as const) {
          const r = { state: 'waiting' as const, waiting_kind: kind, waiting_on: 'A colleague\'s CR approval' }
          expect(phaseForReport({ ...r, answered_person: true }, task, true, armed), `${kind} ${armed}`).toBe('NEED_ACTION')
          // The same report from a turn nobody wrote into parks as before.
          if (kind === 'outside' || armed !== false) expect(phaseForReport(r, task, true, armed), `${kind} ${armed}`).toBe('WAITING')
        }
      }
    }
  })

  it('reads its answer to read first, even with a trigger armed, never Needs you', () => {
    const report: StatusReport = { state: 'waiting', waiting_kind: 'outside', waiting_on: 'A colleague\'s CR approval', at: iso(T + 10_000), answered_person: true }
    const input = { phase: 'NEED_ACTION' as const, phaseChangedAt: iso(T), hasSession: true, processStatus: 'idle' as const, report, triggers: ['CR approval watch'] }
    expect(deriveUserStatus(input, T + 20_000)).toMatchObject({ state: 'read', toRead: 'answer', waitingOn: `${ANSWER_TO_READ}; then it waits on: A colleague's CR approval` })
    // No trigger, no lead: the same, never the bare "its turn ended" line.
    expect(deriveUserStatus({ ...input, triggers: [] }, T + 20_000)).toMatchObject({ state: 'read', toRead: 'answer' })
    // An answer whose report said needs-you with no ask (a Q&A answer, 2026-11-02) reads the same.
    expect(deriveUserStatus({ ...input, report: { state: 'needs', at: iso(T + 10_000), answered_person: true } }, T + 20_000))
      .toMatchObject({ state: 'read', toRead: 'answer', waitingOn: ANSWER_TO_READ })
    // A turn nobody wrote into: the watch.
    expect(deriveUserStatus({ ...input, report: { ...report, answered_person: undefined } }, T + 20_000)).toMatchObject({ state: 'waiting' })
    // Main and a lead are never Needs you.
    expect(deriveUserStatus({ ...input, isLead: true }, T + 20_000).state).not.toBe('needs')
  })
})

describe('on a real task', () => {
  const SID = '0b1c2d3e-4f50-4617-8899-aabbccddeeff'
  let id = ''
  beforeAll(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    id = (await addTask({ title: 'Walk the user through the test', project: 'Garden' })).task.id
    await createSessionRecord(SID, id, 'Garden', WALNUT_HOME)
  })
  afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })

  const handBack = async (endedAt: number) => {
    await updateTaskRaw(id, { phase: 'NEED_ACTION', phase_changed_at: iso(endedAt) }, { source: 'test' })
    await updateSessionRecord(SID, { process_status: 'idle' })
  }
  const waitingOnCr = { state: 'waiting' as const, waiting_kind: 'outside' as const, waiting_on: 'A colleague\'s CR approval', at: '' }

  it('the user\'s turn stays Needs you; a later turn nobody wrote into parks', async () => {
    const userTurnEnd = Date.now() - 60_000
    await updateSessionRecord(SID, { humanInputAt: iso(userTurnEnd - 30_000), process_status: 'running' })
    await updateTaskRaw(id, { phase: 'IN_PROGRESS' }, { source: 'test' })
    await handBack(userTurnEnd)
    expect(await applyStatusAnswer(id, SID, { ...waitingOnCr, at: iso(userTurnEnd + 10_000) }, userTurnEnd)).toBe(true)
    let t = await getTask(id)
    expect(t.phase).toBe('NEED_ACTION')
    expect(t.status_report?.answered_person).toBe(true)


    // A trigger's fire turn: no message from him since.
    const fireEnd = Date.now()
    await handBack(fireEnd)
    expect(await applyStatusAnswer(id, SID, { ...waitingOnCr, at: iso(fireEnd + 5_000) }, fireEnd)).toBe(true)
    t = await getTask(id)
    expect(t.status_report?.answered_person).toBeUndefined()
    expect(t.phase).toBe('WAITING')
  })
})

// A turn's report is stored in one place, which records whether it answered a person; a new writer
// of task.status_report either stamps it too or says why it is no turn's report.
describe('guard: every writer of a task report', () => {
  const WRITERS: Record<string, string> = {
    'src/core/sessions/status-question.ts': 'the turn\'s own report (native side question and summary): stamps answered_person',
    'src/core/sessions/report-set.ts': 'a person\'s or a lead\'s deliberate change (task_report_set), no turn\'s report',
    'src/core/router/processing.ts': 'a receiving task\'s own saved findings, built with report-set\'s reportOfChange, no turn\'s report',
  }
  it('no other file writes status_report', async () => {
    const path = await import('node:path')
    const root = path.resolve(__dirname, '../..')
    const walk = async (dir: string, out: string[] = []): Promise<string[]> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) await walk(p, out)
        else if (/\.tsx?$/.test(e.name)) out.push(p)
      }
      return out
    }
    const found: string[] = []
    for (const f of await walk(path.join(root, 'src'))) {
      const code = (await fs.readFile(f, 'utf8')).split('\n').filter((l) => !/^\s*(?:\*|\/\/|\/\*)/.test(l)).join('\n')
      if (/\bstatus_report:\s/.test(code)) found.push(path.relative(root, f))
    }
    const unlisted = found.filter((f) => !WRITERS[f])
    expect(unlisted, `A new writer of task.status_report: stamp answered_person (sessions/report-phase.ts turnAnsweredPerson) or list it with why: ${unlisted.join(', ')}`).toEqual([])
  })
})
