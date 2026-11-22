/**
 * Guard: what holds a card at his Acknowledge is only work on its own subject, whatever its state
 * (src/core/org/thread-ack-outcome.ts ackOutcome via thread-ack.ts ackWaitsOf; 2026-11-20, the
 * user: "if I ack and ai should determine if it should go to closed or wait or wip", "If U know why
 * not close"). Every kind of wait is enumerated from its own answer: each, alone and all together,
 * holds a thread in every state, an answered one (its result delivered) included, and a task off
 * its subject never does. A new kind of wait with no case here fails the test.
 *
 * Also: every group the server draws by is one the web and the phone name, in the same words.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OrgThread, ThreadState } from '../../../src/core/org/threads-model.js'
import { ackWaitsOf, type AckTask, type AckWaits } from '../../../src/core/org/thread-ack.js'
import { THREAD_GROUPS, THREAD_GROUP_LABELS } from '../../../src/core/org/thread-groups.js'

const AT = '2026-11-20T06:00:00.000Z'
const OPEN_TASKS = new Map<string, AckTask>([['t-oven', { id: 't-oven', title: 'Fix the oven timer', phase: 'IN_PROGRESS' }]])
/** The same task, now titled for another subject. */
const OFF_SUBJECT = new Map<string, AckTask>([['t-oven', { id: 't-oven', title: 'Paint the garden shed', phase: 'IN_PROGRESS' }]])

function thread(state: ThreadState, extra: Partial<OrgThread> = {}): OrgThread {
  return {
    id: 'th-aaaaaaaaaaaa', title: 'Oven timer', state, createdAt: AT, updatedAt: AT,
    messages: [{ id: 'tm-aaaaaaaaaaaa', at: AT, text: 'Fix the oven timer', via: 'chat' }],
    ...extra,
  }
}

/** One way to make each kind of wait true on a thread. */
const WAIT_MAKERS: Record<keyof AckWaits, Partial<OrgThread>> = {
  tasks: { tasks: ['t-oven'] },
  replies: { messages: [{ id: 'tm-bbbbbbbbbbbb', at: AT, text: 'and the clock', via: 'chat', delivery: { state: 'pending', at: AT } }] },
  letter: { letter: { id: 'lt-1', task: 'lead-1', options: [] } },
}

const all = (Object.values(WAIT_MAKERS) as Partial<OrgThread>[]).reduce((a, b) => ({ ...a, ...b }), {})
/** Every state, answered (its result delivered) included. */
const STATES: ThreadState[] = ['new', 'working', 'pending', 'needs', 'answered']

describe('only work on its own subject holds an acknowledged thread', () => {
  it('every kind of wait is listed here', () => {
    const kinds = Object.keys(ackWaitsOf(thread('working', all), OPEN_TASKS) ?? {}).sort()
    expect(kinds.length).toBeGreaterThan(0)
    expect(kinds).toEqual(Object.keys(WAIT_MAKERS).sort())
  })

  for (const kind of Object.keys(WAIT_MAKERS) as Array<keyof AckWaits>) {
    it(`${kind}: holds a thread in every state, an answered one included`, () => {
      for (const state of STATES) {
        const w = ackWaitsOf(thread(state, WAIT_MAKERS[kind]), OPEN_TASKS)
        expect(w, `${state} with ${kind}`).not.toBeNull()
        expect(w![kind] === true || (Array.isArray(w![kind]) && (w![kind] as unknown[]).length > 0), `${state} with ${kind}`).toBe(true)
      }
    })
  }

  it('a task it lists that moved on to another subject holds nothing: the card closes', () => {
    for (const state of STATES) expect(ackWaitsOf(thread(state, WAIT_MAKERS.tasks), OFF_SUBJECT), state).toBeNull()
  })
})

describe('every group has its place on each surface, in his words', () => {
  const root = path.resolve(import.meta.dirname, '../../..')
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

  it('the web draws each group by the shared labels', () => {
    expect(read('web/src/components/org/OrgThreadsByState.tsx')).toContain('THREAD_GROUP_LABELS[g]')
    for (const g of THREAD_GROUPS) expect(THREAD_GROUP_LABELS[g], g).toBeTruthy()
  })

  it('the phone has the same groups, ids and words', () => {
    const model = read('ios-native/Walnut/Views/Org/OrgThreadModel.swift')
    expect(model).toContain(`case ${THREAD_GROUPS.join(', ')}`)
    for (const g of THREAD_GROUPS) expect(model, g).toContain(`case .${g}: return "${THREAD_GROUP_LABELS[g]}"`)
    // Its folds' ids, in the server's order: tests/web/thread-folds-guard.test.ts.
  })
})
