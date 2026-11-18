/**
 * The Mac app is a first signing device by itself (2026-11-11, the user: approving an agent's
 * browser step "is just a button click", it must not need the Passwords master password, and
 * there must be nothing to set up). A first key counts only from the signed Mac app's own process
 * (src/core/approvals/mac-app-proof.ts) running in the account's own home folder: a script on this
 * computer, here curl, is refused, so an agent cannot make itself the first signer and approve its
 * own step, and so is a copy of the app a test started with another home (2026-11-18). Nothing that
 * is refused asks the person. With the app's key, an agent's outward step (`guard: 'person'`) takes
 * one Touch ID signature and no unlock.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-approvals-mac-first-key'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { answerMessage, keyIdOf } from '../../src/core/approvals/digest.js'
import { _setMacAppProofForTesting } from '../../src/core/approvals/mac-app-proof.js'

let base = ''
const execFileP = promisify(execFile)

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}

/** A script's request: curl, a process of this account that is not the Mac app. */
async function curl(path: string, body: unknown) {
  const { stdout } = await execFileP('curl', ['-s', '--noproxy', '*', '-X', 'POST', '-H', 'content-type: application/json',
    '-d', JSON.stringify(body), '-w', '\n%{http_code}', `${base}${path}`])
  const cut = stdout.lastIndexOf('\n')
  return { status: Number(stdout.slice(cut + 1)), body: JSON.parse(stdout.slice(0, cut) || '{}') as Record<string, any> }
}

function softKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  return { spki, id: keyIdOf(spki), sign: (digest: string, d: 'approve' | 'deny') =>
    crypto.sign('sha256', Buffer.from(answerMessage(digest, d)), { key: privateKey, dsaEncoding: 'der' }).toString('base64') }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterEach(() => _setMacAppProofForTesting(null))

afterAll(async () => {
  await stopServer()
})

describe('the Mac app as the first signing device', () => {
  it('a script cannot add the first key, whatever kind it names; the signed app\'s own process can', async () => {
    const agent = softKey()
    // The real process check runs: the request's process is curl, not the signed Mac app.
    const script = await curl('/api/v1/approvals/keys', { publicKey: agent.spki, name: 'Mac', kind: 'mac-app' })
    expect(script.status).toBe(403)
    expect(script.body.code).toBe('first_key_from_phone')
    const fetched = await http('POST', '/api/v1/approvals/keys', { publicKey: agent.spki, name: 'Mac', kind: 'mac-app' })
    expect(fetched.status).toBe(403)
    expect((await http('GET', '/api/v1/approvals/keys')).body.keys).toEqual([])

    // The app's own process (the check stands in for lsof + codesign, which no test process passes).
    const seen: unknown[] = []
    _setMacAppProofForTesting(async (conn) => { seen.push(conn); return { ok: true, pid: 4242, bundle: '/Applications/Walnut.app' } })
    // A copy of the signed app started with another home folder (2026-11-18: a test's copy gave it a
    // fresh CFFIXED_USER_HOME, made a new Touch ID key there and sent it): it says so, or says
    // nothing (an older app), and adds no device and asks nothing.
    const copy = softKey()
    for (const accountHome of [undefined, false, 'true', 1]) {
      const r = await http('POST', '/api/v1/approvals/keys', { publicKey: copy.spki, name: 'Studio Mac', kind: 'mac-app', ...(accountHome === undefined ? {} : { accountHome }) })
      expect(r.status, String(accountHome)).toBe(403)
      expect(r.body.code).toBe('first_key_from_phone')
    }
    expect((await http('GET', '/api/v1/approvals/keys')).body.keys).toEqual([])
    const mac = softKey()
    const app = await http('POST', '/api/v1/approvals/keys', { publicKey: mac.spki, name: 'Studio Mac', kind: 'mac-app', accountHome: true })
    expect(app.status).toBe(200)
    expect(app.body.key).toMatchObject({ id: mac.id, kind: 'mac-app', status: 'active' })
    expect(app.body.enrollment).toBeUndefined()
    // The check was given this request's own connection.
    expect(seen).toHaveLength(5)
    expect(seen[4]).toMatchObject({ remotePort: expect.any(Number), localPort: expect.any(Number) })
    // The person's own app sending its known key again without the flag (an app built before it)
    // keeps signing: nothing changes, nothing is refused.
    const known = await http('POST', '/api/v1/approvals/keys', { publicKey: mac.spki, name: 'Studio Mac', kind: 'mac-app' })
    expect(known.status).toBe(200)
    expect(known.body.key.status).toBe('active')

    // A later key from a device app the person set up signs at once too (2026-11-12, the user:
    // "我都已经连接了，为什么还要问我？"): a second Mac app with its own proof, and the paired iPhone.
    const again = softKey()
    const second = await http('POST', '/api/v1/approvals/keys', { publicKey: again.spki, name: 'Other Mac', kind: 'mac-app', accountHome: true })
    expect(second.status).toBe(200)
    expect(second.body.key.status).toBe('active')
    const paired = await http('POST', '/api/devices', { name: 'mac-first-key-phone' })
    const phone = softKey()
    const ph = await http('POST', '/api/v1/approvals/keys', { publicKey: phone.spki, name: 'iPhone', kind: 'iphone' }, { authorization: `Bearer ${paired.body.token}` })
    expect(ph.body.key.status).toBe('active')
    // The paired iPhone through the cloud companion: the Mac's forward runner (target.ts) carries the
    // phone the companion checked (2026-11-18: before, it read as a stranger and became an ask).
    const { runForwardedCall } = await import('../../src/web/v1-forward/target.js')
    const viaCompanion = softKey()
    const data = Buffer.from(JSON.stringify({ publicKey: viaCompanion.spki, name: 'iPhone', kind: 'iphone' }))
    const forwarded = await runForwardedCall({
      method: 'POST', url: '/api/v1/approvals/keys', headers: { 'content-type': 'application/json' },
      data: data.toString('base64'), size: data.byteLength, phone: 'iphone-via-companion',
    })
    expect(forwarded.status).toBe(200)
    expect(JSON.parse(Buffer.from(forwarded.data ?? '', 'base64').toString()).key).toMatchObject({ id: viaCompanion.id, status: 'active' })
    // Anything else naming a phone in those headers names nothing: it is refused.
    const spoof = softKey()
    const spoofed = await http('POST', '/api/v1/approvals/keys', { publicKey: spoof.spki, name: 'iPhone', kind: 'iphone' },
      { 'x-walnut-forwarded-phone': 'iphone', 'x-walnut-forwarded-phone-proof': 'f'.repeat(64) })
    expect(spoofed.status).toBe(403)
    // A browser's sign-in, or a device that said it is no phone, is not the phone app: refused, and
    // nothing asked (2026-11-12 review: a paired browser could otherwise add a signer with WebCrypto).
    const { setDeviceInfo } = await import('../../src/core/device-auth.js')
    for (const [name, report] of [['browser-a1b2c3', undefined], ['desk-laptop', { model: 'MacBookPro18,1', os: 'macOS 26.1' }]] as const) {
      const made = await http('POST', '/api/devices', { name })
      expect(made.status).toBe(201)
      if (report) await setDeviceInfo(name, report)
      const k = softKey()
      const refused = await http('POST', '/api/v1/approvals/keys', { publicKey: k.spki, name: 'iPhone', kind: 'iphone' }, { authorization: `Bearer ${made.body.token}` })
      expect(refused.status, name).toBe(403)
      expect(refused.body.code, name).toBe('first_key_from_phone')
    }
    // A request with no proof (the process check fails, no device token) is refused too.
    _setMacAppProofForTesting(async () => ({ ok: false, why: 'not the app' }))
    const stray = softKey()
    const pend = await http('POST', '/api/v1/approvals/keys', { publicKey: stray.spki, name: 'Mac', kind: 'mac-app', accountHome: true })
    expect(pend.status).toBe(403)
    _setMacAppProofForTesting(async (conn) => { seen.push(conn); return { ok: true, pid: 4242, bundle: '/Applications/Walnut.app' } })
    // Not one of those asked the person anything, and only the device apps' keys were added.
    expect((await http('GET', '/api/v1/approvals?status=all')).body.approvals).toEqual([])
    expect(((await http('GET', '/api/v1/approvals/keys')).body.keys as Array<{ id: string }>).map((k) => k.id).sort())
      .toEqual([mac.id, again.id, phone.id, viaCompanion.id].sort())

    // An agent's browser step: Touch ID's signature approves it with no Passwords unlock, a bare tap does not.
    const { createApproval } = await import('../../src/core/approvals/store.js')
    const { approval } = await createApproval({
      what: 'Post a comment on example.org?', detail: 'Page: https://example.org', mode: 'biometric', guard: 'person',
      timeoutMs: 60_000, requester: { host: 'test', taskId: 't-1', taskTitle: 'Promotion' } as any,
    })
    const tap = await http('POST', `/api/v1/approvals/${approval.id}/answer`, { decision: 'approve' })
    expect(tap.status).toBe(403)
    const signed = await http('POST', `/api/v1/approvals/${approval.id}/answer`, {
      decision: 'approve', keyId: mac.id, signature: mac.sign(approval.digest, 'approve'), device: { name: 'Studio Mac', kind: 'mac-app' },
    })
    expect(signed.status).toBe(200)
    expect(signed.body.approval).toMatchObject({ status: 'approved', answer: { mode: 'biometric', keyId: mac.id } })
  }, 60_000)

  it('an approval asked while no device signed (a tap ask) is approved by the app\'s first Touch ID too', async () => {
    const { createApproval } = await import('../../src/core/approvals/store.js')
    const { approval } = await createApproval({
      what: 'Save a post on example.org?', mode: 'tap', guard: 'person', timeoutMs: 60_000, requester: { host: 'test' } as any,
    })
    const keys = (await http('GET', '/api/v1/approvals/keys')).body.keys as Array<{ id: string; status: string; kind: string }>
    const mac = keys.find((k) => k.kind === 'mac-app' && k.status === 'active')
    expect(mac).toBeTruthy()
    // A wrong signature is refused, never taken as a tap.
    const forged = softKey()
    const bad = await http('POST', `/api/v1/approvals/${approval.id}/answer`, { decision: 'approve', keyId: mac!.id, signature: forged.sign(approval.digest, 'approve') })
    expect(bad.status).toBe(403)
    expect(bad.body.code).toBe('bad_signature')
  }, 60_000)

  it('no approvals read names a device by a generated id (a work Mac named like a1b2c3d4e5f6), every GET route', async () => {
    // 2026-11-18, the person read "Let "<id>" (Mac app) sign your approvals": the Mac's computer name is
    // a generated id. Enumerated from the router, so a new read route is checked too.
    const RAW = 'a1b2c3d4e5f6'
    _setMacAppProofForTesting(async () => ({ ok: true, pid: 4242, bundle: '/Applications/Walnut.app' }))
    const hashed = softKey()
    const added = await http('POST', '/api/v1/approvals/keys', { publicKey: hashed.spki, name: RAW, kind: 'mac-app', accountHome: true })
    expect(added.status).toBe(200)
    expect(added.body.key.name).toBe('Mac')
    const { createApproval } = await import('../../src/core/approvals/store.js')
    const { approval } = await createApproval({ what: 'Ship it?', mode: 'biometric', timeoutMs: 60_000, requester: { host: 'test' } as any })
    const signed = await http('POST', `/api/v1/approvals/${approval.id}/answer`, {
      decision: 'approve', keyId: hashed.id, signature: hashed.sign(approval.digest, 'approve'), device: { name: RAW, kind: 'mac-app' },
    })
    expect(signed.status).toBe(200)
    expect(signed.body.approval.answer.device.name).toBe('Mac')
    const tapped = await createApproval({ what: 'Tap it?', mode: 'tap', timeoutMs: 60_000, requester: { host: 'test' } as any })
    expect((await http('POST', `/api/v1/approvals/${tapped.approval.id}/answer`, { decision: 'approve', device: { name: RAW, kind: 'mac-app' } })).status).toBe(200)

    const src = await fs.readFile(new URL('../../src/web/routes/approvals-v1.ts', import.meta.url), 'utf8')
    const gets = [...src.matchAll(/approvalsV1Router\.get\('([^']+)'/g)].map((m) => m[1]!)
    expect(gets).toEqual(expect.arrayContaining(['/approvals', '/approvals/keys', '/approvals/:id']))
    for (const route of gets) {
      for (const id of route.includes(':id') ? [approval.id, tapped.approval.id] : ['']) {
        const url = `/api/v1${route.replace(':id', id)}${route === '/approvals' ? '?status=all' : ''}`
        const r = await http('GET', url)
        expect(r.status, url).toBe(200)
        expect(JSON.stringify(r.body), url).not.toContain(RAW)
      }
    }
  }, 60_000)
})
