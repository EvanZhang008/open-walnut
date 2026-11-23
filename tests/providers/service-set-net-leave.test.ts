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
 *  - ServiceSetLink.leave removes this Walnut's own set from the host, bounded, then forgets it;
 *  - leaveServiceSet (service-set-provision.ts): what is run on the host, in which order.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { forgetSetNet, pairServiceSetNet, type NetPairDeps } from '../../src/providers/service-set-net-pair.js'
import { hostServiceSets, serviceSetNetMembers } from '../../src/providers/service-set-leader.js'
import { serviceSetMoves } from '../../src/providers/service-set-move.js'
import { ServiceSetLink, type SetLinkConn } from '../../src/providers/service-set-move-link.js'
import { leaveServiceSet } from '../../src/providers/service-set-provision.js'

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
  function link(o: { uninstall?: () => Promise<string>; connected?: boolean; stop?: (id: string) => { ok: true } | { ok: false; why: string } } = {}) {
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
        if (command.includes('walnut daemon status')) { calls.push('status'); return `service set: ${SET}\n{"installed":true}` }
        calls.push('run')
        return ''
      },
      provision: async () => ({ set: SET, installed: true, ok: true }),
      relink: async () => SET,
      setHold: () => {},
      redeliver: () => {},
      dialled: () => null,
      home: ask.home,
      walnutId: async () => WALNUT,
      notice: () => {},
    }
    const l = new ServiceSetLink(c, {
      sessions: async () => [{ id: 's1' }],
      stop: async (id) => { calls.push(`stop:${id}`); return o.stop?.(id) ?? { ok: true } },
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
    expect(t.calls).toEqual(['status', 'server.configure', 'stop:s1', 'uninstall', 'net.configure:{"enabled":false}', `unregister:${SET_EP.slice(0, 4)}`, 'apply'])
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

  it('drill round 3, R3-5: this Walnut\'s sessions on the set are stopped, each proven, before its uninstall; one not stopped is said', async () => {
    const t = link({ stop: () => ({ ok: false, why: 'session s1: a CLI of it still runs (live pid 7)' }) })
    const out = await t.l.leave(5_000)
    expect(t.calls.indexOf('stop:s1')).toBeGreaterThan(-1)
    expect(t.calls.indexOf('stop:s1')).toBeLessThan(t.calls.indexOf('uninstall'))
    expect(out).toMatchObject({ ok: true, why: expect.stringMatching(/not stopped first: session s1: a CLI of it still runs/) })
  })

  it('round 3, L-N4: a move under way ends (bounded) before the leave forgets the records it writes', async () => {
    const t = link()
    // The move ends by itself a little later; a leave that did not wait would have run its steps by then.
    ;(t.l as unknown as { checking: Promise<void> }).checking = new Promise<void>((r) => { setTimeout(() => { t.calls.push('move-ended'); r() }, 200) })
    await t.l.leave(8_000)
    expect(t.calls[0]).toBe('move-ended')
    expect(t.calls.indexOf('move-ended')).toBeLessThan(t.calls.indexOf(`unregister:${SET_EP.slice(0, 4)}`))
    // One that never ends holds the leave a quarter of the bound at most.
    await hostServiceSets.write('net:box', { at: Date.now(), set: SET, movedAt: Date.now(), netEndpoint: SET_EP, netShared: SHARED, netSharedLeftAt: Date.now() })
    const u = link()
    ;(u.l as unknown as { checking: Promise<void> }).checking = new Promise<void>(() => {})
    const started = Date.now()
    await u.l.leave(400)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(u.calls).toContain(`unregister:${SET_EP.slice(0, 4)}`)
  })

  it('round 3, L-N2: the turn wait is a quarter of the bound, so the uninstall keeps most of it', async () => {
    const t = link()
    let now = 0
    const slept: number[] = []
    const d = (t.l as unknown as { d: Record<string, unknown> }).d
    d.sessions = async () => [{ id: 's1', busy: true }]
    d.now = () => now
    d.sleep = async (ms: number) => { slept.push(ms); now += ms }
    expect(await t.l.leave(40_000)).toMatchObject({ ok: false, why: expect.stringMatching(/ran the whole wait/) })
    // 10 s of wait: one 15 s look, then the bound of the wait (half the bound, before: two looks).
    expect(slept).toEqual([15_000])
    expect(t.calls).not.toContain('uninstall')
  })

  it('the companion did not forget the endpoint: the record stays for the next sync to finish', async () => {
    const t = link()
    ;(t.l as unknown as { d: { net: { unregister: () => Promise<void> } } }).d.net.unregister = async () => { throw new Error('companion said 502') }
    await t.l.leave(5_000)
    expect((await hostServiceSets.read('net:box'))?.netEndpoint).toBe(SET_EP)
  })
})

describe('leaveServiceSet', () => {
  const base = (said: string, inTurn = false, hello = SET) => {
    const sent: string[] = []
    const params_: Array<Record<string, unknown>> = []
    let now = 0
    return {
      sent, params: params_,
      deps: {
        set: SET, ask, now: () => now, sleep: async (ms: number) => { now += ms },
        sessions: async () => [{ inTurn }],
        stopSessions: async () => { sent.push('stop-sessions'); return [] as string[] },
        send: async (cmd: string, params: Record<string, unknown>) => { sent.push(cmd); params_.push(params); return {} },
        helloSet: () => hello,
        runSetCli: async (words: string) => { sent.push(words); return said },
        waitMs: 60_000,
      },
    }
  }
  const UNINSTALL = `uninstall --yes --walnut ${WALNUT} --walnut-home /home/u/.open-walnut`
  const STATUS = `status --walnut ${WALNUT} --walnut-home /home/u/.open-walnut`

  it('drill D4: stops its follower there, uninstalls only its set, then stops the set\'s own walnut-net', async () => {
    const b = base(`service set: ${SET}\n{"ok":true}`)
    expect(await leaveServiceSet(b.deps)).toMatchObject({ ok: true })
    // Over a host network link the set's walnut-net carries the link itself: it is stopped after the uninstall's answer.
    expect(b.sent).toEqual([STATUS, 'server.configure', 'stop-sessions', UNINSTALL, 'net.configure'])
    expect(b.params[0]).toEqual({ home: '/home/u/.open-walnut', spec: null })
    expect(b.params[1]).toEqual({ enabled: false })
  })

  it('option B: a link that reaches the shared daemon never turns the machine\'s walnut-net off', async () => {
    const b = base(`service set: ${SET}\n{"ok":true}`, false, '')
    expect(await leaveServiceSet(b.deps)).toMatchObject({ ok: true })
    expect(b.sent).toEqual([STATUS, 'server.configure', 'stop-sessions', UNINSTALL])
  })

  it('drill D4: a follower stop that fails does not hold the uninstall (best effort)', async () => {
    const b = base(`service set: ${SET}\n{"ok":true}`)
    const send = b.deps.send
    b.deps.send = async (cmd: string, params: Record<string, unknown>) => { if (cmd === 'server.configure') { b.sent.push(cmd); throw new Error('timed out') } return send(cmd, params) }
    expect(await leaveServiceSet(b.deps)).toMatchObject({ ok: true })
    expect(b.sent).toEqual([STATUS, 'server.configure', 'stop-sessions', UNINSTALL, 'net.configure'])
  })

  it('drill D5: an uninstall that kept the set\'s dir says why', async () => {
    const b = base(`service set: ${SET}\n{"ok":true,"setDir":{"removed":false,"why":"1 CLI of the set still runs (s1)"}}`)
    expect(await leaveServiceSet(b.deps)).toEqual({ ok: true, why: 'this Walnut\'s own service set was removed from the host; its dir stays (1 CLI of the set still runs (s1))' })
  })

  it('waits for a turn, bounded, and removes nothing at the bound', async () => {
    const b = base(`service set: ${SET}\n{"ok":true}`, true)
    expect(await leaveServiceSet(b.deps)).toMatchObject({ ok: false })
    expect(b.sent).toEqual([])
  })

  it('an answer that names another set is not taken for this one', async () => {
    const b = base('service set: default\n{"ok":true}')
    expect(await leaveServiceSet(b.deps)).toMatchObject({ ok: false })
    expect(await leaveServiceSet({ ...b.deps, set: '' })).toMatchObject({ ok: false })
  })

  it('round 3, L-N3: a host whose CLI no longer picks this set (its install marks lost) gets no uninstall at all', async () => {
    for (const status of ['service set: default\n{"installed":true}', '{"installed":true}']) {
      const b = base(`service set: ${SET}\n{"ok":true}`)
      b.deps.runSetCli = async (words: string) => { b.sent.push(words); return words.startsWith('status') ? status : `service set: ${SET}\n{"ok":true}` }
      expect(await leaveServiceSet(b.deps)).toMatchObject({ ok: false, why: expect.stringMatching(/before the uninstall the host named .*nothing was removed/) })
      expect(b.sent).toEqual([STATUS])
    }
  })

  it('round 3, L-H2: the uninstall\'s reply lost as the set\'s daemon stopped, the link no longer on the set: removed', async () => {
    let hello = SET
    const b = base(`service set: ${SET}\n{"ok":true}`)
    b.deps.helloSet = () => hello
    b.deps.runSetCli = async (words: string) => {
      b.sent.push(words)
      if (words.startsWith('status')) return `service set: ${SET}\n{"installed":true}`
      hello = ''
      throw new Error('the link closed')
    }
    expect(await leaveServiceSet(b.deps)).toMatchObject({ ok: true, why: expect.stringMatching(/reply was lost/) })
    // A lost reply while the link still reaches the set is no removal.
    const c = base(`service set: ${SET}\n{"ok":true}`)
    c.deps.runSetCli = async (words: string) => { c.sent.push(words); if (words.startsWith('status')) return `service set: ${SET}\n{}`; throw new Error('timed out') }
    expect(await leaveServiceSet(c.deps)).toMatchObject({ ok: false, why: expect.stringMatching(/named no set/) })
  })
})
