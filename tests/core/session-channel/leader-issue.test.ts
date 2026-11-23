/**
 * The leader's issue of a host's door credential (src/core/session-channel/leader-issue.ts), against
 * the host's real credential route over a stream: with the switch off, or no door configured,
 * nothing is asked or sent; on, a host with no credential is issued one (then one standby batch),
 * a host that holds it is left alone, and a changed door list rotates it (the old token still good
 * for its grace); a doors push reaches every known host on its daemon link but the ones skipped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-leader-issue'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { doorKeysOf, hostCredentialOf } from '../../../src/core/session-channel/host-credentials.js'
import { configuredHostKeys, issueOnce, startCredentialIssuer, type IssuerDeps } from '../../../src/core/session-channel/leader-issue.js'
import { answerCredentialRoute, answerDoorsRoute, readHostCredential } from '../../../src/core/session-channel/host-credential-file.js'
import { setMachineIdHomeForTest } from '../../../src/core/machine-id.js'
import { setOutwardDoorChecker } from '../../../src/core/leader/switch/doors.js'

const MACHINE = 'c3'.repeat(16)
const WALNUT = 'feedface'.repeat(4)
const DOOR = 'ws://127.0.0.1:3456/host-door'

let home = ''
let server: http.Server
let port = 0
let posts: Array<Record<string, unknown>> = []

beforeEach(async () => {
  _resetDeviceAuthForTesting()
  await fsp.rm(path.join(WALNUT_HOME, 'auth.json'), { force: true })
  await fsp.rm(path.join(WALNUT_HOME, 'auth.json.bak'), { force: true })
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'leader-issue-host-'))
  setMachineIdHomeForTest(home)
  posts = []
  // The host's route, as host-routes.ts serves it (its credential seam under `home`).
  server = http.createServer((req, res) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(parts).toString() || '{}')
      posts.push(body)
      const answer = req.url === '/host-api/doors' ? answerDoorsRoute : answerCredentialRoute
      const r = await answer(body, { walnutId: WALNUT, machineId: async () => MACHINE })
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(r.body))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as net.AddressInfo).port
})
afterEach(async () => {
  setOutwardDoorChecker(null)
  await new Promise<void>((r) => server.close(() => r()))
  setMachineIdHomeForTest(null)
  await fsp.rm(home, { recursive: true, force: true })
})

function deps(o: { flag?: boolean; doors?: unknown; synced?: { n: number }; configured?: Set<string>; logs?: string[] } = {}): IssuerDeps {
  return {
    walnutId: async () => WALNUT,
    flagOn: async () => o.flag ?? true,
    doorUrls: async () => o.doors ?? [DOOR],
    machineIdOf: () => MACHINE,
    openStream: async () => net.connect(port, '127.0.0.1'),
    standing: () => ({ permitNumber: 0, epoch: 4 }),
    syncStandby: async () => { if (o.synced) o.synced.n++; return null },
    configured: (k) => (o.configured ?? new Set(['devbox', 'twin'])).has(k),
    log: (_l, msg) => { o.logs?.push(msg) },
  }
}

describe('issuing a host its door credential', () => {
  it('with the switch off, or no door configured, nothing is asked or sent', async () => {
    for (const d of [deps({ flag: false }), deps({ doors: [] }), deps({ doors: ['ws://203.0.113.4/host-door'] })]) {
      const issuer = startCredentialIssuer(d)
      issuer.noteHost('devbox', { connected: true, dials: true })
      expect(await issuer.idle('devbox')).toBe('skipped')
      issuer.stop()
    }
    // Nor for a host that does not name the door capability, or is not connected.
    const issuer = startCredentialIssuer(deps())
    issuer.noteHost('devbox', { connected: true, dials: false })
    issuer.noteHost('devbox', { connected: false, dials: true })
    expect(await issuer.idle('devbox')).toBeNull()
    expect(posts).toEqual([])
    expect(await hostCredentialOf(MACHINE)).toBeNull()
  })

  it('issues a host with none, then one standby batch; a host that holds it is left alone; new doors rotate it', async () => {
    const synced = { n: 0 }
    expect(await issueOnce(deps({ synced }), 'devbox', MACHINE, [DOOR])).toBe('issued')
    expect(synced.n).toBe(1)
    const held = await readHostCredential(WALNUT)
    expect(held).toMatchObject({ machineId: MACHINE, doors: [DOOR], permit: { permitNumber: 0, epoch: 4 } })
    expect((await hostCredentialOf(MACHINE))!.verifyKey).toBe(held!.verifyKey)
    expect(JSON.stringify(posts)).not.toContain('token')
    expect(posts.map((p) => (p.check ? 'check' : 'write'))).toEqual(['check', 'write'])

    expect(await issueOnce(deps({ synced }), 'devbox', MACHINE, [DOOR])).toBe('held')
    expect(synced.n).toBe(1)

    const doors = [DOOR, 'wss://leader.example.test/host-door']
    expect(await issueOnce(deps({ synced }), 'devbox', MACHINE, doors)).toBe('issued')
    const now = await readHostCredential(WALNUT)
    expect(now!.doors).toEqual(doors)
    expect(now!.verifyKey).not.toBe(held!.verifyKey)
    // The old key still opens the door, for its grace.
    expect(doorKeysOf((await hostCredentialOf(MACHINE))!).map((k) => [k.which, k.verifyKey])).toEqual([['current', now!.verifyKey], ['previous', held!.verifyKey]])
  })

  it('with the write permission\'s system on, a refusal at the door mints and sends nothing', async () => {
    setOutwardDoorChecker((kind) => { if (kind === 'host-credential') throw new Error('this machine does not hold the write permission') })
    await expect(issueOnce(deps(), 'devbox', MACHINE, [DOOR])).rejects.toThrow(/write permission/)
    expect(await hostCredentialOf(MACHINE)).toBeNull()
    expect(posts.filter((p) => !p.check)).toEqual([])
  })

  it('a doors push tells every known host on its daemon link its new list, but the ones skipped', async () => {
    const issuer = startCredentialIssuer(deps())
    issuer.noteHost('devbox', { connected: true, dials: true })
    expect(await issuer.idle('devbox')).toBe('issued')
    const doors = [DOOR, 'wss://leader.example.test/host-door']
    expect(await issuer.pushDoors(doors, new Set(['devbox']))).toEqual({ told: [], failed: [] })
    expect((await readHostCredential(WALNUT))!.doors).toEqual([DOOR])
    expect(await issuer.pushDoors(doors)).toEqual({ told: ['devbox'], failed: [] })
    expect((await readHostCredential(WALNUT))!.doors).toEqual(doors)
    expect(posts.at(-1)).toMatchObject({ walnutId: WALNUT, machineId: MACHINE, doors, permitNumber: 0, epoch: 4 })
    // A host gone from its link is not told.
    issuer.noteHost('devbox', { connected: false, dials: true })
    expect(await issuer.pushDoors([DOOR])).toEqual({ told: [], failed: [] })
    issuer.stop()
  })

  it('issues only to a host in the config', async () => {
    expect(await issueOnce(deps({ configured: new Set() }), 'devbox', MACHINE, [DOOR])).toBe('skipped')
    expect(posts).toEqual([])
    expect(await hostCredentialOf(MACHINE)).toBeNull()
  })

  it('two host keys reporting one machine id: the credential stays with the first, the second is refused and logged', async () => {
    const logs: string[] = []
    expect(await issueOnce(deps({ logs }), 'devbox', MACHINE, [DOOR])).toBe('issued')
    const first = await hostCredentialOf(MACHINE)
    const before = posts.length
    expect(await issueOnce(deps({ logs }), 'twin', MACHINE, [DOOR])).toBe('refused')
    expect(logs.some((l) => /two hosts report one machine id/.test(l))).toBe(true)
    // Nothing asked of or sent to the second, nothing rotated: no fight between the two.
    expect(posts.length).toBe(before)
    expect(await hostCredentialOf(MACHINE)).toEqual(first)
    expect(await issueOnce(deps({ logs }), 'devbox', MACHINE, [DOOR])).toBe('held')
    expect(await hostCredentialOf(MACHINE)).toEqual(first)
  })

  it('counts as configured only a host that is on and, when found in ~/.ssh/config, has the person\'s yes', () => {
    const keys = configuredHostKeys({
      devbox: { enabled: true },
      plain: {},
      off: { enabled: false },
      'found-asked': { discovered: true, connect: 'ask' },
      'found-not-now': { discovered: true, connect: 'not_now', enabled: false },
      'found-undecided': { discovered: true },
      'found-walnut-yes': { discovered: true, connect: 'yes', connect_by: 'walnut' },
      'found-person-yes': { discovered: true, connect: 'yes' },
      gone: null,
    } as never)
    expect([...keys].sort()).toEqual(['devbox', 'found-person-yes', 'plain'])
  })
})
