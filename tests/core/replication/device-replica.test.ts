/**
 * The device copy rows gain a stable id (the Mac's record id), the list hash
 * stays over `name:tokenHash` so an older host server still agrees with a newer
 * Mac, and a round reaches every host at once when a device is paired or gets a
 * new QR (docs/plan/walnut-replica-servers-impl.md, section 1, auth; WP1).
 *
 * The pairing half runs on the real device store (auth.json in this test's
 * own data dir, a fresh temp dir per run: the default test home is shared by
 * every run on the machine), not a stub of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-devrep'))

import { createDeviceCopy } from '../../../src/host-server/device-copy.js'
import {
  _resetDeviceReplicaForTesting, deviceListHash, deviceReplicaEntry, startDeviceReplicaSync, type DeviceReplicaEntry,
} from '../../../src/core/replication/device-replica.js'
import type { ReplicaTarget } from '../../../src/core/replication/replica-targets.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
/** The hash an older host server computes (host-server/device-copy.ts before ids). */
const oldHash = (rows: Array<{ name: string; tokenHash: string }>) => sha(rows.map((d) => `${d.name}:${d.tokenHash}`).sort().join('\n')).slice(0, 16)
const PHONE = { id: 'd0123456789abcdef', name: 'marina-phone', tokenHash: sha('phone-token') }
const BROWSER = { name: 'browser-acme', tokenHash: sha('browser-token') }

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devrep-')); _resetDeviceReplicaForTesting() })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('device copy rows with a stable id', () => {
  it('the list hash ignores the id and equals the old formula', () => {
    expect(deviceListHash([PHONE, BROWSER])).toBe(oldHash([PHONE, BROWSER]))
    expect(deviceListHash([PHONE])).toBe(deviceListHash([{ name: PHONE.name, tokenHash: PHONE.tokenHash }]))
  })

  it('the copy keeps the id, answers it with the device, and still takes rows without one', () => {
    const file = path.join(dir, 'replica', 'devices.json')
    const copy = createDeviceCopy(file)
    expect(copy.put({ devices: [PHONE, BROWSER] })).toEqual({ ok: true, hash: oldHash([PHONE, BROWSER]), devices: 2 })
    expect(copy.verifyDevice('phone-token')).toEqual({ name: 'marina-phone', id: PHONE.id })
    expect(copy.verifyDevice('browser-token')).toEqual({ name: 'browser-acme', id: null })
    expect(copy.verify('phone-token')).toBe('marina-phone')
    // Kept across a restart, id included.
    expect(createDeviceCopy(file).verifyDevice('phone-token')).toEqual({ name: 'marina-phone', id: PHONE.id })
  })

  it('a list resent with ids it lacked (same hash) is written with them', () => {
    const file = path.join(dir, 'replica', 'devices.json')
    const copy = createDeviceCopy(file)
    copy.put({ devices: [{ name: PHONE.name, tokenHash: PHONE.tokenHash }] })
    expect(copy.verifyDevice('phone-token')?.id).toBeNull()
    const r = copy.put({ devices: [PHONE] })
    expect(r.ok && r.hash).toBe(oldHash([PHONE]))
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).devices).toEqual([PHONE])
    expect(copy.verifyDevice('phone-token')?.id).toBe(PHONE.id)
  })

  it('a malformed id drops from its row only: the list is taken, the device and its revokes still land', () => {
    const file = path.join(dir, 'replica', 'devices.json')
    const copy = createDeviceCopy(file)
    copy.put({ devices: [BROWSER, PHONE] })
    for (const id of ['', 'has space', 'x'.repeat(81), 7, null, '\u00e9t\u00e9']) {
      // The browser was revoked on the Mac in the same round: it must leave the copy.
      expect(copy.put({ devices: [{ ...PHONE, id }] })).toEqual({ ok: true, hash: oldHash([PHONE]), devices: 1 })
      expect(copy.verifyDevice('phone-token')).toEqual({ name: PHONE.name, id: null })
      expect(copy.verify('browser-token')).toBeNull()
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).devices).toEqual([{ name: PHONE.name, tokenHash: PHONE.tokenHash }])
      copy.put({ devices: [BROWSER, PHONE] })
    }
  })

  it('the Mac sends a record id only when the copy can keep it', () => {
    expect(deviceReplicaEntry({ id: PHONE.id, name: PHONE.name, tokenHash: PHONE.tokenHash })).toEqual(PHONE)
    for (const id of [undefined, '', 'has space', 'x'.repeat(81), 7, { a: 1 }]) {
      expect(deviceReplicaEntry({ id, name: PHONE.name, tokenHash: PHONE.tokenHash })).toEqual({ name: PHONE.name, tokenHash: PHONE.tokenHash })
    }
  })
})

describe('a round on pairing (create and rotate)', () => {
  /** A host target that keeps every list it was sent. */
  function hostTarget(sent: Array<{ devices: DeviceReplicaEntry[]; hash: string }>): ReplicaTarget {
    return {
      id: 'host:marina', kind: 'host', label: 'marina', available: async () => true,
      post: async (body) => {
        const b = body as { devices: DeviceReplicaEntry[]; hash: string }
        sent.push({ devices: b.devices, hash: b.hash })
        return { ok: true, status: 200, reply: { ok: true, hash: b.hash } } as never
      },
    }
  }

  async function until(fn: () => boolean, ms: number): Promise<void> {
    const end = Date.now() + ms
    while (!fn()) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it('a new device and a new QR each reach the host within a second, with the record id', async () => {
    expect(WALNUT_HOME).not.toBe(path.join(os.homedir(), '.open-walnut'))
    const auth = await import('../../../src/core/device-auth.js')
    auth._resetDeviceAuthForTesting()
    const sent: Array<{ devices: DeviceReplicaEntry[]; hash: string }> = []
    const target = hostTarget(sent)
    const sync = startDeviceReplicaSync({
      targets: () => [target],
      devices: async () => (await auth.listDeviceRecords()).filter((r) => r.kind !== 'machine')
        .map((r) => ({ id: r.id, name: r.name, tokenHash: r.tokenHash })),
    })
    try {
      // The listeners are wired after a dynamic import: let it land.
      await new Promise((r) => setTimeout(r, 300))
      const created = await auth.createDevice('marina-phone')
      await until(() => sent.some((s) => s.devices.some((d) => d.name === 'marina-phone')), 1_500)
      const first = sent.at(-1)!
      const row = first.devices.find((d) => d.name === 'marina-phone')!
      expect(row.tokenHash).toBe(sha(created.token))
      const id = (await auth.listDeviceRecords()).find((r) => r.name === 'marina-phone')!.id
      expect(row.id).toBe(id)
      expect(first.hash).toBe(oldHash(first.devices))

      const before = sent.length
      const rotated = await auth.rotateDevice('marina-phone', { by: { local: true } })
      await until(() => sent.length > before && sent.at(-1)!.devices.some((d) => d.tokenHash === sha(rotated.token)), 1_500)
      expect(sent.at(-1)!.devices.some((d) => d.tokenHash === sha(created.token))).toBe(false)
    } finally {
      sync.stop()
      fs.rmSync(path.join(WALNUT_HOME, 'auth.json'), { force: true })
      auth._resetDeviceAuthForTesting()
    }
  })

  /** A sync over the real store whose target keeps what it was sent; `run` pairs something. */
  async function pairingReaches(run: (auth: typeof import('../../../src/core/device-auth.js')) => Promise<string>): Promise<void> {
    const auth = await import('../../../src/core/device-auth.js')
    auth._resetDeviceAuthForTesting()
    const sent: Array<{ devices: DeviceReplicaEntry[]; hash: string }> = []
    const sync = startDeviceReplicaSync({
      targets: () => [hostTarget(sent)],
      devices: async () => (await auth.listDeviceRecords()).filter((r) => r.kind !== 'machine')
        .map((r) => ({ id: r.id, name: r.name, tokenHash: r.tokenHash })),
    })
    try {
      await new Promise((r) => setTimeout(r, 300))
      const tokenHash = await run(auth)
      // The first round is 10 s after start and the tick 30 s: only the pairing's own round lands this soon.
      await until(() => sent.some((s) => s.devices.some((d) => d.tokenHash === tokenHash)), 1_500)
    } finally {
      sync.stop()
      fs.rmSync(path.join(WALNUT_HOME, 'auth.json'), { force: true })
      auth._resetDeviceAuthForTesting()
    }
  }

  it('a new QR for a name with no pairing yet (nothing revoked) reaches the host within a second', async () => {
    await pairingReaches(async (auth) => sha((await auth.rotateDevice('marina-tablet', { by: { local: true } })).token))
  })

  it('a pairing adopted from another box reaches the host within a second', async () => {
    const tokenHash = sha('adopted-phone-token')
    await pairingReaches(async () => {
      const { adoptDeviceRecord } = await import('../../../src/core/device-adoption.js')
      expect(await adoptDeviceRecord({ name: 'acme-phone', tokenHash, adoptedFrom: 'cloud' })).toMatchObject({ adopted: true })
      return tokenHash
    })
  })
})

describe('stop()', () => {
  it('a rerun queued before stop() never posts after it', async () => {
    const posts: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    let n = 0
    const deps = {
      // A new list each read, so a rerun would post again.
      devices: async () => [{ name: `acme-${++n}`, tokenHash: sha(`t${n}`) }],
      targets: (): ReplicaTarget[] => [{
        id: 'host:marina', kind: 'host', label: 'marina', available: async () => true,
        post: async (body) => {
          const b = body as { hash: string }
          posts.push(b.hash)
          await gate
          return { ok: true, status: 200, reply: { ok: true, hash: b.hash } } as never
        },
      }],
    }
    const sync = startDeviceReplicaSync(deps)
    const { syncDeviceReplica } = await import('../../../src/core/replication/device-replica.js')
    const first = syncDeviceReplica(deps)
    while (posts.length === 0) await new Promise((r) => setTimeout(r, 10))
    void syncDeviceReplica(deps) // queued: the round is running
    sync.stop()
    release()
    await first
    await new Promise((r) => setTimeout(r, 200))
    expect(posts).toHaveLength(1)
  })
})
