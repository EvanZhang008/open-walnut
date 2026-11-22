/**
 * A host's door credential in the leader's auth.json (src/core/session-channel/host-credentials.ts):
 * minted with its verify key, verified in constant time, a rotated token still taken for its
 * grace and not after, refused by every other door and route (verifyDeviceToken, the one check
 * /bridge, /ws and REST share), untouched by a pairing revoke, and a revoke that closes the
 * host's live door socket at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-credentials'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetDeviceAuthForTesting, readDeviceRegistry, revokeDevice, verifyDeviceToken } from '../../../src/core/device-auth.js'
import { validateBearerCredential } from '../../../src/web/middleware/auth.js'
import {
  PREVIOUS_GRACE_MS, credentialDue, hostCredentialName, hostCredentialOf, mintHostCredential, matchDoorToken, verifyHostCredential,
} from '../../../src/core/session-channel/host-credentials.js'
import { revokeHostCredential, setRevokeStandbySync } from '../../../src/core/session-channel/leader-issue.js'
import { handleHostDoorUpgrade, startHostDoor, verifyHostDoorUpgrade } from '../../../src/core/session-channel/host-door.js'
import type { ChannelSocket } from '../../../src/core/session-channel/leader-links.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const MACHINE = 'a1'.repeat(16)
const WALNUT = 'c0ffee'.repeat(5) + 'ab'

async function writeAuth(devices: unknown[], extra: Record<string, unknown> = {}): Promise<void> {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ instanceId: WALNUT, devices, ...extra }, null, 2) + '\n', { mode: 0o600 })
}

beforeEach(async () => {
  _resetDeviceAuthForTesting()
  await fs.rm(path.join(WALNUT_HOME, 'auth.json'), { force: true })
  await fs.rm(path.join(WALNUT_HOME, 'auth.json.bak'), { force: true })
})

describe('the record', () => {
  it('is minted as a leader-issued machine record: hash and verify key kept, the token returned once', async () => {
    const t0 = Date.parse('2026-11-01T00:00:00Z')
    const issued = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox', now: t0 })
    expect(issued.token).toMatch(/^[0-9a-f]{64}$/)
    expect(issued.verifyKey).toMatch(/^[0-9a-f]{64}$/)
    const rec = await hostCredentialOf(MACHINE)
    expect(rec).toMatchObject({ name: hostCredentialName(MACHINE), kind: 'machine', issuer: 'leader', machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox', tokenHash: sha(issued.token), verifyKey: issued.verifyKey })
    expect(rec?.previous).toBeUndefined()
    // The plaintext token is in no file.
    const disk = await fs.readFile(path.join(WALNUT_HOME, 'auth.json'), 'utf8')
    expect(disk).not.toContain(issued.token)
    expect((await fs.stat(path.join(WALNUT_HOME, 'auth.json'))).mode & 0o777).toBe(0o600)
    // Due again after 30 days, not before.
    expect(credentialDue(rec, t0 + 29 * 86_400_000)).toBe(false)
    expect(credentialDue(rec, t0 + 31 * 86_400_000)).toBe(true)
    expect(credentialDue(null)).toBe(true)
  })

  it('verifies the current token with its key, a rotated one with ITS key within the grace, and not after', async () => {
    const t0 = Date.now()
    const first = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox', now: t0 })
    expect((await verifyHostCredential(first.token))).toMatchObject({ which: 'current', verifyKey: first.verifyKey })
    const second = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox', now: t0 })
    const cur = await verifyHostCredential(second.token)
    expect(cur).toMatchObject({ which: 'current', verifyKey: second.verifyKey })
    const prev = await verifyHostCredential(first.token, t0 + PREVIOUS_GRACE_MS - 1_000)
    expect(prev).toMatchObject({ which: 'previous', verifyKey: first.verifyKey })
    expect(await verifyHostCredential(first.token, t0 + PREVIOUS_GRACE_MS + 1_000)).toBeNull()
    expect(await verifyHostCredential('f'.repeat(64))).toBeNull()
    expect(await verifyHostCredential('')).toBeNull()
  })

  it('a revoked hash never matches, even if its record came back', async () => {
    const { token } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const { devices } = await readDeviceRegistry()
    expect(matchDoorToken(devices, new Set([sha(token)]), token)).toBeNull()
    expect(matchDoorToken(devices, new Set(), token)).not.toBeNull()
  })

  it('is refused by verifyDeviceToken and validateBearerCredential: no /bridge, /ws or REST route takes it', async () => {
    const { token } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    expect(await verifyDeviceToken(token)).toBeNull()
    expect(await validateBearerCredential(token)).toBeNull()
  })

  it('a pairing revoke of a device that owns machine credentials leaves it', async () => {
    const issued = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const host = (await readDeviceRegistry()).devices.find((d) => d.issuer === 'leader')!
    await writeAuth([
      { name: 'mac', id: 'd1111111111111111', tokenHash: sha('mac-token'), createdAt: '2026-09-01T00:00:00.000Z' },
      { name: 'bridge-local', id: 'd2222222222222222', tokenHash: sha('bridge-token'), createdAt: '2026-09-01T00:00:00.000Z', kind: 'machine', ownerId: 'd1111111111111111' },
      { name: 'bridge-old', id: 'd3333333333333333', tokenHash: sha('old-token'), createdAt: '2026-09-01T00:00:00.000Z', kind: 'machine' },
      host,
    ])
    _resetDeviceAuthForTesting()
    expect(await revokeDevice('mac')).toBe(true)
    const names = (await readDeviceRegistry()).devices.map((d) => d.name).sort()
    // The owner's machine credentials and the unowned one went with it; the host's door credential stayed.
    expect(names).toEqual([hostCredentialName(MACHINE)])
    expect(await verifyHostCredential(issued.token)).not.toBeNull()
  })
})

describe('revoke', () => {
  let server: http.Server | null = null
  let stopDoor: (() => void) | null = null
  afterEach(async () => {
    stopDoor?.(); stopDoor = null
    setRevokeStandbySync(null)
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    server = null
  })

  it('closes the host\'s live door socket at once and runs one standby batch', async () => {
    const { token, verifyKey } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const adopted: ChannelSocket[] = []
    stopDoor = await startHostDoor({
      walnutId: async () => WALNUT,
      standing: () => ({ pair: { permitNumber: 0, epoch: 1 }, holder: 'leader-machine' }),
      adopt: (_k, s) => { adopted.push(s); return true },
      log: () => {},
    })
    server = http.createServer()
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x')
      void handleHostDoorUpgrade(req, socket, head, { verify: () => verifyHostDoorUpgrade(url, req) })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(`ws://127.0.0.1:${port}/host-door`, { headers: { authorization: `Bearer ${token}` } })
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    const welcome = new Promise<any>((r) => ws.on('message', (m) => r(JSON.parse(String(m)))))
    await new Promise<void>((r) => ws.on('open', () => r()))
    ws.send(JSON.stringify({ ch: 'door', op: 'hello', v: 1, walnutId: WALNUT, machineId: MACHINE, nonce: 'ab'.repeat(32) }))
    const w = await welcome
    expect(w).toMatchObject({ op: 'welcome', walnutId: WALNUT, holder: 'leader-machine', permitNumber: 0, epoch: 1 })
    expect(w.proof).toMatch(/^[0-9a-f]{64}$/)
    expect(verifyKey).not.toBe(w.proof)
    await vi.waitFor(() => expect(adopted).toHaveLength(1))
    let synced = 0
    setRevokeStandbySync(async () => { synced++; return null })
    expect(await revokeHostCredential(MACHINE)).toBe(true)
    expect(await closed).toBe(4003)
    expect(synced).toBe(1)
    expect(await hostCredentialOf(MACHINE)).toBeNull()
    expect(await verifyHostCredential(token)).toBeNull()
    // The same token is refused at the door now (401 before any upgrade).
    const again = new WebSocket(`ws://127.0.0.1:${port}/host-door`, { headers: { authorization: `Bearer ${token}` } })
    const status = await new Promise<number>((r) => { again.on('unexpected-response', (_q, res) => r(res.statusCode ?? 0)); again.on('open', () => r(101)) })
    expect(status).toBe(401)
  })
})
