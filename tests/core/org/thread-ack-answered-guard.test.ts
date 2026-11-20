/**
 * Guard: his Acknowledge on a card that holds the result closes it, whatever is open on it
 * (2026-11-20, the user: "I ack, she sees it herself, nothing else, so it closes, right?";
 * src/core/org/thread-ack.ts ackWaitsOf). Every kind of wait ackWaitsOf knows is enumerated from
 * its own answer: each, alone and all together, holds a thread that is still at work (it would go
 * Known), and never an answered one. A new kind of wait with no case here fails the test.
 *
 * Also: every state group the server draws by is one the web draws and the phone has a place for.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OrgThread, ThreadState } from '../../../src/core/org/threads-model.js'
import { ackWaitsOf, type AckWaits } from '../../../src/core/org/thread-ack.js'
import { THREAD_GROUPS } from '../../../src/core/org/thread-groups.js'

const AT = '2026-11-20T06:00:00.000Z'
const OPEN_TASKS = new Map([['t-oven', 'Fix the oven timer']])

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
/** The states a thread is in while its work is not finished (answered holds the result; needs waits on him). */
const AT_WORK: ThreadState[] = ['new', 'working', 'pending']

describe('an acknowledged answered thread is never held', () => {
  it('every kind of wait is listed here', () => {
    const kinds = Object.keys(ackWaitsOf(thread('working', all), OPEN_TASKS) ?? {}).sort()
    expect(kinds.length).toBeGreaterThan(0)
    expect(kinds).toEqual(Object.keys(WAIT_MAKERS).sort())
  })

  for (const kind of Object.keys(WAIT_MAKERS) as Array<keyof AckWaits>) {
    it(`${kind}: holds a thread at work, never an answered one`, () => {
      for (const state of AT_WORK) {
        const w = ackWaitsOf(thread(state, WAIT_MAKERS[kind]), OPEN_TASKS)
        expect(w, `${state} with ${kind}`).not.toBeNull()
        expect(w![kind] === true || (Array.isArray(w![kind]) && (w![kind] as unknown[]).length > 0), `${state} with ${kind}`).toBe(true)
      }
      expect(ackWaitsOf(thread('answered', WAIT_MAKERS[kind]), OPEN_TASKS)).toBeNull()
    })
  }

  it('all of them at once: still never an answered one', () => {
    expect(ackWaitsOf(thread('answered', all), OPEN_TASKS)).toBeNull()
  })
})

describe('every state group has its place on each surface', () => {
  const root = path.resolve(import.meta.dirname, '../../..')
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

  it('the web opens or folds each group by default and names its chip', () => {
    const byState = read('web/src/components/org/OrgThreadsByState.tsx')
    const bar = read('web/src/components/org/ThreadsFilterBar.tsx')
    for (const g of THREAD_GROUPS) {
      expect(byState, g).toMatch(new RegExp(`\\b${g}: (true|false)`))
      expect(bar, g).toMatch(new RegExp(`\\b${g}: '`))
    }
  })

  it('the phone has a Known section, a jump to it and a reveal into it', () => {
    expect(read('ios-native/Walnut/Views/Org/OrgThreadModel.swift')).toMatch(/var known: \[OrgThread\]/)
    expect(read('ios-native/Walnut/Views/Org/OrgThreadsView.swift')).toContain('("known", "Known"')
    expect(read('ios-native/Walnut/Views/Org/OrgThreadFocus.swift')).toMatch(/enum Fold: String, Equatable \{ case known,/)
  })
})
