/**
 * The first look at a host for this Walnut's service set and its install (service-set-provision.ts),
 * and the link that runs the look and the move
 * (service-set-move-link.ts) with a fake connection: no ssh, no daemon, every line recorded.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { provisionWith, setCliCommand, setRuntimeDirFrom } from '../../src/providers/service-set-provision.js'
import { ServiceSetLink, type SetLinkConn } from '../../src/providers/service-set-move-link.js'
import { hostServiceSets } from '../../src/providers/service-set-leader.js'
import { serviceSetMoves } from '../../src/providers/service-set-move.js'
import type { SetProvision } from '../../src/providers/service-set-provision.js'

const WALNUT = '0123456789abcdef0123456789abcdef'
const SET = '0123456789abcdef'
const ask = { walnutId: WALNUT, home: '/home/u/.open-walnut' }
const EXE = '/x/walnut'
/** The dir an SSH link takes when no set points it elsewhere. */
const TODAY_DIR = '/tmp/open-walnut-daemon'

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

  describe('an own set installed by an earlier build of this Walnut (the leader updated before the move)', () => {
    const BUILD = 'walnut-daemon-0123456789ab'
    const installed = { ' status': `service set: ${SET}\n{"installed":true,"scope":"user"}`, 'id -u': '/home/u\n1000\n' }

    it('says the build is missing, with its scope, and runs no update or install of its own', async () => {
      const h = host({ ...installed, 'echo build:yes': 'build:no\n' })
      expect(await provisionWith(EXE, h.io, ask, { expected: BUILD })).toEqual({
        set: SET, installed: true, ok: false, buildMissing: { scope: 'user' }, runtimeDir: `/home/u/.open-walnut-host/walnuts/${SET}/rt`,
      })
      const probe = h.lines.find((l) => l.includes('echo build:yes'))!
      // The probe looks in this set's install root for this build, as setCliCommand does.
      expect(probe).toContain(`/.open-walnut-host/walnuts/${SET}/daemon/versions`)
      expect(probe).toContain(`= ${BUILD} ]`)
      expect(h.lines.some((l) => l.includes(' update ') || l.includes(' install ') || l.includes(' uninstall '))).toBe(false)
    })

    it('a set that has this build is left as it is', async () => {
      const h = host({ ...installed, 'echo build:yes': 'build:yes\n' })
      expect(await provisionWith(EXE, h.io, ask, { expected: BUILD })).toMatchObject({ set: SET, installed: true, ok: true })
      expect(h.lines.some((l) => l.includes(' update '))).toBe(false)
    })

    it('a probe that does not read (a link cut mid-line) changes nothing and asks for another look', async () => {
      const h = host({ ...installed, 'echo build:yes': '' })
      expect(await provisionWith(EXE, h.io, ask, { expected: BUILD })).toMatchObject({ set: SET, ok: false, retryLook: true })
      expect(h.lines.some((l) => l.includes(' update '))).toBe(false)
    })

    it('without refresh (moved, or the link may reach the set) nothing is probed', async () => {
      const h = host(installed)
      expect(await provisionWith(EXE, h.io, ask)).toMatchObject({ set: SET, ok: true })
      expect(h.lines.some((l) => l.includes('echo build:yes'))).toBe(false)
    })

    it('the probe runs in a real sh: this build found, another build, no versions dir', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'set-probe-'))
      try {
        const v = path.join(home, '.open-walnut-host/walnuts', SET, 'daemon/versions/abc')
        fs.mkdirSync(v, { recursive: true })
        const exe = path.join(v, 'daemon')
        fs.writeFileSync(exe, `#!/bin/sh\necho ${BUILD}\n`, { mode: 0o755 })
        const run = (build: string, h = home) => execFileSync('/bin/sh', ['-c', setCliCommand(SET, build, 'status')], { env: { ...process.env, HOME: h }, encoding: 'utf8' })
        // Found: the line runs that copy (here it prints its version again for any words).
        expect(run(BUILD).trim()).toBe(BUILD)
        expect(run('walnut-daemon-ffffffffffff')).toMatch(/"code":"no_build"/)
        expect(run(BUILD, path.join(home, 'nowhere'))).toMatch(/"code":"no_build"/)
      } finally { fs.rmSync(home, { recursive: true, force: true }) }
    })
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
    /** Each look's `refresh` (an own set not moved to yet takes this build). */
    const refreshes: Array<boolean | undefined> = []
    const dialled: string[] = []
    /** Where the last dial went (SetLinkConn.dialled). */
    let at: string | null = null
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
      provision: async (_ask, opts) => { calls.push('provision'); refreshes.push(opts?.refresh); return provision },
      relink: async () => {
        calls.push('relink')
        // SSH: the dial goes where sshDir points now; net: to the endpoint netEndpoint names (else the host row's).
        if (kind === 'ssh') { const d = await link.sshDir(); hello = d?.set ?? ''; at = d?.dir ?? TODAY_DIR }
        else {
          const ep = (await link.netEndpoint()) ?? SHARED
          dialled.push(ep)
          at = ep
          hello = ep === SET_EP && o.setAnswers !== false ? SET : ''
          if (ep === SET_EP && o.setAnswers === false) return null
        }
        return hello
      },
      setHold: (on) => { held = on; calls.push(on ? 'hold' : 'release') },
      redeliver: () => calls.push('redeliver'),
      dialled: () => at,
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
    return { link, calls, refreshes, dialled, held: () => held, setHello: (h: string) => { hello = h }, setDialled: (d: string) => { at = d } }
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

  it('a look refreshes an own set\'s build only while nothing of this Walnut can run on it', async () => {
    const rt = `/home/u/.open-walnut-host/walnuts/${SET}/rt`
    // A record not known yet (the first look): no refresh, the look names the set first.
    const t = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: rt })
    await t.link.check()
    expect(t.refreshes[0]).toBe(false)
    expect(await hostServiceSets.read('ssh:h')).toMatchObject({ set: SET, movedAt: expect.any(Number) })
    // Moved: the set runs this Walnut's sessions, and the usual daemon update keeps its build.
    const m = conn('ssh', { set: SET, installed: true, ok: true })
    await m.link.check()
    expect(m.refreshes).toEqual([false])
    // Recorded, not moved, the link reaching the shared daemon: refresh.
    await hostServiceSets.write('ssh:h', { at: 1, set: SET, runtimeDir: rt })
    await serviceSetMoves.write('ssh:h', null)
    const s = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: rt })
    await s.link.check()
    expect(s.refreshes[0]).toBe(true)
    // A move that flipped (a restart in its flipped phase): no refresh.
    await hostServiceSets.write('ssh:h', { at: 1, set: SET, runtimeDir: rt })
    await serviceSetMoves.write('ssh:h', { v: 1, at: 1, set: SET, link: 'ssh', phase: 'flipped', startedAt: 1, stopped: [] })
    const f = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: rt })
    await f.link.check()
    expect(f.refreshes[0]).toBe(false)
    // The hello names the set already: no refresh.
    await serviceSetMoves.write('ssh:h', null)
    const hset = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: rt })
    hset.setHello(SET)
    await hset.link.check()
    expect(hset.refreshes).not.toContain(true)
  })

  it('a refresh that did not happen is no move: the look runs again', async () => {
    await hostServiceSets.write('ssh:h', { at: 1, set: SET, runtimeDir: `/home/u/.open-walnut-host/walnuts/${SET}/rt` })
    const t = conn('ssh', { set: SET, installed: true, ok: false, retryLook: true, message: 'the update failed' })
    await t.link.check()
    expect(t.calls).toEqual(['provision', 'notice'])
    await new Promise((r) => setTimeout(r, 0))
    // provisionedAt was reset: the next check looks again instead of moving with no build.
    await t.link.check()
    expect(t.calls.filter((c) => c === 'provision').length).toBe(2)
    expect(t.calls).not.toContain('hold')
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

    it('drill round 3, R3-3: a look that throws (the link cut mid-line) is looked at again soon, not in 30 min', async () => {
      const t = conn('net', { set: SET, installed: true, ok: true })
      ;(t.link as unknown as { c: SetLinkConn }).c.provision = async () => { t.calls.push('provision'); throw new Error('not connected') }
      const later: number[] = []
      t.link.schedule = (ms?: number) => { later.push(ms ?? -1) }
      await t.link.check()
      await t.link.check()
      expect(t.calls).toEqual(['provision', 'provision'])
      expect(later).toEqual([60_000, 120_000])
      expect(t.link.looked).toBe(true)
    })

    it('M6: a moved host whose set\'s dir answers with a daemon naming no set is moved no more: today\'s dir again, the next look starts anew', async () => {
      const t = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: RT })
      await hostServiceSets.write('ssh:h', { at: Date.now(), set: SET, runtimeDir: RT, movedAt: Date.now() })
      await serviceSetMoves.write('ssh:h', { v: 1, at: Date.now(), set: SET, link: 'ssh', phase: 'done', startedAt: Date.now(), stopped: [] })
      expect(await t.link.sshDir()).toEqual({ dir: RT, set: SET })
      t.setHello('')
      t.setDialled(RT)
      await t.link.check()
      expect((await hostServiceSets.read('ssh:h'))?.movedAt).toBeUndefined()
      expect(await serviceSetMoves.read('ssh:h')).toBe(null)
      // Round 3, S3: what this leader pushed to the daemon that answered there goes first (triggers, follower).
      expect(t.calls).toEqual(['triggers.configure', 'server.configure', 'server.status', 'relink'])
      // The redial goes to today's dir: the set's dir only while a move points there.
      expect(await t.link.sshDir()).toBe(null)
    })

    it('L-M2: a moved host whose link reached another place than the set\'s (today\'s dir) is no undo', async () => {
      const t = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: RT })
      await hostServiceSets.write('ssh:h', { at: Date.now(), set: SET, runtimeDir: RT, movedAt: Date.now() })
      await serviceSetMoves.write('ssh:h', { v: 1, at: Date.now(), set: SET, link: 'ssh', phase: 'done', startedAt: Date.now(), stopped: [] })
      t.setHello('')
      t.setDialled(TODAY_DIR)
      await t.link.check()
      // No M6 undo (it drops this Walnut's scope there, then relinks, and never looks): the look goes on.
      expect(t.calls[0]).toBe('provision')
      expect(await serviceSetMoves.read('ssh:h')).not.toBe(null)
      expect((await hostServiceSets.read('ssh:h'))?.movedAt).toEqual(expect.any(Number))
      expect(await t.link.sshDir()).toEqual({ dir: RT, set: SET })
    })

    it('S3: a connect that finds the set\'s dir empty undoes a done move there; a move under way only loses its pointer', async () => {
      const t = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: RT })
      await hostServiceSets.write('ssh:h', { at: Date.now(), set: SET, runtimeDir: RT, movedAt: Date.now() })
      await serviceSetMoves.write('ssh:h', { v: 1, at: Date.now(), set: SET, link: 'ssh', phase: 'done', startedAt: Date.now(), stopped: [] })
      await t.link.setGoneAt('/some/other/dir')
      expect(await t.link.sshDir()).toEqual({ dir: RT, set: SET })
      await t.link.setGoneAt(RT)
      expect(await t.link.sshDir()).toBe(null)
      expect((await hostServiceSets.read('ssh:h'))?.movedAt).toBeUndefined()
      expect(await serviceSetMoves.read('ssh:h')).toBe(null)
      // Nothing was sent: the undo runs before any push (the caller deploys nothing there).
      expect(t.calls).toEqual([])
    })
  })

  it('round 3, L-H1: an update line\'s words with a standing that cannot be read: today\'s line on the default\'s daemon, never words naming no set', async () => {
    const t = conn('ssh', { set: SET, installed: true, ok: true })
    t.link.standingFor = async () => { throw new Error('the record store did not read') }
    expect(await t.link.wordsDue('')).toBe(false)
    expect(await t.link.wordsDue(SET)).toBe(true)
    // Read: the default set the host gave this Walnut names it.
    const u = conn('ssh', { set: '', installed: true, ok: true })
    await hostServiceSets.write('ssh:h', { at: Date.now(), set: '' })
    expect(await u.link.wordsDue('')).toBe(true)
  })

  it('flag off: nothing runs at all', async () => {
    process.env.WALNUT_HOST_SERVICE_SETS = '0'
    const t = conn('ssh', { set: SET, installed: true, ok: true })
    await t.link.check()
    await t.link.named(SET)
    expect(t.calls).toEqual([])
    expect(await t.link.setAsk()).toBe(null)
    expect(await t.link.sshDir()).toBe(null)
    expect(await t.link.wordsDue(SET)).toBe(false)
  })
})
