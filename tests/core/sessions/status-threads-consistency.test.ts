/**
 * The task's status agrees with its thread lines (src/core/sessions/status-threads.ts; 2026-11-20,
 * the user: "ask it also the actual status of this, if there are multiple thread please ask for
 * multiple thread, then set the status correctly. like in this case, it is basically a waiting
 * status right"). The case: a task watching a rollout answered FOR_USER_STATE needs-you with no
 * FOR_USER_ASK and read "It answered your question" while all that was left was the rollout outside.
 *
 * The class: every combination of up to three thread lines (working, waiting, answered, done),
 * crossed with every FOR_USER_STATE the session can say and with or without a real ask, read the
 * way Walnut reads an answer (readStatusReport, readThreadLines, settleStateFromThreads), moved to
 * the phase it implies (phaseForReport) and derived (deriveUserStatus). An ask is Needs you; else any
 * working subject is Working; else any waiting subject is Waiting; never Needs you without an ask,
 * and never "It answered your question" while a subject still runs or waits.
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-status-threads-consistency'))

import { readStatusReport } from '../../../src/core/session-hooks/builtins.js'
import { patchForLine, readThreadLines, settleStateFromThreads, threadQuestionBlock, type ThreadLineState } from '../../../src/core/sessions/status-threads.js'
import { phaseForReport } from '../../../src/core/sessions/report-phase.js'
import { deriveUserStatus, ANSWER_TO_READ } from '../../../src/core/user-status.js'

const NOW = Date.parse('2026-11-20T18:00:00Z')
const STATES: ThreadLineState[] = ['working', 'waiting', 'answered', 'done']
const THREADS = [
  { id: 'th-aaaaaa01', title: 'Seed tray rollout', state: 'working' as const },
  { id: 'th-aaaaaa02', title: 'Nightly watering report', state: 'answered' as const },
  { id: 'th-aaaaaa03', title: 'Greenhouse sensor batteries', state: 'pending' as const },
]
const { refs } = threadQuestionBlock(THREADS)

/** What the session can say for the task as a whole. */
const SAID: Record<string, string> = {
  'needs-you, no ask': 'FOR_USER_STATE: needs-you',
  working: 'FOR_USER_STATE: working',
  'waiting outside': 'FOR_USER_STATE: waiting\nFOR_USER_WAITING_ON: outside: the supplier\'s delivery',
  'waiting own': 'FOR_USER_STATE: waiting\nFOR_USER_WAITING_ON: own: the build of my change',
  done: 'FOR_USER_STATE: done',
}
const ASK = 'FOR_USER_STATE: needs-you\nFOR_USER_ASK: Pay for the larger seed trays?\nFOR_USER_ASK_OWN: spending: it buys trays for the team'

/** Every multiset of 0 to 3 line states, one thread each. */
function combos(): ThreadLineState[][] {
  const out: ThreadLineState[][] = [[]]
  for (const a of STATES) {
    out.push([a])
    for (const b of STATES) {
      out.push([a, b])
      for (const c of STATES) out.push([a, b, c])
    }
  }
  return out
}

function derived(answer: string) {
  const read = readStatusReport(answer, new Date(NOW - 60_000))
  expect(read, answer).not.toBeNull()
  const report = settleStateFromThreads({ ...read!, ...readThreadLines(answer, refs) })
  const task = { parent_task_id: undefined, org_role: undefined }
  const phase = phaseForReport(report, task as never, true, false) ?? 'IN_PROGRESS'
  return { report, status: deriveUserStatus({ phase, hasSession: true, processStatus: 'idle', report }, NOW) }
}

describe('the status from the thread lines', () => {
  const cases = combos()
  it('enumerates every combination (the matrix reads them all)', () => {
    expect(cases.length).toBe(1 + 4 + 16 + 64)
  })

  for (const [saidName, said] of [...Object.entries(SAID), ['a real ask', ASK] as const]) {
    it(`${saidName}: agrees with the thread lines in every combination`, () => {
      for (const lines of cases) {
        const answer = [said, 'FOR_USER_NOW: The trays are on order.', 'FOR_USER_NEXT: I check the delivery.',
          ...lines.map((s, i) => `FOR_USER_THREAD: t${i + 1} | ${s} | Step ${i + 1} stands so.`)].join('\n')
        const { report, status } = derived(answer)
        const label = `${saidName} + [${lines.join(', ')}] -> ${status.state} (${status.waitingOn ?? ''})`
        const asks = saidName === 'a real ask'
        const ownWork = saidName === 'working' || saidName === 'waiting own'
        // Never Needs you without an ask; an ask is always Needs you.
        if (asks) { expect(status.state, label).toBe('needs'); continue }
        expect(status.state, label).not.toBe('needs')
        if (lines.includes('working') || ownWork) expect(status.state, label).toBe('working')
        else if (lines.includes('waiting') || saidName === 'waiting outside') expect(status.state, label).toBe('waiting')
        if (lines.includes('working') || lines.includes('waiting')) expect(status.waitingOn ?? '', label).not.toContain(ANSWER_TO_READ)
        // The lines are read into the report, one per thread named.
        expect(report.threads?.length ?? 0, label).toBe(lines.length)
      }
    })
  }

  it('the motivating case: needs-you with no ask while only the rollout runs outside reads Waiting on it', () => {
    const { report, status } = derived('FOR_USER_STATE: needs-you\nFOR_USER_NOW: The new version rolls out.\nFOR_USER_THREAD: t1 | waiting | The rollout is at half the regions.\nFOR_USER_THREAD: t2 | done | Auto-push is on, as you set it.')
    expect(report).toMatchObject({ state: 'waiting', waiting_kind: 'outside', waiting_on: 'Seed tray rollout', from_threads: true })
    expect(status).toMatchObject({ state: 'waiting', kind: 'outside', waitingOn: 'Seed tray rollout' })
  })
})

describe('reading the thread lines', () => {
  it('reads each named thread once, drops unknown refs and state words, and keeps the other fields whole', () => {
    const answer = [
      'FOR_USER_STATE: working',
      'FOR_USER_NOW: The trays are on order.',
      'FOR_USER_THREAD: t1 | waiting | The supplier ships on Monday.',
      '**FOR_USER_THREAD:** T2 | answered | The report is in your inbox | with the totals.',
      'FOR_USER_THREAD: t2 | done | A second line for the same thread is dropped.',
      'FOR_USER_THREAD: t9 | working | No such thread.',
      'FOR_USER_THREAD: t3 | finished | Not a state word.',
      'FOR_USER_THREAD_NEW: waiting | Compost delivery | The truck comes Tuesday.',
      'FOR_USER_THREAD_NEW: done | Not a state a new thread takes | x',
      'FOR_USER_THREAD_NEW: working | Seed tray rollout | Already a thread.',
      'FOR_USER_NEXT: I check the delivery.',
    ].join('\n')
    const lines = readThreadLines(answer, refs)
    expect(lines.threads).toEqual([
      { id: 'th-aaaaaa01', title: 'Seed tray rollout', state: 'waiting', progress: 'The supplier ships on Monday.' },
      { id: 'th-aaaaaa02', title: 'Nightly watering report', state: 'answered', progress: 'The report is in your inbox | with the totals.' },
    ])
    expect(lines.threads_new).toEqual([{ title: 'Compost delivery', state: 'waiting', progress: 'The truck comes Tuesday.' }])
    // The thread lines end the field before them: FOR_USER_NOW and FOR_USER_NEXT stay their own.
    const report = readStatusReport(answer)!
    expect(report.now).toBe('The trays are on order.')
    expect(report.next).toBe('I check the delivery.')
  })

  it('opens at most three new threads from one answer', () => {
    const answer = ['FOR_USER_STATE: working', ...[1, 2, 3, 4].map((n) => `FOR_USER_THREAD_NEW: working | Bed ${n} | Dug.`)].join('\n')
    expect(readThreadLines(answer, refs).threads_new?.map((t) => t.title)).toEqual(['Bed 1', 'Bed 2', 'Bed 3'])
  })

  it('an answer with no thread lines leaves the report as it was', () => {
    const r = readStatusReport('FOR_USER_STATE: needs-you')!
    expect(settleStateFromThreads({ ...r, ...readThreadLines('FOR_USER_STATE: needs-you', refs) })).toEqual(r)
  })
})

describe('the write each line makes', () => {
  const base = { id: 'th-aaaaaa09', title: 'Orchard fence', messages: [], createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T10:00:00.000Z' }
  it('never hides a thread waiting on him, and never writes one into needs', () => {
    const needs = { ...base, state: 'needs' as const, ask: 'Which fence height?' }
    expect(patchForLine(needs, { id: needs.id, title: needs.title, state: 'working', progress: 'x' })).toBeNull()
    expect(patchForLine(needs, { id: needs.id, title: needs.title, state: 'waiting', progress: 'x' })).toBeNull()
    for (const state of STATES) {
      expect(patchForLine({ ...base, state: 'working' }, { id: base.id, title: base.title, state, progress: 'Posts are set.' })?.state).not.toBe('needs')
    }
  })
  it('an answer he has not read keeps the thread in his sight; once he has, a wait hides it', () => {
    const unread = { ...base, state: 'answered' as const, reply: 'The posts are in.', replyAt: '2026-11-20T11:00:00.000Z' }
    expect(patchForLine(unread, { id: base.id, title: base.title, state: 'waiting', progress: 'The wire comes Friday.' })).toEqual({ state: 'answered', reply: 'The wire comes Friday.' })
    const read = { ...unread, reactedAt: '2026-11-20T12:00:00.000Z' }
    expect(patchForLine(read, { id: base.id, title: base.title, state: 'waiting', progress: 'The wire comes Friday.' })).toEqual({ state: 'pending', reply: 'The wire comes Friday.' })
  })
  it('done closes a subject the task opened, and answers his own request', () => {
    const own = { ...base, state: 'working' as const, opener: { text: 'Fence work started.', at: base.createdAt, from: 'node' as const, by: 'task:t1' as const } }
    expect(patchForLine(own, { id: base.id, title: base.title, state: 'done', progress: 'The fence is up.' })).toEqual({ close: 'dropped', reply: 'The fence is up.' })
    expect(patchForLine({ ...base, state: 'working' }, { id: base.id, title: base.title, state: 'done', progress: 'The fence is up.' })).toEqual({ state: 'answered', reply: 'The fence is up.' })
  })
})

// Review round 1 of a4a6d630c: four ways a line could hide what waits on him.
describe('a thread line never hides what waits on the user', () => {
  const line = (state: ThreadLineState) => ({ ref: 't1', id: 'th-aaaaaa09', title: 'Pick the apple variety', state, progress: 'Asked at the stand' })
  const needs = { id: 'th-aaaaaa09', title: 'Pick the apple variety', state: 'needs', messages: [], createdAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-20T10:00:00Z', opener: { text: 'x', at: '2026-11-20T10:00:00Z', from: 'node', by: 'agent' } } as never

  it('no line state moves a thread in needs, not even done or answered', () => {
    for (const s of STATES) expect(patchForLine(needs, line(s) as never), s).toBeNull()
  })

  it('a thread in needs is not asked about', () => {
    const { refs: listed } = threadQuestionBlock([...THREADS, { id: 'th-aaaaaa09', title: 'Pick the apple variety', state: 'needs' as const }].filter((t) => t.state !== 'needs'))
    expect([...listed.values()].some((v) => v.id === 'th-aaaaaa09')).toBe(false)
  })

  it('a wait whose words name him keeps its state, whatever its kind', () => {
    const report = { state: 'waiting', at: '2026-11-20T17:59:00Z', waiting_kind: 'other', waiting_on: 'your review of the tray order', threads: [line('working')] } as never
    expect(settleStateFromThreads(report)).toBe(report)
  })

  it('a turn that answered him reads its answer first, then names what it waits on', () => {
    const at = new Date(NOW - 60_000).toISOString()
    const { threads: _t, threads_new: _n, ...settled } = settleStateFromThreads({ state: 'needs', at, threads: [line('waiting')] } as never)
    expect(settled.state).toBe('waiting')
    const s = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', phaseChangedAt: new Date(NOW - 120_000).toISOString(), report: { ...settled, answered_person: true } }, NOW)
    expect(s.state).toBe('read')
    expect(s.waitingOn ?? '').toContain('Pick the apple variety')
  })
})
