/**
 * Approvals end to end on a real server (src/web/routes/approvals-v1.ts): `walnut approve`'s
 * loop (core/approvals/cli-core.ts) through the real ops against a person answering over HTTP.
 *
 *  - Approve -> exit 0, Deny -> 1, nobody -> 2, and the answer is used once;
 *  - only a person answers or enrolls a device: a session, a CLI automation and a session on
 *    another host are refused (403 human_only), the guard tests/core/agent-parity-ratchet.test.ts lists;
 *  - biometric: with no device it asks for a tap and says why; with an enrolled key, Approve
 *    needs that key's signature over this approval's digest.
 * Nothing but the Claude CLI would be mocked, and no session runs here.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-approvals-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { executeOp } from '../../src/ops/index.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import { runApprove } from '../../src/core/approvals/cli-core.js'
import { opFailure } from '../../src/commands/approve.js'
import { answerMessage, keyIdOf } from '../../src/core/approvals/digest.js'

let base = ''

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}

/** The CLI's loop, its ops through the real executor as a terminal on this machine would call them. */
function approve(what: string, opts: { biometric?: boolean; timeoutMs?: number } = {}) {
  const said: string[] = []
  const out: string[] = []
  const code = runApprove({ what, biometric: !!opts.biometric, timeoutMs: opts.timeoutMs ?? 60_000, json: true, cwd: '/work/repo', command: 'deploy.sh' }, {
    call: async (name, args) => {
      const r = await executeOp(name, args, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })
      return r.ok ? { ok: true, result: r.result } : opFailure(r.message)
    },
    say: (l) => said.push(l),
    out: (l) => out.push(l),
  })
  return { code, said, out }
}

async function pendingNamed(what: string) {
  for (let i = 0; i < 100; i++) {
    const r = await http('GET', '/api/v1/approvals')
    const a = (r.body.approvals as Array<Record<string, any>>).find((x) => x.what === what)
    if (a) return a
    await new Promise((res) => setTimeout(res, 50))
  }
  throw new Error(`no pending approval "${what}"`)
}

beforeAll(async () => {
  // A throwaway server makes no test objects unless told to (core/test-run.ts).
  process.env.WALNUT_TEST_RUN_MARK = '1'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await stopServer()
  delete process.env.WALNUT_TEST_RUN_MARK
})

describe('walnut approve against a real server', () => {
  it('exits 0 when a person approves, and the record says who asked and who answered', async () => {
    const run = approve('Deploy web to prod')
    const a = await pendingNamed('Deploy web to prod')
    expect(a.mode).toBe('tap')
    expect(a.requester).toMatchObject({ cwd: '/work/repo', command: 'deploy.sh' })
    expect(a.requester.host).toBeTruthy()
    const r = await http('POST', `/api/v1/approvals/${a.id}/answer`, { decision: 'approve', device: { name: 'Web console', kind: 'web' } })
    expect(r.status).toBe(200)
    expect(await run.code).toBe(0)
    expect(run.said.join('\n')).toContain('Approved on Web console, with a tap')
    expect(JSON.parse(run.out[0])).toMatchObject({ id: a.id, status: 'approved' })
    const all = await http('GET', '/api/v1/approvals?status=all')
    expect(all.body.approvals.find((x: any) => x.id === a.id).answer).toMatchObject({ decision: 'approve', mode: 'tap', device: { kind: 'web' } })
  }, 60_000)

  it('exits 1 on Deny', async () => {
    const run = approve('Drop the staging table')
    const a = await pendingNamed('Drop the staging table')
    await http('POST', `/api/v1/approvals/${a.id}/answer`, { decision: 'deny' })
    expect(await run.code).toBe(1)
  }, 60_000)

  it('exits 2 when nobody answers in time, and the card is gone', async () => {
    const run = approve('Nobody looks at this', { timeoutMs: 10_000 })
    const a = await pendingNamed('Nobody looks at this')
    expect(await run.code).toBe(2)
    const r = await http('GET', `/api/v1/approvals/${a.id}`)
    expect(r.body.approval.status).toBe('expired')
    expect((await http('POST', `/api/v1/approvals/${a.id}/answer`, { decision: 'approve' })).body.code).toBe('already_expired')
  }, 60_000)

  it('only a person answers: a session, a CLI automation and a session on another host are refused', async () => {
    const created = await executeOp('approval_request', { what: 'Rotate the signing key' }, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })
    expect(created.ok).toBe(true)
    const { approval, waitToken } = created.ok ? created.result as Record<string, any> : ({} as Record<string, any>)
    for (const headers of [
      { 'x-walnut-caller-sid': '11111111-2222-4333-8444-555555555555' },
      { 'x-walnut-caller-kind': 'script' },
      { 'x-walnut-origin': 'host:clouddev' },
    ]) {
      const r = await http('POST', `/api/v1/approvals/${approval.id}/answer`, { decision: 'approve' }, headers)
      expect(r.status, JSON.stringify(headers)).toBe(403)
      expect(r.body.code).toBe('human_only')
      const k = await http('POST', '/api/v1/approvals/keys', { publicKey: 'x', name: 'x', kind: 'iphone' }, headers)
      expect(k.status).toBe(403)
    }
    // There is no op that answers one.
    expect((await executeOp('approval_answer', { id: approval.id }, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })).ok).toBe(false)
    // The asker uses it once.
    await http('POST', `/api/v1/approvals/${approval.id}/answer`, { decision: 'approve' })
    const first = await executeOp('approval_wait', { id: approval.id, token: waitToken, wait_ms: 0 }, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })
    expect(first.ok && (first.result as any).used).toBe(true)
    // A retry right away gets the same decision without using it again (store.ts APPROVAL_REREAD_MS).
    const second = await executeOp('approval_wait', { id: approval.id, token: waitToken, wait_ms: 0 }, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })
    expect(second.ok && (second.result as any)).toMatchObject({ used: false, approval: { status: 'approved' } })
    // Someone else's token reads nothing.
    const other = await executeOp('approval_wait', { id: approval.id, token: 'guess', wait_ms: 0 }, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })
    expect(other.ok).toBe(false)
  }, 60_000)

  it('biometric: asks for a tap when no device signs yet, then needs the enrolled key\'s signature', async () => {
    const tapRun = approve('Publish v1 (no device yet)', { biometric: true })
    const t = await pendingNamed('Publish v1 (no device yet)')
    expect(t.mode).toBe('tap')
    expect(t.downgraded).toMatch(/No device signs approvals yet/)
    await http('POST', `/api/v1/approvals/${t.id}/answer`, { decision: 'approve' })
    expect(await tapRun.code).toBe(0)
    expect(tapRun.said.join('\n')).toContain('No device signs approvals yet')

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    // A first key from this computer is refused: only the paired iPhone app, with its device token.
    const local = await http('POST', '/api/v1/approvals/keys', { publicKey: spki, name: 'Test iPhone', kind: 'iphone' })
    expect(local.status).toBe(403)
    expect(local.body.code).toBe('first_key_from_phone')
    const paired = await http('POST', '/api/devices', { name: 'approvals-e2e-phone' })
    expect(paired.status).toBe(201)
    const phone = { authorization: `Bearer ${paired.body.token}` }
    const enrolled = await http('POST', '/api/v1/approvals/keys', { publicKey: spki, name: 'Test iPhone', kind: 'iphone' }, phone)
    expect(enrolled.status).toBe(200)
    expect(enrolled.body.key).toMatchObject({ id: keyIdOf(spki), status: 'active' })

    const run = approve('Publish v1', { biometric: true })
    const a = await pendingNamed('Publish v1')
    expect(a.mode).toBe('biometric')
    const tap = await http('POST', `/api/v1/approvals/${a.id}/answer`, { decision: 'approve' })
    expect(tap.status).toBe(403)
    expect(tap.body.code).toBe('biometric_required')
    const signature = crypto.sign('sha256', Buffer.from(answerMessage(a.digest, 'approve')), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
    const ok = await http('POST', `/api/v1/approvals/${a.id}/answer`, { decision: 'approve', keyId: keyIdOf(spki), signature })
    expect(ok.status).toBe(200)
    expect(await run.code).toBe(0)
    expect(run.said.join('\n')).toContain('Approved on Test iPhone, with Face ID')
    const keys = await http('GET', '/api/v1/approvals/keys')
    expect(keys.body.keys[0].lastUsedAt).toBeTruthy()
  }, 60_000)

  it('a test run\'s approval shows only to that test run, which cannot change the signing devices', async () => {
    const T = { 'x-walnut-test-run': 'apr-e2e' }
    const made = await http('POST', '/api/v1/approvals', { what: 'Test-run deploy' }, T)
    expect(made.status).toBe(200)
    expect(made.body.approval.testRun).toBe('apr-e2e')
    const id = made.body.approval.id
    expect((await http('GET', '/api/v1/approvals')).body.approvals.map((a: any) => a.id)).not.toContain(id)
    expect((await http('GET', '/api/v1/approvals', undefined, T)).body.approvals.map((a: any) => a.id)).toContain(id)
    expect((await http('GET', `/api/v1/approvals/${id}`)).status).toBe(404)
    // The person never answers a test run's approval by accident, nor a test run the person's.
    expect((await http('POST', `/api/v1/approvals/${id}/answer`, { decision: 'approve' })).status).toBe(404)
    const real = await http('POST', '/api/v1/approvals', { what: 'Real deploy' })
    expect((await http('POST', `/api/v1/approvals/${real.body.approval.id}/answer`, { decision: 'approve' }, T)).status).toBe(404)
    expect((await http('POST', `/api/v1/approvals/${id}/answer`, { decision: 'approve' }, T)).status).toBe(200)
    const k = await http('POST', '/api/v1/approvals/keys', { publicKey: 'x', name: 'x', kind: 'iphone' }, T)
    expect(k.body.code).toBe('test_run')
    await http('POST', `/api/v1/approvals/${real.body.approval.id}/cancel`, { token: real.body.waitToken })
  })
})
