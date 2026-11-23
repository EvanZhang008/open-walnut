/**
 * Leaving a host with a service set of this Walnut's own (review round 2, N1 and N2): the order of the
 * set's net pairing against the cloud companion's member list, and what a Remove of the host clears.
 *
 *  - pairing keeps the set's endpoint on the host's record BEFORE the companion lists it (a sync in
 *    between would take an unknown host member for a machine and give it a host row), and takes the
 *    record back when the companion refuses;
 *  - leaving unregisters at the companion BEFORE the record goes, keeps the record when that fails
 *    (the next sync tries again), and then drops the whole record, so this leader's walnut-net stops
 *    dialling the endpoint;
 *  - ServiceSetLink.leave removes this Walnut's own set from the host, bounded, then forgets it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { forgetSetNet, pairServiceSetNet, type NetPairDeps } from '../../src/providers/service-set-net-pair.js'
import { hostServiceSets, serviceSetNetMembers } from '../../src/providers/service-set-leader.js'
import { serviceSetMoves } from '../../src/providers/service-set-move.js'
import { ServiceSetLink, type SetLinkConn } from '../../src/providers/service-set-move-link.js'

const WALNUT = '0123456789abcdef0123456789abcdef'
const SET = '0123456789abcdef'
const SET_EP = 'a'.repeat(64)
const SHARED = 'd'.repeat(64)
const ask = { walnutId: WALNUT, home: '/home/u/.open-walnut' }

let dir = ''
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-leave-'))
  for (const k of ['WALNUT_HOST_SERVICE_SETS', 'WALNUT_SERVICE_SET_FILE', 'WALNUT_SERVICE_SET_MOVE_FILE']) saved[k] = process.env[k]
  process.env.WALNUT_HOST_SERVICE_SETS = '1'
  process.env.WALNUT_SERVICE_SET_FILE = path.join(dir, 'sets.json')
  process.env.WALNUT_SERVICE_SET_MOVE_FILE = path.join(dir, 'moves.json')
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  fs.rmSync(dir, { recursive: true, force: true })
})

function pairDeps(calls: string[], o: { register?: () => Promise<void> } = {}): NetPairDeps {
  return {
    place: 'net:box', set: SET, ask, shared: SHARED,
    runSetCli: async () => `service set: ${SET}\n{"ok":true,"endpointId":"${SET_EP}","addrs":["10.0.0.5:41641"]}`,
    list: () => ({ members: [{ id: 'e'.repeat(64), name: 'mac', accept: true }] }),
    register: async () => {
      // What a sync running right now would read: the record must already name the endpoint.
      calls.push(`register:${(await hostServiceSets.read('net:box'))?.netEndpoint === SET_EP ? 'recorded' : 'unrecorded'}`)
      await o.register?.()
    },
    unregister: async () => { calls.push('unregister') },
    apply: async () => { calls.push('apply') },
  }
}

describe('N2: the set\'s pairing and the companion\'s list, in order', () => {
  it('(a) pairing keeps the endpoint on the host\'s record before the companion lists it', async () => {
    await hostServiceSets.write('net:box', { at: Date.now(), set: SET })
    const calls: string[] = []
    await pairServiceSetNet(pairDeps(calls))
    expect(calls).toEqual(['register:recorded', 'apply'])
  })

  it('(a) a companion that refuses the endpoint: the record is put back as it was, nothing applied', async () => {
    await hostServiceSets.write('net:box', { at: Date.now(), set: SET })
    const calls: string[] = []
    await expect(pairServiceSetNet(pairDeps(calls, { register: async () => { throw new Error('companion said 500') } }))).rejects.toThrow(/500/)
    expect(calls).toEqual(['register:recorded'])
    const r = await hostServiceSets.read('net:box')
    expect(r?.set).toBe(SET)
    expect(r).not.toHaveProperty('netEndpoint')
    expect((await serviceSetNetMembers()).add).toEqual([])
  })

  it('(b) leaving unregisters while the record still names the endpoint, and keeps it when the companion did not forget it', async () => {
    await hostServiceSets.write('net:box', { at: Date.now(), set: SET, netEndpoint: SET_EP, netAddrs: [] })
    const seen: string[] = []
    const failing = {
      place: 'net:box',
      unregister: async () => { seen.push(`unregister:${(await hostServiceSets.read('net:box'))?.netEndpoint === SET_EP ? 'recorded' : 'gone'}`); throw new Error('companion said 502') },
      apply: async () => { seen.push('apply') },
    }
    await expect(forgetSetNet(failing)).rejects.toThrow(/502/)
    expect(seen).toEqual(['unregister:recorded'])
    expect((await hostServiceSets.read('net:box'))?.netEndpoint).toBe(SET_EP)
  })
})

describe('N1: leaving the host drops its whole set record', () => {
  it('the companion forgets the endpoint first, then the record goes, and this leader dials the endpoint no more', async () => {
    await hostServiceSets.write('net:box', { at: Date.now(), set: SET, movedAt: Date.now(), netEndpoint: SET_EP, netAddrs: ['10.0.0.5:41641'], netShared: SHARED })
    expect((await serviceSetNetMembers()).add.map((a) => a.id)).toEqual([SET_EP])
    const seen: string[] = []
    await forgetSetNet({ place: 'net:box', unregister: async (ep) => { seen.push(`unregister:${ep.slice(0, 4)}`) }, apply: async () => { seen.push('apply') } })
    expect(seen).toEqual([`unregister:${SET_EP.slice(0, 4)}`, 'apply'])
    expect(await hostServiceSets.read('net:box')).toBe(null)
    expect(await serviceSetNetMembers()).toEqual({ add: [], drop: new Set(), gone: [] })
  })

  it('an SSH host\'s record goes too (nothing to unregister)', async () => {
    await hostServiceSets.write('ssh:box', { at: Date.now(), set: SET, movedAt: Date.now(), runtimeDir: '/tmp/rt' })
    const seen: string[] = []
    await forgetSetNet({ place: 'ssh:box', unregister: async () => { seen.push('unregister') }, apply: async () => { seen.push('apply') } })
    expect(seen).toEqual([])
    expect(await hostServiceSets.read('ssh:box')).toBe(null)
  })

  it('a record of a host this leader no longer has is no member it dials, and is named for the sync to forget', async () => {
    await hostServiceSets.write('net:box', { at: Date.now(), set: SET, netEndpoint: SET_EP })
    await hostServiceSets.write('net:kept', { at: Date.now(), set: SET, netEndpoint: 'b'.repeat(64) })
    const m = await serviceSetNetMembers((host) => host === 'kept')
    expect(m.add.map((a) => a.id)).toEqual(['b'.repeat(64)])
    expect(m.gone).toEqual([{ place: 'net:box', id: SET_EP }])
  })
})

describe('N2 (c): a host record store that cannot be read is no empty list', () => {
  it('the strict read throws, so the sync never takes the set endpoints for machines', async () => {
    // The file is a directory: unreadable, not absent.
    fs.mkdirSync(process.env.WALNUT_SERVICE_SET_FILE!, { recursive: true })
    await expect(serviceSetNetMembers()).rejects.toThrow()
    // Absent is nothing paired.
    process.env.WALNUT_SERVICE_SET_FILE = path.join(dir, 'none.json')
    expect(await serviceSetNetMembers()).toEqual({ add: [], drop: new Set(), gone: [] })
  })
})

describe('N1: ServiceSetLink.leave', () => {
  function link(o: { uninstall?: () => Promise<string>; connected?: boolean } = {}) {
    const calls: string[] = []
    const c: SetLinkConn = {
      hostKey: 'box', kind: () => 'net', connected: o.connected ?? true,
      helloSet: () => SET,
      send: async (cmd, params) => { calls.push(cmd === 'net.configure' ? `net.configure:${JSON.stringify(params)}` : cmd); return { ok: true } },
      hasCapability: () => true,
      sharedEndpoint: () => SHARED,
      workUnderWay: () => 0,
      drained: async () => true,
      triggerIds: () => [],
      drainJournal: async () => {},
      run: async (command) => {
        if (command.includes('walnut daemon uninstall')) { calls.push('uninstall'); return (o.uninstall ?? (async () => `service set: ${SET}\n{"ok":true}`))() }
        calls.push('run')
        return ''
      },
      provision: async () => ({ set: SET, installed: true, ok: true }),
      relink: async () => SET,
      setHold: () => {},
      redeliver: () => {},
      home: ask.home,
      walnutId: async () => WALNUT,
      notice: () => {},
    }
    const l = new ServiceSetLink(c, {
      sessions: async () => [{ id: 's1' }],
      net: {
        list: () => ({}),
        register: async () => {},
        unregister: async (ep) => { calls.push(`unregister:${ep.slice(0, 4)}`) },
        apply: async () => { calls.push('apply') },
      },
      sleep: async () => {},
      settleMs: 0,
    }, () => 'walnut-daemon-abc')
    return { l, calls }
  }

  beforeEach(async () => {
    await hostServiceSets.write('net:box', { at: Date.now(), set: SET, movedAt: Date.now(), netEndpoint: SET_EP, netShared: SHARED, netSharedLeftAt: Date.now() })
    await serviceSetMoves.write('net:box', { v: 1, at: Date.now(), set: SET, link: 'net', phase: 'done', startedAt: Date.now(), stopped: [] })
  })

  it('removes this Walnut\'s own set there, turns off only the set\'s walnut-net, then forgets the set here and on the companion', async () => {
    const t = link()
    expect(await t.l.leave(5_000)).toMatchObject({ ok: true })
    expect(t.calls).toEqual(['server.configure', 'uninstall', 'net.configure:{"enabled":false}', `unregister:${SET_EP.slice(0, 4)}`, 'apply'])
    expect(await hostServiceSets.read('net:box')).toBe(null)
    expect(await serviceSetMoves.read('net:box')).toBe(null)
  })

  it('bounded: a host that never answers the uninstall does not hold the removal, and the set is still forgotten here', async () => {
    const t = link({ uninstall: () => new Promise<string>(() => {}) })
    const started = Date.now()
    expect(await t.l.leave(200)).toMatchObject({ ok: false })
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(t.calls).toContain(`unregister:${SET_EP.slice(0, 4)}`)
    expect(await hostServiceSets.read('net:box')).toBe(null)
  })

  it('a host that is away: nothing is run there, the set is still forgotten here', async () => {
    const t = link({ connected: false })
    expect(await t.l.leave(5_000)).toMatchObject({ ok: false })
    expect(t.calls).toEqual([`unregister:${SET_EP.slice(0, 4)}`, 'apply'])
    expect(await hostServiceSets.read('net:box')).toBe(null)
  })

  it('the companion did not forget the endpoint: the record stays for the next sync to finish', async () => {
    const t = link()
    ;(t.l as unknown as { d: { net: { unregister: () => Promise<void> } } }).d.net.unregister = async () => { throw new Error('companion said 502') }
    await t.l.leave(5_000)
    expect((await hostServiceSets.read('net:box'))?.netEndpoint).toBe(SET_EP)
  })
})
