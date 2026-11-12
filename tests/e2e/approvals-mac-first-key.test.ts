/**
 * The Mac app is a first signing device by itself (2026-11-11, the user: approving an agent's
 * browser step "is just a button click", it must not need the Passwords master password, and
 * there must be nothing to set up). A first key counts only from the signed Mac app's own process
 * (src/core/approvals/mac-app-proof.ts): a script on this computer, here curl, is refused, so an
 * agent cannot make itself the first signer and approve its own step. With the app's key, an
 * agent's outward step (`guard: 'person'`) takes one Touch ID signature and no unlock.
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
    const mac = softKey()
    const app = await http('POST', '/api/v1/approvals/keys', { publicKey: mac.spki, name: 'Studio Mac', kind: 'mac-app' })
    expect(app.status).toBe(200)
    expect(app.body.key).toMatchObject({ id: mac.id, kind: 'mac-app', status: 'active' })
    expect(app.body.enrollment).toBeUndefined()
    // The check was given this request's own connection.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ remotePort: expect.any(Number), localPort: expect.any(Number) })

    // A later key from a device app the person set up signs at once too (2026-11-12, the user:
    // "我都已经连接了，为什么还要问我？"): a second Mac app with its own proof, and the paired iPhone.
    const again = softKey()
    const second = await http('POST', '/api/v1/approvals/keys', { publicKey: again.spki, name: 'Other Mac', kind: 'mac-app' })
    expect(second.status).toBe(200)
    expect(second.body.key.status).toBe('active')
    expect(second.body.enrollment).toBeUndefined()
    expect(seen).toHaveLength(2)
    const paired = await http('POST', '/api/devices', { name: 'mac-first-key-phone' })
    const phone = softKey()
    const ph = await http('POST', '/api/v1/approvals/keys', { publicKey: phone.spki, name: 'iPhone', kind: 'iphone' }, { authorization: `Bearer ${paired.body.token}` })
    expect(ph.body.key.status).toBe('active')
    expect(ph.body.enrollment).toBeUndefined()
    // A browser's sign-in, or a device that said it is no phone, is not the phone app: it only asks
    // (2026-11-12 review: a paired browser could otherwise add a signer with WebCrypto).
    const { setDeviceInfo } = await import('../../src/core/device-auth.js')
    for (const [name, report] of [['browser-a1b2c3', undefined], ['desk-laptop', { model: 'MacBookPro18,1', os: 'macOS 26.1' }]] as const) {
      const made = await http('POST', '/api/devices', { name })
      expect(made.status).toBe(201)
      if (report) await setDeviceInfo(name, report)
      const k = softKey()
      const asked = await http('POST', '/api/v1/approvals/keys', { publicKey: k.spki, name: 'iPhone', kind: 'iphone' }, { authorization: `Bearer ${made.body.token}` })
      expect(asked.body.key.status, name).toBe('pending')
    }
    // A request with no proof (the process check fails, no device token) still only asks.
    _setMacAppProofForTesting(async () => ({ ok: false, why: 'not the app' }))
    const stray = softKey()
    const pend = await http('POST', '/api/v1/approvals/keys', { publicKey: stray.spki, name: 'Mac', kind: 'mac-app' })
    expect(pend.body.key.status).toBe('pending')
    expect(pend.body.enrollment).toMatchObject({ mode: 'biometric', enrollsKey: stray.id })
    _setMacAppProofForTesting(async (conn) => { seen.push(conn); return { ok: true, pid: 4242, bundle: '/Applications/Walnut.app' } })

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
})
