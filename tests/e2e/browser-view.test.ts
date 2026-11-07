/**
 * A task's Browser view and the rules around a session in the person's browser, on a real server
 * (src/web/routes/browser-view-v1.ts, browser-v1.ts) with a fake extension that polls like the
 * real one (2026-11-07: a session signed in to the person's bank again in a minimized window he
 * never saw, while he was signed in in his own front tab):
 *
 *   - every open, take and navigate names the window and the tab;
 *   - an open or navigate to a site the person has open in a tab of their own lists those tabs,
 *     and fill_login there is refused unless the person asked for a fresh sign-in;
 *   - the task's tabs (title, address, window) are listed for its Browser view, `browser:tabs`
 *     comes when they change, a frame is the person's only and two viewers share one capture,
 *     Stop ends the agent's use, and the view says why the last tab went;
 *   - a restarted server learns the tabs back from the extension's next report.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-browser-view-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import * as hub from '../../src/core/browser-control/hub.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { _resetFreshSignInForTesting } from '../../src/core/browser-control/fresh-sign-in.js'
import { answerMessage, keyIdOf } from '../../src/core/approvals/digest.js'
import crypto from 'node:crypto'

let base = ''

async function http(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(p.startsWith('/api/') ? `${base}${p}` : `${base}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}

interface Seen { action: string; args: Record<string, any> }
const PIXEL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=='

/** A browser with the person's own tabs, and agent tabs in Walnut's agent window. */
function fakeExtension(token: string, opts: { start?: number; image?: string; seed?: Array<[number, { url: string; owner: string; title: string; window: 'agent' | 'person' }]> } = {}) {
  const seen: Seen[] = []
  const tabs = new Map<number, { url: string; owner: string; title: string; window: 'agent' | 'person' }>(opts.seed ?? [])
  const image = opts.image ?? PIXEL
  /** How the browser answers the list of every tab: as it should, an error, a list of the agents' tabs only, or one without the asking tab. */
  const list = { mode: 'ok' as 'ok' | 'fail' | 'partial' | 'missing' }
  const persons = [
    { id: 11, url: 'https://www.bank.example.test/accounts', title: 'Accounts', active: true },
    { id: 12, url: 'https://news.other.test/', title: 'News' },
  ]
  let next = opts.start ?? 200
  let on = true
  let reportTitles = true
  const auth = { authorization: `Bearer ${token}` }
  const answer = (c: Seen & { id: string }): { ok: boolean; result?: unknown; error?: unknown } => {
    switch (c.action) {
      case 'open': {
        const id = next++
        tabs.set(id, { url: c.args.url, owner: c.args.owner, title: 'Bank login', window: 'agent' })
        return { ok: true, result: { tab: id, url: c.args.url, title: 'Bank login', window: 'agent', windowState: 'normal' } }
      }
      case 'navigate': {
        const t = tabs.get(c.args.tab)!
        t.url = c.args.url
        return { ok: true, result: { tab: c.args.tab, url: t.url, title: t.title, window: t.window, windowState: 'normal' } }
      }
      case 'tabs': if (c.args.all && list.mode === 'fail') return { ok: false, error: { message: 'busy', code: 'browser_error' } }
      if (c.args.all && list.mode === 'partial') return { ok: true, result: { tabs: [...tabs].map(([id, t]) => ({ id, url: t.url, owner: t.owner })) } }
      if (c.args.all && list.mode === 'missing') return { ok: true, result: { all: true, tabs: persons } }
      return {
        ok: true,
        result: c.args.all
          ? { all: true, tabs: [...persons, ...[...tabs].map(([id, t]) => ({ id, url: t.url, title: t.title, owner: t.owner }))] }
          : { tabs: [...tabs].map(([id, t]) => ({ id, url: t.url, owner: t.owner })) },
      }
      case 'view_frame': {
        const t = tabs.get(c.args.tab)
        if (!t) return { ok: false, error: { message: 'gone', code: 'not_your_tab' } }
        return { ok: true, result: { tab: c.args.tab, url: t.url, title: t.title, window: t.window, windowState: 'normal', shown: true, image, at: new Date().toISOString() } }
      }
      case 'view_stop': {
        const had = tabs.delete(c.args.tab)
        return { ok: true, result: { tab: c.args.tab, stopped: had } }
      }
      case 'close': tabs.delete(c.args.tab); return { ok: true, result: { tab: c.args.tab, closed: true } }
      case 'network': return { ok: true, result: { tab: c.args.tab, recording: true, since: '2026-11-07T08:00:00.000Z', total: 1, matched: 1, requests: [{ id: '31.2', url: 'https://login.bank.example.test/api/accounts', method: 'GET', type: 'Fetch', status: 200 }] } }
      case 'network_body': return { ok: true, result: { tab: c.args.tab, request_id: c.args.request_id, body: '{"accounts":2}', length: 14 } }
      case 'resize': return { ok: true, result: { tab: c.args.tab, width: c.args.width, height: c.args.height, viewport: { width: c.args.width - 16, height: c.args.height - 120 } } }
      case 'upload': return { ok: true, result: { tab: c.args.tab, uploaded: ['a.txt (1 bytes)'], into: `the file field ${c.args.selector}` } }
      default: return { ok: true, result: { tab: c.args.tab, snapshot: '[e1] button "Sign in"' } }
    }
  }
  const loop = (async () => {
    while (on) {
      const report = [...tabs].map(([id, t]) => ({ id, owner: t.owner, ...(reportTitles ? { url: t.url, title: t.title, window: t.window } : {}) }))
      const r = await http('POST', '/browser/poll', { browser: 'chrome', version: '9.9', caps: ['screenshot'], tabs: report, waitMs: 300 }, auth)
      if (r.status !== 200) { await new Promise((res) => setTimeout(res, 50)); continue }
      for (const c of r.body.commands as Array<Seen & { id: string }>) {
        seen.push(c)
        // A frame takes a moment, as a capture does.
        if (c.action === 'view_frame') await new Promise((res) => setTimeout(res, 120))
        await http('POST', '/browser/result', { id: c.id, ...answer(c) }, auth)
      }
    }
  })()
  return { seen, tabs, persons, auth, list, quiet: () => { reportTitles = false }, stop: async () => { on = false; await loop } }
}

async function pair(): Promise<{ token: string; name: string }> {
  const code = (await (await fetch(`${base}/api/devices/browser-code`, { method: 'POST' })).json() as { code: string }).code
  return (await http('POST', '/browser-pair', { code, client: 'extension' })).body as { token: string; name: string }
}

/** The web's event socket: every `browser:tabs` it hears. */
function listen(): { events: Array<{ taskId?: string }>; close: () => void; ready: Promise<void> } {
  const events: Array<{ taskId?: string }> = []
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`)
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(String(raw)) as { type?: string; name?: string; event?: string; data?: unknown; payload?: unknown }
      const name = m.name ?? m.event
      if (name === 'browser:tabs') events.push((m.data ?? m.payload) as { taskId?: string })
    } catch { /* not ours */ }
  })
  return { events, close: () => ws.close(), ready: new Promise((r) => ws.once('open', () => r())) }
}

let ext: ReturnType<typeof fakeExtension>
let taskId = ''
let sid = ''
let agentTab = 0
const SESSION = () => ({ 'x-walnut-caller-sid': sid })

beforeAll(async () => {
  process.env.WALNUT_TEST_RUN_MARK = '1'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const dev = await pair()
  ext = fakeExtension(dev.token)
  for (let i = 0; i < 100 && !(await http('GET', '/browser/status')).body.browsers?.length; i++) await new Promise((r) => setTimeout(r, 50))
  const created = await http('POST', '/tasks', { title: 'Pay the electricity bill' })
  taskId = String(created.body.task?.id ?? created.body.id ?? '')
  sid = '7a1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a60'
  await createSessionRecord(sid, taskId, '')
}, 120_000)

afterAll(async () => {
  await ext?.stop()
  await stopServer()
  delete process.env.WALNUT_TEST_RUN_MARK
})

describe('a session in the person\'s browser', () => {
  it('nothing is listed for a task that never used the browser', async () => {
    expect((await http('GET', `/browser/view?task=${taskId}`)).body).toMatchObject({ taskId, tabs: [], browsers: 1 })
    expect((await http('GET', '/browser/view')).status).toBe(400)
  })

  it('an open names the window and tab, and lists the person\'s own tabs on the site with the step instead of a second sign-in', async () => {
    const ws = listen()
    await ws.ready
    const r = await http('POST', '/browser/act', { action: 'open', url: 'https://login.bank.example.test/' }, SESSION())
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    agentTab = r.body.tab
    expect(r.body.where).toBe(`In Walnut's agent window (behind theirs, not minimized), tab ${agentTab} "Bank login" (https://login.bank.example.test/).`)
    expect(r.body.person_tabs).toEqual([{ id: 11, title: 'Accounts', active: true }])
    expect(r.body.person_tabs_note).toMatch(/They already have example\.test open in tab 11 \("Accounts", the tab they are on\)\. If they are signed in there, ask them to hand that tab over/)
    expect(r.body.person_tabs_note).toMatch(/Do not sign in again\.$/)
    // The person's tabs were read before the open went (the open is the last command).
    expect(ext.seen.slice(-2).map((c) => c.action)).toEqual(['tabs', 'open'])
    expect(ext.seen.at(-2)!.args).toMatchObject({ all: true })
    // The Browser view appears: the event, then the tab with its title, address and window.
    await expect.poll(() => ws.events.filter((e) => e.taskId === taskId).length, { timeout: 5000 }).toBeGreaterThan(0)
    ws.close()
    const v = (await http('GET', `/browser/view?task=${taskId}`)).body
    expect(v.tabs).toEqual([expect.objectContaining({ tab: agentTab, title: 'Bank login', url: 'https://login.bank.example.test/', window: 'agent', connected: true, pictures: true })])
  })

  it('the op\'s outcome says the same in words an agent reads', async () => {
    const { getOp } = await import('../../src/ops/registry.js')
    await import('../../src/ops/browser.js')
    const op = getOp('browser')!
    const mapped = op.mapResult!({
      body: { tab: agentTab, url: 'https://login.bank.example.test/', title: 'Bank login', where: 'In Walnut\'s agent window (behind theirs, not minimized), tab 5 "Bank login" (x).', person_tabs_note: 'They already have example.test open in tab 11 ("Accounts"). If they are signed in there, ask them to hand that tab over. Do not sign in again.' },
      args: { action: 'open' },
    } as never) as { outcome?: string; next?: string }
    expect(mapped.outcome).toMatch(/^In Walnut's agent window .* They already have example\.test open in tab 11/)
    expect(mapped.next).toMatch(/Ask the person for their tab/)
    const plain = op.mapResult!({ body: { tab: 5, url: 'https://shop.test/', where: 'In Walnut\'s agent window (behind theirs, not minimized), tab 5.' }, args: { action: 'open' } } as never) as { next?: string }
    expect(plain.next).toMatch(/first line which window and tab/)
  })

  it('a navigate to a site with none of the person\'s tabs names the window and tab, and nothing more', async () => {
    const r = await http('POST', '/browser/act', { action: 'navigate', tab: agentTab, url: 'https://shop.elsewhere.test/' }, SESSION())
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.where).toMatch(/^In Walnut's agent window/)
    expect(r.body.person_tabs).toBeUndefined()
    // The view follows the tab's new address.
    expect((await http('GET', `/browser/view?task=${taskId}`)).body.tabs[0].url).toBe('https://shop.elsewhere.test/')
    await http('POST', '/browser/act', { action: 'navigate', tab: agentTab, url: 'https://login.bank.example.test/' }, SESSION())
  })

  it('the relay\'s last actions go to the browser with their own arguments: network, a body, resize, upload by selector', async () => {
    const net = await http('POST', '/browser/act', { action: 'network', tab: agentTab, url: '/api/', method: 'GET', status: '2xx', type: 'Fetch', include_static: false }, SESSION())
    expect(net.status, JSON.stringify(net.body)).toBe(200)
    expect(ext.seen.at(-1)).toMatchObject({ action: 'network', args: { tab: agentTab, url: '/api/', method: 'GET', status: '2xx', type: 'Fetch', include_static: false } })
    expect(net.body.requests).toEqual([expect.objectContaining({ id: '31.2', status: 200 })])
    const body = await http('POST', '/browser/act', { action: 'network_body', tab: agentTab, request_id: '31.2', max_chars: 5000 }, SESSION())
    expect(body.body).toMatchObject({ request_id: '31.2', body: '{"accounts":2}' })
    expect(ext.seen.at(-1)!.args).toMatchObject({ request_id: '31.2', max_chars: 5000 })
    const size = await http('POST', '/browser/act', { action: 'resize', tab: agentTab, width: 1000, height: 700, viewport: true }, SESSION())
    expect(size.body).toMatchObject({ width: 1000, height: 700, viewport: { width: 984 } })
    expect(ext.seen.at(-1)!.args).toMatchObject({ width: 1000, height: 700, viewport: true })
    const up = await http('POST', '/browser/act', { action: 'upload', tab: agentTab, selector: '#image-upload-field', files: [{ name: 'a.txt', base64: 'YQ==' }] }, SESSION())
    expect(up.body).toMatchObject({ uploaded: ['a.txt (1 bytes)'] })
    expect(ext.seen.at(-1)!.args).toMatchObject({ selector: '#image-upload-field', files: [{ name: 'a.txt', base64: 'YQ==' }] })
    expect((await http('POST', '/browser/act', { action: 'nope', tab: agentTab }, SESSION())).body.code).toBe('bad_action')
  })

  it('fill_login on a site the person has open in their own tab is refused with the step', async () => {
    const r = await http('POST', '/browser/act', { action: 'fill_login', tab: agentTab }, SESSION())
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    expect(r.body.code).toBe('site_open_in_person_tab')
    expect(r.body.person_tabs).toEqual([{ id: 11, title: 'Accounts', active: true }])
    expect(r.body.error).toMatch(/already has example\.test open in tab 11/)
    expect(r.body.error).toMatch(/hand that tab over/)
    expect(r.body.error).toMatch(/fresh_sign_in: true: that asks them to approve it/)
    // Nothing was filled.
    expect(ext.seen.some((c) => c.action === 'fill_login')).toBe(false)
    // The person closed their bank tab: no refusal from this rule.
    ext.persons.splice(0, 1)
    const after = await http('POST', '/browser/act', { action: 'fill_login', tab: agentTab }, SESSION())
    expect(after.body.code).not.toBe('site_open_in_person_tab')
    ext.persons.unshift({ id: 11, url: 'https://www.bank.example.test/accounts', title: 'Accounts', active: true })
  })

  it('a session\'s fresh_sign_in only asks the person: nothing fills until they approve with proof, and the yes is for that tab alone', async () => {
    _resetFreshSignInForTesting()
    const ask = await http('POST', '/browser/act', { action: 'fill_login', tab: agentTab, fresh_sign_in: true }, SESSION())
    expect(ask.status, JSON.stringify(ask.body)).toBe(202)
    expect(ask.body).toMatchObject({ status: 'needs_ok', code: 'fresh_sign_in_needs_ok', site: 'example.test' })
    expect(ext.seen.some((c) => c.action === 'fill_login')).toBe(false)
    // Asked again: the same ask, not a second one.
    expect((await http('POST', '/browser/act', { action: 'fill_login', tab: agentTab, fresh_sign_in: true }, SESSION())).body.request).toBe(ask.body.request)
    // The approval names the site and the person's tab.
    const approval = (await http('GET', `/approvals/${ask.body.request}`)).body.approval
    expect(approval.what).toMatch(/sign in again on example\.test\? You already have it open \(tab 11 \("Accounts"\)\)/)
    // A plain approve from this machine (what the agent itself could send) is no proof.
    expect((await http('POST', `/approvals/${ask.body.request}/answer`, { decision: 'approve' })).status).toBe(403)
    expect((await http('POST', '/browser/act', { action: 'fill_login', tab: agentTab, request: ask.body.request }, SESSION())).status).toBe(202)
    // The person's phone signs a yes.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const phone = await http('POST', '/api/devices', { name: 'browser-view-e2e-phone' })
    expect((await http('POST', '/approvals/keys', { publicKey: spki, name: 'Test iPhone', kind: 'iphone' }, { authorization: `Bearer ${phone.body.token}` })).status).toBe(200)
    const digest = approval.digest as string
    const signature = crypto.sign('sha256', Buffer.from(answerMessage(digest, 'approve')), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
    expect((await http('POST', `/approvals/${ask.body.request}/answer`, { decision: 'approve', keyId: keyIdOf(spki), signature })).status).toBe(200)
    // Through to the vault now (nothing set up here, so the vault answers), past this rule.
    const through = await http('POST', '/browser/act', { action: 'fill_login', tab: agentTab, request: ask.body.request }, SESSION())
    expect(['site_open_in_person_tab', 'fresh_sign_in_needs_ok', 'same_site_unchecked', 'no_such_request']).not.toContain(through.body.code)
    // Another tab of the task on the same site has no yes.
    const second = await http('POST', '/browser/act', { action: 'open', url: 'https://login.bank.example.test/' }, SESSION())
    expect(second.status).toBe(200)
    const other = await http('POST', '/browser/act', { action: 'fill_login', tab: second.body.tab }, SESSION())
    expect(other.body.code).toBe('site_open_in_person_tab')
    // The ask is used: it cannot be brought again.
    expect((await http('POST', '/browser/act', { action: 'fill_login', tab: second.body.tab, request: ask.body.request }, SESSION())).body.code).not.toBe('ok')
    await http('POST', '/browser/act', { action: 'close', tab: second.body.tab }, SESSION())
    _resetFreshSignInForTesting()
  })

  it('a same-site check that cannot be made fills nothing: an error, a list of the agents\' tabs only, a list without this tab', async () => {
    for (const mode of ['fail', 'partial', 'missing'] as const) {
      ext.list.mode = mode
      const r = await http('POST', '/browser/act', { action: 'fill_login', tab: agentTab }, SESSION())
      expect(r.status, `${mode}: ${JSON.stringify(r.body)}`).toBe(503)
      expect(r.body.code).toBe('same_site_unchecked')
      expect(r.body.error).toMatch(/fills nothing yet/)
    }
    ext.list.mode = 'ok'
    expect(ext.seen.some((c) => c.action === 'fill_login')).toBe(false)
    // Once the browser answers again, the rule decides as before.
    expect((await http('POST', '/browser/act', { action: 'fill_login', tab: agentTab }, SESSION())).body.code).toBe('site_open_in_person_tab')
  })

  it('a frame is the person\'s only; two viewers share one capture', async () => {
    const asAgent = await http('GET', `/browser/view/frame?task=${taskId}&tab=${agentTab}`, undefined, SESSION())
    expect(asAgent.status).toBe(403)
    expect(asAgent.body.code).toBe('human_only')
    expect(asAgent.body.error).toMatch(/screenshot/)
    const before = ext.seen.filter((c) => c.action === 'view_frame').length
    const [a, b] = await Promise.all([
      http('GET', `/browser/view/frame?task=${taskId}&tab=${agentTab}`),
      http('GET', `/browser/view/frame?task=${taskId}&tab=${agentTab}`),
    ])
    expect(a.status, JSON.stringify(a.body)).toBe(200)
    expect(a.body).toMatchObject({ tab: agentTab, shown: true, image: PIXEL, window: 'agent', title: 'Bank login' })
    expect(b.body.image).toBe(PIXEL)
    expect(ext.seen.filter((c) => c.action === 'view_frame').length - before).toBe(1)
    // Another task's tab, or no such tab: none.
    expect((await http('GET', `/browser/view/frame?task=other-task&tab=${agentTab}`)).status).toBe(404)
    expect((await http('GET', `/browser/view/frame?task=${taskId}`)).status).toBe(400)
  })

  it('a test run sees none of the person\'s browser and stops nothing', async () => {
    const TEST = { 'x-walnut-test-run': 'webdriver-probe' }
    const before = ext.seen.length
    expect((await http('GET', `/browser/view?task=${taskId}`, undefined, TEST)).body).toMatchObject({ tabs: [], testRun: true })
    const frame = await http('GET', `/browser/view/frame?task=${taskId}&tab=${agentTab}`, undefined, TEST)
    expect(frame.status).toBe(409)
    expect(frame.body.code).toBe('test_run')
    expect(frame.body.image).toBeUndefined()
    const stop = await http('POST', '/browser/view/stop', { task: taskId, tab: agentTab }, TEST)
    expect(stop.status).toBe(409)
    expect(ext.seen.slice(before).filter((c) => c.action === 'view_frame' || c.action === 'view_stop')).toHaveLength(0)
    expect((await http('GET', `/browser/view?task=${taskId}`)).body.tabs).toHaveLength(1)
  })

  it('Stop is the person\'s: a session (this task\'s or another\'s) is refused and the tab stays the task\'s', async () => {
    const before = ext.seen.length
    for (const caller of [SESSION(), { 'x-walnut-caller-sid': 'another-session-id' }]) {
      const r = await http('POST', '/browser/view/stop', { task: taskId, tab: agentTab }, caller)
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('human_only')
    }
    expect(ext.seen.slice(before).some((c) => c.action === 'view_stop')).toBe(false)
    expect((await http('GET', `/browser/view?task=${taskId}`)).body.tabs).toEqual([expect.objectContaining({ tab: agentTab })])
  })

  it('a restarted server learns the tab, its title and window back from the next report', async () => {
    hub._resetBrowserHubForTesting()
    await expect.poll(async () => (await http('GET', `/browser/view?task=${taskId}`)).body.tabs?.length ?? 0, { timeout: 5000 }).toBe(1)
    expect((await http('GET', `/browser/view?task=${taskId}`)).body.tabs[0]).toMatchObject({ tab: agentTab, title: 'Bank login', window: 'agent' })
    expect((await http('GET', `/browser/view/frame?task=${taskId}&tab=${agentTab}`)).body.shown).toBe(true)
  })

  it('Stop ends the agent\'s use, the view says why, and the agent\'s next command is refused', async () => {
    const ws = listen()
    await ws.ready
    const r = await http('POST', '/browser/view/stop', { task: taskId, tab: agentTab })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ ok: true, stopped: true, tab: agentTab })
    expect(ext.seen.at(-1)).toMatchObject({ action: 'view_stop', args: { tab: agentTab } })
    await expect.poll(() => ws.events.filter((e) => e.taskId === taskId).length, { timeout: 5000 }).toBeGreaterThan(0)
    ws.close()
    expect((await http('GET', `/browser/view?task=${taskId}`)).body).toMatchObject({ tabs: [], ended: { why: 'stopped' } })
    expect((await http('POST', '/browser/act', { action: 'snapshot', tab: agentTab }, SESSION())).body.code).toBe('not_your_tab')
    // A Stop of a tab that is no longer the task's is a quiet no.
    expect((await http('POST', '/browser/view/stop', { task: taskId, tab: agentTab })).body).toMatchObject({ ok: true, stopped: false })
  })

  it('an agent that closes its own tab: the view says it closed it', async () => {
    const r = await http('POST', '/browser/act', { action: 'open', url: 'https://news.other.test/today' }, SESSION())
    expect(r.status).toBe(200)
    expect(r.body.person_tabs).toEqual([{ id: 12, title: 'News' }])
    expect((await http('GET', `/browser/view?task=${taskId}`)).body.ended).toBeUndefined()
    await http('POST', '/browser/act', { action: 'close', tab: r.body.tab }, SESSION())
    expect((await http('GET', `/browser/view?task=${taskId}`)).body).toMatchObject({ tabs: [], ended: { why: 'closed' } })
  })

  it('two browsers with the same tab id: a frame or Stop names the browser, and each goes to its own', async () => {
    const r = await http('POST', '/browser/act', { action: 'open', url: 'https://shop.elsewhere.test/' }, SESSION())
    expect(r.status).toBe(200)
    const id = r.body.tab as number
    const devA = (await http('GET', `/browser/view?task=${taskId}`)).body.tabs[0].device as string
    const B_PIXEL = 'data:image/jpeg;base64,/9j/BBBB'
    const second = fakeExtension((await pair()).token, { image: B_PIXEL, seed: [[id, { url: 'https://docs.elsewhere.test/', owner: `task:${taskId}`, title: 'Docs', window: 'agent' }]] })
    try {
      await expect.poll(async () => (await http('GET', `/browser/view?task=${taskId}`)).body.tabs?.length ?? 0, { timeout: 5000 }).toBe(2)
      const tabs = (await http('GET', `/browser/view?task=${taskId}`)).body.tabs as Array<{ tab: number; device: string; title: string }>
      const devB = tabs.find((t) => t.device !== devA)!.device
      expect(tabs.find((t) => t.device === devB)!.title).toBe('Docs')
      // The tab id alone is two tabs: the route asks which browser.
      const which = await http('GET', `/browser/view/frame?task=${taskId}&tab=${id}`)
      expect(which.status).toBe(409)
      expect(which.body.code).toBe('which_browser')
      const fb = await http('GET', `/browser/view/frame?task=${taskId}&tab=${id}&device=${encodeURIComponent(devB)}`)
      expect(fb.body).toMatchObject({ device: devB, image: B_PIXEL, title: 'Docs' })
      const fa = await http('GET', `/browser/view/frame?task=${taskId}&tab=${id}&device=${encodeURIComponent(devA)}`)
      expect(fa.body).toMatchObject({ device: devA, image: PIXEL })
      expect((await http('POST', '/browser/view/stop', { task: taskId, tab: id })).status).toBe(409)
      const stop = await http('POST', '/browser/view/stop', { task: taskId, tab: id, device: devB })
      expect(stop.body).toMatchObject({ stopped: true, device: devB })
      expect(second.seen.some((c) => c.action === 'view_stop')).toBe(true)
      expect(ext.seen.some((c) => c.action === 'view_stop' && c.args.tab === id)).toBe(false)
      expect((await http('GET', `/browser/view?task=${taskId}`)).body.tabs).toEqual([expect.objectContaining({ tab: id, device: devA })])
    } finally {
      await second.stop()
    }
  })
})
