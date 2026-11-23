/**
 * Review round 2, X1: after a confirmed host-network move the host was held for up to 15 min.
 * The move awaited its confirm (which leaves the shared walnut-net's list with `net-forget`, an
 * `exec.run` on the link) before it released the hold, and that `exec.run` went through
 * DaemonConnection.send without passing the hold, so it waited for the release that waited for it.
 *
 * What's real: DaemonConnection.send and its hold (service-set-hold.ts), the link's own SetLinkConn
 * (its `run` over the host network: daemon-net-update-io.ts), ServiceSetLink and runMove, the kept
 * records. What's faked: the wire (sendAdmitted answers), the redial, this leader's network side.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { ServiceSetLink, type SetLinkConn } from '../../src/providers/service-set-move-link.js'
import { hostServiceSets, recordServiceSetFrom } from '../../src/providers/service-set-leader.js'
import { serviceSetMoves } from '../../src/providers/service-set-move.js'
import type { SetHold } from '../../src/providers/service-set-hold.js'

const WALNUT = '0123456789abcdef0123456789abcdef'
const SET = '0123456789abcdef'
const ME = 'e'.repeat(64)
const SHARED = 'd'.repeat(64)
const SET_EP = 'a'.repeat(64)
const late = (ms: number) => new Promise<'late'>((r) => { setTimeout(() => r('late'), ms).unref?.() })

type Internals = {
  serviceSetLink: ServiceSetLink & { c: SetLinkConn }
  _setHold: SetHold
  _connected: boolean
  _helloServiceSet: string
  sendAdmitted: (cmd: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
  relinkForServiceSet: (ms: number) => Promise<string | null>
}

describe('X1: the hold ends right after the move is done, and the set\'s CLI line passes the hold', () => {
  let dir = ''
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-release-'))
    for (const k of ['WALNUT_HOST_SERVICE_SETS', 'WALNUT_SERVICE_SET_FILE', 'WALNUT_SERVICE_SET_MOVE_FILE']) saved[k] = process.env[k]
    process.env.WALNUT_HOST_SERVICE_SETS = '1'
    process.env.WALNUT_SERVICE_SET_FILE = path.join(dir, 'sets.json')
    process.env.WALNUT_SERVICE_SET_MOVE_FILE = path.join(dir, 'moves.json')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A host-network DaemonConnection with the real hold; the wire answers each command. */
  function netConn() {
    vi.spyOn(DaemonConnection.prototype, 'linkKind', 'get').mockReturnValue('net')
    const conn = new DaemonConnection('devbox', null)
    const x = conn as unknown as Internals
    x._connected = true
    // A shared daemon that keeps one trigger set per Walnut (the move gives up on an older one).
    vi.spyOn(conn, 'hasCapability').mockImplementation((cap: string) => cap === 'walnut-scope-v1')
    const wire: string[] = []
    vi.spyOn(x, 'sendAdmitted').mockImplementation(async (cmd, params) => {
      if (cmd !== 'exec.run') { wire.push(cmd); return { ok: true, status: { state: 'off' } } }
      const line = String((params.argv as string[] | undefined)?.[2] ?? params.command ?? '')
      const words = /walnut daemon (net-id|net-forget)/.exec(line)?.[1] ?? 'other'
      wire.push(`exec.run:${words}`)
      const output = words === 'net-id'
        ? `service set: ${SET}\n{"ok":true,"endpointId":"${SET_EP}","addrs":["10.0.0.5:41641"]}\n`
        : '{"ok":true,"changed":true}\n'
      return { ok: true, exitCode: 0, output }
    })
    vi.spyOn(x, 'relinkForServiceSet').mockImplementation(async () => { wire.push('relink'); x._helloServiceSet = SET; return SET })
    return { conn, x, wire }
  }

  it('the set\'s CLI line (exec.run over the host network) is the move\'s own command: it goes while the host is held', async () => {
    const { x, wire } = netConn()
    const c = x.serviceSetLink.c
    x._setHold.set(true)
    expect(await Promise.race([c.run('walnut daemon net-forget --member x', 5_000), late(3_000)])).not.toBe('late')
    expect(wire).toEqual(['exec.run:net-forget'])
    x._setHold.set(false)
  })

  it('a confirmed net move releases the held work before it leaves the shared walnut-net\'s list, and never waits on its own hold', async () => {
    const { x, wire } = netConn()
    const real = x.serviceSetLink.c
    // The link as DaemonConnection builds it, with only this leader's id, notices and redelivery replaced.
    const c: SetLinkConn = Object.create(real, {
      walnutId: { value: async () => WALNUT },
      sharedEndpoint: { value: () => SHARED },
      notice: { value: () => {} },
      setHold: { value: (on: boolean) => { wire.push(on ? 'hold' : 'release'); real.setHold(on) } },
      redeliver: { value: () => {} },
      home: { value: '/home/u/.open-walnut' },
    })
    const link = new ServiceSetLink(c, {
      sessions: async () => [],
      openWork: async () => null,
      stopFollower: async () => { wire.push('follower-off') },
      dropScope: async () => { wire.push('drop-scope') },
      endpointId: async () => ME,
      net: {
        list: () => ({ relayMode: 'public', relays: [], relayRoots: [], members: [{ id: ME, name: 'mac', accept: true }] }),
        register: async () => {}, unregister: async () => {}, apply: async () => {},
      },
      sleep: async () => {},
      settleMs: 0,
    }, () => 'walnut-daemon-abc')
    await recordServiceSetFrom('net:devbox', `service set: ${SET}`)
    const record = (await hostServiceSets.read('net:devbox'))!
    const move = (link as unknown as { move: (r: typeof record, force: boolean) => Promise<{ result: string }> }).move(record, true)
    const out = await Promise.race([move, late(8_000)])
    expect(out).not.toBe('late')
    expect(out).toMatchObject({ result: 'moved' })
    expect(x._setHold.on).toBe(false)
    expect((await serviceSetMoves.read('net:devbox'))?.phase).toBe('done')
    // Released right after the done record, then the shared list is left (it never waits for the hold).
    const release = wire.indexOf('release')
    expect(release).toBeGreaterThan(wire.indexOf('relink'))
    expect(wire.indexOf('exec.run:net-forget')).toBeGreaterThan(release)
    expect((await hostServiceSets.read('net:devbox'))?.netSharedLeftAt).toBeTypeOf('number')
  }, 20_000)
})
