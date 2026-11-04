/**
 * Agents in the person's browser on a real server (src/web/routes/browser-v1.ts): a paired
 * extension polls for work with its device token and answers; an agent's act reaches it; a new
 * site waits for the person's approval (202 needs_ok, then through once approved; a denial is
 * refused and not asked again); tabs belong to who opened them; only a person changes the site
 * setting; a test run never reaches the browser. The extension is a fake that polls like the
 * real one (packages/browser-extension/src/agent.ts); the real one runs in
 * tests/e2e/browser/extension-agent.spec.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-browser-control-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import * as hub from '../../src/core/browser-control/hub.js'
import { siteKey } from '../../src/core/vault/url-match.js'
import { createDevice } from '../../src/core/device-auth.js'
import { getPairingTargets } from '../../src/core/pairing-targets.js'

let base = ''
const AGENT = { 'x-walnut-caller-kind': 'automation' }

async function http(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(p.startsWith('/api/') ? `${base}${p}` : `${base}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}

interface Seen { action: string; args: Record<string, any>; allow: { any: boolean; sites: string[]; walnut?: string[] } }

/** A browser extension that polls like the real one and answers from a script. */
function fakeExtension(token: string, browser = 'chrome') {
  const seen: Seen[] = []
  const tabs = new Map<number, { url: string; owner: string }>()
  let next = 100
  let on = true
  const auth = { authorization: `Bearer ${token}` }
  const answer = (c: Seen & { id: string }): { ok: boolean; result?: unknown; error?: unknown } => {
    const site = (u: string) => siteKey(u)?.domain ?? ''
    const allowed = (u: string) => c.allow.any || c.allow.sites.includes(site(u))
    switch (c.action) {
      case 'open': {
        if (!allowed(c.args.url)) return { ok: false, error: { message: 'no', code: 'site_not_allowed', extra: { url: c.args.url } } }
        const id = next++
        tabs.set(id, { url: c.args.url, owner: c.args.owner })
        return { ok: true, result: { tab: id, url: c.args.url, title: 'Fake page' } }
      }
      case 'tabs': return { ok: true, result: { tabs: [...tabs].map(([id, t]) => ({ id, url: t.url, owner: t.owner })) } }
      case 'click': {
        // A click that follows a link to a site not allowed yet.
        const t = tabs.get(c.args.tab)!
        if (c.args.ref === 'e9') {
          const to = 'https://elsewhere.example.org/landing'
          if (!allowed(to)) return { ok: false, error: { message: 'no', code: 'site_not_allowed', extra: { url: to } } }
          t.url = to
        }
        return { ok: true, result: { clicked: `link ${c.args.ref}`, tab: c.args.tab, url: t.url } }
      }
      case 'close': tabs.delete(c.args.tab); return { ok: true, result: { tab: c.args.tab, closed: true } }
      default: return { ok: true, result: { tab: c.args.tab, snapshot: `[e1] button "Go"` } }
    }
  }
  const loop = (async () => {
    while (on) {
      const r = await http('POST', '/browser/poll', { browser, version: '9.9', caps: ['screenshot'], tabs: [...tabs].map(([id, t]) => ({ id, owner: t.owner })), waitMs: 300 }, auth)
      if (r.status !== 200) { await new Promise((res) => setTimeout(res, 50)); continue }
      for (const c of r.body.commands as Array<Seen & { id: string }>) {
        seen.push(c)
        await http('POST', '/browser/result', { id: c.id, ...answer(c) }, auth)
      }
    }
  })()
  return { seen, tabs, auth, stop: async () => { on = false; await loop } }
}

async function pair(): Promise<{ token: string; name: string }> {
  const code = (await (await fetch(`${base}/api/devices/browser-code`, { method: 'POST' })).json() as { code: string }).code
  return (await http('POST', '/browser-pair', { code, client: 'extension' })).body as { token: string; name: string }
}

async function answerApproval(id: string, decision: 'approve' | 'deny') {
  expect((await http('POST', `/approvals/${id}/answer`, { decision })).status).toBe(200)
}

let ext: ReturnType<typeof fakeExtension>
let device = ''

beforeAll(async () => {
  process.env.WALNUT_TEST_RUN_MARK = '1'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await ext?.stop()
  await stopServer()
  delete process.env.WALNUT_TEST_RUN_MARK
})

describe('agents in the person\'s browser', () => {
  it('with no browser letting agents in, an act says how to turn it on', async () => {
    const r = await http('POST', '/browser/act', { action: 'tabs' }, AGENT)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('browser_not_connected')
    expect((await http('GET', '/browser/status')).body).toMatchObject({ browsers: [], mode: 'ask', sites: [] })
  })

  it('only the extension polls, with its own device token', async () => {
    expect((await http('POST', '/browser/poll', { waitMs: 10 })).status).toBe(403)
    const dev = await pair()
    device = dev.name
    ext = fakeExtension(dev.token)
    await expect.poll(async () => (await http('GET', '/browser/status')).body.browsers.length, { timeout: 5000 }).toBe(1)
    expect((await http('GET', '/browser/status')).body.browsers[0]).toMatchObject({ device, browser: 'chrome', version: '9.9' })
  })

  it('a new site asks the person; approved, the open goes through and the site stays allowed', async () => {
    const first = await http('POST', '/browser/act', { action: 'open', url: 'https://shop.example.test/cart' }, AGENT)
    expect(first.status).toBe(202)
    expect(first.body).toMatchObject({ status: 'needs_ok', site: 'example.test' })
    expect(ext.seen.filter((c) => c.action === 'open')).toHaveLength(0)
    // Asking again is the same ask, not a second one.
    const again = await http('POST', '/browser/act', { action: 'open', url: 'https://shop.example.test/cart' }, AGENT)
    expect(again.body.approvalId).toBe(first.body.approvalId)
    await answerApproval(first.body.approvalId, 'approve')
    const opened = await http('POST', '/browser/act', { action: 'open', url: 'https://shop.example.test/cart' }, AGENT)
    expect(opened.status).toBe(200)
    expect(opened.body).toMatchObject({ tab: 100, url: 'https://shop.example.test/cart' })
    expect(ext.seen.at(-1)).toMatchObject({ action: 'open', args: { owner: 'agent' }, allow: { any: false, sites: ['example.test'] } })
    expect((await http('GET', '/browser/status')).body.sites.map((s: { site: string }) => s.site)).toEqual(['example.test'])
    // `tab` may be left out after one was used.
    const snap = await http('POST', '/browser/act', { action: 'snapshot' }, AGENT)
    expect(snap.body).toMatchObject({ tab: 100, snapshot: expect.stringContaining('[e1]') })
  })

  it('holds for the answer with wait_ms', async () => {
    const asked = await http('POST', '/browser/act', { action: 'navigate', url: 'https://docs.example.net/' }, AGENT)
    expect(asked.status).toBe(202)
    const held = http('POST', '/browser/act', { action: 'navigate', url: 'https://docs.example.net/', wait_ms: 10_000 }, AGENT)
    await new Promise((r) => setTimeout(r, 300))
    await answerApproval(asked.body.approvalId, 'approve')
    expect((await held).status).toBe(200)
  })

  it('a page that goes to a site not allowed yet asks too; a denial is refused and not asked again', async () => {
    const r = await http('POST', '/browser/act', { action: 'click', ref: 'e9' }, AGENT)
    expect(r.status).toBe(202)
    expect(r.body.site).toBe('example.org')
    await answerApproval(r.body.approvalId, 'deny')
    const no = await http('POST', '/browser/act', { action: 'click', ref: 'e9' }, AGENT)
    expect(no.status).toBe(403)
    expect(no.body.code).toBe('site_denied')
    const pending = (await http('GET', '/approvals')).body.approvals.filter((a: { status: string }) => a.status === 'pending')
    expect(pending).toHaveLength(0)
  })

  it('tabs belong to who opened them', async () => {
    hub.ownTab(device, 777, 'task:someone-else')
    ext.tabs.set(777, { url: 'https://shop.example.test/other', owner: 'task:someone-else' })
    const r = await http('POST', '/browser/act', { action: 'snapshot', tab: 777 }, AGENT)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('not_your_tab')
    expect((await http('POST', '/browser/act', { action: 'snapshot', tab: 4242 }, AGENT)).body.code).toBe('not_your_tab')
    const list = await http('POST', '/browser/act', { action: 'tabs' }, AGENT)
    expect(list.body.tabs.map((t: { id: number }) => t.id)).toEqual([100])
    expect(JSON.stringify(list.body)).not.toContain('someone-else')
  })

  it('the person\'s own tabs and an agent\'s are apart; status says no one\'s tabs', async () => {
    const mine = await http('POST', '/browser/act', { action: 'open', url: 'https://shop.example.test/mine' })
    expect(mine.status).toBe(200)
    expect(ext.seen.at(-1)?.args.owner).toBe('person')
    expect((await http('POST', '/browser/act', { action: 'snapshot', tab: mine.body.tab }, AGENT)).body.code).toBe('not_your_tab')
    expect((await http('POST', '/browser/act', { action: 'snapshot', tab: 100 })).body.code).toBe('not_your_tab')
    const st = await http('GET', '/browser/status')
    expect(JSON.stringify(st.body)).not.toMatch(/owner|"tabs"/)
    await http('POST', '/browser/act', { action: 'close', tab: mine.body.tab })
  })

  it('with two browsers, a tab\'s commands go to the browser that holds it', async () => {
    const dev2 = await pair()
    const ff = fakeExtension(dev2.token, 'firefox')
    try {
      await expect.poll(async () => (await http('GET', '/browser/status')).body.browsers.length, { timeout: 5000 }).toBe(2)
      // Firefox polled last; the agent's tab is in Chrome.
      await new Promise((r) => setTimeout(r, 400))
      const before = ff.seen.length
      const r = await http('POST', '/browser/act', { action: 'snapshot', tab: 100 }, AGENT)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(ff.seen.length).toBe(before)
      expect((await http('POST', '/browser/act', { action: 'snapshot' }, AGENT)).status).toBe(200)
      expect(ff.seen.length).toBe(before)
    } finally {
      await ff.stop()
      await http('POST', '/browser/off', {}, ff.auth)
    }
  })

  it('a device named like the extension can only be the extension', async () => {
    const r = await http('POST', '/api/devices', { name: 'extension-abcdef' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('reserved_name')
    // The CLI's own way in (`walnut device add`) holds the same rule.
    await expect(createDevice('extension-abcdef')).rejects.toThrow(/kept for the Walnut browser extension/)
  })

  it('Walnut\'s own addresses are never an agent\'s page, and every command carries them', async () => {
    const port = Number(new URL(base).port)
    const lan = (await getPairingTargets(`http://localhost:${port}`, port)).find((t) => t.kind !== 'cloud')
    if (lan) {
      const r = await http('POST', '/browser/act', { action: 'open', url: `${lan.origin}/api/v1/tasks` }, AGENT)
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('walnut_page')
      expect(ext.seen.at(-1)?.allow.walnut).toContain(new URL(lan.origin).host)
    } else {
      expect((await http('POST', '/browser/act', { action: 'tabs' }, AGENT)).status).toBe(200)
      expect(Array.isArray(ext.seen.at(-1)?.allow.walnut)).toBe(true)
    }
  })

  it('only a person changes the site setting', async () => {
    expect((await http('PUT', '/browser/settings', { mode: 'any' }, AGENT)).body.code).toBe('human_only')
    expect((await http('PUT', '/browser/settings', { mode: 'any' }, { 'x-walnut-caller-sid': 'some-session' })).status).toBe(403)
    expect((await http('PUT', '/browser/settings', { mode: 'any' })).body.mode).toBe('any')
    const any = await http('POST', '/browser/act', { action: 'open', url: 'https://free.example.com/' }, AGENT)
    expect(any.status).toBe(200)
    expect(ext.seen.at(-1)?.allow.any).toBe(true)
    const back = await http('PUT', '/browser/settings', { mode: 'ask', removeSite: 'example.test' })
    expect(back.body).toMatchObject({ mode: 'ask' })
    expect(back.body.sites.map((s: { site: string }) => s.site)).not.toContain('example.test')
  })

  it('a test run never reaches the person\'s browser', async () => {
    const before = ext.seen.length
    const r = await http('POST', '/browser/act', { action: 'tabs' }, { ...AGENT, 'x-walnut-test-run': 'browser-e2e' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('test_run')
    expect(ext.seen.length).toBe(before)
  })

  it('a browser whose poll connection drops is not connected any more', async () => {
    const dev = await pair()
    const ctl = new AbortController()
    const hung = fetch(`${base}/api/v1/browser/poll`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${dev.token}` }, body: JSON.stringify({ browser: 'firefox', version: '1', caps: [], waitMs: 20_000 }), signal: ctl.signal }).catch(() => null)
    await expect.poll(async () => (await http('GET', '/browser/status')).body.browsers.some((b: { device: string }) => b.device === dev.name), { timeout: 5000 }).toBe(true)
    ctl.abort()
    await hung
    await expect.poll(async () => (await http('GET', '/browser/status')).body.browsers.some((b: { device: string }) => b.device === dev.name), { timeout: 5000 }).toBe(false)
  })

  it('the extension turning agents off disconnects it', async () => {
    await ext.stop()
    expect((await http('POST', '/browser/off', {}, ext.auth)).status).toBe(200)
    expect((await http('GET', '/browser/status')).body.browsers).toEqual([])
  })
})
