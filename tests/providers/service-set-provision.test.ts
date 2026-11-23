/**
 * The first look at a host for this Walnut's service set and its install (service-set-provision.ts),
 * leaving a host (leaveServiceSet), and the link that runs the look and the move
 * (service-set-move-link.ts) with a fake connection: no ssh, no daemon, every line recorded.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { leaveServiceSet, provisionWith, setRuntimeDirFrom } from '../../src/providers/service-set-provision.js'
import { ServiceSetLink, setCliCommand, type SetLinkConn } from '../../src/providers/service-set-move-link.js'
import { hostServiceSets } from '../../src/providers/service-set-leader.js'
import { serviceSetMoves } from '../../src/providers/service-set-move.js'
import type { SetProvision } from '../../src/providers/service-set-provision.js'

const WALNUT = '0123456789abcdef0123456789abcdef'
const SET = '0123456789abcdef'
const ask = { walnutId: WALNUT, home: '/home/u/.open-walnut' }
const EXE = '/x/walnut'

function host(answers: Record<string, string>) {
  const lines: string[] = []
  return {
    lines,
    io: { run: async (c: string) => { lines.push(c); for (const [k, v] of Object.entries(answers)) if (c.includes(k)) return v; return '' } },
  }
}

describe('provisionWith', () => {
  it('the default set: nothing is installed', async () => {
    const h = host({ ' status': 'service set: default\n{"installed":true}' })
    expect(await provisionWith(EXE, h.io, ask)).toEqual({ set: '', installed: true, ok: true })
    expect(h.lines.some((l) => l.includes(' install '))).toBe(false)
  })

  it('an own set not installed yet is installed, naming the Walnut, and its runtime dir is computed from the host\'s home and uid', async () => {
    const h = host({
      ' status': `service set: ${SET}\n{"installed":false}`,
      ' install ': `service set: ${SET}\n{"ok":true,"status":{"scope":"user"}}`,
      'id -u': '/home/u\n1000\n',
    })
    const p = await provisionWith(EXE, h.io, ask)
    expect(p).toEqual({ set: SET, installed: true, ok: true, runtimeDir: `/home/u/.open-walnut-host/walnuts/${SET}/rt` })
    expect(h.lines.find((l) => l.includes(' install '))).toBe(`${EXE} walnut daemon install --yes --executable ${EXE} --walnut ${WALNUT} --walnut-home /home/u/.open-walnut 2>/dev/null || true`)
  })

  it('an own set already installed is left as it is', async () => {
    const h = host({ ' status': `service set: ${SET}\n{"installed":true}`, 'id -u': '/home/u\n1000\n' })
    expect(await provisionWith(EXE, h.io, ask)).toMatchObject({ set: SET, installed: true, ok: true })
    expect(h.lines.some((l) => l.includes(' install '))).toBe(false)
  })

  it('a failed install is reported and its half-made set removed (only its own)', async () => {
    const h = host({
      ' status': `service set: ${SET}\n{"installed":false}`,
      ' install ': `service set: ${SET}\n{"ok":false,"failure":{"message":"no launchd"}}`,
      ' uninstall ': `service set: ${SET}\n{"ok":true}`,
      'id -u': '/home/u\n1000\n',
    })
    const p = await provisionWith(EXE, h.io, ask)
    expect(p).toMatchObject({ set: SET, ok: false, installed: false })
    expect(p.message).toMatch(/no launchd/)
  })

  it('an older CLI that names no set: nothing is known and nothing changes', async () => {
    const h = host({ ' status': '{"installed":true}' })
    expect(await provisionWith(EXE, h.io, ask)).toMatchObject({ set: null, ok: false })
    expect(h.lines.length).toBe(1)
  })

  it('the runtime dir falls back to /tmp when the home is too long for a socket path', () => {
    expect(setRuntimeDirFrom(`/home/${'a'.repeat(60)}\n501\n`, SET)).toBe(`/tmp/open-walnut-set-501-${SET}`)
    expect(setRuntimeDirFrom('garbage', SET)).toBeUndefined()
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
        send: async (cmd: string, params: Record<string, unknown>) => { sent.push(cmd); params_.push(params); return {} },
        helloSet: () => hello,
        runSetCli: async (words: string) => { sent.push(words); return said },
        waitMs: 60_000,
      },
    }
  }
  const UNINSTALL = `uninstall --yes --walnut ${WALNUT} --walnut-home /home/u/.open-walnut`

  it('drill D4: stops its follower there, uninstalls only its set, then stops the set\'s own walnut-net', async () => {
    const b = base(`service set: ${SET}\n{"ok":true}`)
    expect(await leaveServiceSet(b.deps)).toMatchObject({ ok: true })
    // Over a host network link the set's walnut-net carries the link itself: it is stopped after the uninstall's answer.
    expect(b.sent).toEqual(['server.configure', UNINSTALL, 'net.configure'])
    expect(b.params[0]).toEqual({ home: '/home/u/.open-walnut', spec: null })
    expect(b.params[1]).toEqual({ enabled: false })
  })

  it('option B: a link that reaches the shared daemon never turns the machine\'s walnut-net off', async () => {
    const b = base(`service set: ${SET}\n{"ok":true}`, false, '')
    expect(await leaveServiceSet(b.deps)).toMatchObject({ ok: true })
    expect(b.sent).toEqual(['server.configure', UNINSTALL])
  })

  it('drill D4: a follower stop that fails does not hold the uninstall (best effort)', async () => {
    const b = base(`service set: ${SET}\n{"ok":true}`)
    const send = b.deps.send
    b.deps.send = async (cmd: string, params: Record<string, unknown>) => { if (cmd === 'server.configure') { b.sent.push(cmd); throw new Error('timed out') } return send(cmd, params) }
    expect(await leaveServiceSet(b.deps)).toMatchObject({ ok: true })
    expect(b.sent).toEqual(['server.configure', UNINSTALL, 'net.configure'])
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
})

describe('the set\'s own CLI line', () => {
  it('runs this build\'s copy from the set\'s install root', () => {
    const cmd = setCliCommand(SET, 'walnut-daemon-abc', `net-forget --member ${'e'.repeat(64)}`)
    expect(cmd).toContain(`"$HOME/.open-walnut-host/walnuts/${SET}/daemon/versions"/*/*`)
    expect(cmd).toContain(`walnut daemon net-forget --member ${'e'.repeat(64)}`)
    expect(() => setCliCommand('bad', 'v', '')).toThrow()
  })
})

const ME = 'e'.repeat(64)
const SHARED = 'd'.repeat(64)
const SET_EP = 'a'.repeat(64)

describe('ServiceSetLink', () => {
  let dir = ''
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-link-'))
    for (const k of ['WALNUT_HOST_SERVICE_SETS', 'WALNUT_SERVICE_SET_FILE', 'WALNUT_SERVICE_SET_MOVE_FILE']) saved[k] = process.env[k]
    process.env.WALNUT_HOST_SERVICE_SETS = '1'
    process.env.WALNUT_SERVICE_SET_FILE = path.join(dir, 'sets.json')
    process.env.WALNUT_SERVICE_SET_MOVE_FILE = path.join(dir, 'moves.json')
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function conn(kind: 'ssh' | 'net', provision: SetProvision, o: { netId?: string; setAnswers?: boolean } = {}) {
    let hello = ''
    let held = false
    const calls: string[] = []
    const dialled: string[] = []
    let link!: ServiceSetLink
    const c: SetLinkConn = {
      hostKey: 'h', kind: () => kind, connected: true,
      helloSet: () => hello,
      send: async (cmd) => { calls.push(cmd); return { ok: true, status: { state: 'off' } } },
      hasCapability: (cap) => cap === 'host-server-v1' || cap === 'walnut-scope-v1',
      sharedEndpoint: () => SHARED,
      workUnderWay: () => 0,
      drained: async () => true,
      run: async (command) => {
        const words = /walnut daemon (net-id|net-forget)( --member [0-9a-f]+)?/.exec(command)
        if (!words) { calls.push(command); return '{"ok":true}' }
        calls.push(words[1] === 'net-id' ? 'net-id' : `net-forget${words[2]}`)
        if (words[1] === 'net-forget') return '{"ok":true,"changed":true}'
        return o.netId ?? `service set: ${SET}\n{"ok":true,"endpointId":"${SET_EP}","addrs":["10.0.0.5:41641"]}`
      },
      provision: async () => { calls.push('provision'); return provision },
      relink: async () => {
        calls.push('relink')
        // SSH: the dial goes where sshDir points now; net: to the endpoint netEndpoint names (else the host row's).
        if (kind === 'ssh') hello = (await link.sshDir())?.set ?? ''
        else {
          const ep = (await link.netEndpoint()) ?? SHARED
          dialled.push(ep)
          hello = ep === SET_EP && o.setAnswers !== false ? SET : ''
          if (ep === SET_EP && o.setAnswers === false) return null
        }
        return hello
      },
      setHold: (on) => { held = on; calls.push(on ? 'hold' : 'release') },
      redeliver: () => calls.push('redeliver'),
      triggerIds: () => [],
      drainJournal: async () => {},
      home: '/home/u/.open-walnut',
      walnutId: async () => WALNUT,
      notice: (_k, t) => calls.push(t === null ? 'notice-clear' : 'notice'),
    }
    link = new ServiceSetLink(c, {
      sessions: async () => [{ id: 's1' }],
      stop: async (id) => { calls.push(`stop:${id}`); return { ok: true } },
      endpointId: async () => ME,
      net: {
        list: () => ({ relayMode: 'public', relays: [], relayRoots: [], members: [{ id: ME, name: 'mac', accept: true }] }),
        register: async (ep, name) => { calls.push(`register:${ep.slice(0, 4)}:${name}`) },
        unregister: async (ep) => { calls.push(`unregister:${ep.slice(0, 4)}`) },
        apply: async () => { calls.push('apply') },
      },
      sleep: async () => {},
      settleMs: 0,
    }, () => 'walnut-daemon-abc')
    return { link, calls, dialled, held: () => held, setHello: (h: string) => { hello = h } }
  }

  it('ssh: the first look installs its set, the move runs, and the link then dials the set\'s runtime dir', async () => {
    const rt = `/home/u/.open-walnut-host/walnuts/${SET}/rt`
    const t = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: rt })
    expect(await t.link.sshDir()).toBe(null)
    await t.link.check()
    // The follower is stopped and seen off first, then the session, then this Walnut's triggers there.
    // Review round 2, M-L1: this Walnut's triggers there go before any session stops (no fire there resumes one).
    expect(t.calls).toEqual(['provision', 'hold', 'server.configure', 'server.status', 'triggers.configure', 'stop:s1', 'relink', 'release', 'redeliver', 'notice-clear'])
    expect(await serviceSetMoves.read('ssh:h')).toMatchObject({ phase: 'done', set: SET })
    expect(await t.link.sshDir()).toEqual({ dir: rt, set: SET })
    expect(t.link.standing).toBe('own')
    expect(t.held()).toBe(false)
  })

  it('B6 guard: after the move this Walnut\'s triggers and plugin jobs are on its set\'s daemon only, never also on the shared one', async () => {
    const rt = `/home/u/.open-walnut-host/walnuts/${SET}/rt`
    const t = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: rt })
    // Two fake daemons, each keeping what a home configured there: the shared one already holds ours.
    type Held = { triggers: string[]; jobs: string[] }
    const daemons: Record<string, Map<string, Held>> = {
      shared: new Map([['/home/u/.open-walnut', { triggers: ['t1'], jobs: ['j1'] }], ['/home/other/.open-walnut', { triggers: ['o1'], jobs: ['oj'] }]]),
      set: new Map(),
    }
    const c = (t.link as unknown as { c: SetLinkConn }).c
    const at = () => (c.helloSet() === SET ? daemons.set : daemons.shared)
    const send = c.send
    c.hasCapability = (cap) => cap === 'host-server-v1' || cap === 'plugin-jobs-v1' || cap === 'walnut-scope-v1'
    c.send = async (cmd, params) => {
      const home = String(params.home ?? '')
      const held = at().get(home) ?? { triggers: [], jobs: [] }
      if (cmd === 'triggers.configure') at().set(home, { ...held, triggers: ((params.config as { triggers: Array<{ id: string }> }).triggers).map((x) => x.id) })
      if (cmd === 'jobs.configure') at().set(home, { ...held, jobs: ((params.spec as { jobs: Array<{ id: string }> }).jobs).map((x) => x.id) })
      return send(cmd, params)
    }
    await t.link.check()
    expect(await serviceSetMoves.read('ssh:h')).toMatchObject({ phase: 'done' })
    // The connect hooks push this Walnut's own triggers and jobs on the new link, to its set's daemon.
    await c.send('triggers.configure', { config: { version: 1, triggers: [{ id: 't1' }] }, home: '/home/u/.open-walnut' })
    await c.send('jobs.configure', { home: '/home/u/.open-walnut', spec: { v: 1, jobs: [{ id: 'j1' }] } })
    const holders = (id: string, kind: keyof Held) => Object.entries(daemons).filter(([, m]) => [...m.values()].some((h) => h[kind].includes(id))).map(([n]) => n)
    expect(holders('t1', 'triggers')).toEqual(['set'])
    expect(holders('j1', 'jobs')).toEqual(['set'])
    // The other Walnut's on the shared daemon are left as they were.
    expect(daemons.shared.get('/home/other/.open-walnut')).toEqual({ triggers: ['o1'], jobs: ['oj'] })
    // The drop went before the flip (relink), so no fire was due on both daemons at once.
    expect(t.calls.indexOf('jobs.configure')).toBeLessThan(t.calls.indexOf('relink'))
  })

  it('net (option B): pairs with the set\'s own walnut-net first, flips by dialling its endpoint, then leaves only its own entry on the shared one', async () => {
    const t = conn('net', { set: SET, installed: true, ok: true })
    await t.link.check()
    expect(t.calls).toEqual([
      'provision',
      // Pairing over the link to the shared daemon: the set's walnut-net takes this leader's list, the relay and this machine's walnut-net list it.
      'net-id', `register:${SET_EP.slice(0, 4)}:h-set`, 'apply',
      'hold', 'server.configure', 'server.status', 'triggers.configure', 'stop:s1',
      'relink',
      // Done: the held work goes at once (review round 2, X1), then this leader dials the shared
      // endpoint no more and takes only itself off its list.
      'release', 'redeliver',
      'apply', `net-forget --member ${ME}`,
      'notice-clear',
    ])
    expect(t.dialled).toEqual([SET_EP])
    expect(await t.link.netEndpoint()).toBe(SET_EP)
    expect(await serviceSetMoves.read('net:h')).toMatchObject({ phase: 'done' })
    const r = await hostServiceSets.read('net:h')
    expect(r).toMatchObject({ set: SET, netEndpoint: SET_EP, netAddrs: ['10.0.0.5:41641'], netShared: SHARED })
    expect(typeof r?.movedAt).toBe('number')
    expect(typeof r?.netSharedLeftAt).toBe('number')
    // A later look on the moved host does not leave the shared list again.
    await t.link.check()
    expect(t.calls.filter((x) => x.startsWith('net-forget'))).toHaveLength(1)
  })

  it('net (option B): pairing not done means the move does not start and nothing is touched', async () => {
    const t = conn('net', { set: SET, installed: true, ok: true }, { netId: `service set: ${SET}\n{"ok":false,"code":"not_running","message":"this Walnut's own service is not running here"}` })
    await t.link.check()
    expect(t.calls).toEqual(['provision', 'net-id', 'notice'])
    expect(await serviceSetMoves.read('net:h')).toMatchObject({ phase: 'gave_up', stopped: [] })
    expect((await serviceSetMoves.read('net:h'))?.why).toContain('not paired')
    expect(await hostServiceSets.read('net:h')).not.toHaveProperty('netEndpoint')
    expect(await t.link.netEndpoint()).toBe(null)
    expect(t.held()).toBe(false)
  })

  it('net (option B): pairing that names the default set or the shared endpoint itself is no pairing', async () => {
    for (const said of ['service set: default\n{"ok":false,"code":"default_set"}', `service set: ${SET}\n{"ok":true,"endpointId":"${SHARED}","addrs":[]}`]) {
      const t = conn('net', { set: SET, installed: true, ok: true }, { netId: said })
      await serviceSetMoves.write('net:h', null)
      await t.link.check()
      expect(t.calls).not.toContain('hold')
      expect(t.calls.some((x) => x.startsWith('stop:') || x.startsWith('register'))).toBe(false)
    }
  })

  it('net (option B): the set\'s service not answering puts the link back on the shared endpoint, still a member, and leaves nothing', async () => {
    const t = conn('net', { set: SET, installed: true, ok: true }, { setAnswers: false })
    await t.link.check()
    // Flip (dial the set's endpoint), no answer, put back (the shared one), the held work released there.
    expect(t.dialled).toEqual([SET_EP, SHARED])
    expect(await t.link.netEndpoint()).toBe(null)
    expect(await serviceSetMoves.read('net:h')).toMatchObject({ phase: 'reverted' })
    expect(t.calls.some((x) => x.startsWith('net-forget'))).toBe(false)
    expect(t.calls.filter((x) => x === 'apply')).toHaveLength(1)
    expect(t.held()).toBe(false)
  })

  it('net (option B): leaving forgets the set\'s endpoint here and on the relay list', async () => {
    const t = conn('net', { set: SET, installed: true, ok: true })
    await t.link.check()
    await t.link.forgetNet()
    expect(t.calls.slice(-2)).toEqual([`unregister:${SET_EP.slice(0, 4)}`, 'apply'])
    // The host's whole record goes (review round 2, N1): no endpoint dialled, no set kept.
    expect(await hostServiceSets.read('net:h')).toBe(null)
    expect(await t.link.netEndpoint()).toBe(null)
  })

  it('the default set: nothing moves', async () => {
    const t = conn('ssh', { set: '', installed: true, ok: true })
    await t.link.check()
    expect(t.calls).toEqual(['provision'])
    expect(await hostServiceSets.read('ssh:h')).toMatchObject({ set: '' })
    await t.link.check()
    expect(t.calls).toEqual(['provision'])
  })

  it('an install that failed is a notice, and nothing is stopped', async () => {
    const t = conn('ssh', { set: SET, installed: false, ok: false, message: 'no launchd' })
    await t.link.check()
    expect(t.calls).toEqual(['provision', 'notice'])
  })

  it('a move that throws after the hold (a store that will not write) never leaves the host held', async () => {
    const t = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: `/home/u/.open-walnut-host/walnuts/${SET}/rt` })
    // The move's record file is a directory: every write after the first look fails.
    fs.mkdirSync(process.env.WALNUT_SERVICE_SET_MOVE_FILE!)
    await t.link.check()
    expect(t.held()).toBe(false)
    expect(t.calls.filter((c) => c === 'hold').length).toBe(t.calls.filter((c) => c === 'release').length)
  })

  it('B7: a host whose move is done keeps its set with the flag off: its lines name the Walnut, SSH dials the set, no new move', async () => {
    const rt = `/home/u/.open-walnut-host/walnuts/${SET}/rt`
    const t = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: rt })
    await t.link.check()
    expect(await hostServiceSets.read('ssh:h')).toMatchObject({ set: SET, movedAt: expect.any(Number) })
    process.env.WALNUT_HOST_SERVICE_SETS = '0'
    // The update, status and install lines still carry --walnut: never the other Walnut's default service.
    expect(await t.link.setAsk()).toEqual(ask)
    // A month later the move's own record is gone: the host's record still says moved.
    await serviceSetMoves.write('ssh:h', null)
    expect(await t.link.sshDir()).toEqual({ dir: rt, set: SET })
    // A link that reaches another daemon with the flag off starts no move.
    t.setHello('')
    const before = t.calls.length
    await t.link.check()
    expect(t.calls.slice(before).filter((c) => c === 'hold' || c.startsWith('stop:'))).toEqual([])
  })

  it('should-fix 8: a moved host\'s record never expires (other writes prune old entries)', async () => {
    const old = Date.now() - 2 * 365 * 24 * 3600_000
    await hostServiceSets.write('ssh:moved', { at: old, set: SET, runtimeDir: '/r', movedAt: old })
    await hostServiceSets.write('ssh:plain', { at: old, set: SET, runtimeDir: '/r' })
    await hostServiceSets.write('ssh:other', { at: Date.now(), set: '' })
    const raw = JSON.parse(fs.readFileSync(process.env.WALNUT_SERVICE_SET_FILE!, 'utf8')) as Record<string, unknown>
    const keys = Object.keys(raw).map((k) => k.split('|').pop())
    expect(keys).toContain('ssh:moved')
    expect(keys).not.toContain('ssh:plain')
  })

  it('low 15: an unknown set holds updates only until the first look ended (an older host that names no set, or a failed look)', async () => {
    const t = conn('ssh', { set: null, installed: false, ok: false, message: 'older host' })
    expect(t.link.looked).toBe(false)
    await t.link.check()
    expect((await t.link.standingFor()).standing).toBe('unknown')
    expect(t.link.looked).toBe(true)
  })

  it('drill D2: a move that gave up looks again by itself at its next try, while the link stays up', async () => {
    const t = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: `/home/u/.open-walnut-host/walnuts/${SET}/rt` })
    const later: number[] = []
    const schedule = t.link.schedule.bind(t.link)
    t.link.schedule = (ms?: number) => { later.push(ms ?? -1); schedule(10 ** 9) }
    ;(t.link as unknown as { d: { sessions: () => Promise<unknown[]> } }).d.sessions = async () => [{ id: 'acp', blocks: 'session acp: an ACP session' }]
    await t.link.check()
    expect(await serviceSetMoves.read('ssh:h')).toMatchObject({ phase: 'gave_up' })
    // The first retry is two hours out (moveRetryMs), plus a second of slack.
    expect(later).toHaveLength(1)
    expect(later[0]).toBeGreaterThan(2 * 3600_000)
    expect(later[0]).toBeLessThanOrEqual(2 * 3600_000 + 1_000)
    t.link.stop()
  })

  describe('review round 2', () => {
    const RT = `/home/u/.open-walnut-host/walnuts/${SET}/rt`
    const CAPS = ['host-server-v1', 'walnut-scope-v1', 'trigger-state-snapshot-v1', 'trigger-state-seed-v1']
    const STATE = { epoch: 'e', seq: 4, seen: { item1: 1 } }

    it('M2, M3, M-L1: the triggers go first and their memory is taken, the journal is drained after the stops, and the memory reaches the set\'s daemon before the release', async () => {
      const t = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: RT })
      const c = (t.link as unknown as { c: SetLinkConn }).c
      const seeds: Array<{ on: string; params: Record<string, unknown> }> = []
      c.hasCapability = (cap) => CAPS.includes(cap)
      c.triggerIds = () => ['t1']
      c.drainJournal = async () => { t.calls.push('drain-journal') }
      const send = c.send
      c.send = async (cmd, params) => {
        if (cmd === 'triggers.state.snapshot') { t.calls.push(cmd); return { ok: true, supported: true, state: STATE, digest: 'dg', seenReliableUntil: Date.now() + 86_400_000 } }
        if (cmd === 'triggers.state.seed') { t.calls.push(cmd); seeds.push({ on: c.helloSet(), params }); return { ok: true, seeded: true } }
        return send(cmd, params)
      }
      await t.link.check()
      expect(await serviceSetMoves.read('ssh:h')).toMatchObject({ phase: 'done' })
      expect(t.calls).toEqual(['provision', 'hold', 'server.configure', 'server.status', 'triggers.configure', 'triggers.state.snapshot', 'stop:s1', 'drain-journal', 'relink', 'triggers.state.seed', 'release', 'redeliver', 'notice-clear'])
      expect(seeds).toEqual([{ on: SET, params: { home: '/home/u/.open-walnut', triggerId: 't1', state: STATE, digest: 'dg' } }])
    })

    it('M5: a shared daemon older than the per-Walnut split is never touched: the move gives up before the hold', async () => {
      const t = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: RT })
      ;(t.link as unknown as { c: SetLinkConn }).c.hasCapability = (cap) => cap === 'host-server-v1'
      await t.link.check()
      expect(await serviceSetMoves.read('ssh:h')).toMatchObject({ phase: 'gave_up', why: expect.stringMatching(/no walnut-scope-v1/) })
      expect(t.calls.filter((x) => x === 'hold' || x === 'triggers.configure' || x === 'server.configure' || x.startsWith('stop:'))).toEqual([])
      t.link.stop()
    })

    it('M4: a reconnect\'s look that finds the try not due sets the timer again for it', async () => {
      const t = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: RT })
      const at = Date.now()
      await serviceSetMoves.write('ssh:h', { v: 1, at, set: SET, link: 'ssh', phase: 'gave_up', startedAt: at, stopped: [], failures: 1, nextTryAt: at + 3 * 3600_000 })
      const later: number[] = []
      const schedule = t.link.schedule.bind(t.link)
      t.link.schedule = (ms?: number) => { later.push(ms ?? -1); schedule(10 ** 9) }
      await t.link.check()
      expect(t.calls).not.toContain('hold')
      expect(later).toHaveLength(1)
      expect(later[0]).toBeGreaterThan(3 * 3600_000 - 60_000)
      expect(later[0]).toBeLessThanOrEqual(3 * 3600_000 + 1_000)
      t.link.stop()
    })

    it('drill N1: a look that finds no set (refused, cut, an older host) looks again soon and then less often, never silent for 30 min', async () => {
      const t = conn('net', { set: null, installed: false, ok: false, message: 'a daemon update is running on the host' })
      const later: number[] = []
      t.link.schedule = (ms?: number) => { later.push(ms ?? -1) }
      await t.link.check()
      await t.link.check()
      await t.link.check()
      // Each check looked again (the 30 min gate does not hold after a look that found nothing).
      expect(t.calls).toEqual(['provision', 'provision', 'provision'])
      expect(later).toEqual([60_000, 120_000, 240_000])
    })

    it('M6: a moved host whose set\'s dir answers with a daemon naming no set is moved no more: today\'s dir again, the next look starts anew', async () => {
      const t = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: RT })
      await hostServiceSets.write('ssh:h', { at: Date.now(), set: SET, runtimeDir: RT, movedAt: Date.now() })
      await serviceSetMoves.write('ssh:h', { v: 1, at: Date.now(), set: SET, link: 'ssh', phase: 'done', startedAt: Date.now(), stopped: [] })
      expect(await t.link.sshDir()).toEqual({ dir: RT, set: SET })
      t.setHello('')
      await t.link.check()
      expect((await hostServiceSets.read('ssh:h'))?.movedAt).toBeUndefined()
      expect(await serviceSetMoves.read('ssh:h')).toBe(null)
      expect(t.calls).toEqual(['relink'])
      // The redial goes to today's dir: the set's dir only while a move points there.
      expect(await t.link.sshDir()).toBe(null)
    })
  })

  it('flag off: nothing runs at all', async () => {
    process.env.WALNUT_HOST_SERVICE_SETS = '0'
    const t = conn('ssh', { set: SET, installed: true, ok: true })
    await t.link.check()
    await t.link.named(SET)
    expect(t.calls).toEqual([])
    expect(await t.link.setAsk()).toBe(null)
    expect(await t.link.sshDir()).toBe(null)
  })
})
