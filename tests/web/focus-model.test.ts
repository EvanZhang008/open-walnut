/**
 * The focus views' words and counts (web/src/focus-spaces/focus-model.ts): what a space holds,
 * what waits outside, and what came to need the person while they focused.
 */
import { describe, it, expect } from 'vitest'
import { outsideCounts, scopeLine, summarize, durationWords, mergeVisibleOrder, focusNoteOf } from '../../web/src/focus-spaces/focus-model'

const t = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, phase: 'IN_PROGRESS', status: 'todo', updated_at: '2026-11-21T10:00:00Z', ...extra }) as never

describe('focus model', () => {
  it('says what a space holds', () => {
    expect(scopeLine({ projects: ['Walnut', ''], tasks: ['a', 'b'] })).toBe('Walnut, Inbox · 2 tasks')
    expect(scopeLine({ tasks: ['a'] }, () => 'Question bank practice')).toBe('Question bank practice')
  })

  it('counts open tasks outside, and those that need the person', () => {
    const tasks = [t('in'), t('out'), t('out-needs', { phase: 'NEED_ACTION' }), t('out-done', { phase: 'COMPLETE', status: 'done' })]
    expect(outsideCounts(tasks, (id) => id === 'in')).toEqual({ open: 2, needs: 1 })
  })

  it('sums up what changed outside since the focus began', () => {
    const since = Date.parse('2026-11-21T09:00:00Z')
    const tasks = [t('in'), t('old', { updated_at: '2026-11-21T08:00:00Z', phase: 'NEED_ACTION' }), t('new-needs', { phase: 'NEED_ACTION' }), t('new')]
    const s = summarize({ name: 'Walnut', scope: { tasks: ['in'] }, since, by: 'person' }, tasks, (id) => id === 'in', since + 90 * 60_000)
    expect(s).toEqual({ name: 'Walnut', minutes: 90, needs: [{ id: 'new-needs', title: 'new-needs' }], changed: 2 })
    expect(durationWords(90)).toBe('1 h 30 min')
  })

  // 2026-11-21 review: a drag on Home in a focus sent only the shown ids, and the server put the
  // project's hidden tasks after them, rewriting the whole project's manual order.
  it('merges a new order of the shown rows back into the whole order, hidden rows in their slots', () => {
    const full = ['h1', 'a', 'h2', 'b', 'h3', 'c']
    expect(mergeVisibleOrder(full, ['c', 'a', 'b'])).toEqual(['h1', 'c', 'h2', 'a', 'h3', 'b'])
    // Nothing hidden: the new order as it is.
    expect(mergeVisibleOrder(['a', 'b'], ['b', 'a'])).toEqual(['b', 'a'])
    // A shown row the whole order lacks (just made) goes last.
    expect(mergeVisibleOrder(['h1', 'a'], ['n', 'a'])).toEqual(['h1', 'n', 'a'])
  })

  it('tells the quick bar what a focus leaves out', () => {
    expect(focusNoteOf(undefined)).toBeUndefined()
    expect(focusNoteOf({ name: 'Walnut', outside: 3 })).toBe('In focus: Walnut · 3 tasks outside it not listed. A line to anyone outside is sent, and its reply waits there.')
    expect(focusNoteOf({ name: 'Walnut', outside: 0 })).toBe('In focus: Walnut. A line to anyone outside is sent, and its reply waits there.')
  })
})
