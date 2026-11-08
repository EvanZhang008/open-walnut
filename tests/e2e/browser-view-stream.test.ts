/**
 * The Browser view's live stream, Take over and the sign-in hand-off, on a real server
 * (src/web/routes/browser-view-v1.ts, browser-view-stream.ts, browser-v1.ts) with a fake extension
 * that streams like the real one (packages/browser-extension/src/agent-view.ts, agent-takeover.ts).
 * 2026-11-08, the user: "very laggy like it doesn't show in real time, it takes so long to
 * screenshot ... I want it to be able to take over if needed"; then, of another agent's browser,
 * "let our browser task learn from this" (the person signs in themselves; Google's refusal page).
 *
 *   - a viewer's first ask starts one stream; each posted picture reaches a waiting viewer at once,
 *     `after` holds the request until a newer one, `unchanged` when none came, a `same` post keeps
 *     the picture without its bytes, and a stream nobody watches is told to stop;
 *   - Take over and Hand back are the person's alone, reach the browser, and show on the tab list;
 *   - request_sign_in waits for the person's Done (Hand back here or on the tab's pill) and answers
 *     done; Stop ends it as stopped;
 *   - an act that lands on Google's refusal page carries hand_off to request_sign_in.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-browser-view-stream-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'

let base = ''

async function http(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}

const shot = (n: number) => `data:image/jpeg;base64,${Buffer.from(`picture ${n} `.repeat(50)).toString('base64')}`
const GOOGLE_REFUSED = 'https://accounts.google.com/v3/signin/rejected?continue=x'

interface Cmd { id: string; action: string; args: Record<string, any> }

/** A browser that streams: on view_watch it posts pictures until Walnut says nobody watches. */
function streamingExtension(token: string) {
  const auth = { authorization: `Bearer ${token}` }
  const seen: Cmd[] = []
  const tabs = new Map<number, { url: string; owner: string; title: string; driving?: boolean }>()
  let next = 300
  let on = true
  let picture = 1
  /** How each post's answer went: more, or stop. */
  const answers: Array<{ more: boolean }> = []
  const streams = new Set<number>()
  const pushes = { count: 0, same: 0 }
  const stream = async (tab: number) => {
    if (streams.has(tab)) return
    streams.add(tab)
    let last = ''
    try {
      for (;;) {
        const t = tabs.get(tab)
        if (!t) { await http('POST', '/browser/view/push', { tab, gone: true }, auth); return }
        const image = shot(picture)
        const body = { tab, url: t.url, title: t.title, window: 'agent', windowState: 'normal', shown: true, at: new Date().toISOString(), ...(t.driving ? { driving: true } : {}), ...(image === last ? { same: true } : { image }) }
        if (image === last) pushes.same++
        last = image
        pushes.count++
        const r = await http('POST', '/browser/view/push', body, auth)
        answers.push({ more: r.body.more === true })
        if (r.body.again) last = ''
        if (r.body.more !== true) return
        await new Promise((res) => setTimeout(res, 80))
      }
    } finally { streams.delete(tab) }
  }
  const answer = (c: Cmd): { ok: boolean; result?: unknown; error?: unknown } => {
    const t = typeof c.args.tab === 'number' ? tabs.get(c.args.tab) : undefined
    if (t?.driving && !c.action.startsWith('view_')) return { ok: false, error: { message: 'The person took this tab over', code: 'person_driving' } }
    switch (c.action) {
      case 'open': {
        const id = next++
        tabs.set(id, { url: c.args.url, owner: c.args.owner, title: 'Sign in' })
        return { ok: true, result: { tab: id, url: c.args.url, title: 'Sign in', window: 'agent', windowState: 'normal' } }
      }
      case 'navigate': {
        t!.url = c.args.url
        t!.title = c.args.url.includes('rejected') ? 'Couldn’t sign you in' : 'Page'
        return { ok: true, result: { tab: c.args.tab, url: t!.url, title: t!.title, window: 'agent', windowState: 'normal' } }
      }
      case 'view_watch': void stream(c.args.tab); return { ok: true, result: { tab: c.args.tab, watching: true } }
      case 'view_takeover': if (!t) return { ok: false, error: { message: 'gone', code: 'not_your_tab' } }; t.driving = true; return { ok: true, result: { tab: c.args.tab, driving: true } }
      case 'view_handback': if (t) delete t.driving; return { ok: true, result: { tab: c.args.tab, handedBack: true } }
      case 'view_stop': return { ok: true, result: { tab: c.args.tab, stopped: tabs.delete(c.args.tab) } }
      default: return { ok: true, result: { tab: c.args.tab, snapshot: '[e1] button "Next"', url: t?.url, title: t?.title } }
    }
  }
  const loop = (async () => {
    while (on) {
      const report = [...tabs].map(([id, x]) => ({ id, owner: x.owner, url: x.url, title: x.title, window: 'agent', ...(x.driving ? { driving: true } : {}) }))
      const r = await http('POST', '/browser/poll', { browser: 'chrome', version: '9.9', caps: ['screenshot', 'view-stream', 'takeover'], tabs: report, waitMs: 300 }, auth)
      if (r.status !== 200) { await new Promise((res) => setTimeout(res, 50)); continue }
      for (const c of r.body.commands as Cmd[]) {
        seen.push(c)
        void http('POST', '/browser/result', { id: c.id, ...answer(c) }, auth)
      }
    }
  })()
  return {
    seen, tabs, answers, pushes, auth,
    show: (n: number) => { picture = n },
    streaming: (tab: number) => streams.has(tab),
    stop: async () => { on = false; await loop },
  }
}

async function pair(): Promise<{ token: string }> {
  const code = (await (await fetch(`${base}/api/devices/browser-code`, { method: 'POST' })).json() as { code: string }).code
  return (await http('POST', '/browser-pair', { code, client: 'extension' })).body as { token: string }
}

let ext: ReturnType<typeof streamingExtension>
let taskId = ''
let sid = ''
let tab = 0
let device = ''
const SESSION = () => ({ 'x-walnut-caller-sid': sid })
let epoch = ''
const frame = async (after?: number, ep = epoch) => {
  const r = await http('GET', `/browser/view/frame?task=${taskId}&tab=${tab}&device=${device}${after !== undefined ? `&after=${after}&epoch=${ep}` : ''}`)
  if (typeof r.body.epoch === 'string') epoch = r.body.epoch
  return r
}

beforeAll(async () => {
  process.env.WALNUT_TEST_RUN_MARK = '1'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  ext = streamingExtension((await pair()).token)
  for (let i = 0; i < 100 && !(await http('GET', '/browser/status')).body.browsers?.length; i++) await new Promise((r) => setTimeout(r, 50))
  device = (await http('GET', '/browser/status')).body.browsers[0].device
  const created = await http('POST', '/tasks', { title: 'Order the printer paper' })
  taskId = String(created.body.task?.id ?? created.body.id ?? '')
  sid = '9b2e3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
  await createSessionRecord(sid, taskId, '')
  const r = await http('POST', '/browser/act', { action: 'open', url: 'https://shop.example.test/login' }, SESSION())
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  tab = r.body.tab
}, 120_000)

afterAll(async () => {
  await ext?.stop()
  await stopServer()
  delete process.env.WALNUT_TEST_RUN_MARK
})

describe('the live stream', () => {
  it('the first ask starts one stream and gets its first picture as soon as the browser posts it', async () => {
    const t0 = Date.now()
    const f = await frame()
    expect(f.status, JSON.stringify(f.body)).toBe(200)
    expect(f.body).toMatchObject({ stream: true, shown: true, tab, url: 'https://shop.example.test/login' })
    expect(f.body.image).toBe(shot(1))
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(ext.seen.filter((c) => c.action === 'view_watch')).toHaveLength(1)
    // Never the one-picture command for a browser that streams.
    expect(ext.seen.some((c) => c.action === 'view_frame')).toBe(false)
  })

  it('`after` waits for a newer picture and answers the moment one is posted', async () => {
    const first = await frame()
    const waiting = frame(first.body.seq)
    await new Promise((r) => setTimeout(r, 150))
    ext.show(2)
    const t0 = Date.now()
    const f = await waiting
    expect(f.body.image).toBe(shot(2))
    expect(f.body.seq).toBeGreaterThan(first.body.seq)
    expect(Date.now() - t0).toBeLessThan(1500)
  })

  it('the same picture is posted without its bytes, and a viewer gets `unchanged`, never the bytes again', async () => {
    const f = await frame()
    const sameBefore = ext.pushes.same
    await expect.poll(() => ext.pushes.same, { timeout: 4000 }).toBeGreaterThan(sameBefore)
    const later = await frame(f.body.seq)
    expect(later.body).toMatchObject({ unchanged: true, seq: f.body.seq })
    expect(later.body.image).toBeUndefined()
  }, 20_000)

  it('a viewer holding a picture of another stream (a restart, a new holding) gets the picture, never `unchanged`', async () => {
    const f = await frame()
    const other = await frame(f.body.seq + 50, 'some-other-stream')
    expect(other.body.unchanged).toBeUndefined()
    expect(other.body.image).toBeTruthy()
  })

  it('Take over and Hand back are the person\'s alone, reach the browser, and show on the tab list', async () => {
    expect((await http('POST', '/browser/view/takeover', { task: taskId, tab, device }, SESSION())).status).toBe(403)
    const t = await http('POST', '/browser/view/takeover', { task: taskId, tab, device })
    expect(t.status, JSON.stringify(t.body)).toBe(200)
    expect(t.body).toMatchObject({ ok: true, driving: true })
    expect(ext.seen.at(-1)).toMatchObject({ action: 'view_takeover', args: { tab, owner: `task:${taskId}` } })
    expect((await http('GET', `/browser/view?task=${taskId}`)).body.tabs[0]).toMatchObject({ tab, driving: true })
    // The agent waits: its command on that tab is refused while the person has it.
    const act = await http('POST', '/browser/act', { action: 'snapshot', tab }, SESSION())
    expect(act.body.code).toBe('person_driving')
    const b = await http('POST', '/browser/view/handback', { task: taskId, tab, device })
    expect(b.body).toMatchObject({ ok: true, driving: false })
    expect((await http('GET', `/browser/view?task=${taskId}`)).body.tabs[0].driving).toBe(false)
    expect((await http('POST', '/browser/act', { action: 'snapshot', tab }, SESSION())).status).toBe(200)
  })
})

describe('the sign-in hand-off', () => {
  it('request_sign_in shows on the view and waits for the person\'s Done', async () => {
    const ask = await http('POST', '/browser/act', { action: 'request_sign_in', tab, text: 'the shop asks for a code sent to your phone' }, SESSION())
    expect(ask.status, JSON.stringify(ask.body)).toBe(202)
    expect(ask.body).toMatchObject({ status: 'needs_ok', code: 'sign_in_waiting', site: 'example.test' })
    const v = (await http('GET', `/browser/view?task=${taskId}`)).body.tabs[0]
    expect(v.signIn).toMatchObject({ id: ask.body.request, site: 'example.test', note: 'the shop asks for a code sent to your phone' })
    // Asked again: the same ask.
    const again = http('POST', '/browser/act', { action: 'request_sign_in', tab, request: ask.body.request, wait_ms: 10_000 }, SESSION())
    await http('POST', '/browser/view/takeover', { task: taskId, tab, device })
    await new Promise((r) => setTimeout(r, 200))
    await http('POST', '/browser/view/handback', { task: taskId, tab, device })
    const done = await again
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body).toMatchObject({ signIn: 'done', done: true, tab })
    expect((await http('GET', `/browser/view?task=${taskId}`)).body.tabs[0].signIn).toBeUndefined()
  })

  it('Hand back on the tab\'s own pill (the extension) also ends the wait', async () => {
    const ask = await http('POST', '/browser/act', { action: 'request_sign_in', tab }, SESSION())
    const waiting = http('POST', '/browser/act', { action: 'request_sign_in', tab, request: ask.body.request, wait_ms: 10_000 }, SESSION())
    await new Promise((r) => setTimeout(r, 200))
    expect((await http('POST', '/browser/handback', { tab }, ext.auth)).body).toMatchObject({ handedBack: true })
    expect((await waiting).body).toMatchObject({ done: true })
    // Only the extension posts that.
    expect((await http('POST', '/browser/handback', { tab })).status).toBe(403)
  })

  it('a page that refuses this browser\'s sign-in carries hand_off, and the op tells the agent to ask the person', async () => {
    const r = await http('POST', '/browser/act', { action: 'navigate', tab, url: GOOGLE_REFUSED }, SESSION())
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.hand_off).toMatchObject({ why: 'google_refused_browser', next: 'request_sign_in' })
    const { getOp } = await import('../../src/ops/registry.js')
    await import('../../src/ops/browser.js')
    const mapped = getOp('browser')!.mapResult!({ body: r.body, args: { action: 'navigate' } } as never) as { outcome?: string; next?: string }
    expect(mapped.outcome).toMatch(/Do not try again: call request_sign_in/)
    expect(mapped.next).toMatch(/^request_sign_in/)
    // An ordinary page carries none.
    const plain = await http('POST', '/browser/act', { action: 'navigate', tab, url: 'https://shop.example.test/cart' }, SESSION())
    expect(plain.body.hand_off).toBeUndefined()
  })

  it('Stop ends a waiting sign-in as stopped, and the stream with it', async () => {
    const ask = await http('POST', '/browser/act', { action: 'request_sign_in', tab }, SESSION())
    const waiting = http('POST', '/browser/act', { action: 'request_sign_in', tab, request: ask.body.request, wait_ms: 10_000 }, SESSION())
    await new Promise((r) => setTimeout(r, 200))
    expect((await http('POST', '/browser/view/stop', { task: taskId, tab, device })).body).toMatchObject({ stopped: true })
    // The tab is gone for the agent: its waiting call ends (not your tab, or the sign-in ask stopped).
    const end = await waiting
    expect(end.status === 200 ? end.body.signIn : end.body.code).toMatch(/stopped|not_your_tab/)
    expect((await frame()).status).toBe(404)
  })
})

describe('a stream nobody watches', () => {
  it('is told to stop within a few seconds of the last viewer', async () => {
    const r = await http('POST', '/browser/act', { action: 'open', url: 'https://shop.example.test/two' }, SESSION())
    tab = r.body.tab
    expect((await frame()).body.shown).toBe(true)
    await expect.poll(() => ext.streaming(tab), { timeout: 1000 }).toBe(true)
    // Nobody asks any more: the next posts answer more: false, and the browser stops.
    await expect.poll(() => ext.streaming(tab), { timeout: 9000, interval: 200 }).toBe(false)
    expect(ext.answers.at(-1)).toEqual({ more: false })
  }, 20_000)
})
