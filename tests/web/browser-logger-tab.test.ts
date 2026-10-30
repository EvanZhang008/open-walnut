/**
 * Every forwarded browser log line names its tab, and a reload keeps the name
 * (sessionStorage). Two windows, or two parallel browser tests, write into one
 * server log; the browser test audit reads only its own page's errors by it
 * (tests/e2e/browser/codex-test-audit.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../web/src/api/ws', () => ({ wsClient: { state: 'disconnected', sendRpc: () => Promise.resolve() } }))

class MemoryStorage {
  m = new Map<string, string>()
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
}

let session: MemoryStorage
beforeEach(() => {
  session = new MemoryStorage()
  vi.stubGlobal('sessionStorage', session)
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
})
afterEach(() => { vi.unstubAllGlobals() })

async function load() {
  vi.resetModules()
  return import('../../web/src/utils/browser-logger')
}

describe('browser log lines name their tab', () => {
  it('a line carries the tab id, and a reload of the same tab keeps it', async () => {
    const first = await load()
    first.initBrowserLogger()
    console.info('tab-line-1')
    const tab = first.getRecentEntries().find((e) => e.message === 'tab-line-1')?.tab
    first.destroyBrowserLogger()
    expect(tab).toMatch(/^[a-z0-9]{1,16}$/)
    expect(session.getItem(first.LOG_TAB_KEY)).toBe(tab)

    const reloaded = await load()
    reloaded.initBrowserLogger()
    console.info('tab-line-2')
    expect(reloaded.getRecentEntries().find((e) => e.message === 'tab-line-2')?.tab).toBe(tab)
    reloaded.destroyBrowserLogger()
  })

  it('another tab gets its own id', async () => {
    const a = await load()
    const idA = session.getItem(a.LOG_TAB_KEY)
    session = new MemoryStorage()
    vi.stubGlobal('sessionStorage', session)
    const b = await load()
    expect(session.getItem(b.LOG_TAB_KEY)).not.toBe(idA)
  })
})
