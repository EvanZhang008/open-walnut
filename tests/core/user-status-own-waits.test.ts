/**
 * A worker handed back while it waits on another task of its own reads Waiting on that task, never
 * on its lead (src/core/user-status.ts awaitedTask). 2026-11-07: at least four workers ended a turn
 * while their own review subtask ran, each read "Its lead, to look at it: its turn ended without
 * asking you anything", and filled their lead's "Waiting on you" list (org/lead-waits.ts) with
 * notices.
 *
 * Every wait source a status input has is listed here with what it reads as; a new input field
 * that says it wakes the task or that the task waits on it fails the ratchet until it is listed.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { deriveUserStatus, OWN_TASK_WAIT_SOURCES, type UserStatusInput } from '../../src/core/user-status.js'
import { completeStatusFacts, type StatusFacts } from '../../src/core/user-status-sync.js'
import type { Task } from '../../src/core/types.js'

const NOW = Date.parse('2026-11-07T01:00:00Z')

/** Every wait source of UserStatusInput, and how a handed-back worker reads with only it set. */
const WAIT_SOURCES: Record<string, { input: Partial<UserStatusInput>; reads: 'task' | 'watch' | 'time' | 'not a wait of a hand-back' }> = {
  waitingOnTasks: { input: { waitingOnTasks: ['Review: the diff'] }, reads: 'task' },
  workersAtWork: { input: { workersAtWork: ['Review: the diff'] }, reads: 'task' },
  triggers: { input: { triggers: ['CI on main'] }, reads: 'watch' },
  // A routine's next run wakes a task in progress; a handed-back one is not parked on it (wakeSource(..., false)).
  schedules: { input: { schedules: [{ name: 'Nightly digest', nextAt: '2026-11-07T06:00:00Z' }] }, reads: 'not a wait of a hand-back' },
  // A count of every open subtask, handed back ones too: the hand-back reads workersAtWork.
  openWorkers: { input: { openWorkers: 2 }, reads: 'not a wait of a hand-back' },
  // A model endpoint Walnut retries on its own: a machine wait, read before any of these.
  endpointWait: { input: {}, reads: 'not a wait of a hand-back' },
  // Main's and a lead's own wait (the user's next message), never a worker's.
  isMain: { input: {}, reads: 'not a wait of a hand-back' },
}

const handedBack = (over: Partial<UserStatusInput>, processStatus: 'idle' | 'stopped'): UserStatusInput => ({
  phase: 'NEED_ACTION', hasSession: true, hasLeader: true, processStatus, ...over,
})

describe('a handed-back worker that waits on a task of its own reads Waiting on that task', () => {
  it('lists every wait source of the status input (ratchet)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/core/user-status.ts'), 'utf-8')
    const start = src.indexOf('export interface UserStatusInput')
    const body = src.slice(start, src.indexOf('\n}\n', start))
    const waits = [...body.matchAll(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*\n\s*(\w+)\??:/g)]
      .filter((m) => /wakes? it|waits? (?:on|for)/i.test(m[1]!.replace(/\s+/g, ' ')))
      .map((m) => m[2]!)
    for (const key of waits) expect(Object.keys(WAIT_SOURCES), `${key} is a wait source: list it here and say what a hand-back reads`).toContain(key)
    for (const key of OWN_TASK_WAIT_SOURCES) expect(WAIT_SOURCES[key]?.reads).toBe('task')
  })

  for (const [key, { input, reads }] of Object.entries(WAIT_SOURCES)) {
    if (reads === 'not a wait of a hand-back') continue
    for (const processStatus of ['idle', 'stopped'] as const) {
      it(`${key}, session ${processStatus}: never its lead's`, () => {
        const s = deriveUserStatus(handedBack(input, processStatus), NOW)
        expect(s.state).toBe('waiting')
        expect(s.kind).not.toBe('lead')
        if (reads === 'task') {
          expect(s.kind).toBe('task')
          expect(s.waitingOn).toContain('Review: the diff')
        }
      })
    }
  }

  it('with none of them, it is its lead to look at, as before; and its own ask or done report still speaks', () => {
    expect(deriveUserStatus(handedBack({}, 'idle'), NOW)).toMatchObject({ state: 'waiting', kind: 'lead' })
    expect(deriveUserStatus(handedBack({}, 'stopped'), NOW)).toMatchObject({ state: 'waiting', kind: 'lead' })
    const at = new Date(NOW).toISOString()
    expect(deriveUserStatus(handedBack({ workersAtWork: ['Review'], report: { state: 'needs', ask: 'Approve the spend', at } as never }, 'idle'), NOW).state).toBe('needs')
    expect(deriveUserStatus(handedBack({ workersAtWork: ['Review'], report: { state: 'done', at } as never }, 'idle'), NOW)).toMatchObject({ kind: 'lead' })
    // A turn still running, or its report still to come, is not read as a wait yet.
    expect(deriveUserStatus(handedBack({ workersAtWork: ['Review'], reportPending: true }, 'idle'), NOW).kind).not.toBe('task')
  })

  it('a subtask counts as at work only in progress or parked on its own wait; handed back or not started it is its parent to look at', () => {
    const task = (id: string, phase: Task['phase'], parent?: string): Task => ({ id, title: `T ${id}`, phase, ...(parent ? { parent_task_id: parent } : {}) } as Task)
    const facts = { titles: new Map() } as unknown as StatusFacts
    completeStatusFacts(facts, [
      task('p', 'NEED_ACTION'),
      task('a', 'IN_PROGRESS', 'p'), task('b', 'WAITING', 'p'), task('c', 'NEED_ACTION', 'p'), task('d', 'TODO', 'p'), task('e', 'COMPLETE', 'p'),
    ])
    expect(facts.workersAtWork?.get('p')).toEqual(['T a', 'T b'])
    expect(facts.openWorkers?.get('p')).toBe(4)
  })
})
