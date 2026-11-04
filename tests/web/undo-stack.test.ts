/**
 * The app's undo stack for task actions (web/src/undo/undo-stack.ts): the newest live entry
 * is what mod+z takes back, an entry lives the undo window and no longer, a held commit (a
 * delete) runs exactly once, and a second action on the same target keeps the first one's
 * undo, so one Undo goes all the way back.
 */
import { describe, expect, it } from 'vitest'
import { createUndoStack, MAX_PAUSED_MS, UNDO_WINDOW_MS, type UndoClock } from '../../web/src/undo/undo-stack'

function fakeClock() {
  let now = 0
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: UndoClock = {
    now: () => now,
    setTimeout: (fn, ms) => { timers.set(++id, { at: now + ms, fn }); return id },
    clearTimeout: (h) => { timers.delete(h as number) },
  }
  const advance = (ms: number) => {
    now += ms
    for (const [key, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now && timers.has(key)) { timers.delete(key); t.fn() }
    }
  }
  return { clock, advance, setNow: (n: number) => { now = n } }
}

describe('undo stack', () => {
  it('undoes the newest live entry first, then the one before', () => {
    const { clock } = fakeClock()
    const stack = createUndoStack(clock)
    const log: string[] = []
    stack.push({ key: 'phase:a', undo: () => log.push('a') })
    stack.push({ key: 'phase:b', undo: () => log.push('b') })
    expect(stack.undoLatest()).toBe(true)
    expect(stack.undoLatest()).toBe(true)
    expect(stack.undoLatest()).toBe(false)
    expect(log).toEqual(['b', 'a'])
  })

  it('an entry is gone when the window ends, and its commit runs once', () => {
    const { clock, advance } = fakeClock()
    const stack = createUndoStack(clock)
    let commits = 0
    let undos = 0
    const settled: string[] = []
    stack.push({ key: 'delete:a', undo: () => undos++, commit: () => commits++, onSettled: (how) => settled.push(how) })
    advance(UNDO_WINDOW_MS - 1)
    expect(stack.hasLive()).toBe(true)
    advance(1)
    expect(stack.hasLive()).toBe(false)
    expect(stack.undoLatest()).toBe(false)
    stack.commitAll()
    expect({ commits, undos, settled }).toEqual({ commits: 1, undos: 0, settled: ['expired'] })
  })

  it('an entry lives as long as its timer; a page back from the background sweeps what passed its time', () => {
    const { clock, setNow } = fakeClock()
    const stack = createUndoStack(clock)
    let undos = 0
    let commits = 0
    stack.push({ key: 'delete:a', undo: () => undos++, commit: () => commits++ })
    setNow(UNDO_WINDOW_MS + 50) // the clock moved on, the throttled timer has not fired yet
    expect(stack.hasLive()).toBe(true) // its toast is still up too: the same timer takes both down
    stack.sweep()
    expect(stack.undoLatest()).toBe(false)
    expect({ undos, commits }).toEqual({ undos: 0, commits: 1 })
  })

  it('undoing a held delete never commits it', () => {
    const { clock, advance } = fakeClock()
    const stack = createUndoStack(clock)
    let commits = 0
    let undos = 0
    const h = stack.push({ key: 'delete:a', undo: () => undos++, commit: () => commits++ })
    expect(stack.undo(h)).toBe(true)
    advance(UNDO_WINDOW_MS * 2)
    stack.commitAll()
    expect({ commits, undos }).toEqual({ commits: 0, undos: 1 })
    expect(stack.undo(h)).toBe(false)
  })

  it('the page leaving commits every held entry at once', () => {
    const { clock } = fakeClock()
    const stack = createUndoStack(clock)
    const commits: string[] = []
    stack.push({ key: 'delete:a', undo: () => {}, commit: () => commits.push('a') })
    stack.push({ key: 'delete:b', undo: () => {}, commit: () => commits.push('b') })
    stack.commitAll()
    expect(commits.sort()).toEqual(['a', 'b'])
    expect(stack.size()).toBe(0)
  })

  it('a second action on the same target stacks on the first: each Undo steps back one', () => {
    const { clock } = fakeClock()
    const stack = createUndoStack(clock)
    const log: string[] = []
    stack.push({ key: 'pin:a', undo: () => log.push('unpin') })            // pinned to Focus
    stack.push({ key: 'pin:a', undo: () => log.push('back to Focus') })    // then moved
    expect(stack.size()).toBe(2)
    stack.undoLatest()
    stack.undoLatest()
    expect(log).toEqual(['back to Focus', 'unpin'])
    expect(stack.undoLatest()).toBe(false)
  })

  it('the second half of one gesture keeps the first undo (pin, then its group: one Undo unpins)', () => {
    const { clock, advance } = fakeClock()
    const stack = createUndoStack(clock)
    const log: string[] = []
    const settled: string[] = []
    stack.push({ key: 'pin:a', undo: () => log.push('unpin'), onSettled: (how) => settled.push(how) })
    advance(3000)
    stack.push({ key: 'pin:a', merge: true, undo: () => log.push('back to first tier') })
    expect(stack.size()).toBe(1)
    // The replacement starts a full window of its own.
    advance(UNDO_WINDOW_MS - 1)
    expect(stack.undoLatest()).toBe(true)
    expect(log).toEqual(['unpin'])
    expect(settled).toEqual(['replaced'])
  })

  it('an expired entry on the same target is not inherited', () => {
    const { clock, advance } = fakeClock()
    const stack = createUndoStack(clock)
    const log: string[] = []
    stack.push({ key: 'phase:a', undo: () => log.push('first') })
    advance(UNDO_WINDOW_MS + 1)
    stack.push({ key: 'phase:a', merge: true, undo: () => log.push('second') })
    stack.undoLatest()
    expect(log).toEqual(['second'])
  })

  it('drop forgets an entry with neither its undo nor its commit (a refused action)', () => {
    const { clock } = fakeClock()
    const stack = createUndoStack(clock)
    let ran = 0
    stack.push({ key: 'column-done:a', undo: () => ran++, commit: () => ran++ })
    expect(stack.drop('column-done:a')).toBe(true)
    expect(stack.undoLatest()).toBe(false)
    stack.commitAll()
    expect(ran).toBe(0)
  })

  it('discard takes away only its own entry: a newer one on the same target stays (a late refusal)', () => {
    const { clock } = fakeClock()
    const stack = createUndoStack(clock)
    const log: string[] = []
    const settled: string[] = []
    const pin = stack.push({ key: 'pin:a', undo: () => log.push('pin'), onSettled: (how) => settled.push(`pin:${how}`) })
    const unpin = stack.push({ key: 'pin:a', undo: () => log.push('unpin'), onSettled: (how) => settled.push(`unpin:${how}`) })
    // The pin's write is refused after the unpin: the unpin's own entry stays.
    expect(stack.discard(pin)).toBe(true)
    expect(stack.size()).toBe(1)
    expect(stack.discard(pin)).toBe(false)
    expect(stack.discard(unpin)).toBe(true)
    expect(stack.undoLatest()).toBe(false)
    expect(log).toEqual([])
    expect(settled).toEqual(['pin:dropped', 'unpin:dropped'])
  })

  it('an undo that throws still leaves the stack consistent', () => {
    const { clock } = fakeClock()
    const stack = createUndoStack(clock)
    const log: string[] = []
    stack.push({ key: 'a', undo: () => log.push('a') })
    stack.push({ key: 'b', undo: () => { throw new Error('boom') } })
    const err = console.error
    console.error = () => {}
    try { expect(stack.undoLatest()).toBe(true) } finally { console.error = err }
    expect(stack.undoLatest()).toBe(true)
    expect(log).toEqual(['a'])
  })

  it('an entry out of sight keeps the time it had: its clock stands still until it is shown again', () => {
    const { clock, advance } = fakeClock()
    const stack = createUndoStack(clock)
    const settled: string[] = []
    const h = stack.push({ key: 'pin:a', undo: () => {}, onSettled: (how) => settled.push(how) })
    advance(1_000)
    stack.pause(h)
    advance(3_000)
    expect(stack.timeLeft(h)).toBe(UNDO_WINDOW_MS - 1_000)
    stack.resume(h)
    advance(UNDO_WINDOW_MS - 1_001)
    expect(settled).toEqual([])
    advance(2)
    expect(settled).toEqual(['expired'])
  })

  it('an entry stands still at most MAX_PAUSED_MS all told, then ends as it would have', () => {
    const { clock, advance } = fakeClock()
    const stack = createUndoStack(clock)
    const settled: string[] = []
    const h = stack.push({ key: 'delete:a', undo: () => {}, commit: () => settled.push('commit'), onSettled: (how) => settled.push(how) })
    stack.pause(h)
    advance(MAX_PAUSED_MS + UNDO_WINDOW_MS - 1)
    expect(settled).toEqual([])
    advance(2)
    expect(settled).toEqual(['commit', 'expired'])
    // Paused again after its spare time was used: nothing more to give.
    const h2 = stack.push({ key: 'delete:b', undo: () => {}, onSettled: (how) => settled.push(`b:${how}`) })
    stack.pause(h2)
    advance(MAX_PAUSED_MS)
    stack.resume(h2)
    stack.pause(h2)
    advance(UNDO_WINDOW_MS + 1)
    expect(settled).toContain('b:expired')
  })

  it('an older Undo pressed on its own button takes the newer ones on the same target with it', () => {
    const { clock } = fakeClock()
    const stack = createUndoStack(clock)
    const log: string[] = []
    const settled: string[] = []
    const first = stack.push({ key: 'snooze:a', undo: () => log.push('no snooze'), onSettled: (how) => settled.push(`first:${how}`) })
    stack.push({ key: 'snooze:a', undo: () => log.push('first date'), onSettled: (how) => settled.push(`second:${how}`) })
    stack.push({ key: 'pin:b', undo: () => log.push('unpin b') })
    expect(stack.undo(first)).toBe(true)
    expect(log).toEqual(['no snooze'])
    expect(settled).toEqual(['second:dropped', 'first:undone'])
    // The other target's Undo is untouched.
    expect(stack.undoLatest()).toBe(true)
    expect(log).toEqual(['no snooze', 'unpin b'])
    expect(stack.undoLatest()).toBe(false)
  })
})

