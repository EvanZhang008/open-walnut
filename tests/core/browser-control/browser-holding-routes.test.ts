/**
 * The real browser routes (src/web/routes/browser-v1.ts, browser-view-v1.ts, approvals-v1.ts) over
 * a real hub and a real vault in a temp dir, with the browser faked at the hub (2026-11-07 review,
 * round 2). A new sign-in's yes:
 *   - lets a normal approve-then-retry fill (the ask's id is not handed on to the vault);
 *   - fills once, also when two fills race for it;
 *   - is for the site it was asked on: a page that moved to another site before the fill gets
 *     nothing, and no other site's login;
 *   - counts from the person's answer: one read long after gives no fresh window.
 * And a Stop or a frame acts only on the holding of the tab it began on: a late Stop never releases
 * the next task's tab, and a tab held again after a Stop never shows the last holding's picture.
 * Fake data only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-browser-holding-routes'))

import express from 'express'
import { browserV1Router, _resetBrowserRoutesForTesting } from '../../../src/web/routes/browser-v1.js'
import { approvalsV1Router } from '../../../src/web/routes/approvals-v1.js'
import * as h from '../../../src/core/browser-control/hub.js'
import * as fresh from '../../../src/core/browser-control/fresh-sign-in.js'
import * as store from '../../../src/core/approvals/store.js'
import { answerMessage } from '../../../src/core/approvals/digest.js'
import { withTestRun } from '../../../src/core/test-run.js'
import { createItems, resetVaultForTest, setupVault } from '../../../src/core/vault/store.js'
import { randomBytes, toB64 } from '../../../src/core/vault/crypto.js'
import { createSession } from '../../../src/core/vault/sessions.js'

const A = { device: 'extension-aaaaaa', label: 'Browser A', browser: 'chrome', version: '9.9', caps: ['screenshot'] }
const AGENT = { 'x-walnut-caller-kind': 'agent' }
const SCOPE = { owner: 'agent', device: A.device, tab: 43, site: 'example.test' }

let server: Server
let base = ''
let dir = ''
let timer: ReturnType<typeof setInterval> | undefined
type Seen = { action: string; args: Record<string, unknown> }
let seen: Seen[] = []
/** Where the agent's tab 43 is when the fill reads it (the all-tabs list shows the sign-in page). */
let fillUrl: string | null = null
/** Runs when a view_stop arrives, before its answer (another task takes the tab meanwhile). */
let onStop: () => void = () => {}
/** What the browser answers a view_stop: it ends the holding, or finds another holding there. */
let stopStopped = true
let frameN = 0

async function request(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json() as Record<string, any> }
}
const login = (extra: Record<string, unknown> = {}) => request('POST', '/browser/act', { action: 'fill_login', device: A.device, tab: 43, ...extra }, AGENT)
const fills = () => seen.filter((c) => c.action === 'fill_login').length

/** The person's phone signs a yes. */
async function approve(id: string) {
  const approval = await store.getApproval(id)
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const key = { id: 'test-key', name: 'Test iPhone', kind: 'iphone' as const, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
  const signature = crypto.sign('sha256', Buffer.from(answerMessage(approval!.digest, 'approve')), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
  await store.answerApproval(id, { decision: 'approve', keyId: key.id, signature, device: { kind: 'iphone', name: 'Test iPhone' } }, async () => key as never)
}

async function freshYes(): Promise<string> {
  const ask = await login({ fresh_sign_in: true })
  expect(ask.status, JSON.stringify(ask.body)).toBe(202)
  expect(ask.body.code).toBe('fresh_sign_in_needs_ok')
  await approve(ask.body.request)
  return ask.body.request as string
}

/** The person's yes, taken up as the route takes it up when the agent comes back with the ask. */
async function freshGrant(): Promise<void> {
  const id = await freshYes()
  expect(await fresh.answerFreshSignIn({ ...SCOPE, id, holdMs: 0 })).toEqual({ ok: true })
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-holding-routes-'))
  resetVaultForTest(dir)
  await setupVault({ passwordKey: toB64(randomBytes(32)), kdf: { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }, agentsWhileAway: false })
  await createItems([
    { type: 'login', title: 'Test Bank', username: 'a@example.test', password: 'fake-bank-Pass', urls: ['https://bank.example.test'] },
    { type: 'login', title: 'Test Shop', username: 'b@other.test', password: 'fake-shop-Pass', urls: ['https://shop.other.test'] },
  ])
  createSession('test-window', 30)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => withTestRun(req.headers['x-walnut-test-run'] as string | undefined, next))
  app.use('/api/v1', browserV1Router, approvalsV1Router)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
}, 60_000)

afterAll(async () => {
  if (timer) clearInterval(timer)
  h._resetBrowserHubForTesting()
  await new Promise<void>((r) => server.close(() => r()))
  resetVaultForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  if (timer) clearInterval(timer)
  h._resetBrowserHubForTesting()
  _resetBrowserRoutesForTesting()
  fresh._resetFreshSignInForTesting()
  seen = []
  fillUrl = null
  onStop = () => {}
  stopStopped = true
  await h.poll(A, 0)
  h.ownTab(A.device, 43, 'agent', { url: 'https://bank.example.test/login' })
  h.ownTab(A.device, 42, 'task:A', { url: 'https://shop.other.test/' })
  timer = setInterval(async () => {
    for (const cmd of await h.poll(A, 0)) {
      seen.push({ action: cmd.action, args: cmd.args })
      if (cmd.action === 'tabs') {
        h.answer(A.device, cmd.id, true, {
          ...(cmd.args.all === true ? { all: true } : {}),
          tabs: [
            { id: 43, owner: 'agent', url: cmd.args.all ? 'https://bank.example.test/login' : fillUrl ?? 'https://bank.example.test/login' },
            ...(cmd.args.all ? [{ id: 99, url: 'https://bank.example.test/account', title: 'Accounts' }, { id: 100, url: 'https://shop.other.test/account', title: 'Shop' }] : []),
          ],
        })
      } else if (cmd.action === 'fill_login') setTimeout(() => h.answer(A.device, cmd.id, true, { filled: true }), 60)
      else if (cmd.action === 'view_frame') h.answer(A.device, cmd.id, true, { shown: true, image: `data:image/jpeg;base64,frame${++frameN}`, url: 'https://shop.other.test/' })
      else if (cmd.action === 'view_stop') { onStop(); h.answer(A.device, cmd.id, true, { tab: cmd.args.tab, stopped: stopStopped }) }
      else h.answer(A.device, cmd.id, true, {})
    }
  }, 10)
})

describe('a new sign-in the person approved', () => {
  it('fills on the retry that brings the ask, and only once', async () => {
    const id = await freshYes()
    const r = await login({ request: id })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.filled).toBe(true)
    expect(fills()).toBe(1)
    // The yes is used.
    expect((await login()).body.code).toBe('site_open_in_person_tab')
    expect((await login({ request: id })).body.code).toBe('site_open_in_person_tab')
    expect(fills()).toBe(1)
  })

  it('two fills racing for one yes: one fills, the other is refused', async () => {
    await freshGrant()
    const both = await Promise.all([login(), login(), login()])
    expect(both.filter((r) => r.body.filled === true)).toHaveLength(1)
    expect(fills()).toBe(1)
  })

  it('two retries bringing the same ask at once: one fills', async () => {
    const id = await freshYes()
    const both = await Promise.all([login({ request: id }), login({ request: id }), login()])
    expect(both.filter((r) => r.body.filled === true)).toHaveLength(1)
    expect(fills()).toBe(1)
  })

  it('is for the site it was asked on: a tab that moved to another site gets nothing filled', async () => {
    await freshGrant()
    fillUrl = 'https://shop.other.test/login'
    const r = await login()
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    expect(r.body.code).toBe('page_changed')
    expect(fills()).toBe(0)
    // Nothing was filled, so the yes still stands for the site it was asked on.
    fillUrl = null
    expect((await login()).body.filled).toBe(true)
  })

  it('counts from the person\'s answer: read long after, it gives no fill', async () => {
    const id = await freshYes()
    const now = Date.now
    Date.now = () => now() + fresh.GRANT_MS + 60_000
    try {
      await h.poll(A, 0)
      createSession('test-window-later', 30)
      // Taken up long after the person's answer: no yes to fill with.
      const late = await fresh.answerFreshSignIn({ ...SCOPE, id, holdMs: 0 })
      expect(late).toMatchObject({ ok: false, status: 409, body: { code: 'fresh_sign_in_expired' } })
      expect(fresh.hasGrant(SCOPE)).toBe(false)
      expect((await login()).body.code).toBe('site_open_in_person_tab')
      expect(fills()).toBe(0)
    } finally {
      Date.now = now
    }
  })
})

describe('a new sign-in approved long ago, through the route', () => {
  it('the agent coming back with the ask hears it expired, and nothing is filled', async () => {
    const id = await freshYes()
    const now = Date.now
    Date.now = () => now() + fresh.GRANT_MS + 60_000
    try {
      await h.poll(A, 0)
      createSession('test-window-later-2', 30)
      const r = await login({ request: id })
      expect(r.status, JSON.stringify(r.body)).toBe(409)
      expect(r.body.code).toBe('fresh_sign_in_expired')
      expect(fills()).toBe(0)
    } finally {
      Date.now = now
    }
  })
})

describe('Stop and frames act on one holding of the tab', () => {
  it('a Stop whose answer comes after another task took the tab leaves that task holding it', async () => {
    onStop = () => h.ownTab(A.device, 42, 'task:B')
    const r = await request('POST', '/browser/view/stop', { task: 'A', tab: 42 })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    // The browser is told whose holding to end.
    expect(seen.find((c) => c.action === 'view_stop')?.args).toMatchObject({ tab: 42, owner: 'task:A' })
    expect(h.tabOwner(A.device, 42)).toBe('task:B')
  })

  it('a browser that stopped nothing (another holding is there now) leaves the hub as it is', async () => {
    stopStopped = false
    const r = await request('POST', '/browser/view/stop', { task: 'A', tab: 42 })
    expect(r.body.stopped).toBe(false)
    expect(h.tabOwner(A.device, 42)).toBe('task:A')
  })

  it('a Stop of the holding still there ends it', async () => {
    const r = await request('POST', '/browser/view/stop', { task: 'A', tab: 42 })
    expect(r.body.stopped).toBe(true)
    expect(h.tabOwner(A.device, 42)).toBeUndefined()
  })

  it('a tab held again by the same task after a Stop shows a new picture, never the last holding\'s', async () => {
    const first = await request('GET', `/browser/view/frame?task=A&tab=42&device=${A.device}`)
    expect(first.body.image).toBe(`data:image/jpeg;base64,frame${frameN}`)
    h.releaseTab(A.device, 42, 'stopped')
    h.ownTab(A.device, 42, 'task:A', { url: 'https://shop.other.test/' })
    const second = await request('GET', `/browser/view/frame?task=A&tab=42&device=${A.device}`)
    expect(second.body.image).not.toBe(first.body.image)
    expect(seen.filter((c) => c.action === 'view_frame')).toHaveLength(2)
  })
})

describe('the hub numbers each holding', () => {
  it('a new owner, a release and a report naming another grant each make a new holding', async () => {
    const g1 = h.tabGen(A.device, 42)
    h.ownTab(A.device, 42, 'task:A')
    expect(h.tabGen(A.device, 42)).toBe(g1)
    h.ownTab(A.device, 42, 'task:B')
    const g2 = h.tabGen(A.device, 42)
    expect(g2).not.toBe(g1)
    await h.poll({ ...A, tabs: [{ id: 42, owner: 'task:B', grant: 'g-one' }, { id: 43, owner: 'agent' }] }, 0)
    const g3 = h.tabGen(A.device, 42)
    await h.poll({ ...A, tabs: [{ id: 42, owner: 'task:B', grant: 'g-one' }, { id: 43, owner: 'agent' }] }, 0)
    expect(h.tabGen(A.device, 42)).toBe(g3)
    await h.poll({ ...A, tabs: [{ id: 42, owner: 'task:B', grant: 'g-two' }, { id: 43, owner: 'agent' }] }, 0)
    expect(h.tabGen(A.device, 42)).not.toBe(g3)
    expect(h.releaseTabIf(A.device, 42, 'task:B', g3, 'stopped')).toBe(false)
    expect(h.releaseTabIf(A.device, 42, 'task:B', h.tabGen(A.device, 42), 'stopped')).toBe(true)
  })
})
