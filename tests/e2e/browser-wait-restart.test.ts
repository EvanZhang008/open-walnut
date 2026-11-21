/**
 * A wait on the person crosses a Walnut restart (2026-11-20: a deploy restarted the server while
 * an agent's `walnut browser request-sign-in` waited for the person's Touch ID; the ask was
 * forgotten, the agent's next call made a second card, and the person was asked again).
 *
 * Against a real server and a fake extension: the server's memory is dropped the way a restart
 * drops it (the hub's tabs and every kept ask), the extension reports its tabs again, and
 *   - the same request id is answered after the reload: the same ask, no second card;
 *   - the person's Done (Hand back) after the restart ends it, and the agent's wait answers done;
 *   - before the browser reports again, a call naming the ask waits (browser_reconnecting), never refused;
 *   - an ask whose tab is gone when the browser reports again ends as gone, never stays open.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-browser-wait-restart-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { _forgetBrowserHubForRestart } from '../../src/core/browser-control/hub.js'
import { forgetKeptForRestart, flushKept } from '../../src/core/kept-asks.js'

let base = ''

async function http(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}

interface Cmd { id: string; action: string; args: Record<string, any> }

/** A browser that keeps its tabs (and their owners) across Walnut's restart, as the extension does. */
function extension(token: string) {
  const auth = { authorization: `Bearer ${token}` }
  const tabs = new Map<number, { url: string; owner: string; title: string; driving?: boolean }>()
  let next = 500
  let on = true
  let paused = false
  const answer = (c: Cmd): { ok: boolean; result?: unknown; error?: unknown } => {
    const t = tabs.get(c.args.tab)
    switch (c.action) {
      case 'open': {
        const id = next++
        tabs.set(id, { url: c.args.url, owner: c.args.owner, title: 'Sign in' })
        return { ok: true, result: { tab: id, url: c.args.url, title: 'Sign in', window: 'agent', windowState: 'normal' } }
      }
      case 'view_takeover': if (!t) return { ok: false, error: { message: 'gone', code: 'not_your_tab' } }; t.driving = true; return { ok: true, result: { tab: c.args.tab, driving: true } }
      case 'view_handback': if (t) delete t.driving; return { ok: true, result: { tab: c.args.tab, handedBack: true } }
      default: return { ok: true, result: { tab: c.args.tab, url: t?.url, title: t?.title } }
    }
  }
  const loop = (async () => {
    while (on) {
      if (paused) { await new Promise((r) => setTimeout(r, 20)); continue }
      const report = [...tabs].map(([id, x]) => ({ id, owner: x.owner, url: x.url, title: x.title, window: 'agent', ...(x.driving ? { driving: true } : {}) }))
      const r = await http('POST', '/browser/poll', { browser: 'chrome', version: '9.9', caps: ['screenshot', 'takeover'], tabs: report, waitMs: 200 }, auth).catch(() => ({ status: 0, body: {} as Record<string, any> }))
      if (r.status !== 200) { await new Promise((res) => setTimeout(res, 30)); continue }
      for (const c of (r.body.commands ?? []) as Cmd[]) void http('POST', '/browser/result', { id: c.id, ...answer(c) }, auth)
    }
  })()
  return {
    tabs, auth,
    /** The browser is away (Walnut restarting): no poll reaches it. */
    pause: () => { paused = true },
    resume: () => { paused = false },
    stop: async () => { on = false; await loop },
  }
}

async function pair(): Promise<{ token: string }> {
  const code = (await (await fetch(`${base}/api/devices/browser-code`, { method: 'POST' })).json() as { code: string }).code
  return (await http('POST', '/browser-pair', { code, client: 'extension' })).body as { token: string }
}

let ext: ReturnType<typeof extension>
let taskId = ''
let sid = ''
let device = ''
const SESSION = () => ({ 'x-walnut-caller-sid': sid })

/** What a restart drops: every in-memory ask and the hub's tabs, while what is on disk stays. */
async function restart(): Promise<void> {
  ext.pause()
  await flushKept()
  forgetKeptForRestart()
  _forgetBrowserHubForRestart()
  ext.resume()
}

async function openTab(): Promise<number> {
  const r = await http('POST', '/browser/act', { action: 'open', url: 'https://shop.example.test/login' }, SESSION())
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return r.body.tab
}

beforeAll(async () => {
  process.env.WALNUT_TEST_RUN_MARK = '1'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  ext = extension((await pair()).token)
  for (let i = 0; i < 100 && !(await http('GET', '/browser/status')).body.browsers?.length; i++) await new Promise((r) => setTimeout(r, 50))
  device = (await http('GET', '/browser/status')).body.browsers[0].device
  const created = await http('POST', '/tasks', { title: 'Order the printer paper' })
  taskId = String(created.body.task?.id ?? created.body.id ?? '')
  sid = '7c2e3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e'
  await createSessionRecord(sid, taskId, '')
}, 120_000)

afterAll(async () => {
  await ext?.stop()
  await stopServer()
  delete process.env.WALNUT_TEST_RUN_MARK
})

describe('a sign-in wait across a restart', () => {
  it('the same request id is the same ask after the reload, and Done after the restart ends it', async () => {
    const tab = await openTab()
    const ask = await http('POST', '/browser/act', { action: 'request_sign_in', tab, text: 'press Touch ID on the shop' }, SESSION())
    expect(ask.status, JSON.stringify(ask.body)).toBe(202)
    const id = ask.body.request as string
    expect(id).toMatch(/^si-/)

    await restart()

    // The agent's next call names its ask: the same one, no second card on the view.
    const again = await http('POST', '/browser/act', { action: 'request_sign_in', tab, request: id, wait_ms: 0 }, SESSION())
    expect(again.status, JSON.stringify(again.body)).toBe(202)
    expect(again.body).toMatchObject({ status: 'needs_ok', code: 'sign_in_waiting', request: id })
    const view = await http('GET', `/browser/view?task=${taskId}`)
    const asks = (view.body.tabs as Array<{ signIn?: { id: string; note?: string } }>).filter((t) => t.signIn)
    expect(asks.map((t) => t.signIn!.id)).toEqual([id])
    expect(asks[0].signIn!.note).toBe('press Touch ID on the shop')

    // The person's Take over and Done after the restart answer the agent's waiting call.
    const waiting = http('POST', '/browser/act', { action: 'request_sign_in', tab, request: id, wait_ms: 10_000 }, SESSION())
    expect((await http('POST', '/browser/view/takeover', { task: taskId, tab, device })).status).toBe(200)
    expect((await http('POST', '/browser/view/handback', { task: taskId, tab, device })).body).toMatchObject({ signIn: 'done' })
    const done = await waiting
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body).toMatchObject({ signIn: 'done', done: true, tab })
  }, 30_000)

  it('before the browser reports again, a call that names its ask waits instead of being refused', async () => {
    const tab = await openTab()
    const id = (await http('POST', '/browser/act', { action: 'request_sign_in', tab }, SESSION())).body.request as string
    ext.pause()
    await flushKept()
    forgetKeptForRestart()
    _forgetBrowserHubForRestart()
    // No browser yet: not "no browser" or "not your tab", but the same ask, still waiting.
    const early = await http('POST', '/browser/act', { action: 'request_sign_in', tab, request: id, wait_ms: 0 }, SESSION())
    expect(early.status, JSON.stringify(early.body)).toBe(202)
    expect(early.body).toMatchObject({ status: 'needs_ok', code: 'browser_reconnecting', request: id })
    // The browser comes back: the next call with that request is the same ask again.
    ext.resume()
    const back = await http('POST', '/browser/act', { action: 'request_sign_in', tab, request: id, wait_ms: 5000 }, SESSION())
    expect(back.body).toMatchObject({ code: 'sign_in_waiting', request: id })
    expect((await http('POST', '/browser/view/handback', { task: taskId, tab, device })).body).toMatchObject({ signIn: 'done' })
  }, 30_000)

  it('an ask whose tab closed while Walnut was down ends as gone once the browser reports again', async () => {
    const tab = await openTab()
    const ask = await http('POST', '/browser/act', { action: 'request_sign_in', tab }, SESSION())
    const id = ask.body.request as string
    ext.pause()
    ext.tabs.delete(tab)
    await restart()
    // The browser's next report lacks the tab: the kept ask ends with it, and the agent's next
    // call hears the tab is gone instead of waiting on an ask nobody can answer.
    const { getAsk } = await import('../../src/core/browser-control/sign-in-ask.js')
    await expect.poll(() => getAsk(id)?.end?.why, { timeout: 5000 }).toBe('gone')
    const after = await http('POST', '/browser/act', { action: 'request_sign_in', tab, request: id, wait_ms: 0 }, SESSION())
    expect(after.status, JSON.stringify(after.body)).toBe(403)
    expect(after.body.code).toBe('not_your_tab')
  }, 30_000)
})
