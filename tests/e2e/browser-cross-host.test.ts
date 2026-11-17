/**
 * The person's browser from a session on another machine, on a real server with a fake extension
 * that polls like the real one (2026-11-16: a session on the cloud dev box opened a tab in the
 * Mac's Chrome, and it showed in no task's Browser view; its 652 MB screen recording could not go
 * into the page's file field):
 *
 *   - a session on another host acts for its task: the tab it opens is listed in the task's Browser
 *     view, also when the call comes in over another alias of the same daemon (one box reached as
 *     clouddev and as newdev), and never when it comes from another daemon;
 *   - a trusted upload of a file on the browser's machine that the task did not download waits for the
 *     person's yes (an approval naming the task, the files and the site); only then do those paths go
 *     to the extension (`granted_paths`), which the agent cannot set itself; a no refuses; a yes holds
 *     for that task and file only; a folder path and a browser without file access are refused first.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-browser-cross-host-e2e'))

/** Host aliases that reach one daemon process, as its hellos would say. */
const ONE_DAEMON = [new Set(['devbox', 'devbox-ssh'])]
vi.mock('../../src/providers/daemon-connection.js', async (orig) => ({
  ...(await orig<typeof import('../../src/providers/daemon-connection.js')>()),
  oneDaemon: async (a: string, b: string) => a === b || ONE_DAEMON.some((s) => s.has(a) && s.has(b)),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { executeOp } from '../../src/ops/index.js'
import { hostOrigin } from '../../src/lib/caller-origin.js'

let base = ''

async function http(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}

interface Seen { action: string; args: Record<string, any> }

function fakeExtension(token: string, caps: string[]) {
  const seen: Seen[] = []
  const tabs = new Map<number, { url: string; owner: string }>()
  let next = 500
  let on = true
  const auth = { authorization: `Bearer ${token}` }
  const answer = (c: Seen): { ok: boolean; result?: unknown } => {
    if (c.action === 'open') {
      const id = next++
      tabs.set(id, { url: c.args.url, owner: c.args.owner })
      return { ok: true, result: { tab: id, url: c.args.url, title: 'Upload test', window: 'agent', windowState: 'normal' } }
    }
    if (c.action === 'tabs') return { ok: true, result: { all: !!c.args.all, tabs: [...tabs].map(([id, t]) => ({ id, url: t.url, owner: t.owner })) } }
    if (c.action === 'downloads') return { ok: true, result: { downloads: [{ filename: '/Users/evan/Downloads/report.pdf', state: 'complete' }] } }
    if (c.action === 'upload') return { ok: true, result: { tab: c.args.tab, uploaded: c.args.paths, into: 'the file field', trusted: true } }
    return { ok: true, result: { tab: c.args.tab } }
  }
  const loop = (async () => {
    while (on) {
      const report = [...tabs].map(([id, t]) => ({ id, owner: t.owner, url: t.url, title: 'Upload test', window: 'agent' }))
      const r = await http('POST', '/browser/poll', { browser: 'chrome', version: '9.9', caps, tabs: report, waitMs: 300 }, auth)
      if (r.status !== 200) { await new Promise((res) => setTimeout(res, 50)); continue }
      for (const c of r.body.commands as Array<Seen & { id: string }>) {
        seen.push(c)
        await http('POST', '/browser/result', { id: c.id, ...answer(c) }, auth)
      }
    }
  })()
  return { seen, stop: async () => { on = false; await loop } }
}

async function pair(): Promise<string> {
  const code = (await (await fetch(`${base}/api/devices/browser-code`, { method: 'POST' })).json() as { code: string }).code
  return ((await http('POST', '/browser-pair', { code, client: 'extension' })).body as { token: string }).token
}

let ext: ReturnType<typeof fakeExtension>
let taskId = ''
const sid = crypto.randomUUID()

/** The browser op as a host's daemon relays it: the server runs it itself, from that host's origin. */
function relayed(host: string, args: Record<string, unknown>) {
  return executeOp('browser', args, { origin: hostOrigin(host), callerSid: sid, callerHost: host, apiBase: base })
}

beforeAll(async () => {
  process.env.WALNUT_TEST_RUN_MARK = '1'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  ext = fakeExtension(await pair(), ['screenshot', 'trusted-input', 'input-v2', 'upload-granted', 'file-access'])
  for (let i = 0; i < 100 && !(await http('GET', '/browser/status')).body.browsers?.length; i++) await new Promise((r) => setTimeout(r, 50))
  const created = await http('POST', '/tasks', { title: 'Upload the demo video' })
  taskId = String(created.body.task?.id ?? created.body.id ?? '')
  await createSessionRecord(sid, taskId, '', WALNUT_HOME, { host: 'devbox', initialProcessStatus: 'idle' })
}, 120_000)

afterAll(async () => {
  await ext?.stop()
  await stopServer()
  delete process.env.WALNUT_TEST_RUN_MARK
})

const viewTabs = async () => ((await http('GET', `/browser/view?task=${taskId}`)).body.tabs as Array<{ tab: number }>).map((t) => t.tab)

describe('a session on another machine in the person\'s browser', () => {
  it('the tab it opens is its task\'s, listed in the task\'s Browser view', async () => {
    const r = await relayed('devbox', { action: 'open', url: 'https://upload.example.test/' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const tab = (r as { result: { tab: number } }).result.tab
    expect(ext.seen.find((c) => c.action === 'open')?.args.owner).toBe(`task:${taskId}`)
    expect(await viewTabs()).toContain(tab)
  }, 60_000)

  it('also when the call comes in over another alias of the same daemon', async () => {
    const r = await relayed('devbox-ssh', { action: 'open', url: 'https://upload.example.test/second' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const tab = (r as { result: { tab: number } }).result.tab
    expect(await viewTabs()).toContain(tab)
  }, 60_000)

  it('never from another daemon that names the session: that tab is not the task\'s', async () => {
    const r = await relayed('otherbox', { action: 'open', url: 'https://upload.example.test/third' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const tab = (r as { result: { tab: number } }).result.tab
    expect(ext.seen.at(-1)?.args.owner).not.toBe(`task:${taskId}`)
    expect(await viewTabs()).not.toContain(tab)
  }, 60_000)
})

describe('a trusted upload of a file on the browser\'s machine', () => {
  const REC = '/Users/evan/Desktop/Screen Recording 2026-11-13 at 12.32.01\u202fPM.mov'
  const KEY = '/Users/evan/.ssh/id_ed25519'
  const uploads = () => ext.seen.filter((c) => c.action === 'upload')
  // The person's answer, as the store takes it once the route checked their proof (guard person).
  const answer = async (id: string, decision: 'approve' | 'deny') => {
    const { answerApproval } = await import('../../src/core/approvals/store.js')
    await answerApproval(id, { decision, device: { name: 'Test iPhone', kind: 'iphone' } } as never, async () => undefined)
    return { status: 200 }
  }

  it('a file the task did not download waits for the person\'s yes, naming the task, the file and the site; nothing is sent before it', async () => {
    const tab = (await viewTabs())[0]
    const r = await relayed('devbox', { action: 'upload', tab, selector: '#file', trusted: true, paths: [REC] })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const body = (r as { result: Record<string, any> }).result
    expect(body).toMatchObject({ status: 'needs_ok', code: 'upload_needs_ok' })
    expect(uploads()).toHaveLength(0)
    const ask = (await http('GET', `/approvals/${body.request}`)).body.approval
    expect(ask).toMatchObject({ status: 'pending', mode: 'tap', guard: 'person' })
    // The approvals store folds every space to a plain one in its title; the detail keeps the path as it is.
    expect(ask.what).toBe('Upload ~/Desktop/Screen Recording 2026-11-13 at 12.32.01 PM.mov from this computer into example.test')
    expect(ask.detail).toContain('Task "Upload the demo video" asks')
    expect(ask.detail).toContain(REC)
    // Asking again names the same ask, never a second one.
    const again = await relayed('devbox', { action: 'upload', tab, selector: '#file', trusted: true, paths: [REC] })
    expect((again as { result: Record<string, any> }).result.request).toBe(body.request)
    // The person says yes: the next call goes, with the path granted by the server.
    expect((await answer(body.request, 'approve')).status).toBe(200)
    const go = await relayed('devbox', { action: 'upload', tab, selector: '#file', trusted: true, paths: [REC], request: body.request, wait_ms: 2000 })
    expect(go.ok, JSON.stringify(go)).toBe(true)
    expect(uploads().at(-1)?.args).toMatchObject({ paths: [REC], granted_paths: [REC], trusted: true })
    // The yes holds for that task and file: no new ask.
    const twice = await relayed('devbox', { action: 'upload', tab, selector: '#file', trusted: true, paths: [REC] })
    expect((twice as { result: Record<string, any> }).result.status).toBeUndefined()
    expect(uploads()).toHaveLength(2)
  }, 60_000)

  it('the agent cannot grant a path itself, and a no refuses', async () => {
    const tab = (await viewTabs())[0]
    const forged = await relayed('devbox', { action: 'upload', tab, selector: '#file', trusted: true, paths: [KEY], granted_paths: [KEY] })
    expect(forged.ok).toBe(false)
    expect(JSON.stringify(forged)).toMatch(/granted_paths/)
    const r = await relayed('devbox', { action: 'upload', tab, selector: '#file', trusted: true, paths: [KEY] })
    const id = (r as { result: Record<string, any> }).result.request
    expect(id).toMatch(/^apr-/)
    await answer(id, 'deny')
    const no = await relayed('devbox', { action: 'upload', tab, selector: '#file', trusted: true, paths: [KEY], request: id, wait_ms: 2000 })
    expect(JSON.stringify(no)).toMatch(/said no/)
    // Asked again at once: refused, never put to the person again.
    const again = await relayed('devbox', { action: 'upload', tab, selector: '#file', trusted: true, paths: [KEY] })
    expect(JSON.stringify(again)).toMatch(/said no to uploading these files here within the hour/)
    expect(uploads().some((c) => (c.args.paths as string[]).includes(KEY))).toBe(false)
  }, 60_000)

  it('a file the task downloaded needs no yes; a folder or a relative path is refused', async () => {
    const tab = (await viewTabs())[0]
    const r = await relayed('devbox', { action: 'upload', tab, selector: '#file', trusted: true, paths: ['/Users/evan/Downloads/report.pdf'] })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect((r as { result: Record<string, any> }).result.status).toBeUndefined()
    expect(uploads().at(-1)?.args.granted_paths).toBeUndefined()
    for (const bad of ['/Users/evan/Desktop/', 'Desktop/a.mov', '/Users/evan/../x']) {
      const b = await relayed('devbox', { action: 'upload', tab, selector: '#file', trusted: true, paths: [bad] })
      expect(JSON.stringify(b)).toMatch(/never a folder, a relative path, or one with hidden characters/)
    }
  }, 60_000)

  it('a plain tap from this machine is not the person\'s proof', async () => {
    const tab = (await viewTabs())[0]
    const r = await relayed('devbox', { action: 'upload', tab, selector: '#file', trusted: true, paths: ['/Users/evan/Desktop/other.mov'] })
    const id = (r as { result: Record<string, any> }).result.request
    const tap = await http('POST', `/approvals/${id}/answer`, { decision: 'approve' })
    expect(tap.status).not.toBe(200)
    expect((await http('GET', `/approvals/${id}`)).body.approval.status).toBe('pending')
  }, 60_000)

  it('another task\'s yes is not this one\'s: a session that is no task\'s is refused', async () => {
    const tab = (await viewTabs())[0]
    // A call from another daemon naming this session is not the session (owner 'agent'): it holds no tab of the task.
    const r = await relayed('otherbox', { action: 'upload', tab, selector: '#file', trusted: true, paths: [REC] })
    expect(r.ok).toBe(false)
  }, 60_000)
})

describe('with approvals off (the default), an upload goes ahead and only a payment asks', () => {
  it('a file on the browser\'s machine goes into the page unasked, and is recorded', async () => {
    const { updateConfig } = await import('../../src/core/config-manager.js')
    const { setAskMe } = await import('../../src/core/approvals/ask-me.js')
    await setAskMe(false, { person: true })
    try {
      const tab = (await viewTabs())[0]
      const GIF = '/Users/evan/promo/make-diagram-demo.gif'
      const r = await relayed('devbox', { action: 'upload', tab, selector: '#file', trusted: true, paths: [GIF] })
      expect(r.ok, JSON.stringify(r)).toBe(true)
      expect((r as { result: Record<string, any> }).result.status).toBeUndefined()
      expect(ext.seen.filter((c) => c.action === 'upload').at(-1)?.args).toMatchObject({ paths: [GIF], granted_paths: [GIF] })
      const { listApprovals } = await import('../../src/core/approvals/store.js')
      const rec = (await listApprovals({ status: 'all' }) as Array<{ unasked?: string; what: string; status: string }>).filter((a) => a.unasked === 'browserUpload')
      expect(rec.map((a) => a.status)).toEqual(['approved'])
      expect(rec[0].what).toContain('make-diagram-demo.gif')
      // Once a day per file: the same upload again records nothing new.
      await relayed('devbox', { action: 'upload', tab, selector: '#file', trusted: true, paths: [GIF] })
      expect((await listApprovals({ status: 'all' }) as Array<{ unasked?: string }>).filter((a) => a.unasked === 'browserUpload')).toHaveLength(1)
      // A payment still asks while the person turned that experiment on, and only then.
      const { asksPerson } = await import('../../src/core/approvals/ask-me.js')
      expect(await asksPerson()).toBe(false)
      expect(await asksPerson('payment')).toBe(false)
      await updateConfig({ experimental: { payments_always_ask: true } })
      expect(await asksPerson('payment')).toBe(true)
      expect(await asksPerson()).toBe(false)
    } finally {
      await setAskMe(true, { person: true })
      await updateConfig({ experimental: { payments_always_ask: false } })
    }
  }, 60_000)
})

