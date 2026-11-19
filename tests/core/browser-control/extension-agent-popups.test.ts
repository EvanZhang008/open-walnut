/**
 * A window an agent's page opens (packages/browser-extension/src/agent-popups.ts, agent-page.ts
 * watchOpened). 2026-11-19, the user's Chrome: an agent's `evaluate` clicked a site's "Sign in with
 * GitHub"; the popup window came in front of him, listed as his, and the agent could not close it.
 * Guards:
 *   - the page's window.open asks for a tab (`popup=0`, its noopener and noreferrer kept), once;
 *   - every command reaches the page only after beforeStep (acting, and the patch), so no step kind
 *     (evaluate, a dialog's answer, a new one) opens a window Walnut does not attribute;
 *   - the browser's new tabs reach the extension through one listener (watchOpened), which adopts
 *     an agent tab's popup and minimizes a popup window it came in; a second listener fails here.
 * The browser side (a click, an evaluate, a page's own early copy of window.open) is the Chromium
 * spec tests/e2e/browser/extension-agent-outward.spec.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { _inPageForTesting } from '../../../packages/browser-extension/src/agent-popups'

const DIR = path.resolve(__dirname, '../../../packages/browser-extension/src')
const src = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8')

function fakeWindow() {
  const calls: unknown[][] = []
  const w = { open: (...a: unknown[]) => { calls.push(a); return null } } as Record<string, unknown>
  return { w, calls }
}

describe('the page\'s window.open asks for a tab', () => {
  it('features become popup=0, noopener and noreferrer kept; none stays none; patched once', () => {
    const { w, calls } = fakeWindow()
    const g = globalThis as Record<string, unknown>
    const had = g.window
    g.window = w
    try {
      expect(_inPageForTesting()).toBe(true)
      const open = w.open as (...a: unknown[]) => unknown
      open('https://login.example.test/oauth', 'signin', 'width=500,height=600,left=10')
      open('https://login.example.test/x', '_blank', 'noopener, width=400 noreferrer')
      open('https://login.example.test/tab', '_blank')
      open('https://login.example.test/empty', '_blank', '  ')
      expect(calls).toEqual([
        ['https://login.example.test/oauth', 'signin', 'popup=0'],
        ['https://login.example.test/x', '_blank', 'popup=0,noopener,noreferrer'],
        ['https://login.example.test/tab', '_blank'],
        ['https://login.example.test/empty', '_blank'],
      ])
      // The page still sees a function, called on the window itself.
      expect(typeof w.open).toBe('function')
      calls.length = 0
      ;(w.open as (...a: unknown[]) => unknown).call(undefined, new URL('https://login.example.test/u'), 'n', 'width=1')
      expect(calls).toEqual([
        [new URL('https://login.example.test/u'), 'n', 'popup=0'],
      ])
      // A second step does not wrap it again.
      const once = w.open
      expect(_inPageForTesting()).toBe(true)
      expect(w.open).toBe(once)
    } finally {
      g.window = had
    }
  })
})

describe('every step goes through beforeStep before it reaches the page', () => {
  it('run calls beforeStep for a command with a tab before act, and nothing else calls act', () => {
    const agent = src('agent.ts')
    const runAt = agent.indexOf('async function run(c: WireCommand)')
    const body = agent.slice(runAt, agent.indexOf('\n}\n', runAt))
    expect(body.indexOf('beforeStep(c.action, c.args.tab)')).toBeGreaterThan(0)
    expect(body.indexOf('beforeStep(c.action, c.args.tab)')).toBeLessThan(body.indexOf('act(c)'))
    const callers = [...agent.matchAll(/[^\w.]act\(c\)/g)].map((m) => agent.lastIndexOf('async function run', m.index!) === runAt)
    expect(callers.length).toBeGreaterThan(0)
    expect(callers.every(Boolean)).toBe(true)
    // beforeStep: weighed as the opener for the whole step (never `acting`, which names downloads),
    // then the patch only in an agent's own tab of the agent window.
    const step = agent.slice(agent.indexOf('async function beforeStep'), agent.indexOf('async function run('))
    expect(step).toMatch(/opening\.set\(tabId, Date\.now\(\) \+ STEP_MS \+ ACTING_MS\)/)
    expect(step).not.toMatch(/\bacting\b/)
    expect(step).toMatch(/!nearPerson\(rec\)/)
    expect(step).toMatch(/t\.windowId === await agentWindowId\(\) && await popupsAsTabs\(tabId\)/)
  })

  it('the browser\'s new tabs reach the extension through watchOpened alone, which minimizes an agent\'s popup window', () => {
    const listeners = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts')).flatMap((f) =>
      [...src(f).matchAll(/\btabs\.onCreated\.addListener|\bwindows\.onCreated\.addListener/g)].map(() => f))
    expect(listeners).toEqual(['agent-page.ts'])
    const page = src('agent-page.ts')
    const adopt = page.slice(page.indexOf('async function adoptOpened'), page.indexOf('\n}\n', page.indexOf('async function adoptOpened')))
    expect(adopt).toMatch(/if \(!nearPerson\(rec\) && openerId !== undefined && .*agentWindowId\(\)\) await minimizeAgentPopup\(tabId\)/)
  })
})
