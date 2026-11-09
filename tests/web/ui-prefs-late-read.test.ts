/**
 * The first GET /api/ui-prefs has 2.5 s before the app renders. Under load (a deploy, a busy
 * Mac) it timed out, the page gave up for its whole life and opened on the default layout, and
 * the defaults components saved after render were stamped newer and PUT over the user's prefs.
 *
 * Now a failed first read is retried in the background with longer deadlines, writes made
 * before it answers are held (never sent, stamped weakest), and when it answers the server's
 * values win, the keys it lacks are sent up, and the app mounts again once (when the person
 * has not touched the page and has no unsaved text).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Entry = { v: string | null; ts: number }
const server = vi.hoisted(() => ({
  prefs: {} as Record<string, { v: string | null; ts: number }>,
  /** 'fail' answers like a timed-out read, 'refuse' with a 403, 'empty' with no body; 'ok' answers with `prefs`. */
  mode: 'fail' as 'fail' | 'ok' | 'refuse' | 'empty',
  gets: [] as Array<{ key?: string; timeoutMs?: number; at: number }>,
  puts: [] as Array<{ prefs: Record<string, { v: string | null; ts: number }>; at: number }>,
}))
vi.mock('@/api/client', () => ({
  apiGet: async (_path: string, params?: { key?: string }, opts?: { timeoutMs?: number }) => {
    server.gets.push({ key: params?.key, timeoutMs: opts?.timeoutMs, at: Date.now() })
    if (server.mode === 'fail') throw new Error('The operation timed out.')
    if (server.mode === 'refuse') throw Object.assign(new Error('Forbidden'), { status: 403 })
    if (server.mode === 'empty') return undefined
    if (params?.key) return { prefs: params.key in server.prefs ? { [params.key]: server.prefs[params.key] } : {} }
    return { prefs: { ...server.prefs } }
  },
  apiPut: async (_path: string, body: { prefs: Record<string, Entry> }) => {
    server.puts.push({ prefs: body.prefs, at: Date.now() })
    for (const [k, e] of Object.entries(body.prefs)) server.prefs[k] = e
  },
}))
vi.mock('@/api/device-token', () => ({ getDeviceToken: () => null }))

class MapStorage {
  m = new Map<string, string>()
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string): void { this.m.set(k, String(v)) }
  removeItem(k: string): void { this.m.delete(k) }
}
class FakeStorageEvent extends Event {
  key: string | null
  newValue: string | null
  constructor(type: string, init: { key?: string | null; newValue?: string | null } = {}) {
    super(type)
    this.key = init.key ?? null
    this.newValue = init.newValue ?? null
  }
}

const COLUMNS = 'open-walnut-layout:home-columns'
const USERS_COLUMNS = JSON.stringify({ v: 1, value: [{ id: 'users-own', locked: true }] })
const DEFAULT_COLUMNS = JSON.stringify({ v: 1, value: [{ id: 'ceo-chat', locked: false }] })
const WEIGHTS = 'open-walnut-col-weights'
const META = 'open-walnut-ui-prefs-sync-meta'

let local: MapStorage
let session: MapStorage
let win: EventTarget
/** A document whose visibility a test sets. */
class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible'
  setVisibility(v: 'visible' | 'hidden'): void { this.visibilityState = v; this.dispatchEvent(new Event('visibilitychange')) }
}
let doc: FakeDocument
let mod: typeof import('../../web/src/utils/ui-prefs-sync')
const storageEvents: string[] = []

async function boot(seed: Record<string, string> = {}): Promise<void> {
  local = new MapStorage()
  for (const [k, v] of Object.entries(seed)) local.m.set(k, v)
  win = new EventTarget()
  win.addEventListener('storage', (e) => { storageEvents.push((e as FakeStorageEvent).key ?? '') })
  doc = new FakeDocument()
  Object.assign(globalThis, { Storage: MapStorage, localStorage: local, sessionStorage: session, window: win, document: doc, StorageEvent: FakeStorageEvent })
  vi.resetModules()
  mod = await import('../../web/src/utils/ui-prefs-sync')
  await mod.initUiPrefsSync()
}

const metaOf = (): Record<string, number> => JSON.parse(local.getItem(META) ?? '{}')
const putKeys = (): string[] => server.puts.flatMap((p) => Object.keys(p.prefs))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-09T16:00:00Z'))
  server.prefs = { [COLUMNS]: { v: USERS_COLUMNS, ts: 1_000 }, [WEIGHTS]: { v: '[2,1]', ts: 1_000 } }
  server.mode = 'fail'
  server.gets = []
  server.puts = []
  storageEvents.length = 0
  session = new MapStorage()
  // A real browser (the Mac app), not automation: the layout record is adopted.
  Object.defineProperty(globalThis, 'navigator', { value: { webdriver: false }, configurable: true })
})
afterEach(() => {
  mod?.__resetUiPrefsSyncForTests()
  vi.useRealTimers()
  for (const k of ['Storage', 'localStorage', 'sessionStorage', 'window', 'document', 'StorageEvent']) delete (globalThis as Record<string, unknown>)[k]
})

describe('a first read that times out', () => {
  it('holds writes made before the server answered: never PUT, never stamped newer, and the server wins when it answers', async () => {
    await boot()
    expect(server.gets).toHaveLength(1)
    expect(server.gets[0].timeoutMs).toBe(2500)
    // The page rendered on defaults; components save them.
    localStorage.setItem(COLUMNS, DEFAULT_COLUMNS)
    localStorage.setItem(WEIGHTS, '[1,1]')
    localStorage.setItem('open-walnut-only-here', 'mine')
    await vi.advanceTimersByTimeAsync(1_000) // past the flush debounce, and the first retry (fails)
    expect(server.puts).toHaveLength(0)
    expect(metaOf()[COLUMNS]).toBe(0)
    expect(metaOf()[WEIGHTS]).toBe(0)

    const remount = vi.fn()
    mod.setLatePrefsHost({ remount, canRemount: () => true })
    server.mode = 'ok'
    await vi.advanceTimersByTimeAsync(3_000) // the second retry
    expect(local.getItem(COLUMNS)).toBe(USERS_COLUMNS)
    expect(local.getItem(WEIGHTS)).toBe('[2,1]')
    expect(local.getItem('open-walnut-only-here')).toBe('mine')
    // Only the key the server does not hold went up; the user's values on the server are intact.
    expect(putKeys()).toEqual(['open-walnut-only-here'])
    expect(server.prefs[COLUMNS].v).toBe(USERS_COLUMNS)
    expect(server.prefs[WEIGHTS].v).toBe('[2,1]')
    expect(remount).toHaveBeenCalledTimes(1)
    expect(storageEvents).toEqual(expect.arrayContaining([COLUMNS, WEIGHTS]))
    expect(metaOf()[COLUMNS]).toBe(1_000)
  })

  it('retries with backoff and longer deadlines, and stops once it succeeds', async () => {
    await boot()
    const plan = mod.RETRY_PLAN
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(plan[i].waitMs)
    expect(server.gets.map((g) => g.timeoutMs)).toEqual([2500, plan[0].timeoutMs, plan[1].timeoutMs, plan[2].timeoutMs])
    const gaps = server.gets.slice(1).map((g, i) => g.at - server.gets[i].at)
    expect(gaps).toEqual([plan[0].waitMs, plan[1].waitMs, plan[2].waitMs])
    expect(plan.map((s) => s.waitMs)).toEqual([...plan.map((s) => s.waitMs)].sort((a, b) => a - b))
    expect(plan.map((s) => s.timeoutMs).every((t) => t > 2500)).toBe(true)
    // About two minutes in all.
    const total = plan.reduce((n, s) => n + s.waitMs, 0)
    expect(total).toBeGreaterThan(60_000)
    expect(total).toBeLessThan(180_000)

    server.mode = 'ok'
    await vi.advanceTimersByTimeAsync(plan[3].waitMs)
    const after = server.gets.length
    expect(local.getItem(COLUMNS)).toBe(USERS_COLUMNS)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(server.gets.length).toBe(after)
  })

  it('past the plan it keeps trying slowly, and at once when the page comes back online', async () => {
    await boot()
    const planMs = mod.RETRY_PLAN.reduce((n, s) => n + s.waitMs, 0)
    await vi.advanceTimersByTimeAsync(planMs)
    const n = server.gets.length
    expect(n).toBe(1 + mod.RETRY_PLAN.length)
    await vi.advanceTimersByTimeAsync(mod.SLOW_RETRY_MS)
    expect(server.gets.length).toBe(n + 1)
    server.mode = 'ok'
    win.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(server.gets.length).toBe(n + 2)
    expect(local.getItem(WEIGHTS)).toBe('[2,1]')
    await vi.advanceTimersByTimeAsync(mod.SLOW_RETRY_MS * 3)
    expect(server.gets.length).toBe(n + 2)
  })

  it('after the late read, writes are the person\'s again: stamped and PUT (last writer wins)', async () => {
    await boot()
    server.mode = 'ok'
    await vi.advanceTimersByTimeAsync(mod.RETRY_PLAN[0].waitMs)
    expect(local.getItem(WEIGHTS)).toBe('[2,1]')
    server.puts = []
    localStorage.setItem(WEIGHTS, '[3,1]')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(putKeys()).toEqual([WEIGHTS])
    expect(server.prefs[WEIGHTS].v).toBe('[3,1]')
    expect(server.prefs[WEIGHTS].ts).toBeGreaterThan(1_000)
  })

  it('does not remount in view once the person pressed or typed, or with unsaved text; the values wait in storage', async () => {
    await boot()
    const remount = vi.fn()
    mod.setLatePrefsHost({ remount, canRemount: () => true })
    win.dispatchEvent(new Event('pointerdown'))
    server.mode = 'ok'
    await vi.advanceTimersByTimeAsync(mod.RETRY_PLAN[0].waitMs)
    expect(local.getItem(COLUMNS)).toBe(USERS_COLUMNS)
    expect(storageEvents).toContain(COLUMNS)
    expect(remount).not.toHaveBeenCalled()

    mod.__resetUiPrefsSyncForTests()
    server.mode = 'fail'
    await boot()
    const remount2 = vi.fn()
    mod.setLatePrefsHost({ remount: remount2, canRemount: () => false })
    server.mode = 'ok'
    await vi.advanceTimersByTimeAsync(mod.RETRY_PLAN[0].waitMs)
    expect(local.getItem(COLUMNS)).toBe(USERS_COLUMNS)
    expect(remount2).not.toHaveBeenCalled()
  })

  it('no remount when nothing the UI reads changed', async () => {
    await boot({ [COLUMNS]: USERS_COLUMNS, [WEIGHTS]: '[2,1]', [META]: JSON.stringify({ [COLUMNS]: 1_000, [WEIGHTS]: 1_000 }) })
    const remount = vi.fn()
    mod.setLatePrefsHost({ remount, canRemount: () => true })
    server.mode = 'ok'
    await vi.advanceTimersByTimeAsync(mod.RETRY_PLAN[0].waitMs)
    expect(remount).not.toHaveBeenCalled()
    expect(server.puts).toHaveLength(0)
  })

  it('a page whose every read failed leaves its defaults weaker than the server at the next boot', async () => {
    await boot({ [WEIGHTS]: '[5,5]', [META]: JSON.stringify({ [WEIGHTS]: 5_000 }) })
    // This page wrote a default over a value it had stamped newer than the server's (5000 > 1000).
    localStorage.setItem(WEIGHTS, '[1,1]')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(server.puts).toHaveLength(0)
    // Reload: the next boot's first read answers.
    mod.__resetUiPrefsSyncForTests()
    server.mode = 'ok'
    const kept = new Map(local.m)
    await boot(Object.fromEntries(kept))
    expect(local.getItem(WEIGHTS)).toBe('[2,1]')
    expect(putKeys()).not.toContain(WEIGHTS)
  })
})

describe('a late read the page cannot show at once', () => {
  async function deferredByScroll(): Promise<ReturnType<typeof vi.fn>> {
    await boot()
    const remount = vi.fn()
    mod.setLatePrefsHost({ remount, canRemount: () => true })
    win.dispatchEvent(new Event('wheel'))
    server.mode = 'ok'
    await vi.advanceTimersByTimeAsync(mod.RETRY_PLAN[0].waitMs)
    expect(local.getItem(WEIGHTS)).toBe('[2,1]')
    return remount
  }

  it('a page answered after its first minute is not remounted in view, even untouched', async () => {
    await boot()
    const remount = vi.fn()
    mod.setLatePrefsHost({ remount, canRemount: () => true })
    const plan = mod.RETRY_PLAN
    // Fails through the first five retries (42 s of waits, then the sixth 30 s later: past a minute).
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(plan[i].waitMs)
    server.mode = 'ok'
    await vi.advanceTimersByTimeAsync(plan[5].waitMs)
    expect(local.getItem(COLUMNS)).toBe(USERS_COLUMNS)
    expect(remount).not.toHaveBeenCalled()
  })

  it('until it is shown, a default re-saved with no touch since the merge is put back, never sent', async () => {
    const remount = await deferredByScroll()
    expect(remount).not.toHaveBeenCalled()
    server.puts = []
    // A component still holding its default saves it again (an effect, no person involved).
    localStorage.setItem(WEIGHTS, '[1,1]')
    localStorage.removeItem(COLUMNS)
    // A key the merge did not touch syncs as usual.
    localStorage.setItem('open-walnut-untouched', 'x')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(putKeys()).toEqual(['open-walnut-untouched'])
    expect(local.getItem(WEIGHTS)).toBe('[2,1]')
    expect(local.getItem(COLUMNS)).toBe(USERS_COLUMNS)
    expect(server.prefs[WEIGHTS].v).toBe('[2,1]')
  })

  it('a change the person makes after the merge is theirs: kept, stamped and sent, even before the remount', async () => {
    const remount = await deferredByScroll()
    server.puts = []
    win.dispatchEvent(new Event('pointerdown'))
    localStorage.setItem(WEIGHTS, '[9,1]')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(putKeys()).toEqual([WEIGHTS])
    expect(server.prefs[WEIGHTS].v).toBe('[9,1]')
    expect(server.prefs[WEIGHTS].ts).toBeGreaterThan(1_000)
    expect(local.getItem(WEIGHTS)).toBe('[9,1]')
    expect(remount).not.toHaveBeenCalled()
  })

  it('remounts once the page has been hidden a while, then writes are sent again', async () => {
    const remount = await deferredByScroll()
    doc.setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(5_000)
    doc.setVisibility('visible') // back too soon: nothing moves under the person
    await vi.advanceTimersByTimeAsync(60_000)
    expect(remount).not.toHaveBeenCalled()
    doc.setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(remount).toHaveBeenCalledTimes(1)
    server.puts = []
    localStorage.setItem(WEIGHTS, '[7,1]')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(putKeys()).toEqual([WEIGHTS])
    doc.setVisibility('visible')
    doc.setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(remount).toHaveBeenCalledTimes(1)
  })

  it('a hidden page with unsaved text is not remounted', async () => {
    await boot()
    let unsaved = true
    const remount = vi.fn()
    mod.setLatePrefsHost({ remount, canRemount: () => !unsaved })
    server.mode = 'ok'
    await vi.advanceTimersByTimeAsync(mod.RETRY_PLAN[0].waitMs)
    doc.setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(remount).not.toHaveBeenCalled()
    unsaved = false
    doc.setVisibility('visible')
    doc.setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(remount).toHaveBeenCalledTimes(1)
  })
})

describe('answers that are not prefs', () => {
  it('a refusal asking again will not change (403) ends the wait: no more reads, writes sync as before', async () => {
    server.mode = 'refuse'
    await boot()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(server.gets).toHaveLength(1)
    localStorage.setItem(WEIGHTS, '[1,1]')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(putKeys()).toEqual([WEIGHTS])
  })

  it('an empty answer is no answer: the page keeps asking and keeps holding', async () => {
    server.mode = 'empty'
    await boot()
    localStorage.setItem(WEIGHTS, '[1,1]')
    await vi.advanceTimersByTimeAsync(mod.RETRY_PLAN[0].waitMs)
    expect(server.gets).toHaveLength(2)
    expect(server.puts).toHaveLength(0)
    server.mode = 'ok'
    await vi.advanceTimersByTimeAsync(mod.RETRY_PLAN[1].waitMs)
    expect(local.getItem(WEIGHTS)).toBe('[2,1]')
  })
})

describe('unchanged paths', () => {
  it('a first read that answers in time merges at boot and makes no background reads', async () => {
    server.mode = 'ok'
    await boot()
    expect(local.getItem(COLUMNS)).toBe(USERS_COLUMNS)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(server.gets).toHaveLength(1)
    localStorage.setItem(WEIGHTS, '[4,1]')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(putKeys()).toEqual([WEIGHTS])
  })

  it('the crash-recovery skip reads nothing and mirrors writes at once, as before', async () => {
    const { SKIP_PREFS_MERGE_FLAG } = await import('../../web/src/utils/crash-recovery')
    session.m.set(SKIP_PREFS_MERGE_FLAG, '1') // raw: the prototype is still the previous boot's wrapper
    await boot()
    expect(server.gets).toHaveLength(0)
    localStorage.setItem(WEIGHTS, '[1,1]')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(putKeys()).toEqual([WEIGHTS])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(server.gets).toHaveLength(0)
  })

  it('an automated browser that did not opt in still never adopts nor writes the layout record late', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: { webdriver: true }, configurable: true })
    await boot()
    localStorage.setItem(COLUMNS, DEFAULT_COLUMNS)
    server.mode = 'ok'
    await vi.advanceTimersByTimeAsync(mod.RETRY_PLAN[0].waitMs)
    expect(local.getItem(COLUMNS)).toBe(DEFAULT_COLUMNS)
    expect(local.getItem(WEIGHTS)).toBe('[2,1]')
    expect(putKeys()).not.toContain(COLUMNS)
  })
})
