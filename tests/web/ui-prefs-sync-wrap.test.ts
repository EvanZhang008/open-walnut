/**
 * ui-prefs-sync mirrors localStorage writes by wrapping Storage.prototype, not
 * by assigning `localStorage.setItem`: on WebKit (the Mac app) that assignment
 * stores an item named "setItem" and never replaces the method, so no
 * preference (host banner dismissals included, C92) ever reached the server.
 *
 * The fake below behaves like WebKit per WebIDL: Storage has a named property
 * setter, so assigning ANY string property on an instance stores an item (the
 * built-in methods still resolve from the prototype). A plain class fake let
 * the old instance assignment "work" and hid the bug.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

const puts = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock('@/api/client', () => ({
  apiGet: async () => ({ prefs: {} }),
  apiPut: async (_path: string, body: Record<string, unknown>) => { puts.push(body) },
}))
vi.mock('@/api/device-token', () => ({ getDeviceToken: () => null }))

const items = new WeakMap<object, Map<string, string>>()
const itemsOf = (s: object): Map<string, string> => items.get(s)!

/** Storage's methods live on its prototype (what ui-prefs-sync wraps). */
class FakeStorage {
  getItem(k: string): string | null { const m = itemsOf(this); return m.has(k) ? m.get(k)! : null }
  setItem(k: string, v: string): void { itemsOf(this).set(k, String(v)) }
  removeItem(k: string): void { itemsOf(this).delete(k) }
}

/** An instance with WebIDL's named setter: `storage.anything = v` stores the item "anything". */
function webkitStorage(): FakeStorage {
  const target = new FakeStorage()
  const m = new Map<string, string>()
  const proxy = new Proxy(target, {
    set(t, prop, value) {
      if (typeof prop === 'symbol') return Reflect.set(t, prop, value)
      m.set(prop, String(value))
      return true
    },
  })
  items.set(proxy, m)
  items.set(target, m)
  return proxy
}
const keysOf = (s: FakeStorage): string[] => [...itemsOf(s).keys()]

const ORIGINAL_SET = FakeStorage.prototype.setItem
let local: FakeStorage
let session: FakeStorage
beforeAll(async () => {
  local = webkitStorage()
  session = webkitStorage()
  // An older bundle's leftover on WebKit: the function source stored as an item.
  local.setItem('setItem', '(key, value) => { origSet(key, value); queue(key, value); }')
  Object.assign(globalThis, { Storage: FakeStorage, localStorage: local, sessionStorage: session, window: { addEventListener: () => {} } })
  const { initUiPrefsSync } = await import('../../web/src/utils/ui-prefs-sync')
  await initUiPrefsSync()
})
afterAll(() => {
  for (const k of ['Storage', 'localStorage', 'sessionStorage', 'window']) delete (globalThis as Record<string, unknown>)[k]
})

describe('the fake is WebKit-shaped', () => {
  it('assigning the method stores an item named after it and replaces nothing', () => {
    const s = webkitStorage()
    ;(s as unknown as Record<string, unknown>).setItem = () => 'replaced'
    expect(s.getItem('setItem')).toContain('replaced')
    s.setItem('k', 'v')
    expect(s.getItem('k')).toBe('v')
    expect(keysOf(s).sort()).toEqual(['k', 'setItem'])
  })
})

describe('ui-prefs-sync write mirror', () => {
  it('mirrors a syncable localStorage write through the prototype, and removes the WebKit leftover', async () => {
    expect(keysOf(local)).not.toContain('setItem')
    vi.useFakeTimers()
    localStorage.setItem('open-walnut-host-banner-dismissed', '["buildbox|claude_outdated|2.1.280"]')
    localStorage.removeItem('open-walnut-other')
    sessionStorage.setItem('open-walnut-session-only', '1')
    localStorage.setItem('not-synced', '1')
    await vi.advanceTimersByTimeAsync(1_000)
    vi.useRealTimers()
    expect(puts).toHaveLength(1)
    const prefs = puts[0].prefs as Record<string, { v: string | null }>
    expect(Object.keys(prefs).sort()).toEqual(['open-walnut-host-banner-dismissed', 'open-walnut-other'])
    expect(prefs['open-walnut-host-banner-dismissed'].v).toBe('["buildbox|claude_outdated|2.1.280"]')
    expect(prefs['open-walnut-other'].v).toBeNull()
    // The writes themselves still landed, as items (never as properties).
    expect(local.getItem('open-walnut-host-banner-dismissed')).toContain('buildbox')
    expect(session.getItem('open-walnut-session-only')).toBe('1')
    expect(keysOf(local)).not.toContain('setItem')
  })

  it('a second evaluation of the module (HMR) replaces the wrapper instead of stacking on it: one write, one PUT', async () => {
    vi.resetModules()
    const again = await import('../../web/src/utils/ui-prefs-sync')
    await again.initUiPrefsSync()
    // The raw methods were captured once for the page, before any wrapper.
    const raw = (FakeStorage.prototype as unknown as Record<symbol, { set: unknown }>)[Symbol.for('open-walnut.ui-prefs-sync.raw-storage')]
    expect(raw.set).toBe(ORIGINAL_SET)
    expect(FakeStorage.prototype.setItem).not.toBe(ORIGINAL_SET)
    puts.length = 0
    vi.useFakeTimers()
    localStorage.setItem('open-walnut-after-hmr', '1')
    await vi.advanceTimersByTimeAsync(1_000)
    vi.useRealTimers()
    expect(puts).toHaveLength(1)
    expect(Object.keys(puts[0].prefs as object)).toEqual(['open-walnut-after-hmr'])
    expect(local.getItem('open-walnut-after-hmr')).toBe('1')
  })
})
