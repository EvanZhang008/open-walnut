/**
 * A task's lines read as threads of its own (src/core/org/line-threads.ts; 2026-11-19, the user:
 * "let's make all a thread, thread auto open for all task"): one per line, opened and gone with it,
 * never stored, and every line state reads as a thread state.
 */
import { describe, it, expect } from 'vitest'
import { LINE_STATES, type TaskLine } from '../../../src/core/task-lines.js'
import { isLineThreadId, lineThreads } from '../../../src/core/org/line-threads.js'
import { THREAD_STATES } from '../../../src/core/org/threads-model.js'

const AT = '2026-11-19T22:40:00Z'

describe('a task\'s lines as threads', () => {
  it('a pipeline watch leader: its letter is a thread that needs him, its watches are threads kept quiet', () => {
    const lines: TaskLine[] = [
      { id: 'item:lt-1', kind: 'ask', state: 'needs', what: 'Approve the quota raise', item: 'lt-1' },
      { id: 'watch:0', kind: 'watch', state: 'waiting', what: 'Pipeline watch', until: '2026-11-19T23:00:00Z' },
    ]
    const out = lineThreads({ state: 'needs', source: 'session', lines } as never, AT)
    expect(out.map((t) => [t.id, t.state, t.title])).toEqual([
      ['line:item:lt-1', 'needs', 'Approve the quota raise'],
      ['line:watch:0', 'pending', 'Pipeline watch'],
    ])
    expect(out[0].opener?.ref).toBe('lt-1')
    expect(out[0].ask).toBe('Approve the quota raise')
    expect(out[1].ask).toBeUndefined()
    expect(out.every((t) => isLineThreadId(t.id) && t.messages.length === 0 && !t.closed)).toBe(true)
  })

  it('every line state reads as a thread state, and no lines are no threads', () => {
    for (const state of LINE_STATES) {
      const [t] = lineThreads({ state: 'waiting', source: 'session', lines: [{ id: 'x', kind: 'wait', state, what: 'x' }] } as never, AT)
      expect(THREAD_STATES, state).toContain(t.state)
    }
    expect(lineThreads(undefined, AT)).toEqual([])
    expect(lineThreads({ state: 'working', source: 'session' } as never, AT)).toEqual([])
  })
})
