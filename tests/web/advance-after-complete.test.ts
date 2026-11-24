/**
 * A completion never opens a column (web/src/pages/advance-after-complete.ts).
 *
 * 2026-11-24, the user: "I resolve the pannel 2 task and then there is one more task appear???
 * ... it shoud be gone". Completing a task in its Home column used to open the next task that
 * needs the person in the closed column's place. The going-on now moves only the caret and the
 * list's selection. The class: every way a completion reaches the strip. The scans below fail
 * when the advance (or the completion hook around it) gains a way to open a column.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Task } from '@open-walnut/core'
import { makeAdvance, pickAdvance, type AdvanceDeps } from '../../web/src/pages/advance-after-complete'
import type { SessionSlot } from '../../web/src/pages/sessionColumns'

const at = '2026-11-24T21:00:00Z'
function task(id: string, minutesAgo: number, session?: string): Task {
  const t = new Date(Date.parse(at) - minutesAgo * 60_000).toISOString()
  return {
    id, title: `Task ${id}`, project: 'Acme', status: 'in_progress', phase: 'NEED_ACTION',
    user_status: { state: 'needs' }, created_at: t, updated_at: t,
    ...(session ? { session_id: session } : {}),
  } as unknown as Task
}
const done = (t: Task) => ({ ...t, phase: 'COMPLETE', status: 'done', user_status: { state: 'done' } }) as unknown as Task
const slot = (id: string): SessionSlot => ({ id, locked: false })

describe('pickAdvance', () => {
  const a = task('a', 1, 's-a'), b = task('b', 2, 's-b'), c = task('c', 3)
  const before = ['a', 'b', 'c']

  it('names the next task, and no column when its session is not on the strip', () => {
    expect(pickAdvance(before, 'a', [done(a), b, c], [slot('s-a'), slot('s-x')], 's-a')).toEqual({ task: b })
  })

  it('names the next task\'s column when it is already on the strip', () => {
    expect(pickAdvance(before, 'a', [done(a), b, c], [slot('s-a'), slot('s-b')], 's-a')).toEqual({ task: b, columnId: 's-b' })
  })

  it('never names the closing column', () => {
    const twin = { ...b, session_ids: ['s-a'] } as unknown as Task
    expect(pickAdvance(before, 'a', [done(a), twin, c], [slot('s-a')], 's-a')).toEqual({ task: twin })
  })
})

describe('makeAdvance', () => {
  function deps(strip: SessionSlot[], tasks: Task[]) {
    const d = {
      enabled: () => true,
      tasks: () => tasks,
      strip: () => strip,
      afterStrip: (_ready: () => boolean, fn: () => void) => { fn(); return () => {} },
      focusColumn: vi.fn(() => () => {}),
      focusRow: vi.fn(() => () => {}),
      locateTask: vi.fn(),
      movedSince: () => false,
      noteMove: vi.fn(),
      dropPendingFocus: vi.fn(),
      now: () => 0,
    } satisfies AdvanceDeps
    return d
  }
  const a = task('a', 1, 's-a'), b = task('b', 2, 's-b'), c = task('c', 3)

  it('a next task whose session is not open: its row takes the caret, the strip is untouched', () => {
    const strip = [slot('s-x')]
    const d = deps(strip, [done(a), b, c])
    const r = makeAdvance(d)({ taskId: 'a', sessionId: 's-a', queueBefore: ['a', 'b', 'c'] })
    expect(r?.task.id).toBe('b')
    expect(r?.inColumn).toBeUndefined()
    expect(d.focusRow).toHaveBeenCalledWith('b')
    expect(d.focusColumn).not.toHaveBeenCalled()
    expect(d.locateTask).toHaveBeenCalledWith('b')
    expect(strip).toEqual([slot('s-x')])
  })

  it('a next task whose column is open: that column takes the caret', () => {
    const d = deps([slot('s-b')], [done(a), b, c])
    const r = makeAdvance(d)({ taskId: 'a', sessionId: 's-a', queueBefore: ['a', 'b', 'c'] })
    expect(r?.inColumn).toBe(true)
    expect(d.focusColumn).toHaveBeenCalledWith('s-b')
  })

  it('quiet: the list follows, the caret stays where the person went', () => {
    const d = deps([], [done(a), b, c])
    makeAdvance(d)({ taskId: 'a', sessionId: 's-a', queueBefore: ['a', 'b', 'c'], quiet: true })
    expect(d.locateTask).toHaveBeenCalledWith('b')
    expect(d.focusRow).not.toHaveBeenCalled()
  })

  it('off in Settings: nothing', () => {
    const d = { ...deps([], [done(a), b]), enabled: () => false }
    expect(makeAdvance(d)({ taskId: 'a', sessionId: 's-a', queueBefore: ['a', 'b'] })).toBeNull()
  })

  it('a task with no session says so on the toast', () => {
    const d = deps([], [done(b), c])
    expect(makeAdvance(d)({ taskId: 'b', sessionId: 's-b', queueBefore: ['b', 'c'] })?.noSession).toBe(true)
  })
})

describe('a completion has no way to open a column (source guard)', () => {
  const root = resolve(__dirname, '../..')
  const read = (p: string) => readFileSync(resolve(root, p), 'utf8')
  // Everything that puts a session on the strip.
  const OPENERS = /\b(openSession\w*|openTask\w*|handleOpen\w*|addSessionColumn|forceAddSessionColumn|restoreSessionColumn|replaceSessionColumn|regrowColumns|setSessionColumns)\b/

  it('the advance module names no opener', () => {
    const src = read('web/src/pages/advance-after-complete.ts').replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, '')
    expect(src).not.toMatch(OPENERS)
  })

  it('Home builds its advance only from that module', () => {
    const main = read('web/src/pages/MainPage.tsx')
    const writes = main.match(/advanceRef\.current\s*\??\?=/g) ?? []
    expect(writes).toHaveLength(1)
    expect(main).toMatch(/advanceRef\.current \?\?= makeAdvance\(\{/)
    expect(main).not.toMatch(/openSessionInPlaceOf/)
    // What Home hands the advance: the caret and the list only, never an open.
    const from = main.indexOf('advanceRef.current ??= makeAdvance({')
    const literal = main.slice(from, main.indexOf('\n  });', from))
    expect(literal).not.toMatch(OPENERS)
    expect(literal).toMatch(/focusColumn: focusColumnComposer,/)
    expect(literal).toMatch(/focusRow: focusTaskRow,/)
    expect(literal).toMatch(/locateTask: \(id\) => locateTaskRef\.current\(id\),/)
  })

  it('the completion hook opens a column only to put the completed one back (its Undo)', () => {
    const src = read('web/src/pages/useColumnCompleteClose.ts')
    const body = src.slice(src.indexOf('export function useColumnCompleteClose'))
    const restore = body.slice(body.indexOf('const restoreColumn = useCallback'), body.indexOf('}, []);', body.indexOf('const restoreColumn = useCallback')))
    const rest = body.replace(restore, '')
    const lines = rest.split('\n').filter((l) => OPENERS.test(l) && !/^\s*(\/\/|\*)/.test(l))
    expect(lines).toEqual([])
  })
})
