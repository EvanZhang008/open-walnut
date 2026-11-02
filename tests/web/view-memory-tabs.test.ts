/**
 * Each tab shows its own kept view (web/src/utils/view-memory.ts). 2026-11-02, a practice plugin
 * open in two tabs on one problem: a file picked in tab A switched tab B too, whose editor
 * remounted while the user typed, because B read the view from localStorage (one for every tab)
 * on every render and its clock re-rendered it every second.
 *
 * Here "another tab" is a write straight into the storage stub, which is what B sees of A's
 * write. tests/e2e/browser/view-state-tabs.spec.ts runs the real two tabs in Chromium and WebKit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { shownText, showKey, snapshotOf, storedText, writeView } from '../../web/src/utils/view-memory'

let store: Map<string, string>
let refuse = false
beforeEach(() => {
  store = new Map()
  refuse = false
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { if (refuse) throw new Error('quota'); store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
})
afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage })

const otherTab = (key: string, text: string) => store.set(key, text)
let n = 0
const fresh = () => `open-walnut-view:test.k${++n}`

describe('view memory: one tab, one view', () => {
  it('a key on screen keeps this tab\'s text when another tab writes; this tab\'s writes show at once', () => {
    const key = fresh()
    otherTab(key, '"a.py"')
    let calls = 0
    const leave = showKey(key, null, () => { calls++ })
    expect(shownText(key)).toBe('"a.py"')
    otherTab(key, '"b.py"')
    // Every render reads the snapshot: it is still this tab's.
    for (let i = 0; i < 5; i++) expect(shownText(key)).toBe('"a.py"')
    expect(calls).toBe(0)
    expect(writeView(key, null, 'c.py')).toBe(true)
    expect(shownText(key)).toBe('"c.py"')
    expect(store.get(key)).toBe('"c.py"')
    expect(calls).toBe(1)
    leave()
  })

  it('the next mount, with nothing of the key on screen, takes what storage holds now', () => {
    const key = fresh()
    const leave = showKey(key, null, () => {})
    writeView(key, null, 'a.py')
    otherTab(key, '"b.py"')
    expect(shownText(key)).toBe('"a.py"')
    // A second mount in this tab while the first is still on screen shows the same text.
    const leave2 = showKey(key, null, () => {})
    expect(shownText(key)).toBe('"a.py"')
    leave2()
    leave()
    expect(shownText(key)).toBe('"b.py"')
    const again = showKey(key, null, () => {})
    expect(shownText(key)).toBe('"b.py"')
    again()
  })

  it('per id: this tab writes its id without taking another tab\'s other ids, and storage keeps both', () => {
    const key = fresh()
    const leave = showKey(key, 'one', () => {})
    writeView(key, 'one', 'x')
    // Another tab sets id "two" and changes "one".
    otherTab(key, storedText(storedText(store.get(key)!, 'two', 'y'), 'one', 'z'))
    writeView(key, 'three', 'w')
    const mine = JSON.parse(shownText(key)!) as Array<[string, unknown]>
    expect(Object.fromEntries(mine)).toEqual({ one: 'x', three: 'w' })
    const kept = JSON.parse(store.get(key)!) as Array<[string, unknown]>
    expect(Object.fromEntries(kept)).toEqual({ one: 'z', two: 'y', three: 'w' })
    leave()
  })

  it('a write nothing shows goes to storage only, so the next mount reads it there', () => {
    const key = fresh()
    writeView(key, null, 'a.py')
    otherTab(key, '"b.py"')
    expect(shownText(key)).toBe('"b.py"')
  })

  it('per id: the first mount of an id in this tab takes that id from storage, already at its first render', () => {
    const key = fresh()
    let told = 0
    const leaveOne = showKey(key, 'one', () => { told++ })
    writeView(key, 'one', 'x')
    told = 0
    // Another tab sets "two" and changes "one".
    otherTab(key, storedText(storedText(store.get(key)!, 'two', 'y'), 'one', 'z'))
    // A mount of "two" renders before it subscribes: it already reads storage's "two".
    const pick = (id: string) => Object.fromEntries(JSON.parse(snapshotOf(key, id)!) as Array<[string, unknown]>)[id]
    expect(pick('two')).toBe('y')
    expect(pick('one')).toBe('x')
    const leaveTwo = showKey(key, 'two', () => {})
    expect(Object.fromEntries(JSON.parse(shownText(key)!) as Array<[string, unknown]>)).toEqual({ one: 'x', two: 'y' })
    // The "one" mount is told the key's text moved (its own value did not).
    expect(told).toBe(1)
    // A second mount of "one" while the first shows it keeps this tab's "one".
    const leaveOne2 = showKey(key, 'one', () => {})
    expect(pick('one')).toBe('x')
    leaveOne2(); leaveTwo(); leaveOne()
  })

  it('a pick of what this tab shows already still reaches storage when another tab left something else', () => {
    const key = fresh()
    const leave = showKey(key, null, () => {})
    writeView(key, null, 'a.py')
    otherTab(key, '"b.py"')
    expect(writeView(key, null, 'a.py')).toBe(false)
    expect(store.get(key)).toBe('"a.py"')
    leave()
  })

  it('a write storage refuses still holds for this load', () => {
    const key = fresh()
    refuse = true
    const leave = showKey(key, null, () => {})
    writeView(key, null, 'a.py')
    expect(store.has(key)).toBe(false)
    expect(shownText(key)).toBe('"a.py"')
    leave()
    expect(shownText(key)).toBe('"a.py"')
  })

  it('two mounts re-writing their own unchanged views write nothing and tell no one (no ping-pong)', () => {
    const key = fresh()
    let told = 0
    const leaveA = showKey(key, 'a', () => { told++ })
    const leaveB = showKey(key, 'b', () => { told++ })
    writeView(key, 'a', { view: 'files' })
    writeView(key, 'b', { view: 'chat' })
    const text = store.get(key)
    told = 0
    let writes = 0
    const set = (globalThis as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage.setItem
    ;(globalThis as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage.setItem = (k, v) => { writes++; set(k, v) }
    for (let i = 0; i < 5; i++) {
      expect(writeView(key, 'a', { view: 'files' })).toBe(false)
      expect(writeView(key, 'b', { view: 'chat' })).toBe(false)
    }
    expect(told).toBe(0)
    expect(writes).toBe(0)
    expect(store.get(key)).toBe(text)
    leaveB(); leaveA()
  })

  it('the same text again writes nothing', () => {
    const key = fresh()
    const leave = showKey(key, null, () => {})
    expect(writeView(key, null, 'a.py')).toBe(true)
    expect(writeView(key, null, 'a.py')).toBe(false)
    leave()
  })
})
