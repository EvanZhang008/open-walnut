/**
 * The boot merge adopts the server's layout record (Home's and Org's columns, the ask the chat
 * slot shows): a Mac app relaunch gets back what it showed. Under browser automation it does
 * not, unless the spec opts in: the shared Playwright fixture server would otherwise hand one
 * spec the columns another left open (layout-record.ts adoptsServerLayout).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const serverPrefs = vi.hoisted(() => ({ value: {} as Record<string, { v: string | null; ts: number }> }))
const puts = vi.hoisted(() => [] as Array<{ prefs: Record<string, unknown> }>)
vi.mock('@/api/client', () => ({
  apiGet: async () => ({ prefs: serverPrefs.value }),
  apiPut: async (_p: string, body: { prefs: Record<string, unknown> }) => { puts.push(body) },
}))
vi.mock('@/api/device-token', () => ({ getDeviceToken: () => null }))

class MapStorage {
  m = new Map<string, string>()
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string): void { this.m.set(k, String(v)) }
  removeItem(k: string): void { this.m.delete(k) }
}

const COLUMNS = 'open-walnut-layout:home-columns'
const SAVED = JSON.stringify({ v: 1, value: [{ id: 's1', locked: true }] })
let local: MapStorage
const origNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

async function boot(webdriver: boolean, optIn = false): Promise<void> {
  local = new MapStorage()
  if (optIn) local.m.set('walnut-e2e-layout-record', '1')
  Object.assign(globalThis, { Storage: MapStorage, localStorage: local, sessionStorage: new MapStorage(), window: { addEventListener: () => {} } })
  Object.defineProperty(globalThis, 'navigator', { value: { webdriver }, configurable: true })
  vi.resetModules()
  const { initUiPrefsSync } = await import('../../web/src/utils/ui-prefs-sync')
  await initUiPrefsSync()
}

beforeEach(() => {
  serverPrefs.value = { [COLUMNS]: { v: SAVED, ts: 5 }, 'open-walnut-col-weights': { v: '[1,1]', ts: 5 } }
})
afterEach(() => {
  for (const k of ['Storage', 'localStorage', 'sessionStorage', 'window']) delete (globalThis as Record<string, unknown>)[k]
  if (origNavigator) Object.defineProperty(globalThis, 'navigator', origNavigator)
})

async function written(key: string): Promise<boolean> {
  puts.length = 0
  vi.useFakeTimers()
  localStorage.setItem(key, JSON.stringify({ v: 1, value: [{ id: 'mine', locked: true }] }))
  await vi.advanceTimersByTimeAsync(1_000)
  vi.useRealTimers()
  return puts.some((b) => key in b.prefs)
}

describe('an automated browser never writes the layout record it did not read', () => {
  it('a real browser sends its columns to the server', async () => {
    await boot(false)
    expect(await written(COLUMNS)).toBe(true)
  })
  it('an automated browser (a Playwright look at the live server) does not', async () => {
    await boot(true)
    expect(await written(COLUMNS)).toBe(false)
    expect(await written('open-walnut-col-weights')).toBe(true)
  })
  it('an automated browser that opted in does', async () => {
    await boot(true, true)
    expect(await written(COLUMNS)).toBe(true)
  })
})

describe('boot merge of the layout record', () => {
  it('a real browser (the Mac app after a relaunch) adopts the saved columns', async () => {
    await boot(false)
    expect(local.getItem(COLUMNS)).toBe(SAVED)
  })
  it('an automated browser does not, but still adopts other prefs', async () => {
    await boot(true)
    expect(local.getItem(COLUMNS)).toBeNull()
    expect(local.getItem('open-walnut-col-weights')).toBe('[1,1]')
  })
  it('an automated browser that opted in adopts them', async () => {
    await boot(true, true)
    expect(local.getItem(COLUMNS)).toBe(SAVED)
  })
})
