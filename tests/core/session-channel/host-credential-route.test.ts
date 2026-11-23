/**
 * The host's door credential route (`POST /host-api/credential`, host-routes.ts and
 * host-credential-file.ts), on the leader door the way the Mac's streams reach it: refused for
 * another Walnut or another machine (nothing written), written 0600 in a 0700 dir beside the
 * machine id (the machine-id home seam moves both), answered by a check with the hash of what is
 * held, and never reachable through the call frames of a host-dialed link (routes.call). The doors
 * route keeps a new door list only from a standing not below the one held; the minting's host half
 * (writeHostCredentialFile) refuses another machine whoever calls it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createLeaderDoor, type LeaderDoor } from '../../../src/replica/leader-door.js'
import { createHostSessionRoutes, type HostSessionRoutes } from '../../../src/core/session-channel/host-routes.js'
import { StartBundles } from '../../../src/core/session-channel/host-port.js'
import { setMachineIdHomeForTest, readMachineId } from '../../../src/core/machine-id.js'
import { hostCredentialFile, readHostCredential, writeHostCredentialFile, type HostCredential } from '../../../src/core/session-channel/host-credential-file.js'
import { doorKeyId } from '../../../src/core/session-channel/door-wire.js'

const WALNUT = '0123456789abcdef'.repeat(2)
let home = ''
let door: LeaderDoor
let server: net.Server
let port = 0
let routes: HostSessionRoutes
let issued: HostCredential[] = []

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-cred-route-'))
  setMachineIdHomeForTest(home)
  issued = []
  seen = null
  routes = createHostSessionRoutes({
    enabled: async () => true, runner: async () => ({}) as never, bundles: new StartBundles(), channel: () => null,
    emit: () => {}, enqueue: async () => {}, spillDir: path.join(home, 'prompts'),
    credential: { walnutId: WALNUT, seenPermit: () => seen, onIssued: (c) => { issued.push(c) } },
  })
  door = createLeaderDoor({ devices: {} as never, sessions: () => routes })
  server = net.createServer((sock) => door.accept(sock))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as net.AddressInfo).port
})
afterEach(async () => {
  routes.close()
  await door.close()
  await new Promise<void>((r) => server.close(() => r()))
  setMachineIdHomeForTest(null)
  await fsp.rm(home, { recursive: true, force: true })
})

async function post(body: unknown, route = '/host-api/credential'): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() as Record<string, unknown> }
}

const KEY = 'bb'.repeat(32)
const DOORS = ['ws://127.0.0.1:3456/host-door', 'wss://leader.example.test/host-door']
let seen: { permitNumber: number; epoch: number } | null = null

describe('POST /host-api/credential', () => {
  it('refuses another Walnut and another machine, and writes nothing', async () => {
    const me = await readMachineId()
    expect(await post({ walnutId: 'f'.repeat(32), machineId: me, verifyKey: KEY, doors: DOORS, permitNumber: 0, epoch: 1 }))
      .toEqual({ status: 403, body: { ok: false, error: 'walnut_mismatch' } })
    expect(await post({ walnutId: WALNUT, machineId: 'e'.repeat(32), verifyKey: KEY, doors: DOORS, permitNumber: 0, epoch: 1 }))
      .toEqual({ status: 403, body: { ok: false, error: 'machine_mismatch' } })
    expect(fs.existsSync(hostCredentialFile(WALNUT))).toBe(false)
    expect(issued).toHaveLength(0)
  })

  it('refuses a door that is plain ws:// to a public address, and a secret of the wrong shape', async () => {
    const me = await readMachineId()
    expect((await post({ walnutId: WALNUT, machineId: me, verifyKey: KEY, doors: ['ws://203.0.113.9/host-door'], permitNumber: 0, epoch: 1 })).body.error).toBe('bad_door')
    expect((await post({ walnutId: WALNUT, machineId: me, verifyKey: 'short', doors: DOORS, permitNumber: 0, epoch: 1 })).body.error).toBe('bad_secret')
    expect(fs.existsSync(hostCredentialFile(WALNUT))).toBe(false)
  })

  it('writes the credential 0600 in a 0700 dir beside the machine id, and a check answers its hash', async () => {
    const me = await readMachineId()
    expect(await post({ walnutId: WALNUT, machineId: me, check: true })).toEqual({ status: 200, body: { ok: true, holds: false } })
    expect(await post({ walnutId: WALNUT, machineId: me, verifyKey: KEY, doors: DOORS, permitNumber: 2, epoch: 7 })).toEqual({ status: 200, body: { ok: true } })
    const file = hostCredentialFile(WALNUT)
    expect(path.dirname(path.dirname(file))).toBe(path.join(home, '.local', 'state', 'open-walnut'))
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(await readHostCredential(WALNUT)).toMatchObject({ walnutId: WALNUT, machineId: me, verifyKey: KEY, doors: DOORS, permit: { permitNumber: 2, epoch: 7 } })
    expect(issued).toHaveLength(1)
    const check = await post({ walnutId: WALNUT, machineId: me, check: true })
    expect(check.body).toMatchObject({ ok: true, holds: true, keyId: doorKeyId(KEY), doors: DOORS })
    // The answer never carries the key.
    expect(JSON.stringify(check.body)).not.toContain(KEY)
    // No temp file is left beside it.
    expect(fs.readdirSync(path.dirname(file))).toEqual([`${WALNUT}.json`])
  })

  it('is never reachable through a host-dialed link\'s call frames', async () => {
    const me = await readMachineId()
    const r = await routes.call('POST', '/host-api/credential', { walnutId: WALNUT, machineId: me, verifyKey: KEY, doors: DOORS, permitNumber: 0, epoch: 1 })
    expect(r.status).toBe(404)
    expect(fs.existsSync(hostCredentialFile(WALNUT))).toBe(false)
  })

  it('POST /host-api/doors keeps a new list only from a standing not below the one held', async () => {
    const me = await readMachineId()
    const doors = (d: string[], permitNumber: number, epoch: number) => post({ walnutId: WALNUT, machineId: me, doors: d, permitNumber, epoch }, '/host-api/doors')
    expect(await doors(DOORS, 0, 1)).toEqual({ status: 409, body: { ok: false, error: 'no_credential' } })
    await post({ walnutId: WALNUT, machineId: me, verifyKey: KEY, doors: [DOORS[0]], permitNumber: 2, epoch: 7 })
    expect(await doors(DOORS, 2, 6)).toEqual({ status: 409, body: { ok: false, error: 'stale_permit' } })
    expect(await doors(['ws://203.0.113.9/host-door'], 2, 7)).toEqual({ status: 400, body: { ok: false, error: 'bad_doors' } })
    expect((await post({ walnutId: 'f'.repeat(32), machineId: me, doors: DOORS, permitNumber: 9, epoch: 9 }, '/host-api/doors')).status).toBe(403)
    expect((await readHostCredential(WALNUT))!.doors).toEqual([DOORS[0]])
    expect(await doors(DOORS, 2, 7)).toEqual({ status: 200, body: { ok: true, updated: true } })
    expect(await readHostCredential(WALNUT)).toMatchObject({ doors: DOORS, permit: { permitNumber: 2, epoch: 7 } })
    expect(await doors(DOORS, 3, 0)).toEqual({ status: 200, body: { ok: true, updated: false } })
    expect((await readHostCredential(WALNUT))!.permit).toEqual({ permitNumber: 3, epoch: 0 })
    expect((await routes.call('POST', '/host-api/doors', { walnutId: WALNUT, machineId: me, doors: DOORS, permitNumber: 9, epoch: 9 })).status).toBe(404)
  })

  it('writeHostCredentialFile refuses another machine and a bad secret, and writes 0600', async () => {
    const me = await readMachineId()
    const input = { walnutId: WALNUT, machineId: me, verifyKey: KEY, doors: DOORS, permitNumber: 0, epoch: 1 }
    expect(await writeHostCredentialFile({ ...input, machineId: 'e'.repeat(32) })).toEqual({ ok: false, error: 'machine_mismatch' })
    expect(await writeHostCredentialFile({ ...input, verifyKey: 'nope' })).toEqual({ ok: false, error: 'bad_secret' })
    expect(await writeHostCredentialFile({ ...input, token: 'aa'.repeat(32) } as typeof input)).toMatchObject({ ok: true })
    // No bearer is ever kept, whatever a caller passes.
    expect(fs.readFileSync(hostCredentialFile(WALNUT), 'utf8')).not.toContain('token')
    fs.rmSync(hostCredentialFile(WALNUT))
    expect(fs.existsSync(hostCredentialFile(WALNUT))).toBe(false)
    const w = await writeHostCredentialFile(input)
    expect(w).toMatchObject({ ok: true, credential: { machineId: me, doors: DOORS } })
    expect(fs.statSync(hostCredentialFile(WALNUT)).mode & 0o777).toBe(0o600)
  })

  it('refuses a credential write below the highest standing the host holds (its credential\'s, its fact log\'s), the file unchanged', async () => {
    const me = await readMachineId()
    const write = (verifyKey: string, permitNumber: number, epoch: number) => post({ walnutId: WALNUT, machineId: me, verifyKey, doors: DOORS, permitNumber, epoch })
    expect(await write(KEY, 2, 7)).toEqual({ status: 200, body: { ok: true } })
    // A stale leader (a lower pair) cannot replace the newer one's credential.
    expect(await write('cc'.repeat(32), 2, 6)).toEqual({ status: 409, body: { ok: false, error: 'stale_permit' } })
    expect(await write('cc'.repeat(32), 1, 99)).toEqual({ status: 409, body: { ok: false, error: 'stale_permit' } })
    expect((await readHostCredential(WALNUT))!.verifyKey).toBe(KEY)
    // The fact log saw (3, 0): a write at (2, 9) is below it too.
    seen = { permitNumber: 3, epoch: 0 }
    expect(await write('cc'.repeat(32), 2, 9)).toEqual({ status: 409, body: { ok: false, error: 'stale_permit' } })
    expect((await readHostCredential(WALNUT))!.verifyKey).toBe(KEY)
    expect(await write('cc'.repeat(32), 3, 0)).toEqual({ status: 200, body: { ok: true } })
    expect((await readHostCredential(WALNUT))!.verifyKey).toBe('cc'.repeat(32))
    expect(issued).toHaveLength(2)
  })
})
