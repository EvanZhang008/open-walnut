/**
 * The tasks the person opened lately (web/src/utils/recent-opened.ts), what Home's Recent tab
 * lists: one entry per task at its newest open, newest first, capped; bad stored rows dropped;
 * another window's or device's opens merged in, never lost to a last-writer-wins overwrite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/hooks/useWebSocket', () => ({ useEvent: () => {} }))

const serverValue = vi.hoisted(() => ({ v: null as string | null, asked: [] as Array<Record<string, string> | undefined> }))
vi.mock('@/api/client', () => ({
  apiGet: async (_path: string, params?: Record<string, string>) => {
    serverValue.asked.push(params)
    return { prefs: serverValue.v === null ? {} : { 'walnut-todo-recent-opened': { v: serverValue.v, ts: 1 } } }
  },
}))

const listeners = vi.hoisted(() => new Map<string, (event: { isTrusted: boolean }) => void>())
vi.stubGlobal('document', { addEventListener: (name: string, listener: (event: { isTrusted: boolean }) => void) => listeners.set(name, listener) })

const {
  recentOpenRecorder, withRecentHumanInput, RECENT_OPENED_KEY, RECENT_OPENED_MAX, mergeRecentOpened, parseRecentOpened, pullRecentOpened,
  mergeRecentOpenedRaw, readRecentOpened, recentRowOrder, recordTaskOpened, withOpened,
} = await import('../../web/src/utils/recent-opened')
import type { HeldRow } from '../../web/src/utils/recent-opened'

class MapStorage {
  m = new Map<string, string>()
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string): void { this.m.set(k, String(v)) }
  removeItem(k: string): void { this.m.delete(k) }
}

const at = (min: number) => new Date(Date.UTC(2026, 10, 6, 19, min)).toISOString()
let local: MapStorage
let events: string[]
let input: (event: { isTrusted: boolean }) => void

beforeEach(() => {
  local = new MapStorage()
  events = []
  vi.stubGlobal('localStorage', local)
  vi.stubGlobal('window', { dispatchEvent: (e: Event) => { events.push(e.type); return true } })
  input = listeners.get('click')!
  input({ isTrusted: true })
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
  it('a stale browser list cannot evict verified rows from the cap or change their time', () => {
    const stale = Array.from({ length: 60 }, (_, i) => ({ id: `auto${i}`, at: at(30) }))
    stale.push({ id: 'human', at: at(40) })
    expect(mergeRecentOpened([{ id: 'human', at: at(1), human: true }], stale)).toEqual([{ id: 'human', at: at(1), human: true }])
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
    expect(readRecentOpened()).toEqual([{ id: 'a', at: at(3), human: true as const }, { id: 'b', at: at(2), human: true as const }])
    expect(JSON.parse(local.getItem(RECENT_OPENED_KEY)!)).toEqual([{ id: 'a', at: at(3), human: true as const }, { id: 'b', at: at(2), human: true as const }])
    expect(events).toEqual(['walnut:recent-opened', 'walnut:recent-opened', 'walnut:recent-opened'])
  })
  it('automatic opens and synthetic events cannot add or reorder rows; async human lookups can', async () => {
    recordTaskOpened('human', new Date(at(1)))
    const openAfterLookup = recentOpenRecorder()
    await new Promise((resolve) => setTimeout(resolve, 1))
    recordTaskOpened('automatic', new Date(at(3)))
    input({ isTrusted: false })
    recordTaskOpened('human', new Date(at(4)))
    expect(readRecentOpened()).toEqual([{ id: 'human', at: at(1), human: true as const }])
    openAfterLookup('async-human')
    expect(readRecentOpened().map((e) => e.id)).toEqual(['async-human', 'human'])
  })
  it('an async lookup records the input time, not its delayed answer time', async () => {
    vi.useFakeTimers();
    const started = new Date('2026-11-09T20:00:00Z');
    vi.setSystemTime(started);
    const record = withRecentHumanInput(() => recentOpenRecorder());
    vi.setSystemTime(new Date('2026-11-09T21:00:00Z'));
    record('looked-up');
    expect(readRecentOpened()).toEqual([{ id: 'looked-up', at: started.toISOString(), human: true }]);
    vi.useRealTimers();
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
    const mine = [{ id: 'a', at: at(10), human: true as const }, { id: 'b', at: at(4), human: true as const }]
    const theirs = [{ id: 'c', at: at(8), human: true as const }, { id: 'b', at: at(6), human: true as const }]
    expect(mergeRecentOpened(mine, theirs)).toEqual([{ id: 'a', at: at(10), human: true as const }, { id: 'c', at: at(8), human: true as const }, { id: 'b', at: at(6), human: true as const }])
  })
  it("a pull takes in the server's opens without dropping this window's, asking for the one key", async () => {
    recordTaskOpened('mine', new Date(at(10)))
    serverValue.v = JSON.stringify([{ id: 'phone', at: at(12), human: true as const }, { id: 'mine', at: at(2), human: true as const }])
    await pullRecentOpened()
    expect(serverValue.asked).toEqual([{ key: RECENT_OPENED_KEY }])
    expect(readRecentOpened()).toEqual([{ id: 'phone', at: at(12), human: true as const }, { id: 'mine', at: at(10), human: true as const }])
  })
  it('an empty or failing server leaves the list as it was', async () => {
    recordTaskOpened('mine', new Date(at(10)))
    await pullRecentOpened()
    expect(readRecentOpened()).toEqual([{ id: 'mine', at: at(10), human: true as const }])
  })
})

describe('recentRowOrder: a row opened from the list keeps its place', () => {
  const opens = (pairs: Array<[string, number]>) => pairs.map(([id, min]) => ({ id, at: at(min) }))
  it('no held rows: newest open first', () => {
    expect(recentRowOrder(opens([['c', 3], ['b', 2], ['a', 1]]), new Map())).toEqual(['c', 'b', 'a'])
  })
  it("the click's own opens (within 2 s) leave the row where it was; an open elsewhere later lets it go", () => {
    const click = Date.parse(at(10))
    const held = new Map<string, HeldRow>([['a', { before: at(1), clickedAt: click }]])
    // a was clicked in the list at minute 10 (recorded twice, a second apart): it stays third.
    const afterClick = [{ id: 'a', at: new Date(click + 1000).toISOString() }, ...opens([['c', 3], ['b', 2]])]
    expect(recentRowOrder(afterClick, held)).toEqual(['c', 'b', 'a'])
    expect(held.has('a')).toBe(true)
    // A new open of another task comes in on top; a stays.
    expect(recentRowOrder([...opens([['d', 11]]), ...afterClick], held)).toEqual(['d', 'c', 'b', 'a'])
    // a opened again from a chat link a minute later: it goes to the top and is no longer held.
    expect(recentRowOrder([...opens([['a', 12], ['d', 11], ['c', 3], ['b', 2]])], held)).toEqual(['a', 'd', 'c', 'b'])
    expect(held.has('a')).toBe(false)
  })
})

describe('the boot merge and optimistic ids', () => {
  it("the raw merge keeps both sides' opens", () => {
    const local = JSON.stringify([{ id: 'offline', at: at(9) }, { id: 'b', at: at(2) }])
    const server = JSON.stringify([{ id: 'phone', at: at(7) }, { id: 'b', at: at(5) }])
    expect(JSON.parse(mergeRecentOpenedRaw(local, server))).toEqual([{ id: 'offline', at: at(9) }, { id: 'phone', at: at(7) }, { id: 'b', at: at(5) }])
  })
  it("an optimistic create's tmp- id is never recorded", () => {
    recordTaskOpened('tmp-abc123')
    expect(local.getItem(RECENT_OPENED_KEY)).toBeNull()
  })
})
