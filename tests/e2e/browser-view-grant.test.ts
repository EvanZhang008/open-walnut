/**
 * "Show it live" on a covered Browser view, on a real server (src/web/routes/browser-view-v1.ts
 * POST /browser/view/grant, browser-view-stream.ts) with a fake extension that streams covered
 * frames like the real one (packages/browser-extension/src/agent-view.ts, agent-live.ts) and
 * answers view_grant (grant-open.ts). 2026-11-09: Chrome draws nothing in a covered agent window;
 * live pictures take them through its debugger once the person allows it on the extension's page.
 *
 *   - the tab list says whether the browser can offer it (`liveGrant`, the `live-pictures` cap);
 *   - a covered frame's `live` reaches the viewer;
 *   - the person's request reaches the browser as view_grant with person: true; an agent's request
 *     is let through too (every person's action is an agent's), as person: false, which opens the
 *     page in the background only;
 *   - an older extension (no cap) is told to update; a test run is refused.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-browser-view-grant-e2e'))

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

interface Cmd { id: string; action: string; args: Record<string, any> }

/** A browser whose agent window is covered: every frame it posts says so, with its live state. */
function coveredExtension(token: string) {
  const auth = { authorization: `Bearer ${token}` }
  const seen: Cmd[] = []
  const tabs = new Map<number, { url: string; owner: string; title: string }>()
  const state = { caps: ['screenshot', 'view-stream', 'takeover', 'live-pictures'], live: 'no_permission' }
  let next = 500
  let on = true
  const streams = new Set<number>()
  const stream = async (tab: number) => {
    if (streams.has(tab)) return
    streams.add(tab)
    try {
      for (;;) {
        const t = tabs.get(tab)
        if (!t) return
        const r = await http('POST', '/browser/view/push', { tab, url: t.url, title: t.title, window: 'agent', windowState: 'normal', shown: false, why: 'covered', live: state.live }, auth)
        if (r.body.more !== true) return
        await new Promise((res) => setTimeout(res, 80))
      }
    } finally { streams.delete(tab) }
  }
  const answer = (c: Cmd): { ok: boolean; result?: unknown; error?: unknown } => {
    switch (c.action) {
      case 'open': {
        const id = next++
        tabs.set(id, { url: c.args.url, owner: c.args.owner, title: 'Shop' })
        return { ok: true, result: { tab: id, url: c.args.url, title: 'Shop', window: 'agent', windowState: 'normal' } }
      }
      case 'view_watch': void stream(c.args.tab); return { ok: true, result: { tab: c.args.tab, watching: true } }
      case 'view_grant': return { ok: true, result: { opened: true, shown: c.args.person === true } }
      default: return { ok: true, result: { tab: c.args.tab } }
    }
  }
  const loop = (async () => {
    while (on) {
      const report = [...tabs].map(([id, x]) => ({ id, owner: x.owner, url: x.url, title: x.title, window: 'agent' }))
      const r = await http('POST', '/browser/poll', { browser: 'chrome', version: '9.9', caps: state.caps, tabs: report, waitMs: 300 }, auth)
      if (r.status !== 200) { await new Promise((res) => setTimeout(res, 50)); continue }
      for (const c of r.body.commands as Cmd[]) {
        seen.push(c)
        void http('POST', '/browser/result', { id: c.id, ...answer(c) }, auth)
      }
    }
  })()
  return { seen, state, stop: async () => { on = false; await loop } }
}

async function pair(): Promise<{ token: string }> {
  const code = (await (await fetch(`${base}/api/devices/browser-code`, { method: 'POST' })).json() as { code: string }).code
  return (await http('POST', '/browser-pair', { code, client: 'extension' })).body as { token: string }
}

let ext: ReturnType<typeof coveredExtension>
let taskId = ''
let tab = 0
let device = ''
const sid = '4c1d2e3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const SESSION = () => ({ 'x-walnut-caller-sid': sid })
/** Waits for the next poll to carry the caps just set. */
const settle = () => new Promise((r) => setTimeout(r, 700))

beforeAll(async () => {
  process.env.WALNUT_TEST_RUN_MARK = '1'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  ext = coveredExtension((await pair()).token)
  for (let i = 0; i < 100 && !(await http('GET', '/browser/status')).body.browsers?.length; i++) await new Promise((r) => setTimeout(r, 50))
  device = (await http('GET', '/browser/status')).body.browsers[0].device
  const created = await http('POST', '/tasks', { title: 'Watch the covered window' })
  taskId = String(created.body.task?.id ?? created.body.id ?? '')
  await createSessionRecord(sid, taskId, '')
  const r = await http('POST', '/browser/act', { action: 'open', url: 'https://shop.example.test/' }, SESSION())
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  tab = r.body.tab
}, 120_000)

afterAll(async () => {
  await ext?.stop()
  await stopServer()
  delete process.env.WALNUT_TEST_RUN_MARK
})

describe('Show it live', () => {
  it('the tab list says the browser can offer it, and a covered frame says why there is no live picture', async () => {
    expect((await http('GET', `/browser/view?task=${taskId}`)).body.tabs[0]).toMatchObject({ tab, liveGrant: true })
    const f = await http('GET', `/browser/view/frame?task=${taskId}&tab=${tab}&device=${device}`)
    expect(f.status, JSON.stringify(f.body)).toBe(200)
    expect(f.body).toMatchObject({ stream: true, why: 'covered', live: 'no_permission' })
    expect(f.body.shown).not.toBe(true)
    expect(f.body.image).toBeUndefined()
  })

  it('the person\'s click reaches the browser as view_grant for them', async () => {
    const r = await http('POST', '/browser/view/grant', { task: taskId, tab, device })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ ok: true, opened: true, shown: true, tab, device })
    expect(ext.seen.filter((c) => c.action === 'view_grant').at(-1)).toMatchObject({ args: { tab, person: true } })
  })

  it('an agent may ask too: the page opens in the background (person: false), the grant still the person\'s clicks', async () => {
    const r = await http('POST', '/browser/view/grant', { task: taskId, tab, device }, SESSION())
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ ok: true, opened: true, shown: false })
    expect(ext.seen.filter((c) => c.action === 'view_grant').at(-1)).toMatchObject({ args: { tab, person: false } })
  })

  it('asks for a task and a tab; another task\'s tab is not this one\'s', async () => {
    expect((await http('POST', '/browser/view/grant', { task: taskId })).status).toBe(400)
    expect((await http('POST', '/browser/view/grant', { task: 'no-such-task', tab, device })).body.code).toBe('not_your_tab')
  })

  it('a test run is refused', async () => {
    const r = await http('POST', '/browser/view/grant', { task: taskId, tab, device }, { 'x-walnut-test-run': 'grant-e2e' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('test_run')
  })

  it('an older extension (no live-pictures cap) is told to update, and its tab offers nothing', async () => {
    const before = ext.seen.filter((c) => c.action === 'view_grant').length
    ext.state.caps = ['screenshot', 'view-stream', 'takeover']
    await settle()
    expect((await http('GET', `/browser/view?task=${taskId}`)).body.tabs[0].liveGrant).toBe(false)
    const r = await http('POST', '/browser/view/grant', { task: taskId, tab, device })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('old_extension')
    expect(ext.seen.filter((c) => c.action === 'view_grant')).toHaveLength(before)
  })
})
