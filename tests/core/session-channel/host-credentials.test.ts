/**
 * A host's door credential in the leader's auth.json (src/core/session-channel/host-credentials.ts):
 * minted with its key S and no bearer (an empty token hash), one record per machine bound to its
 * host key, a rotated key still taken for its grace and not after, refused by every other door and
 * route (verifyDeviceToken, the one check /bridge, /ws and REST share), untouched by a pairing
 * revoke; and revokes that close the host's door socket: one in this process at once, one made by
 * another process (or a previous key past its grace) at the door's recheck, and a host removed
 * from the config (revokeHostsGone) at once, after which its hello is told unknown_credential.
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
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'
import {
  HostDoorRevoked, HostKeyMismatch, PREVIOUS_GRACE_MS, credentialDue, doorKeysOf, hostCredentialName, hostCredentialOf, hostDoorRevoked, mintHostCredential,
} from '../../../src/core/session-channel/host-credentials.js'
import { allowHostDoorNow, hostRevokedNow, revokeHostCredential, revokeHostDoorNow, revokeHostsGone, setDoorHostHooks, setRevokeStandbySync } from '../../../src/core/session-channel/leader-issue.js'
import { handleHostDoorUpgrade, startHostDoor, verifyHostDoorUpgrade } from '../../../src/core/session-channel/host-door.js'
import { doorKeyId } from '../../../src/core/session-channel/door-wire.js'
import type { ChannelSocket } from '../../../src/core/session-channel/leader-links.js'
import { doorHandshake } from '../../helpers/host-door-client.js'
import { setRevokedHostResolver, setRevokedHosts } from '../../../src/core/session-channel/revoked-hosts.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const MACHINE = 'a1'.repeat(16)
const WALNUT = 'c0ffee'.repeat(5) + 'ab'

async function writeAuth(devices: unknown[], extra: Record<string, unknown> = {}): Promise<void> {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ instanceId: WALNUT, devices, ...extra }, null, 2) + '\n', { mode: 0o600 })
}

beforeEach(async () => {
  _resetDeviceAuthForTesting()
  _resetAuthRateLimitForTesting()
  await fs.rm(path.join(WALNUT_HOME, 'auth.json'), { force: true })
  await fs.rm(path.join(WALNUT_HOME, 'auth.json.bak'), { force: true })
})

describe('the record', () => {
  it('is minted as a leader-issued machine record: its key kept, no bearer and no token hash', async () => {
    const t0 = Date.parse('2026-11-01T00:00:00Z')
    const minted = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox', now: t0 })
    expect(minted.verifyKey).toMatch(/^[0-9a-f]{64}$/)
    expect(minted).not.toHaveProperty('token')
    const rec = await hostCredentialOf(MACHINE)
    expect(rec).toMatchObject({ name: hostCredentialName(MACHINE), kind: 'machine', issuer: 'leader', machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox', tokenHash: '', verifyKey: minted.verifyKey })
    expect(rec?.previous).toBeUndefined()
    expect((await fs.stat(path.join(WALNUT_HOME, 'auth.json'))).mode & 0o777).toBe(0o600)
    // Due again after 30 days, not before.
    expect(credentialDue(rec, t0 + 29 * 86_400_000)).toBe(false)
    expect(credentialDue(rec, t0 + 31 * 86_400_000)).toBe(true)
    expect(credentialDue(null)).toBe(true)
  })

  it('takes the current key, a rotated one within its grace, and not after', async () => {
    const t0 = Date.now()
    const first = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox', now: t0 })
    expect(doorKeysOf((await hostCredentialOf(MACHINE))!, t0).map((k) => k.which)).toEqual(['current'])
    const second = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox', now: t0 })
    const rec = (await hostCredentialOf(MACHINE))!
    expect(doorKeysOf(rec, t0 + PREVIOUS_GRACE_MS - 1_000)).toEqual([
      { keyId: doorKeyId(second.verifyKey), verifyKey: second.verifyKey, which: 'current' },
      { keyId: doorKeyId(first.verifyKey), verifyKey: first.verifyKey, which: 'previous' },
    ])
    expect(doorKeysOf(rec, t0 + PREVIOUS_GRACE_MS + 1_000).map((k) => k.which)).toEqual(['current'])
  })

  it('is one record per machine, bound to its host key: another key never rotates it', async () => {
    const first = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    await expect(mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'other-box' })).rejects.toBeInstanceOf(HostKeyMismatch)
    expect(await hostCredentialOf(MACHINE)).toMatchObject({ hostKey: 'devbox', verifyKey: first.verifyKey })
  })

  it('is refused by verifyDeviceToken and validateBearerCredential: no /bridge, /ws or REST route takes it', async () => {
    const { verifyKey } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    for (const bearer of [verifyKey, '', sha('')]) {
      expect(await verifyDeviceToken(bearer)).toBeNull()
      expect(await validateBearerCredential(bearer)).toBeNull()
    }
  })

  it('a pairing revoke of a device that owns machine credentials leaves it', async () => {
    await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
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
  })
})

describe('revoke', () => {
  let server: http.Server | null = null
  let stopDoor: (() => void) | null = null
  let configured = new Set(['devbox'])
  let doorNow = Date.now()
  let adopted: ChannelSocket[] = []
  afterEach(async () => {
    stopDoor?.(); stopDoor = null
    setRevokeStandbySync(null)
    setDoorHostHooks(null)
    setRevokedHostResolver(null)
    setRevokedHosts([])
    delete process.env.WALNUT_HOST_RUNS_SESSIONS
    server?.closeAllConnections?.()
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    server = null
  })

  async function door(recheckMs = 60_000): Promise<string> {
    configured = new Set(['devbox'])
    doorNow = Date.now()
    adopted = []
    stopDoor = await startHostDoor({
      walnutId: async () => WALNUT,
      standing: () => ({ pair: { permitNumber: 0, epoch: 1 }, holder: 'leader-machine' }),
      configured: (k) => configured.has(k),
      adopt: (_k, s) => { adopted.push(s); return true },
      recheckMs, now: () => doorNow,
      log: () => {},
    })
    server = http.createServer()
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x')
      void handleHostDoorUpgrade(req, socket, head, { verify: () => verifyHostDoorUpgrade(url, req) })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    return `ws://127.0.0.1:${(server.address() as { port: number }).port}/host-door`
  }

  it('in this process closes the host\'s door socket at once and runs one standby batch; its next hello is unknown', async () => {
    const url = await door()
    const { verifyKey } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const c = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })
    expect(c.welcome).toMatchObject({ op: 'welcome', walnutId: WALNUT, holder: 'leader-machine', permitNumber: 0, epoch: 1 })
    await vi.waitFor(() => expect(adopted).toHaveLength(1))
    let synced = 0
    setRevokeStandbySync(async () => { synced++; return null })
    expect(await revokeHostCredential(MACHINE)).toBe(true)
    expect(await c.closed).toBe(4003)
    expect(synced).toBe(1)
    expect(await hostCredentialOf(MACHINE)).toBeNull()
    expect((await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })).code).toBe(4004)
  })

  it('made by another process closes the socket at the door\'s next recheck', async () => {
    const url = await door(50)
    const { verifyKey } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const c = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })
    await vi.waitFor(() => expect(adopted).toHaveLength(1))
    // Another process (the CLI) writes auth.json without the record: no event reaches this one.
    const others = (await readDeviceRegistry()).devices.filter((d) => d.issuer !== 'leader')
    await writeAuth(others)
    _resetDeviceAuthForTesting()
    expect(await c.closed).toBe(4003)
  })

  it('a socket that proved a previous key closes once that key\'s grace ended', async () => {
    const url = await door(50)
    const first = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const c = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey: first.verifyKey })
    expect(c.welcome.proofs).toHaveLength(2)
    await vi.waitFor(() => expect(adopted).toHaveLength(1))
    doorNow = Date.now() + PREVIOUS_GRACE_MS + 1_000
    expect(await c.closed).toBe(4003)
    // And a new dial with it is not even offered a proof for it any more.
    const again = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey: first.verifyKey })
    expect(again.welcome.proofs.map((p: { keyId: string }) => p.keyId)).not.toContain(doorKeyId(first.verifyKey))
    expect(await again.closed).toBe(4001)
  })

  it('a host removed from the config loses its credential and its socket (revokeHostsGone), and is told unknown after', async () => {
    const url = await door()
    const { verifyKey } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    await mintHostCredential({ machineId: 'b2'.repeat(16), walnutId: WALNUT, hostKey: 'keeper' })
    const c = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })
    await vi.waitFor(() => expect(adopted).toHaveLength(1))
    setRevokeStandbySync(async () => null)
    configured = new Set(['keeper'])
    expect(await revokeHostsGone(configured)).toEqual([MACHINE])
    expect(await c.closed).toBe(4003)
    expect(await hostCredentialOf(MACHINE)).toBeNull()
    expect(await hostCredentialOf('b2'.repeat(16))).not.toBeNull()
    expect((await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })).code).toBe(4004)
  })

  it('the door lets in and keeps only a host still in the config, whatever its record says', async () => {
    const url = await door(50)
    const { verifyKey } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const c = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })
    await vi.waitFor(() => expect(adopted).toHaveLength(1))
    configured = new Set()
    expect(await c.closed).toBe(4003)
    expect((await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })).code).toBe(4004)
    expect(await hostCredentialOf(MACHINE)).not.toBeNull()
  })

  it('a revoke of a host still in the config is a ban: socket closed at once, no key kept, nothing minted until an allow', async () => {
    const url = await door()
    const { verifyKey } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const c = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })
    await vi.waitFor(() => expect(adopted).toHaveLength(1))
    let synced = 0
    setRevokeStandbySync(async () => { synced++; return null })
    const rechecked: string[] = []
    const cut: Array<[string, boolean]> = []
    setDoorHostHooks({ machineIdOf: () => MACHINE, recheck: (k) => { rechecked.push(k) }, cut: (k) => { cut.push([k, hostRevokedNow(k)]) } })
    expect(await revokeHostDoorNow('devbox', 'task:t-revoker')).toEqual({ revoked: true, closed: 1, standbySynced: true })
    // The session channel is cut too, on every link (leader-side.ts noteRevoked reads hostRevokedNow).
    expect(cut).toEqual([['devbox', true]])
    expect(await c.closed).toBe(4003)
    expect(synced).toBe(1)
    // Kept with the credential records: no key, who did it and when.
    const rec = (await hostCredentialOf(MACHINE))!
    expect(rec).toMatchObject({ hostKey: 'devbox', revoked: { by: 'task:t-revoker' } })
    expect(rec.verifyKey).toBeUndefined()
    expect(rec.previous).toBeUndefined()
    expect(doorKeysOf(rec)).toEqual([])
    expect(await hostDoorRevoked('devbox')).toMatchObject({ by: 'task:t-revoker' })
    expect((await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })).code).toBe(4004)
    // Still in the config, still linked: still not minted (a revoke is no rotation).
    await expect(mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })).rejects.toBeInstanceOf(HostDoorRevoked)
    // Removing the host is no allow: its mark stays.
    setRevokeStandbySync(async () => null)
    expect(await revokeHostsGone(new Set())).toEqual([])
    expect(await hostDoorRevoked('devbox')).not.toBeNull()
    // A drop of its credential (a rotation, a removal listed before the revoke) keeps the mark (N3).
    expect(await revokeHostCredential(MACHINE)).toBe(false)
    expect(await hostDoorRevoked('devbox')).not.toBeNull()

    expect(await allowHostDoorNow('devbox', 'human')).toEqual({ allowed: true, standbySynced: true })
    expect(rechecked).toEqual(['devbox'])
    expect(cut).toEqual([['devbox', true], ['devbox', false]])
    expect(await hostDoorRevoked('devbox')).toBeNull()
    expect(await hostCredentialOf(MACHINE)).toMatchObject({ allowed: { by: 'human' } })
    const fresh = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    expect(fresh.verifyKey).not.toBe(verifyKey)
    const back = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey: fresh.verifyKey })
    expect(back.welcome).toMatchObject({ op: 'welcome' })
    await vi.waitFor(() => expect(adopted).toHaveLength(2))
    // The old key never comes back.
    expect(doorKeysOf((await hostCredentialOf(MACHINE))!).map((k) => k.verifyKey)).toEqual([fresh.verifyKey])
  })

  it('a revoke made by another process closes the socket at the next recheck', async () => {
    const url = await door(50)
    const { verifyKey } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const c = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })
    await vi.waitFor(() => expect(adopted).toHaveLength(1))
    // Another process wrote the mark: no event reaches this one, the record still holds a key here and there.
    const devices = (await readDeviceRegistry()).devices.map((d) => (d.issuer === 'leader' ? { ...d, revoked: { at: new Date().toISOString(), by: 'human' } } : d))
    await writeAuth(devices)
    _resetDeviceAuthForTesting()
    expect(await c.closed).toBe(4003)
  })

  it('a host with no credential yet: with the switch on, the machine its link names is marked; with it off, nothing is written', async () => {
    setRevokeStandbySync(async () => null)
    setDoorHostHooks({ machineIdOf: () => MACHINE, recheck: () => {} })
    process.env.WALNUT_HOST_RUNS_SESSIONS = '0'
    expect(await revokeHostDoorNow('devbox', 'human')).toEqual({ revoked: false, closed: 0, standbySynced: true })
    expect(await hostCredentialOf(MACHINE)).toBeNull()
    process.env.WALNUT_HOST_RUNS_SESSIONS = '1'
    expect(await revokeHostDoorNow('devbox', 'human')).toEqual({ revoked: true, closed: 0, standbySynced: true })
    expect(await hostCredentialOf(MACHINE)).toMatchObject({ hostKey: 'devbox', kind: 'machine', issuer: 'leader', tokenHash: '', revoked: { by: 'human' } })
    await expect(mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })).rejects.toBeInstanceOf(HostDoorRevoked)
    // A key whose daemon names a machine kept under another key is that machine: the ban is of the
    // machine, so its record is marked (a ban never stops at the name it was made under).
    await mintHostCredential({ machineId: 'b2'.repeat(16), walnutId: WALNUT, hostKey: 'keeper' })
    setDoorHostHooks({ machineIdOf: () => 'b2'.repeat(16), recheck: () => {} })
    expect(await revokeHostDoorNow('stranger', 'human')).toEqual({ revoked: true, closed: 1, standbySynced: true })
    expect(await hostDoorRevoked('keeper')).toMatchObject({ by: 'human', as: 'keeper' })
    // A record of another kind under the machine's name is never a host's to ban.
    await writeAuth([{ name: hostCredentialName('c3'.repeat(16)), id: 'd4444444444444444', tokenHash: sha('x'), createdAt: '2026-09-01T00:00:00.000Z' }])
    _resetDeviceAuthForTesting()
    setDoorHostHooks({ machineIdOf: () => 'c3'.repeat(16), recheck: () => {} })
    expect(await revokeHostDoorNow('other', 'human')).toEqual({ revoked: false, closed: 0, standbySynced: true })
  })

  it('a ban holds under every name of the machine: revoked as one alias, the other\'s door, mint and ban read refused; allowed under either', async () => {
    const url = await door()
    const { verifyKey } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const c = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })
    await vi.waitFor(() => expect(adopted).toHaveLength(1))
    setRevokeStandbySync(async () => null)
    // `devbox-net` is the host-network row of the same daemon: its hello names the same machine.
    const twins: Record<string, string[]> = { devbox: ['devbox-net'], 'devbox-net': ['devbox'] }
    setRevokedHostResolver({ machineOf: (k) => (twins[k] ? MACHINE : null), aliasesOf: (k) => twins[k] ?? [] })
    const cut: string[] = []
    setDoorHostHooks({ machineIdOf: (k) => (twins[k] ? MACHINE : null), recheck: () => {}, cut: (k) => { cut.push(k) } })
    expect(await revokeHostDoorNow('devbox-net', 'human')).toEqual({ revoked: true, closed: 1, standbySynced: true })
    // The machine's one record, issued to `devbox`, is the one marked; its socket closes at once.
    expect(await c.closed).toBe(4003)
    expect(await hostCredentialOf(MACHINE)).toMatchObject({ hostKey: 'devbox', revoked: { by: 'human' } })
    expect(hostRevokedNow('devbox')).toBe(true)
    expect(hostRevokedNow('devbox-net')).toBe(true)
    expect(await hostDoorRevoked('devbox-net')).toMatchObject({ as: 'devbox' })
    await expect(mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })).rejects.toBeInstanceOf(HostDoorRevoked)
    expect((await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })).code).toBe(4004)
    // Allowed under the name it was not issued to: the machine's ban goes.
    expect(await allowHostDoorNow('devbox-net', 'human')).toMatchObject({ allowed: true })
    expect(hostRevokedNow('devbox')).toBe(false)
    expect(hostRevokedNow('devbox-net')).toBe(false)
    expect(cut).toEqual(expect.arrayContaining(['devbox-net', 'devbox']))
    expect((await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })).verifyKey).not.toBe(verifyKey)
  })
})
