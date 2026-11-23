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
import { netRouteCommand, parseRouteReply, ServiceSetLink, type SetLinkConn } from '../../src/providers/service-set-move-link.js'
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
  const base = (said: string, inTurn = false) => {
    const sent: string[] = []
    let now = 0
    return {
      sent,
      deps: {
        set: SET, ask, now: () => now, sleep: async (ms: number) => { now += ms },
        sessions: async () => [{ inTurn }],
        send: async (cmd: string) => { sent.push(cmd); return {} },
        runSetCli: async (words: string) => { sent.push(words); return said },
        waitMs: 60_000,
      },
    }
  }

  it('revokes its own net members, then uninstalls only its set', async () => {
    const b = base(`service set: ${SET}\n{"ok":true}`)
    expect(await leaveServiceSet(b.deps)).toMatchObject({ ok: true })
    expect(b.sent).toEqual(['net.configure', `uninstall --yes --walnut ${WALNUT} --walnut-home /home/u/.open-walnut`])
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

describe('the net route line', () => {
  it('runs this build\'s copy from the set\'s install root, and reads the answer', () => {
    const cmd = netRouteCommand(SET, 'walnut-daemon-abc', `--walnut ${WALNUT} --member ${'e'.repeat(64)} --confirm`)
    expect(cmd).toContain(`"$HOME/.open-walnut-host/walnuts/${SET}/daemon/versions"/*/*`)
    expect(cmd).toContain(`walnut daemon net-route --walnut ${WALNUT} --member ${'e'.repeat(64)} --confirm`)
    expect(() => netRouteCommand('bad', 'v', '')).toThrow()
    expect(parseRouteReply(`service set: ${SET}\n{"ok":true,"state":"pending"}`)).toEqual({ ok: true, message: '' })
    expect(parseRouteReply('{"ok":false,"code":"no_member","error":"not a member"}')).toEqual({ ok: false, message: 'not a member' })
  })
})

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

  function conn(kind: 'ssh' | 'net', provision: SetProvision) {
    let hello = ''
    let held = false
    const calls: string[] = []
    let link!: ServiceSetLink
    const c: SetLinkConn = {
      hostKey: 'h', kind: () => kind, connected: true,
      helloSet: () => hello,
      send: async (cmd) => { calls.push(cmd); return { ok: true, status: { state: 'off' } } },
      hasCapability: (cap) => cap === 'host-server-v1',
      workUnderWay: () => 0,
      drained: async () => true,
      run: async (command) => { calls.push(command.includes('net-route') ? `net-route${command.split('net-route')[1]!.split(' 2>')[0]}` : command); return '{"ok":true}' },
      provision: async () => { calls.push('provision'); return provision },
      relink: async () => {
        calls.push('relink')
        // SSH: the dial goes where sshDir points now.
        if (kind === 'ssh') hello = (await link.sshDir())?.set ?? ''
        else hello = calls.some((x) => x.includes('--revert-after')) ? SET : ''
        return hello
      },
      setHold: (on) => { held = on; calls.push(on ? 'hold' : 'release') },
      redeliver: () => calls.push('redeliver'),
      home: '/home/u/.open-walnut',
      walnutId: async () => WALNUT,
      notice: (_k, t) => calls.push(t === null ? 'notice-clear' : 'notice'),
    }
    link = new ServiceSetLink(c, {
      sessions: async () => [{ id: 's1' }],
      stop: async (id) => { calls.push(`stop:${id}`); return { ok: true } },
      endpointId: async () => 'e'.repeat(64),
      sleep: async () => {},
      settleMs: 0,
    }, () => 'walnut-daemon-abc')
    return { link, calls, held: () => held, setHello: (h: string) => { hello = h } }
  }

  it('ssh: the first look installs its set, the move runs, and the link then dials the set\'s runtime dir', async () => {
    const rt = `/home/u/.open-walnut-host/walnuts/${SET}/rt`
    const t = conn('ssh', { set: SET, installed: true, ok: true, runtimeDir: rt })
    expect(await t.link.sshDir()).toBe(null)
    await t.link.check()
    // The follower is stopped and seen off first, then the session, then this Walnut's triggers there.
    expect(t.calls).toEqual(['provision', 'hold', 'server.configure', 'server.status', 'stop:s1', 'triggers.configure', 'relink', 'release', 'redeliver', 'notice-clear'])
    expect(await serviceSetMoves.read('ssh:h')).toMatchObject({ phase: 'done', set: SET })
    expect(await t.link.sshDir()).toEqual({ dir: rt, set: SET })
    expect(t.link.standing).toBe('own')
    expect(t.held()).toBe(false)
  })

  it('net: the flip runs net-route with this leader\'s endpoint and a put-back, then confirms', async () => {
    const t = conn('net', { set: SET, installed: true, ok: true })
    await t.link.check()
    const routes = t.calls.filter((x) => x.startsWith('net-route'))
    expect(routes).toEqual([
      ` --walnut ${WALNUT} --member ${'e'.repeat(64)} --revert-after 120`,
      ` --walnut ${WALNUT} --member ${'e'.repeat(64)} --confirm`,
    ].map((r) => `net-route${r}`))
    expect(await serviceSetMoves.read('net:h')).toMatchObject({ phase: 'done' })
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
