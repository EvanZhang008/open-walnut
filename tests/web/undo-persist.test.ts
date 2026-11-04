/**
 * The Undos saved as the page goes come back once, for the time they had left
 * (web/src/undo/undo-persist.ts).
 */
import { describe, expect, it } from 'vitest'
import { RETURN_WITHIN_MS, saveUndos, takeUndos, UNDO_PERSIST_NAME, type PersistedUndo } from '../../web/src/undo/undo-persist'

function memoryStore() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
  }
}

const undo = (key: string, leftMs: number, savedAt = 1_000): PersistedUndo => ({ kind: 'phase', data: { id: key }, key, title: 'Task completed', leftMs, savedAt })

describe('undo-persist', () => {
  it('gives back what had time left, with the time it had (the reload does not count), ending first first, once', () => {
    const store = memoryStore()
    saveUndos(store, [undo('b', 4_000), undo('a', 3_000), undo('spent', 200)])
    // Four seconds of reload: the two still have their 3 and 4 seconds.
    const back = takeUndos(store, 5_000)
    expect(back.map((u) => [u.key, u.leftMs])).toEqual([['a', 3_000], ['b', 4_000]])
    expect(store.map.has(UNDO_PERSIST_NAME)).toBe(false)
    expect(takeUndos(store, 5_000)).toEqual([])
  })

  it('says when nothing could be kept, so a held delete goes now instead of waiting for a page that brings nothing back', () => {
    expect(saveUndos(undefined, [undo('a', 4_000)])).toBe(false)
    const full = { ...memoryStore(), setItem: () => { throw new Error('QuotaExceededError') } }
    expect(saveUndos(full, [undo('a', 4_000)])).toBe(false)
    expect(saveUndos(memoryStore(), [undo('a', 4_000)])).toBe(true)
  })

  it('a page gone too long brings nothing back', () => {
    const store = memoryStore()
    saveUndos(store, [undo('a', 4_000, 1_000)])
    expect(takeUndos(store, 1_000 + RETURN_WITHIN_MS)).toEqual([])
  })

  it('an empty list clears what an earlier page saved', () => {
    const store = memoryStore()
    saveUndos(store, [undo('a', 9_000)])
    saveUndos(store, [])
    expect(takeUndos(store, 1_000)).toEqual([])
  })

  it('a broken or foreign value reads as nothing', () => {
    const store = memoryStore()
    store.setItem(UNDO_PERSIST_NAME, '{not json')
    expect(takeUndos(store, 1_000)).toEqual([])
    store.setItem(UNDO_PERSIST_NAME, JSON.stringify([{ key: 'x' }, undo('ok', 9_000)]))
    expect(takeUndos(store, 1_000).map((u) => u.key)).toEqual(['ok'])
  })

  it('a store that throws costs nothing', () => {
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') }, removeItem: () => {} }
    expect(() => saveUndos(broken, [undo('a', 9_000)])).not.toThrow()
    expect(takeUndos(broken, 0)).toEqual([])
    expect(takeUndos(undefined, 0)).toEqual([])
  })
})
