/**
 * E2E: signing Antigravity in on this machine, and installing it, through the real server's
 * routes (src/web/routes/engine-sign-in.ts → core/agents/engine-sign-in.ts → the daemon's
 * `engine.signIn` → providers/acp-engine-sign-in.ts → the CLI's process). The host side runs
 * in-process behind this machine's daemon link, as the daemon builds it, on a temp HOME; the
 * CLI is a fake `agy` that prints the real one's words (tests/fixtures/antigravity/fake-agy.mjs).
 * No real account, key or network.
 *
 *   status: installed, not signed in; the hosts list puts this machine first
 *   sign-in: the link, a bad code (400, the code in no answer and no log), a good one
 *   sign-out; the API key in Settings (masked in GET /api/config); install where it is missing
 *   a daemon that predates it; unknown host and engine
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-engine-sign-in-e2e'))

import { WALNUT_HOME, LOG_DIR } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import * as hostLink from '../../src/core/hosts/link.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { flushLogBufferNow } from '../../src/logging/logger.js'
import { fakeHostSignIn, makeFakeAgyHome, type FakeAgyHome } from '../helpers/fake-agy.js'

let server: HttpServer
let port: number
let installed: FakeAgyHome
let missing: FakeAgyHome
let host: ReturnType<typeof fakeHostSignIn>
let capable = true
const sent: Array<Record<string, unknown>> = []

const linked: string[] = []

async function api(method: string, p: string, body?: unknown, sid?: string): Promise<{ status: number; body: any; text: string }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null, text }
}

function logText(): string {
  flushLogBufferNow()
  try { return fs.readdirSync(LOG_DIR).map((f) => fs.readFileSync(path.join(LOG_DIR, f), 'utf8')).join('\n') } catch { return '' }
}

beforeAll(async () => {
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
  installed = makeFakeAgyHome()
  missing = makeFakeAgyHome({ installed: false })
  host = fakeHostSignIn(installed)
  // This machine's daemon link, in-process: the real host side on the temp HOME.
  const local = {
    connected: true, hostKey: '__local__',
    hasCapability: (c: string) => capable && c === 'engine-sign-in-v1',
    send: async (cmd: string, params: Record<string, unknown> = {}) => {
      if (cmd !== 'engine.signIn') return { ok: false, error: `${cmd} is not part of this test` }
      sent.push(params)
      return { ok: true, result: await host.handle(params) }
    },
  }
  const real = hostLink.link
  vi.spyOn(hostLink, 'link').mockImplementation(async (h) => {
    linked.push(h)
    if (h === '__local__') return local as never
    // Another host never answers here: no SSH, no deploy.
    if (h === 'devbox') throw new Error('no route to devbox in this test')
    return real(h)
  })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  await updateConfig({ hosts: { devbox: { hostname: 'devbox.example' } } } as never)
}, 120_000)

afterAll(async () => {
  await stopServer()
  vi.restoreAllMocks()
  installed?.cleanup()
  missing?.cleanup()
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
})

describe('Antigravity sign-in on this machine', () => {
  it('reads installed and not signed in; the hosts list starts with this machine', async () => {
    const r = await api('GET', '/api/engines/antigravity/sign-in')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      engine: 'antigravity', host: '__local__', state: 'not_signed_in', installed: true, version: '1.5.14',
      method: null, google: false, apiKey: { set: false, source: null }, signIn: null,
      install: { canInstall: false, command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
    })
    expect(r.body.hostName).toMatch(/^this (Mac|computer)$/)
    // The daemon got the engine's own env: file storage on, a default SSH_CONNECTION.
    expect(sent.at(-1)?.env).toMatchObject({ AGY_ACP_FORCE_FILE_STORAGE: '1' })
    linked.length = 0
    const all = await api('GET', '/api/engines/antigravity/sign-in/hosts')
    expect(all.status).toBe(200)
    expect(all.body.hosts[0]).toMatchObject({ host: '__local__', state: 'not_signed_in' })
    // Opening Settings dials no other host: one with no open link reads not connected.
    expect(all.body.hosts.find((h: { host: string }) => h.host === 'devbox')).toMatchObject({ state: 'unknown', connected: false })
    expect(linked).not.toContain('devbox')
    // Its own row, asked, dials it (and here it does not answer).
    const one = await api('GET', '/api/engines/antigravity/sign-in?host=devbox')
    expect(one.status).toBe(200)
    expect(one.body).toMatchObject({ host: 'devbox', state: 'unknown' })
    expect(one.body.connected).toBeUndefined()
    expect(one.body.reason).toContain('could not reach devbox')
    expect(linked).toContain('devbox')
  })

  it('an agent may start a sign-in, but the API key and the sign-out are the user\'s own', async () => {
    const sid = 'engine-sign-in-e2e-session'
    const start = await api('POST', '/api/engines/antigravity/sign-in', {}, sid)
    expect(start.status).toBe(200)
    expect((await api('POST', '/api/engines/antigravity/sign-in/cancel', { id: start.body.id }, sid)).body).toEqual({ cancelled: true })
    for (const [method, p, body] of [['PUT', '/api/engines/antigravity/api-key', { key: 'AIzaFakeKeyForTests1111111111111111111' }], ['DELETE', '/api/engines/antigravity/api-key', undefined], ['POST', '/api/engines/antigravity/sign-out', {}]] as const) {
      const r = await api(method, p, body, sid)
      expect(r.status, `${method} ${p}`).toBe(403)
      expect(r.body.code).toBe('human_only')
    }
    expect(fs.readFileSync(path.join(WALNUT_HOME, 'config.yaml'), 'utf8')).not.toContain('AIzaFakeKeyForTests1111')
  })

  it('hands out the Google link, refuses a bad code without saying it, then takes a good one', async () => {
    const start = await api('POST', '/api/engines/antigravity/sign-in', {})
    expect(start.status).toBe(200)
    expect(start.body).toMatchObject({ host: '__local__', phase: 'waiting_code' })
    expect(start.body.link).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?.*redirect_uri=https%3A%2F%2Fantigravity\.google%2Foauth-callback/)
    // The status shows the sign-in that waits, for a page opened again.
    expect((await api('GET', '/api/engines/antigravity/sign-in')).body.signIn).toMatchObject({ id: start.body.id, link: start.body.link })
    const code = 'secret-looking-code-4f9a'
    const bad = await api('POST', '/api/engines/antigravity/sign-in/finish', { host: '__local__', id: start.body.id, code })
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe('bad_code')
    expect(bad.body.error).toContain("couldn't log in")
    expect(bad.text).not.toContain(code)
    expect(logText()).not.toContain(code)
    // That sign-in is over; a new one takes the good code.
    expect((await api('POST', '/api/engines/antigravity/sign-in/finish', { id: start.body.id, code: 'good' })).body.code).toBe('no_sign_in')
    const again = await api('POST', '/api/engines/antigravity/sign-in', { host: '__local__' })
    expect(again.body.id).not.toBe(start.body.id)
    const ok = await api('POST', '/api/engines/antigravity/sign-in/finish', { id: again.body.id, code: 'good' })
    expect(ok.status).toBe(200)
    expect(ok.body.status).toMatchObject({ state: 'signed_in', method: 'google', google: true, signIn: null })
    expect(fs.existsSync(installed.signedInFile)).toBe(true)
  })

  it('a code that is not one line is refused before it reaches the CLI', async () => {
    const start = await api('POST', '/api/engines/antigravity/sign-in', {})
    const r = await api('POST', '/api/engines/antigravity/sign-in/finish', { id: start.body.id, code: 'good\nexit' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('invalid_code')
    const cancel = await api('POST', '/api/engines/antigravity/sign-in/cancel', { id: start.body.id })
    expect(cancel.body).toEqual({ cancelled: true })
    expect((await api('GET', '/api/engines/antigravity/sign-in')).body.signIn).toBeNull()
  })

  it('signs out through the CLI\'s own logout', async () => {
    const r = await api('POST', '/api/engines/antigravity/sign-out', { host: '__local__' })
    expect(r.status).toBe(200)
    expect(r.body.status).toMatchObject({ state: 'not_signed_in', google: false })
    expect(fs.existsSync(installed.signedInFile)).toBe(false)
  })

  it('an API key in Settings signs every host in with it, masked in the config view, and comes off again', async () => {
    const key = 'AIzaFakeKeyForTests0000000000000000000'
    expect((await api('PUT', '/api/engines/antigravity/api-key', { key: 'two words' })).status).toBe(400)
    const put = await api('PUT', '/api/engines/antigravity/api-key', { key, host: '__local__' })
    expect(put.status).toBe(200)
    expect(put.body.apiKey).toEqual({ set: true })
    expect(put.body.status).toMatchObject({ state: 'signed_in', method: 'api-key', apiKey: { set: true, source: 'settings' }, google: false })
    expect(put.text).not.toContain(key)
    expect(fs.readFileSync(path.join(WALNUT_HOME, 'config.yaml'), 'utf8')).toContain(key)
    expect((await api('GET', '/api/config')).text).not.toContain(key)
    // Sessions get it: the env the daemon is handed carries it.
    expect(sent.at(-1)?.env).toMatchObject({ GEMINI_API_KEY: key })
    const del = await api('DELETE', '/api/engines/antigravity/api-key?host=__local__')
    expect(del.body.apiKey).toEqual({ set: false })
    expect(del.body.status).toMatchObject({ state: 'not_signed_in', method: null })
    expect(fs.readFileSync(path.join(WALNUT_HOME, 'config.yaml'), 'utf8')).not.toContain(key)
  })

  it('install is refused where the CLI is there, and runs the installer where it is missing', async () => {
    const there = await api('POST', '/api/engines/antigravity/install', { host: '__local__' })
    expect(there.status).toBe(409)
    expect(there.body.code).toBe('installed')
    host = fakeHostSignIn(missing)
    const before = await api('GET', '/api/engines/antigravity/sign-in')
    expect(before.body).toMatchObject({ state: 'not_installed', installed: false, install: { canInstall: true, state: 'idle' } })
    expect(before.body.reason).toContain('agy is not installed')
    const started = await api('POST', '/api/engines/antigravity/install', { host: '__local__' })
    expect(started.status).toBe(202)
    expect(started.body.state).toBe('running')
    await vi.waitFor(async () => {
      expect((await api('GET', '/api/engines/antigravity/install?host=__local__')).body.state).toBe('done')
    }, { timeout: 15_000, interval: 100 })
    const after = await api('GET', '/api/engines/antigravity/sign-in')
    expect(after.body).toMatchObject({ state: 'not_signed_in', installed: true, install: { state: 'done', canInstall: false } })
    host = fakeHostSignIn(installed)
  })

  it('a daemon older than this answers that it must update, and bad names are refused', async () => {
    capable = false
    try {
      const status = await api('GET', '/api/engines/antigravity/sign-in')
      expect(status.status).toBe(200)
      expect(status.body).toMatchObject({ state: 'unknown', needsDaemonUpdate: true })
      const start = await api('POST', '/api/engines/antigravity/sign-in', {})
      expect(start.status).toBe(501)
      expect(start.body.code).toBe('daemon_needs_upgrade')
    } finally { capable = true }
    expect((await api('GET', '/api/engines/antigravity/sign-in?host=nowhere')).status).toBe(400)
    expect((await api('POST', '/api/engines/claude/sign-in', {})).status).toBe(404)
    expect((await api('GET', '/api/engines/no-such/sign-in/hosts')).status).toBe(404)
  })
})
