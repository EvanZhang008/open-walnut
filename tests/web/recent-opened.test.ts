/**
 * The tasks the person opened lately (web/src/utils/recent-opened.ts), what Home's Recent tab
 * lists: one entry per task at its newest open, newest first, capped; bad stored rows dropped;
 * another window's or device's opens merged in, never lost to a last-writer-wins overwrite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const serverValue = vi.hoisted(() => ({ v: null as string | null, asked: [] as Array<Record<string, string> | undefined> }))
vi.mock('@/api/client', () => ({
  apiGet: async (_path: string, params?: Record<string, string>) => {
    serverValue.asked.push(params)
    return { prefs: serverValue.v === null ? {} : { 'walnut-todo-recent-opened': { v: serverValue.v, ts: 1 } } }
  },
}))

import {
  RECENT_OPENED_KEY, RECENT_OPENED_MAX, mergeRecentOpened, parseRecentOpened, pullRecentOpened,
  readRecentOpened, recordTaskOpened, settledOrder, withOpened,
} from '../../web/src/utils/recent-opened'

class MapStorage {
  m = new Map<string, string>()
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string): void { this.m.set(k, String(v)) }
  removeItem(k: string): void { this.m.delete(k) }
}

const at = (min: number) => new Date(Date.UTC(2026, 10, 6, 19, min)).toISOString()
let local: MapStorage
let events: string[]

beforeEach(() => {
  local = new MapStorage()
  events = []
  vi.stubGlobal('localStorage', local)
  vi.stubGlobal('window', { dispatchEvent: (e: Event) => { events.push(e.type); return true } })
  serverValue.v = null
  serverValue.asked = []
})
afterEach(() => { vi.unstubAllGlobals() })

describe('parseRecentOpened', () => {
  it('keeps one row per task at its newest open, newest first, and drops bad rows', () => {
    const raw = JSON.stringify([
      { id: 'a', at: at(1) }, { id: 'b', at: at(5) }, { id: 'a', at: at(9) },
      { id: '', at: at(2) }, { id: 'c', at: 'not a date' }, { id: 7, at: at(3) }, null, 'x',
    ])
    expect(parseRecentOpened(raw)).toEqual([{ id: 'a', at: at(9) }, { id: 'b', at: at(5) }])
  })
  it('anything that is not a list reads as none', () => {
    expect(parseRecentOpened(null)).toEqual([])
    expect(parseRecentOpened('not json')).toEqual([])
    expect(parseRecentOpened('{"id":"a"}')).toEqual([])
  })
})

describe('recording an open', () => {
  it('puts the task on top, moves one already there, and tells the window', () => {
    recordTaskOpened('a', new Date(at(1)))
    recordTaskOpened('b', new Date(at(2)))
    recordTaskOpened('a', new Date(at(3)))
    expect(readRecentOpened()).toEqual([{ id: 'a', at: at(3) }, { id: 'b', at: at(2) }])
    expect(JSON.parse(local.getItem(RECENT_OPENED_KEY)!)).toEqual([{ id: 'a', at: at(3) }, { id: 'b', at: at(2) }])
    expect(events).toEqual(['walnut:recent-opened', 'walnut:recent-opened', 'walnut:recent-opened'])
  })
  it('keeps the newest RECENT_OPENED_MAX', () => {
    let list = parseRecentOpened(null)
    for (let i = 0; i < RECENT_OPENED_MAX + 5; i++) list = withOpened(list, `t${i}`, new Date(Date.UTC(2026, 10, 6, 0, i)).toISOString())
    expect(list).toHaveLength(RECENT_OPENED_MAX)
    expect(list[0].id).toBe(`t${RECENT_OPENED_MAX + 4}`)
    expect(list.some((e) => e.id === 't0')).toBe(false)
  })
  it('no id, no write', () => {
    recordTaskOpened(null)
    recordTaskOpened('')
    expect(local.getItem(RECENT_OPENED_KEY)).toBeNull()
    expect(events).toEqual([])
  })
})

describe('two windows or devices', () => {
  it('merge keeps every task at its newest open', () => {
    const mine = [{ id: 'a', at: at(10) }, { id: 'b', at: at(4) }]
    const theirs = [{ id: 'c', at: at(8) }, { id: 'b', at: at(6) }]
    expect(mergeRecentOpened(mine, theirs)).toEqual([{ id: 'a', at: at(10) }, { id: 'c', at: at(8) }, { id: 'b', at: at(6) }])
  })
  it("a pull takes in the server's opens without dropping this window's, asking for the one key", async () => {
    recordTaskOpened('mine', new Date(at(10)))
    serverValue.v = JSON.stringify([{ id: 'phone', at: at(12) }, { id: 'mine', at: at(2) }])
    await pullRecentOpened()
    expect(serverValue.asked).toEqual([{ key: RECENT_OPENED_KEY }])
    expect(readRecentOpened()).toEqual([{ id: 'phone', at: at(12) }, { id: 'mine', at: at(10) }])
  })
  it('an empty or failing server leaves the list as it was', async () => {
    recordTaskOpened('mine', new Date(at(10)))
    await pullRecentOpened()
    expect(readRecentOpened()).toEqual([{ id: 'mine', at: at(10) }])
  })
})

describe('settledOrder: a Recent tab on screen keeps its rows in place', () => {
  it('a tab just opened draws newest first', () => {
    expect(settledOrder(null, ['c', 'b', 'a'])).toEqual(['c', 'b', 'a'])
  })
  it('re-opening a shown row does not move it; a new open comes in on top; a dropped one leaves', () => {
    // a was opened again (it is first in the stored order now) and d is new; b fell off the cap.
    expect(settledOrder(['c', 'b', 'a'], ['d', 'a', 'c'])).toEqual(['d', 'c', 'a'])
  })
})
