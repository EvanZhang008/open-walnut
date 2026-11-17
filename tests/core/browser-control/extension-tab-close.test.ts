/**
 * Every close of a tab by the extension goes through packages/browser-extension/src/tab-close.ts,
 * which never waits on a page's "Leave site?" (chrome.tabs.remove does not end while one is up:
 * 2026-11-17, an agent's close hung 30 s and a tidy pass waiting on one would hold every open behind
 * it). Ratchet: a new `tabs.remove(` anywhere else in the extension fails here until it uses
 * closeTab, or is listed with why it cannot meet a beforeunload.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.resolve(__dirname, '../../../packages/browser-extension/src')
/** The files that may call tabs.remove themselves, and why. */
const ALLOWED: Record<string, string> = {
  'tab-close.ts': 'the one helper',
  'agent-leave.ts': 'an agent\'s own close, which waits on it while the debugger watches for the page\'s "Leave site?"',
  'grant.ts': 'closes its own extension page (no beforeunload)',
  'agent-window-own.ts': 'closes Walnut\'s own agent page (an extension page, no beforeunload)',
}

describe('closing a tab', () => {
  it('goes through closeTab everywhere else (ratchet)', () => {
    const found = new Set<string>()
    for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.ts'))) {
      if (/\btabs\.remove\(/.test(fs.readFileSync(path.join(DIR, f), 'utf8'))) found.add(f)
    }
    expect([...found].filter((f) => !(f in ALLOWED))).toEqual([])
    // A listed file that no longer needs it leaves the list.
    expect(Object.keys(ALLOWED).filter((f) => !found.has(f))).toEqual([])
  })

  it('closeTab never waits on a close that does not end (a "Leave site?" up) longer than its cap', async () => {
    const ev = () => ({ addListener() {}, removeListener() {} })
    ;(globalThis as any).chrome = {
      runtime: { id: 'test', getURL: (p: string) => p, getManifest: () => ({ version: '0' }), onMessage: ev() },
      storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, local: { get: async () => ({}), set: async () => {} }, onChanged: ev() },
      tabs: { get: async () => ({ id: 9 }), remove: () => new Promise(() => {}), onRemoved: ev(), onUpdated: ev(), onCreated: ev() },
      windows: { onRemoved: ev() },
      permissions: { contains: async () => false, onRemoved: ev() },
    }
    const { closeTab } = await import('../../../packages/browser-extension/src/tab-close')
    const t0 = Date.now()
    expect(await closeTab(9, { ms: 300 })).toBe(false)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})
