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
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-browser-control-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import * as hub from '../../src/core/browser-control/hub.js'
import { siteKey } from '../../src/core/vault/url-match.js'
import { createDevice, revokeDevice } from '../../src/core/device-auth.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { getPairingTargets } from '../../src/core/pairing-targets.js'
import { answerMessage, keyIdOf } from '../../src/core/approvals/digest.js'

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

describe('security alert attribution on the real API', () => {
  it('reports ours with its task and sends unknown verification to agents', async () => {
    const { noteAgentAction } = await import('../../src/core/browser-control/agent-actions.js');
    const at = Date.now();
    await noteAgentAction('task-login-owner', 'https://secure.alert.test/login?secret=PRIVATE_CANARY', 'fill_login', at, 'account@example.test');
    const response = await http('GET', `/browser/security-alert?${new URLSearchParams({ domain: 'alert.test', occurred_at: new Date(at).toISOString(), account: 'account@example.test' })}`, undefined, AGENT);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ours', actions: [{ taskId: 'task-login-owner' }] });
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE_CANARY');
    const unknown = await http('GET', `/browser/security-alert?${new URLSearchParams({ domain: 'unknown.test', occurred_at: new Date(at).toISOString() })}`, undefined, AGENT);
    expect(unknown.status).toBe(200);
    expect(unknown.body.status).toBe('unknown');
    expect(unknown.body.next).toContain('supervisor');
    expect(unknown.body.next).toContain('Do not ask the user');
    const invalid = await http('GET', '/browser/security-alert?domain=alert.test&occurred_at=recently', undefined, AGENT);
    expect(invalid.status).toBe(400);
  });
  it('a replica reports unavailable rather than reading an empty local attribution file', async () => {
    const roles = await import('../../src/core/server-role.js');
    const spy = vi.spyOn(roles, 'isFollower').mockReturnValue(true);
    try {
      const result = await http('GET', `/browser/security-alert?${new URLSearchParams({ domain: 'alert.test', occurred_at: new Date().toISOString() })}`, undefined, AGENT);
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ status: 'unavailable', actions: [] });
    } finally { spy.mockRestore(); }
  });
});

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
        // A button that places an order: the page holds it until the server brings the person's yes.
        const hold = { kind: 'buy', why: '"Place order" buys or pays', what: 'click button "Place order"', url: 'https://shop.example.test/cart', sig: 'buy|click button "Place order"|https://shop.example.test/cart' }
        if (c.args.ref === 'e11' && c.args.outward_ok !== hold.sig) return { ok: false, error: { message: 'held', code: 'outward_needs_ok', extra: { hold } } }
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
    // Agents may use any site unless the person asks to approve each one.
    expect((await http('GET', '/browser/status')).body).toMatchObject({ browsers: [], mode: 'any', sites: [] })
    expect((await http('PUT', '/browser/settings', { mode: 'ask' })).body.mode).toBe('ask')
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

  it('a click that places an order waits for the person; a plain local Approve is no proof; it goes through once, after a signed yes', async () => {
    const ask = await http('POST', '/browser/act', { action: 'click', ref: 'e11' }, AGENT)
    expect(ask.status).toBe(202)
    expect(ask.body).toMatchObject({ status: 'needs_ok', code: 'outward_needs_ok', kind: 'buy', what: 'click button "Place order"', waitsMinutes: 10 })
    expect(ask.body.error).toContain('on shop.example.test')
    // An agent cannot bring the approval's mark itself.
    expect((await http('POST', '/browser/act', { action: 'click', ref: 'e11', outward_ok: 'buy|click button "Place order"|https://shop.example.test/cart' }, AGENT)).status).toBe(202)
    expect(ext.seen.filter((c) => c.action === 'click' && c.args.outward_ok)).toHaveLength(0)
    // Another step with this ask, or another caller, is refused.
    expect((await http('POST', '/browser/act', { action: 'click', ref: 'e1', request: ask.body.request }, AGENT)).body.code).toBe('no_such_request')
    // A plain Approve from this machine (what any process here, the agent too, can send) is no
    // proof that it is the person: refused, and the step does not run.
    const forged = await http('POST', `/approvals/${ask.body.request}/answer`, { decision: 'approve' })
    expect(forged.status).toBe(403)
    expect(forged.body.code).toBe('proof_needed')
    expect((await http('POST', '/browser/act', { action: 'click', ref: 'e11', request: ask.body.request }, AGENT)).status).toBe(202)
    expect(ext.seen.filter((c) => c.action === 'click' && c.args.outward_ok)).toHaveLength(0)
    // Face ID on the person's phone: its device key signs the answer.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const phone = await http('POST', '/api/devices', { name: 'browser-control-e2e-phone' })
    expect((await http('POST', '/approvals/keys', { publicKey: spki, name: 'Test iPhone', kind: 'iphone' }, { authorization: `Bearer ${phone.body.token}` })).status).toBe(200)
    const signed = async (id: string) => {
      const digest = (await http('GET', `/approvals/${id}`)).body.approval.digest as string
      const signature = crypto.sign('sha256', Buffer.from(answerMessage(digest, 'approve')), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
      return http('POST', `/approvals/${id}/answer`, { decision: 'approve', keyId: keyIdOf(spki), signature })
    }
    // Held for the answer.
    const held = http('POST', '/browser/act', { action: 'click', ref: 'e11', request: ask.body.request, wait_ms: 10_000 }, AGENT)
    await new Promise((r) => setTimeout(r, 300))
    expect((await signed(ask.body.request)).status).toBe(200)
    const done = await held
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(ext.seen.filter((c) => c.action === 'click' && c.args.outward_ok)).toHaveLength(1)
    // One use.
    expect((await http('POST', '/browser/act', { action: 'click', ref: 'e11', request: ask.body.request }, AGENT)).body.code).toBe('no_such_request')
    // A no is refused, and nothing reaches the page.
    const again = await http('POST', '/browser/act', { action: 'click', ref: 'e11' }, AGENT)
    expect(again.body.request).not.toBe(ask.body.request)
    // With a device that signs, the ask is a Face ID or Touch ID one.
    expect((await http('GET', `/approvals/${again.body.request}`)).body.approval).toMatchObject({ mode: 'biometric', guard: 'person' })
    await answerApproval(again.body.request, 'deny')
    const no = await http('POST', '/browser/act', { action: 'click', ref: 'e11', request: again.body.request }, AGENT)
    expect(no.status).toBe(403)
    expect(no.body.code).toBe('denied')
    expect(ext.seen.filter((c) => c.action === 'click' && c.args.outward_ok)).toHaveLength(1)
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

  it('the side panel keeps a page\'s text for the ask in a file only the owner reads', async () => {
    const text = 'Release notes. The sync engine retries a failed upload three times.'
    const r = await http('POST', '/browser/page', { url: 'https://docs.example.test/notes', title: 'Release  notes', text })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const file = String(r.body.file)
    expect(file.startsWith(`${WALNUT_HOME}/cache/browser-pages/`)).toBe(true)
    const body = await fsp.readFile(file, 'utf8')
    expect(body).toContain('# Release notes')
    expect(body).toContain('https://docs.example.test/notes')
    expect(body).toContain(text)
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600)
    // An agent may keep a page the same way (every person's step is an agent's too).
    expect((await http('POST', '/browser/page', { url: 'https://docs.example.test/notes', text }, AGENT)).status).toBe(200)
    expect((await http('POST', '/browser/page', { url: 'file:///etc/passwd', text })).status).toBe(400)
    expect((await http('POST', '/browser/page', { url: 'https://docs.example.test/notes', text: '  ' })).status).toBe(400)
  })

  it('the person lets an ask act in their tab from the side panel: its task owns the tab, no site is allowed for others', async () => {
    const created = await http('POST', '/tasks', { title: 'Ask about the release notes' })
    const taskId = String(created.body.task?.id ?? created.body.id ?? '')
    expect(taskId, JSON.stringify(created.body)).not.toBe('')
    const url = 'https://docs.panel.test/notes'
    // Only the extension hands a tab over, with its own token.
    expect((await http('POST', '/browser/adopt', { tab: 900, task: taskId, url })).body.code).toBe('not_extension')
    expect((await http('POST', '/browser/adopt', { tab: 900, task: 'no-such-task', url }, ext.auth)).status).toBe(404)
    expect((await http('POST', '/browser/adopt', { tab: 900, task: taskId, url: 'chrome://settings' }, ext.auth)).body.code).toBe('not_a_web_page')
    const port = Number(new URL(base).port)
    const lan = (await getPairingTargets(`http://localhost:${port}`, port)).find((t) => t.kind !== 'cloud')
    if (lan) expect((await http('POST', '/browser/adopt', { tab: 900, task: taskId, url: `${lan.origin}/` }, ext.auth)).body.code).toBe('walnut_page')
    const ok = await http('POST', '/browser/adopt', { tab: 900, task: taskId, url }, ext.auth)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body).toMatchObject({ ok: true, tab: 900, site: 'panel.test' })
    expect(hub.tabOwner(device, 900)).toBe(`task:${taskId}`)
    // Handing one tab over lets no agent open that site anywhere else.
    expect((await http('GET', '/browser/status')).body.sites.map((x: { site: string }) => x.site)).not.toContain('panel.test')
    const elsewhere = await http('POST', '/browser/act', { action: 'open', url: 'https://docs.panel.test/other' }, AGENT)
    expect(elsewhere.status).toBe(202)
    expect(elsewhere.body.code).toBe('site_needs_ok')
    expect((await http('GET', '/browser/panel')).body.panel).toBe(1)
    // Anyone else is refused the tab.
    ext.tabs.set(900, { url, owner: `task:${taskId}` })
    expect((await http('POST', '/browser/act', { action: 'snapshot', tab: 900 }, AGENT)).body.code).toBe('not_your_tab')
    // The task itself goes on in that site in that tab with no ask (the person handed it over),
    // and still asks for another site there.
    const sid = '6f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b'
    await createSessionRecord(sid, taskId, '')
    const inSite = await http('POST', '/browser/act', { action: 'navigate', tab: 900, url: 'https://docs.panel.test/changelog' }, { 'x-walnut-caller-sid': sid })
    expect(inSite.status, JSON.stringify(inSite.body)).toBe(200)
    const offSite = await http('POST', '/browser/act', { action: 'navigate', tab: 900, url: 'https://news.other-site.test/' }, { 'x-walnut-caller-sid': sid })
    expect(offSite.body.code).toBe('site_needs_ok')
  })

  it('the extension turning agents off disconnects it', async () => {
    await ext.stop()
    expect((await http('POST', '/browser/off', {}, ext.auth)).status).toBe(200)
    expect((await http('GET', '/browser/status')).body.browsers).toEqual([])
    expect((await http('GET', '/browser/status')).body.gone).toMatchObject({ why: 'off' })
  })

  it('the person disconnects the extension: status says so at once and a command fails at once, plainly', async () => {
    const dev = await pair()
    const other = fakeExtension(dev.token)
    await expect.poll(async () => (await http('GET', '/browser/status')).body.browsers.length, { timeout: 5000 }).toBe(1)
    // Its Disconnect removes its device (as the extension does: lock, DELETE its device); its poll stays open.
    expect(await revokeDevice(dev.name)).toBe(true)
    const st = (await http('GET', '/browser/status')).body
    expect(st.browsers).toEqual([])
    expect(st.gone).toMatchObject({ why: 'disconnected' })
    const t = Date.now()
    const r = await http('POST', '/browser/act', { action: 'text', tab: 100 }, AGENT)
    expect(Date.now() - t).toBeLessThan(2000)
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    expect(r.body.code).toBe('browser_disconnected')
    expect(r.body.error).toContain('disconnected this browser from Walnut')
    await other.stop()
  })

  it('the extension says it is disconnecting (its Disconnect, before it forgets this Walnut)', async () => {
    const dev = await pair()
    const other = fakeExtension(dev.token)
    await expect.poll(async () => (await http('GET', '/browser/status')).body.browsers.length, { timeout: 5000 }).toBe(1)
    await other.stop()
    expect((await http('POST', '/browser/off', { why: 'disconnected' }, other.auth)).status).toBe(200)
    expect((await http('POST', '/browser/act', { action: 'tabs' }, AGENT)).body.code).toBe('browser_disconnected')
  })
})

describe('setting the extension up from Walnut, and keeping it current', () => {
  // A built web app of the test's own: the two zips and walnut-extension.json, for a build.
  const statics: string[] = []
  async function staticFor(build: string): Promise<string> {
    const { manifestFor, writeZip } = await import('../../scripts/build-extension.mjs' as string) as { manifestFor: (b: string, build?: string) => object; writeZip: (d: string, to: string) => void }
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-ext-static-'))
    statics.push(root)
    for (const b of ['chrome', 'firefox']) {
      const src = path.join(root, `src-${b}`)
      await fsp.mkdir(src, { recursive: true })
      await fsp.writeFile(path.join(src, 'manifest.json'), JSON.stringify(manifestFor(b, build)))
      await fsp.writeFile(path.join(src, 'background.js'), `// ${build}`)
      writeZip(src, path.join(root, 'downloads', `walnut-extension-${b}.zip`))
    }
    await fsp.writeFile(path.join(root, 'downloads', 'walnut-extension.json'), JSON.stringify({ version: '0.6.25', build }))
    return root
  }
  afterAll(async () => {
    delete process.env.WALNUT_WEB_STATIC_DIR
    for (const d of statics) await fsp.rm(d, { recursive: true, force: true })
  })

  it('names the build Walnut ships, sets the folder up (never in a test run), and brings it up to a newer build', async () => {
    process.env.WALNUT_WEB_STATIC_DIR = await staticFor('aaaaaa111111')
    expect((await http('GET', '/browser/panel')).body).toEqual({ panel: 1, askPanel: 2, extension: { version: '0.6.25', build: 'aaaaaa111111' } })
    const refused = await http('POST', '/browser/extension/setup', { browser: 'chrome' }, { 'x-walnut-test-run': 'probe' })
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe('test_run')
    expect((await http('POST', '/browser/extension/setup', { browser: 'safari' })).status).toBe(400)
    const ok = await http('POST', '/browser/extension/setup', { browser: 'chrome' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    // A throwaway server keeps the folder in its own data home and opens nothing on the machine.
    const dir = path.join(WALNUT_HOME, 'browser-extension', 'chrome')
    expect(ok.body).toEqual({ dir, build: 'aaaaaa111111', copied: false, opened: false })
    const manifest = () => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { version_name?: string }
    expect(manifest().version_name).toMatch(/build aaaaaa111111$/)
    // The folder is marked as this Walnut's, and the panel names its id (only that copy reloads itself).
    const marker = JSON.parse(fs.readFileSync(path.join(dir, 'walnut-folder.json'), 'utf8')) as { folder: string; browser: string; serverUrl?: string }
    expect(marker).toMatchObject({ browser: 'chrome', serverUrl: expect.stringMatching(/^http:\/\/localhost:\d+$/) })
    expect((await http('GET', '/browser/panel')).body.extension).toEqual({ version: '0.6.25', build: 'aaaaaa111111', folder: marker.folder })
    // A newer Walnut: the extension asking which build there is finds the folder already on it.
    process.env.WALNUT_WEB_STATIC_DIR = await staticFor('bbbbbb222222')
    expect((await http('GET', '/browser/panel')).body.extension.build).toBe('bbbbbb222222')
    expect(manifest().version_name).toMatch(/build bbbbbb222222$/)
    // Firefox was never set up: it stays so.
    expect(fs.existsSync(path.join(WALNUT_HOME, 'browser-extension', 'firefox'))).toBe(false)
    // A Walnut built without the extension says so.
    process.env.WALNUT_WEB_STATIC_DIR = path.join(os.tmpdir(), 'walnut-no-such-static')
    expect((await http('GET', '/browser/panel')).body).toEqual({ panel: 1, askPanel: 2 })
    expect((await http('POST', '/browser/extension/setup', { browser: 'chrome' })).body.code).toBe('no_extension_build')
  })
})

