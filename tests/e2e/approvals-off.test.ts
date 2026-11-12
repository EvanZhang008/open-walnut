/**
 * The one Approvals switch on a real server (src/core/approvals/ask-me.ts; 2026-11-12, the user:
 * "I want it to be off by default don't need my approval for anything"):
 *
 *  - off (nothing stored): `walnut approve` is answered yes at once, recorded as not asked, and
 *    the CLI goes on (exit 0) with no card;
 *  - a session cannot turn it on or off (403 human_only); the person can, from any screen;
 *  - on: the same ask waits for the person again;
 *  - a signed single-use ask is never answered by the switch;
 *  - while a device signs approvals, turning them off is an approval of its own: an unsigned PUT,
 *    a config.yaml written by another path, or a forged turn-off leaves the switch on, and only a
 *    device's signed Approve turns it off (2026-11-12, a review of the Git gate).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-approvals-off-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { executeOp } from '../../src/ops/index.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import { runApprove } from '../../src/core/approvals/cli-core.js'
import { opFailure } from '../../src/commands/approve.js'
import { createApproval } from '../../src/core/approvals/store.js'
import { answerMessage, keyIdOf } from '../../src/core/approvals/digest.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { asksPerson } from '../../src/core/approvals/ask-me.js'

let base = ''
const before = process.env.WALNUT_APPROVALS_ASK

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}

function approve(what: string, timeoutMs = 10_000) {
  const said: string[] = []
  const code = runApprove({ what, biometric: false, timeoutMs, json: true, cwd: '/work/repo', command: 'post.sh' }, {
    call: async (name, args) => {
      const r = await executeOp(name, args, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })
      return r.ok ? { ok: true, result: r.result } : opFailure(r.message)
    },
    say: (l) => said.push(l),
    out: () => {},
  })
  return { code, said }
}

beforeAll(async () => {
  // The product's default: nothing stored and no test-setup default.
  delete process.env.WALNUT_APPROVALS_ASK
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await stopServer()
  if (before === undefined) delete process.env.WALNUT_APPROVALS_ASK
  else process.env.WALNUT_APPROVALS_ASK = before
})

describe('approvals are off by default', () => {
  it('walnut approve goes on at once, recorded as not asked, with nothing waiting', async () => {
    const run = approve('Post the release notes to the team channel?')
    expect(await run.code, run.said.join('\n')).toBe(0)
    const all = await http('GET', '/api/v1/approvals?status=all')
    const rec = (all.body.approvals as Array<Record<string, any>>).find((a) => a.what === 'Post the release notes to the team channel?')
    expect(rec).toMatchObject({ status: 'approved', unasked: 'approve', answer: { decision: 'approve', device: { kind: 'setting' } } })
    const pending = await http('GET', '/api/v1/approvals')
    expect((pending.body.approvals as unknown[]).length).toBe(0)
  })

  it('never answers a signed single-use ask', async () => {
    await expect(createApproval({
      what: 'Push one commit?', mode: 'biometric', singleUse: true, unasked: 'approve',
      requester: { host: 'local' },
    } as Parameters<typeof createApproval>[0])).rejects.toThrow()
  })
})

describe('only the person moves the switch', () => {
  it('refuses a session and lets the person turn it on, then the ask waits again', async () => {
    const bySession = await http('PUT', '/api/config', { approvals: { ask_me: true } }, { 'x-walnut-caller-sid': 'sess-agent' })
    expect(bySession.status).toBe(403)
    expect(bySession.body.code).toBe('human_only')
    expect((await http('PUT', '/api/config', { approvals: { ask_me: 'yes' } })).status).toBe(400)

    const byPerson = await http('PUT', '/api/config', { approvals: { ask_me: true } })
    expect(byPerson.status).toBe(200)
    // Saving it back unchanged is fine for anyone.
    expect((await http('PUT', '/api/config', { approvals: { ask_me: true } }, { 'x-walnut-caller-sid': 'sess-agent' })).status).toBe(200)

    const run = approve('Delete the old preview site?')
    expect(await run.code, run.said.join('\n')).toBe(2)

    const off = await http('PUT', '/api/config', { approvals: { ask_me: false } }, { 'x-walnut-caller-sid': 'sess-agent' })
    expect(off.status).toBe(403)
    expect((await http('PUT', '/api/config', { approvals: { ask_me: false } })).status).toBe(200)
    expect(await approve('Delete the old preview site, again?').code).toBe(0)
  })
})

describe('while a device signs approvals, only its signature turns them off', () => {
  it('opens a turn-off approval, ignores every unsigned way, and turns off on a signed Approve', async () => {
    expect((await http('PUT', '/api/config', { approvals: { ask_me: true } })).status).toBe(200)
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const paired = await http('POST', '/api/devices', { name: 'approvals-off-e2e-phone' })
    const phone = { authorization: `Bearer ${paired.body.token}` }
    expect((await http('POST', '/api/v1/approvals/keys', { publicKey: spki, name: 'Test iPhone', kind: 'iphone' }, phone)).status).toBe(200)
    const sign = (digest: string) => crypto.sign('sha256', Buffer.from(answerMessage(digest, 'approve')), { key: privateKey, dsaEncoding: 'der' }).toString('base64')

    // An unsigned off, with no session header (the one-curl hole): refused, and one approval opens.
    const off = await http('PUT', '/api/config', { approvals: { ask_me: false } })
    expect(off.status).toBe(409)
    expect(off.body.code).toBe('signature_needed')
    const again = await http('PUT', '/api/config', { approvals: { ask_me: false } })
    expect(again.body.approvalId).toBe(off.body.approvalId)
    expect(await asksPerson()).toBe(true)

    // Other write paths: config.yaml written to off, on disk or through updateConfig, stays on.
    await updateConfig({ approvals: { ask_me: false } })
    expect(await asksPerson()).toBe(true)
    const shown = await http('GET', '/api/config')
    expect(shown.body.approvals?.ask_me ?? shown.body.config?.approvals?.ask_me).toBe(true)
    expect((await http('GET', '/api/v1/approvals')).body.askMe).toBe(true)
    // A whole-config round trip of what a client was shown is no change.
    expect((await http('PUT', '/api/config', { approvals: { ask_me: true } })).status).toBe(200)

    // The open turn-off: a tap does not do it, a signature does.
    const list = await http('GET', '/api/v1/approvals')
    const turnOff = (list.body.approvals as Array<Record<string, any>>).find((a) => a.id === off.body.approvalId)!
    expect(turnOff).toMatchObject({ turnsAskMeOff: true, mode: 'biometric', outsideSwitch: true })
    const tap = await http('POST', `/api/v1/approvals/${turnOff.id}/answer`, { decision: 'approve' })
    expect(tap.status).toBe(403)
    expect(await asksPerson()).toBe(true)

    // A biometric approval of another kind, signed, never turns it off.
    const other = await createApproval({ what: 'Publish v2', mode: 'biometric', requester: { host: 'local' } })
    expect((await http('POST', `/api/v1/approvals/${other.approval.id}/answer`, { decision: 'approve', keyId: keyIdOf(spki), signature: sign(other.approval.digest) })).status).toBe(200)
    expect(await asksPerson()).toBe(true)

    const signed = await http('POST', `/api/v1/approvals/${turnOff.id}/answer`, { decision: 'approve', keyId: keyIdOf(spki), signature: sign(turnOff.digest) })
    expect(signed.status).toBe(200)
    expect(await asksPerson()).toBe(false)
    const latch = JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'approvals', 'switch.json'), 'utf8'))
    expect(latch).toMatchObject({ on: false, by: { approvalId: turnOff.id, keyId: keyIdOf(spki) } })
    expect(await approve('Post the weekly summary?').code).toBe(0)

    // On again needs nothing.
    expect((await http('PUT', '/api/config', { approvals: { ask_me: true } })).status).toBe(200)
    expect(await asksPerson()).toBe(true)
  }, 60_000)
})
