/**
 * A command that names no tab (src/web/routes/browser-v1.ts, core/browser-control/tab-words.ts),
 * over a real hub with the browser faked at the hub. 2026-11-10 (a review): a subagent opened its
 * own tab, ran `close` with no tab, and the server's "tab used last" closed the MAIN agent's tab
 * ("ok  tab 1423041407"). Executors of one task share its session, so the server cannot tell them
 * apart; the rule is:
 *   - one tab: a command with no tab acts there (a one-tab flow needs no --tab);
 *   - two or more: every tab step with no tab is refused (`which_tab`) with the task's tabs listed,
 *     and nothing reaches the browser. Checked for EVERY action the route sends to a tab (ON_TAB),
 *     and every other action is listed as one that needs no tab, so a new action is classified;
 *   - a tab this task closed earlier says so, not "the person took it back".
 * Fake data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-browser-default-tab-routes'))

import express from 'express'
import { ACTIONS, ON_TAB, browserV1Router, _resetBrowserRoutesForTesting } from '../../../src/web/routes/browser-v1.js'
import * as h from '../../../src/core/browser-control/hub.js'
import { parseBrowserArgv, runBrowser, BROWSER_EXIT } from '../../../src/core/browser-control/browser-cli.js'
import { shortUrl, whichTabWords } from '../../../src/core/browser-control/tab-words.js'

const A = { device: 'extension-tabs', label: 'Browser A', browser: 'chrome', version: '9.9', caps: ['screenshot', 'trusted-input', 'input-v2'] }
const AGENT = { 'x-walnut-caller-kind': 'agent' }
/** The actions that need no tab, each with why. A new action must be in ON_TAB or here. */
const NO_TAB: Record<string, string> = {
  open: 'makes a new tab and answers its id',
  tabs: 'lists the task\'s tabs',
  downloads: 'the task\'s downloads, of every tab',
  take: 'names the person\'s tab it takes (refused without one)',
}
let server: Server
let base = ''
let timer: ReturnType<typeof setInterval> | undefined
let seen: Array<{ action: string; args: Record<string, unknown> }> = []

async function act(body: Record<string, unknown>) {
  const r = await fetch(`${base}/browser/act`, { method: 'POST', headers: { 'content-type': 'application/json', ...AGENT }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() as Record<string, any> }
}

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', browserV1Router)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
}, 60_000)

afterAll(async () => {
  if (timer) clearInterval(timer)
  h._resetBrowserHubForTesting()
  await new Promise<void>((r) => server.close(() => r()))
})

beforeEach(async () => {
  if (timer) clearInterval(timer)
  h._resetBrowserHubForTesting()
  _resetBrowserRoutesForTesting()
  seen = []
  await h.poll(A, 0)
  timer = setInterval(async () => {
    for (const cmd of await h.poll(A, 0)) {
      seen.push({ action: cmd.action, args: cmd.args })
      const tab = typeof cmd.args.tab === 'number' ? cmd.args.tab : 0
      h.answer(A.device, cmd.id, true, { tab, url: 'https://shop.example.test/board', ...(cmd.action === 'close' ? { closed: true } : {}) })
    }
  }, 10)
})

const own = (tab: number, title: string, url: string) => h.ownTab(A.device, tab, 'agent', { url, title, window: 'agent' })

describe('every action is classified: on a tab, or needs none', () => {
  it('each action is in ON_TAB or listed with why it needs no tab', () => {
    for (const a of ACTIONS) expect(ON_TAB.has(a) || a in NO_TAB, `${a}: put it in ON_TAB or NO_TAB`).toBe(true)
    for (const a of Object.keys(NO_TAB)) expect(ON_TAB.has(a as never), a).toBe(false)
  })
})

describe('two or more tabs: a tab step with no tab is refused, never sent to a guessed tab', () => {
  it.each([...ON_TAB])('%s with no tab answers which_tab and reaches no browser', async (action) => {
    own(41, 'Search', 'https://code.example.test/search')
    own(42, 'Releases', 'https://code.example.test/acme/releases')
    // The tab used last is the other executor's: it must not be picked.
    await act({ action: 'snapshot', tab: 41 })
    seen = []
    const r = await act({ action, ...(action === 'click_label' ? { label: 1 } : {}) })
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    expect(r.body.code).toBe('which_tab')
    expect(r.body.tabs).toEqual([41, 42])
    expect(seen).toEqual([])
  })

  it('the refusal lists each tab with its title and short address, and says to pass --tab', async () => {
    own(41, 'Search', 'https://code.example.test/search?q=x')
    own(42, 'Releases · acme/app', 'https://code.example.test/acme/app/releases')
    const r = await act({ action: 'close' })
    expect(r.body.error).toMatch(/^This task has 2 tabs, so name the one to act on: pass --tab <id>/)
    expect(r.body.error).toContain('  41  Search  code.example.test/search')
    expect(r.body.error).toContain('  42  Releases · acme/app  code.example.test/acme/app/releases')
    expect(r.body.error).toMatch(/Subagents of one task share its tabs/)
    // Both tabs are still the task's.
    expect(h.tabsOf(A.device, 'agent').sort()).toEqual([41, 42])
  })

  it('a step that names its tab goes there; open, tabs and downloads need none', async () => {
    own(41, 'Search', 'https://code.example.test/search')
    own(42, 'Releases', 'https://code.example.test/releases')
    expect((await act({ action: 'close', tab: 42 })).status).toBe(200)
    expect(seen.at(-1)).toMatchObject({ action: 'close', args: { tab: 42 } })
    for (const action of ['tabs', 'downloads']) expect((await act({ action })).status, action).toBe(200)
  })

  it('the shell prints the refusal as it came and exits 1 (a choice to make)', async () => {
    own(41, 'Search', 'https://code.example.test/search')
    own(42, 'Releases', 'https://code.example.test/releases')
    const p = parseBrowserArgv(['close'])
    if (!p.ok) throw new Error(p.error)
    const said: string[] = []
    const code = await runBrowser(p, {
      call: async (_op, args) => { const r = await act(args); return r.status === 200 ? { ok: true, result: r.body } : { ok: false, message: r.body.error, code: r.body.code } },
      say: (l) => said.push(l), out: () => undefined, cwd: os.tmpdir(),
    })
    expect(code).toBe(BROWSER_EXIT.refused)
    expect(said.join('\n')).toMatch(/This task has 2 tabs[\s\S]*41  Search[\s\S]*42  Releases/)
  })
})

describe('one tab: no --tab needed', () => {
  it('a tab step with no tab acts in the task\'s only tab, close included', async () => {
    own(41, 'Search', 'https://code.example.test/search')
    expect((await act({ action: 'text' })).status).toBe(200)
    expect(seen.at(-1)).toMatchObject({ action: 'text', args: { tab: 41 } })
    expect((await act({ action: 'close' })).status).toBe(200)
    expect(seen.at(-1)).toMatchObject({ action: 'close', args: { tab: 41 } })
    expect(h.tabsOf(A.device, 'agent')).toEqual([])
  })

  it('no tab at all: open a page first', async () => {
    const r = await act({ action: 'snapshot' })
    expect(r.body.code).toBe('which_tab')
    expect(r.body.error).toMatch(/^Open a page first/)
  })
})

describe('a tab that is not the task\'s now says how it ended', () => {
  it('closed by this task (a subagent\'s close, say): this task closed it earlier', async () => {
    own(41, 'Search', 'https://code.example.test/search')
    own(42, 'Releases', 'https://code.example.test/releases')
    expect((await act({ action: 'close', tab: 41 })).status).toBe(200)
    const r = await act({ action: 'close', tab: 41 })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('not_your_tab')
    expect(r.body.error).toMatch(/^This task closed tab 41 earlier/)
    expect(r.body.error).not.toMatch(/Stop/)
  })

  it('taken back with Stop, tidied, closed in the browser: each in its words; never known: the general words', async () => {
    own(41, 'Search', 'https://code.example.test/search')
    h.releaseTab(A.device, 41, 'stopped')
    expect((await act({ action: 'text', tab: 41 })).body.error).toMatch(/^The person took tab 41 back with Stop/)
    own(43, 'Old', 'https://code.example.test/old')
    h.releaseTab(A.device, 43, 'tidied')
    expect((await act({ action: 'text', tab: 43 })).body.error).toMatch(/^Walnut closed tab 43 after it went unused/)
    own(44, 'Gone', 'https://code.example.test/gone')
    h.releaseTab(A.device, 44, 'gone')
    expect((await act({ action: 'text', tab: 44 })).body.error).toMatch(/^Tab 44 was closed in the browser/)
    expect((await act({ action: 'text', tab: 999 })).body.error).toMatch(/^That tab is not one an agent opened/)
  })

  it('another task\'s ended tab reads as the general words (nothing of another task is told)', async () => {
    h.ownTab(A.device, 50, 'task:other', { url: 'https://code.example.test/x' })
    h.releaseTab(A.device, 50, 'closed')
    expect((await act({ action: 'text', tab: 50 })).body.error).toMatch(/^That tab is not one an agent opened/)
  })
})

describe('the words', () => {
  it('a short address: host and path, no scheme or query, cut to size', () => {
    expect(shortUrl('https://code.example.test/acme/app/issues/3?x=1#c')).toBe('code.example.test/acme/app/issues/3')
    expect(shortUrl('https://code.example.test/')).toBe('code.example.test')
    expect(shortUrl(`https://code.example.test/${'a'.repeat(200)}`).length).toBe(70)
    expect(shortUrl(undefined)).toBe('')
  })

  it('more than ten tabs: the first ten, and how many more', () => {
    const w = whichTabWords(Array.from({ length: 12 }, (_, i) => ({ tab: i + 1, title: `T${i + 1}` })))
    expect(w.split('\n')).toHaveLength(12)
    expect(w).toMatch(/… and 2 more \(tabs lists them\)$/)
  })
})
