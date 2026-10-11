/**
 * The Mac's side of companion ownership (src/integrations/cloud-bridge-config.ts):
 * it proves it is the Mac a companion from before owners were recorded belongs
 * to, with the first `bridge-local` token only its own daemon ever held.
 *
 *  - every mint (and the DELETE of a lost cache) carries that proof;
 *  - once per start, a cache hit offers it on its own (POST .../adopt);
 *  - the console relay asks for it too (machineProofHeaders);
 *  - a refusal by the companion's ownership rules (403/409) ends the attempt:
 *    no DELETE and re-mint loop, the code and sentence kept for the host card,
 *    and nothing ever says "Another Mac" unless the companion did.
 *
 * A fake companion on loopback records every request; only the git remote read
 * (where the pairing lives) is pointed at it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-bridge-proof'))

const remote = vi.hoisted(() => ({ domain: '', token: 'mac-own-companion-token' }))
vi.mock('../../src/integrations/git-sync.js', async (orig) => {
  const creds = () => (remote.domain ? { domain: remote.domain, token: remote.token, secure: false } : null)
  return {
    ...(await orig<typeof import('../../src/integrations/git-sync.js')>()),
    getCloudRemoteCredentials: creds,
    getCloudRemoteCredentialsAsync: async () => creds(),
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import {
  getBridgeConfigForHost, machineProofHeaders, machineTokenRefusal, resetMachineTokenStateForTest,
} from '../../src/integrations/cloud-bridge-config.js'
import { MACHINE_PROOF_HEADER } from '../../src/core/machine-credentials.js'

type Seen = { method: string; url: string; proof?: string; auth?: string }
/** What the fake companion answers, per request; the default is a plain success. */
const box = {
  seen: [] as Seen[],
  answer: (_s: Seen, _body: Record<string, unknown>): { status: number; body: Record<string, unknown> } | null => null,
  minted: 0,
}
const companion = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const s: Seen = { method: req.method ?? '', url: req.url ?? '', proof: req.headers[MACHINE_PROOF_HEADER] as string | undefined, auth: req.headers.authorization }
    box.seen.push(s)
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    const custom = box.answer(s, body)
    const send = (status: number, b: Record<string, unknown>) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(b))
    if (custom) return send(custom.status, custom.body)
    if (s.method === 'POST' && s.url === '/api/devices') return send(201, { name: body.name, token: `minted-${++box.minted}`, createdAt: 'now' })
    if (s.method === 'POST' && s.url.endsWith('/adopt')) return send(200, { ok: true, outcome: 'adopted' })
    if (s.method === 'DELETE') return send(200, { ok: true })
    send(404, {})
  })
})

const cacheFile = () => path.join(WALNUT_HOME, 'sync', 'bridge-tokens.json')
async function writeCache(cache: Record<string, string>): Promise<void> {
  await fs.mkdir(path.dirname(cacheFile()), { recursive: true })
  await fs.writeFile(cacheFile(), JSON.stringify(cache))
}
const settle = () => new Promise((r) => setTimeout(r, 100))

beforeAll(async () => {
  await new Promise<void>((r) => companion.listen(0, '127.0.0.1', () => r()))
  remote.domain = `127.0.0.1:${(companion.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((r) => companion.close(() => r()))
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})
beforeEach(async () => {
  box.seen = []
  box.answer = () => null
  await fs.rm(cacheFile(), { force: true })
  resetMachineTokenStateForTest()
})

describe('the Mac proves it owns its companion', () => {
  it('a new host\'s mint carries the bridge-local proof; a cache hit offers adoption once per start', async () => {
    await writeCache({ 'bridge-local': 'the-local-token' })
    expect(await machineProofHeaders()).toEqual({ [MACHINE_PROOF_HEADER]: 'the-local-token' })
    const devbox = await getBridgeConfigForHost('devbox')
    expect(devbox).toMatchObject({ enabled: true, token: expect.stringMatching(/^minted-/) })
    for (let i = 0; i < 3; i++) expect(await getBridgeConfigForHost('__local__')).toMatchObject({ enabled: true, token: 'the-local-token' })
    await settle()
    expect(box.seen.map((s) => `${s.method} ${s.url} proof=${s.proof ?? '-'}`)).toEqual([
      'POST /api/devices proof=the-local-token',
      'POST /api/devices/bridge-local/adopt proof=the-local-token',
    ])
    expect(box.seen.every((s) => s.auth === `Bearer ${remote.token}`)).toBe(true)
  })

  it('a lost cache: POST, "already exists", DELETE, POST, with no proof to send (the companion knows its owner)', async () => {
    let first = true
    box.answer = (s) => (s.method === 'POST' && first ? ((first = false), { status: 400, body: { error: 'Device "bridge-local" already exists' } }) : null)
    expect(await machineProofHeaders()).toEqual({})
    expect(await getBridgeConfigForHost('__local__')).toMatchObject({ enabled: true, token: expect.stringMatching(/^minted-/) })
    expect(box.seen.map((s) => `${s.method} ${s.url} proof=${s.proof ?? '-'}`)).toEqual([
      'POST /api/devices proof=-',
      'DELETE /api/devices/bridge-local proof=-',
      'POST /api/devices proof=-',
    ])
    expect(machineTokenRefusal('__local__')).toBeUndefined()
  })

  it('a refusal ends the attempt and is kept with the companion\'s own words: no DELETE, no second POST', async () => {
    for (const refusal of [
      { status: 409, body: { code: 'other_mac_connected', error: 'Another Mac is connected to this cloud companion. Disconnect it there first.' } },
      { status: 409, body: { code: 'not_companion_owner', error: 'Only the Mac this cloud companion belongs to can connect computers to it.' } },
      { status: 403, body: { code: 'phone_cannot_mint', error: 'Only the Mac this cloud companion belongs to can connect computers to it.' } },
    ]) {
      box.seen = []
      box.answer = () => refusal
      expect(await getBridgeConfigForHost('devbox')).toEqual({ enabled: false })
      expect(box.seen.map((s) => s.method)).toEqual(['POST'])
      expect(machineTokenRefusal('devbox')).toEqual({ status: refusal.status, code: refusal.body.code, error: refusal.body.error })
    }
    // The next mint that works clears it.
    box.answer = () => null
    expect(await getBridgeConfigForHost('devbox')).toMatchObject({ enabled: true })
    expect(machineTokenRefusal('devbox')).toBeUndefined()
  })

  it('a lost cache the companion will not let this Mac replace: the DELETE\'s refusal is the answer', async () => {
    box.answer = (s) => (s.method === 'POST'
      ? { status: 400, body: { error: 'Device "bridge-local" already exists' } }
      : { status: 409, body: { code: 'not_companion_owner', error: 'Only the Mac this cloud companion belongs to can connect computers to it.' } })
    expect(await getBridgeConfigForHost('__local__')).toEqual({ enabled: false })
    expect(box.seen.map((s) => s.method)).toEqual(['POST', 'DELETE'])
    expect(machineTokenRefusal('__local__')).toMatchObject({ status: 409, code: 'not_companion_owner' })
  })

  it('an adoption the companion refuses changes nothing, and is not sent again this start', async () => {
    await writeCache({ 'bridge-local': 'the-local-token' })
    box.answer = (s) => (s.url.endsWith('/adopt') ? { status: 409, body: { code: 'other_mac_connected', error: 'x' } } : null)
    expect(await getBridgeConfigForHost('__local__')).toMatchObject({ enabled: true, token: 'the-local-token' })
    expect(await getBridgeConfigForHost('__local__')).toMatchObject({ enabled: true, token: 'the-local-token' })
    await settle()
    expect(box.seen.filter((s) => s.url.endsWith('/adopt'))).toHaveLength(1)
  })
})
