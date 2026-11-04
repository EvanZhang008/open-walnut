/**
 * Where "complete and go to the next" lands (web/src/components/tasks/next-needs-you.ts):
 * the task after the completed one in the Needs you order as it was when it was completed,
 * wrapping to the top, skipping what no longer needs the person, and none when nothing does.
 */
import { describe, expect, it } from 'vitest'
import type { Task } from '@open-walnut/core'
import { needsYouQueue, nextNeedsYou } from '../../web/src/components/tasks/next-needs-you'

let clock = Date.parse('2026-11-04T08:00:00Z')
function task(id: string, state: 'needs' | 'working' | 'done', minutesAgo = 0): Task {
  const at = new Date(clock - minutesAgo * 60_000).toISOString()
  return {
    id, title: `Task ${id}`, project: 'Acme', status: state === 'done' ? 'done' : 'in_progress',
    phase: state === 'done' ? 'COMPLETE' : state === 'needs' ? 'NEED_ACTION' : 'IN_PROGRESS',
    user_status: { state: state === 'needs' ? 'needs' : state === 'done' ? 'done' : 'working' },
    created_at: at, updated_at: at,
  } as unknown as Task
}

describe('next task that needs you', () => {
  const a = task('a', 'needs', 1), b = task('b', 'needs', 2), c = task('c', 'needs', 3), w = task('w', 'working', 0)
  const before = needsYouQueue([w, c, a, b]).map((t) => t.id)

  it('the queue is Needs you only, latest activity first', () => {
    expect(before).toEqual(['a', 'b', 'c'])
  })

  it('goes to the one after the completed task', () => {
    const now = [{ ...a, phase: 'COMPLETE', status: 'done', user_status: { state: 'done' } } as Task, b, c, w]
    expect(nextNeedsYou(before, 'a', now)?.id).toBe('b')
    expect(nextNeedsYou(before, 'b', [a, c, w])?.id).toBe('c')
  })

  it('wraps to the top past the last one', () => {
    expect(nextNeedsYou(before, 'c', [a, b, w])?.id).toBe('a')
  })

  it('skips a task that stopped needing you since, and the ids asked to skip', () => {
    const bWorking = { ...b, phase: 'IN_PROGRESS', user_status: { state: 'working' } } as Task
    expect(nextNeedsYou(before, 'a', [bWorking, c, w])?.id).toBe('c')
    expect(nextNeedsYou(before, 'a', [b, c], new Set(['b']))?.id).toBe('c')
  })

  it('a task that started needing you since comes after the known ones', () => {
    const fresh = task('n', 'needs', -5)
    expect(nextNeedsYou(before, 'b', [a, c, fresh])?.id).toBe('c')
    expect(nextNeedsYou(['a'], 'a', [fresh, w])?.id).toBe('n')
  })

  it('a completed task that was not under Needs you goes to the top of the queue', () => {
    expect(nextNeedsYou(before, 'w', [a, b, c])?.id).toBe('a')
  })

  it('none when nothing else needs you', () => {
    expect(nextNeedsYou(['a'], 'a', [a, w])).toBeNull()
    expect(nextNeedsYou([], 'x', [])).toBeNull()
  })
})
