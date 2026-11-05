/**
 * A reader who closed an idle compaction's run keeps it closed in that session, across a reload
 * (web/src/components/sessions/idle-run-pref.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { idleRunsClosed, noteIdleRunsClosed } from '../../web/src/components/sessions/idle-run-pref'

const mem = new Map<string, string>()
beforeEach(() => {
  mem.clear()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v) },
  }
})

describe('the closed idle compaction runs', () => {
  it('are kept per session, and opening one again forgets it', () => {
    expect(idleRunsClosed('s1')).toBe(false)
    noteIdleRunsClosed('s1', true)
    expect(idleRunsClosed('s1')).toBe(true)
    expect(idleRunsClosed('s2')).toBe(false)
    noteIdleRunsClosed('s1', false)
    expect(idleRunsClosed('s1')).toBe(false)
  })

  it('a broken stored value reads as none', () => {
    mem.set('walnut.idle-compact-runs-closed', '{not json')
    expect(idleRunsClosed('s1')).toBe(false)
    noteIdleRunsClosed('s1', true)
    expect(idleRunsClosed('s1')).toBe(true)
  })

  it('no session, nothing kept', () => {
    noteIdleRunsClosed(null, true)
    expect(idleRunsClosed(null)).toBe(false)
    expect(mem.size).toBe(0)
  })
})
