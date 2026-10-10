/**
 * A host server's copy of the Mac's signed-in devices (src/host-server/device-copy.ts)
 * and the Mac's side that sends it (src/core/replication/device-replica.ts):
 * token hashes only, the whole list each time, checked in constant time, kept on
 * disk across a restart; the Mac sends it to host servers only, again only when
 * it changed, backs off from an older host server, and never sends a list it
 * could not read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDeviceCopy } from '../../src/host-server/device-copy.js'
import {
  syncDeviceReplica, deviceListHash, _resetDeviceReplicaForTesting, type DeviceReplicaDeps,
} from '../../src/core/replication/device-replica.js'
import type { ReplicaTarget } from '../../src/core/replication/replica-targets.js'
import type { CloudReplicaReply } from '../../src/core/cloud-ingest.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const PHONE = { name: 'phone-1', tokenHash: sha('phone-token') }
const BROWSER = { name: 'browser-a1b2c3', tokenHash: sha('browser-token') }

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devcopy-')); _resetDeviceReplicaForTesting() })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('the host server\'s device copy', () => {
  it('holds nothing until the Mac sends a list, then knows those tokens only', () => {
    const copy = createDeviceCopy(path.join(dir, 'replica', 'devices.json'))
    expect(copy.held()).toBe(false)
    expect(copy.verify('phone-token')).toBeNull()
    const r = copy.put({ devices: [PHONE, BROWSER] })
    expect(r).toEqual({ ok: true, hash: deviceListHash([PHONE, BROWSER]), devices: 2 })
    expect(copy.verify('phone-token')).toBe('phone-1')
    expect(copy.verify('browser-token')).toBe('browser-a1b2c3')
    expect(copy.verify('other')).toBeNull()
    expect(copy.verify('')).toBeNull()
  })

  it('keeps the list across a restart, file readable by its owner only', () => {
    const file = path.join(dir, 'replica', 'devices.json')
    createDeviceCopy(file).put({ devices: [PHONE] })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')))).not.toContain('phone-token')
    const again = createDeviceCopy(file)
    expect(again.held()).toBe(true)
    expect(again.verify('phone-token')).toBe('phone-1')
  })

  it('a new list replaces the old one: a removed device is gone', () => {
    const copy = createDeviceCopy(path.join(dir, 'devices.json'))
    copy.put({ devices: [PHONE, BROWSER] })
    copy.put({ devices: [BROWSER] })
    expect(copy.verify('phone-token')).toBeNull()
    expect(copy.verify('browser-token')).toBe('browser-a1b2c3')
    // An empty list is a list: nobody is signed in.
    copy.put({ devices: [] })
    expect(copy.held()).toBe(true)
    expect(copy.verify('browser-token')).toBeNull()
  })

  it('refuses a malformed list and keeps the one it has', () => {
    const copy = createDeviceCopy(path.join(dir, 'devices.json'))
    copy.put({ devices: [PHONE] })
    for (const devices of [undefined, 'x', [{ name: 'a', tokenHash: 'short' }], [{ name: '', tokenHash: PHONE.tokenHash }], [{ name: 'x'.repeat(65), tokenHash: PHONE.tokenHash }], new Array(501).fill(PHONE)]) {
      expect(copy.put({ devices })).toMatchObject({ ok: false, status: 400 })
    }
    expect(copy.verify('phone-token')).toBe('phone-1')
  })

  it('a corrupt file reads as no list', () => {
    const file = path.join(dir, 'devices.json')
    fs.writeFileSync(file, '{not json')
    expect(createDeviceCopy(file).held()).toBe(false)
  })
})

function target(id: string, kind: 'host' | 'companion', answer: (payload: Record<string, unknown>) => CloudReplicaReply, available = true) {
  const posts: Array<Record<string, unknown>> = []
  const t: ReplicaTarget = {
    id, kind, label: id,
    available: async () => available,
    post: async (payload) => { posts.push(payload); return answer(payload) },
  }
  return { t, posts }
}

const takes = (copy: ReturnType<typeof createDeviceCopy>) => (p: Record<string, unknown>): CloudReplicaReply => {
  const r = copy.put(p)
  return { ok: true, reply: r.ok ? { ok: true, hash: r.hash, devices: r.devices } : { ok: false, error: r.error } }
}

describe('the Mac\'s device rounds', () => {
  it('sends host servers the list, never the companion, and again only when it changed', async () => {
    const copy = createDeviceCopy(path.join(dir, 'devices.json'))
    const host = target('host:devbox', 'host', takes(copy))
    const companion = target('companion', 'companion', () => ({ ok: true, reply: { ok: true } }))
    let devices = [PHONE]
    const deps: DeviceReplicaDeps = { devices: async () => devices, targets: () => [companion.t, host.t] }
    expect(await syncDeviceReplica(deps)).toEqual([{ target: 'host:devbox', action: 'synced', devices: 1 }])
    expect(host.posts).toEqual([{ op: 'put', kind: 'devices', devices: [PHONE], hash: deviceListHash([PHONE]) }])
    expect(companion.posts).toHaveLength(0)
    expect(copy.verify('phone-token')).toBe('phone-1')
    expect((await syncDeviceReplica(deps))[0].action).toBe('unchanged')
    devices = [PHONE, BROWSER]
    expect((await syncDeviceReplica(deps))[0].action).toBe('synced')
    expect(copy.verify('browser-token')).toBe('browser-a1b2c3')
    expect(host.posts).toHaveLength(2)
  })

  it('never sends a list it could not read', async () => {
    const host = target('host:devbox', 'host', () => ({ ok: true, reply: { ok: true } }))
    expect(await syncDeviceReplica({ devices: async () => null, targets: () => [host.t] })).toEqual([{ target: 'host:devbox', action: 'skipped' }])
    expect(host.posts).toHaveLength(0)
  })

  it('an older host server (400) is asked again only much later; a host that is not running is skipped', async () => {
    const old = target('host:oldbox', 'host', () => ({ ok: false, outcome: 'failed', status: 400, error: 'not_a_replica' }))
    const down = target('host:downbox', 'host', () => ({ ok: true, reply: { ok: true } }), false)
    const deps: DeviceReplicaDeps = { devices: async () => [PHONE], targets: () => [old.t, down.t] }
    expect(await syncDeviceReplica(deps)).toEqual([
      { target: 'host:oldbox', action: 'unsupported' },
      { target: 'host:downbox', action: 'skipped' },
    ])
    expect((await syncDeviceReplica(deps))[0]).toEqual({ target: 'host:oldbox', action: 'skipped' })
    expect(old.posts).toHaveLength(1)
    expect(down.posts).toHaveLength(0)
  })

  it('a host server that answered with another list is sent it again', async () => {
    let wrong = true
    const host = target('host:devbox', 'host', (p) => ({ ok: true, reply: { ok: true, hash: wrong ? 'other' : p.hash } }))
    const deps: DeviceReplicaDeps = { devices: async () => [PHONE], targets: () => [host.t] }
    expect((await syncDeviceReplica(deps))[0].action).toBe('failed')
    wrong = false
    _resetDeviceReplicaForTesting()
    expect((await syncDeviceReplica(deps))[0].action).toBe('synced')
  })
})
