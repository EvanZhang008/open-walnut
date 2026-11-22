/**
 * Every host gets a follower by default (src/core/host-server/follower-default.ts), and the
 * gates that keep one off a host that cannot run it well (eligibility.ts): the default and the
 * opt-out as the config stores them, the global default, each gate saying why, the recheck once
 * the condition clears, and a failed start that backs off without touching the host's sessions.
 * The manager runs against the fake host of the other manager tests.
 */
import { describe, it, expect, vi } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostServerManager } from '../../src/core/host-server/manager.js'
import { followerChosenBy, followerOnByDefault, followerOnEveryHost } from '../../src/core/host-server/follower-default.js'
import { FOLLOWER_FLOORS, judgeFollowerRoom, parseHostRoom, roomProbeScript } from '../../src/core/host-server/eligibility.js'
import { hostServerSettingsFrom, withThisWalnutTunnel } from '../../src/core/host-server/index.js'
import { NoHostFile } from '../../src/core/host-server/host-file.js'
import type { ExposeProviderDefinition } from '../../src/core/expose/types.js'
import { installCannotRun } from '../../src/core/host-server/install.js'
import type { FakeHost } from '../helpers/host-server-fake-host.js'
import { defaultFollowerBench, LINUX, ROOMY } from '../helpers/host-server-default-bench.js'


describe('follower by default: what the stored switch means', () => {
  // The experiment on (src/core/experimental.ts follower_on_every_host).
  const config = { experimental: { follower_on_every_host: true } }
  it('a host Walnut manages, with no switch of its own, is on by default', () => {
    const host = { hostname: 'devbox.example.test' }
    expect(followerOnByDefault(host, config)).toBe(true)
    expect(hostServerSettingsFrom(undefined, undefined, true)).toMatchObject({ enabled: true, byDefault: true })
    expect(followerChosenBy(undefined)).toBe('default')
    expect(followerChosenBy({ copies: { inbox: false } })).toBe('default')
  })

  it('a stored false stays off, a stored true stays on: both are the person\'s', () => {
    const off = hostServerSettingsFrom({ enabled: false }, undefined, true)
    expect(off.enabled).toBe(false)
    expect(off.byDefault).toBeUndefined()
    expect(followerChosenBy({ enabled: false })).toBe('user')
    const on = hostServerSettingsFrom({ enabled: true }, undefined, false)
    expect(on).toMatchObject({ enabled: true })
    expect(on.byDefault).toBeUndefined()
    expect(followerChosenBy({ enabled: true })).toBe('user')
  })

  it('the experiment is on by default: a config that never set it runs a follower on a managed host', () => {
    expect(followerOnEveryHost({})).toBe(true)
    expect(followerOnEveryHost({ experimental: {} })).toBe(true)
    expect(followerOnByDefault({ hostname: 'devbox.example.test' }, {})).toBe(true)
    expect(followerOnByDefault({ hostname: 'devbox.example.test' }, { experimental: { other_flag: true } })).toBe(true)
  })

  it('the experiment turned off (a stored false) keeps the switch opt-in, in one place', () => {
    const off = { experimental: { follower_on_every_host: false } }
    expect(followerOnEveryHost(off)).toBe(false)
    expect(followerOnByDefault({ hostname: 'devbox.example.test' }, off)).toBe(false)
    // "Every experiment on" cannot override the person's own false either.
    expect(followerOnByDefault({ hostname: 'devbox.example.test' }, { experimental: { every_experiment: true, follower_on_every_host: false } })).toBe(false)
    expect(hostServerSettingsFrom(undefined, undefined, false).enabled).toBe(false)
  })

  it('is off for the cloud box, a host turned off, and a found host still waiting for a yes', () => {
    expect(followerOnByDefault({ hostname: 'box', cloud_box: true }, config)).toBe(false)
    expect(followerOnByDefault({ hostname: 'devbox', enabled: false }, config)).toBe(false)
    expect(followerOnByDefault({ hostname: 'devbox', discovered: true, connect: 'ask' }, config)).toBe(false)
    expect(followerOnByDefault({ hostname: 'devbox', discovered: true, connect: 'yes', connect_by: 'walnut' }, config)).toBe(false)
    expect(followerOnByDefault({ hostname: 'devbox', discovered: true, connect: 'yes' }, config)).toBe(true)
    expect(followerOnByDefault(undefined, config)).toBe(false)
  })
})

describe('follower by default: the host that carries this Walnut\'s tunnel', () => {
  it('runs for the tunnel, not by default: nothing gates it', () => {
    const def = { id: 'acme-tunnel', title: 'Acme', command: 'acme', args: [], alwaysOnHostPattern: '^always-on-' } as unknown as ExposeProviderDefinition
    const config = { expose: { enabled: true, provider: 'acme-tunnel', run_on: 'devbox' }, hosts: { devbox: { hostname: 'always-on-devbox.invalid' } } }
    const placed = withThisWalnutTunnel('devbox', hostServerSettingsFrom(undefined, undefined, true), config as never, (id) => (id === def.id ? def : null))
    expect(placed).toMatchObject({ enabled: true, carriesTunnel: true })
    expect(placed.byDefault).toBeUndefined()
  })
})

describe('the gates: a build that runs there, memory, disk', () => {
  it('lets a roomy host through with its target, and a host that says nothing of its room', () => {
    expect(judgeFollowerRoom(LINUX + ROOMY)).toMatchObject({ target: { target: 'linux-x64' }, room: { memTotalMb: 16384, memAvailableMb: 12288, diskFreeMb: 40960 } })
    expect(judgeFollowerRoom(LINUX + 'mem_total_kb=\nmem_avail_kb=\ndisk_free_kb=\n')).toMatchObject({ target: { target: 'linux-x64' } })
  })

  it('no build for the system', () => {
    const judged = judgeFollowerRoom('os=FreeBSD\narch=amd64\n' + ROOMY)
    expect(judged).toMatchObject({ gate: { reason: 'no-build' } })
    expect((judged as { gate: { message: string } }).gate.message).toMatch(/^No Walnut server runs on this host: the host runs FreeBSD/)
  })

  it('too little memory in all, or free, or disk, each says so with the numbers', () => {
    const total = judgeFollowerRoom(LINUX + 'mem_total_kb=1048576\nmem_avail_kb=900000\ndisk_free_kb=41943040\n')
    expect(total).toMatchObject({ gate: { reason: 'memory', message: expect.stringMatching(/has 1 GB of memory, and one needs a host with at least 2 GB/) } })
    const free = judgeFollowerRoom(LINUX + 'mem_total_kb=8388608\nmem_avail_kb=524288\ndisk_free_kb=41943040\n')
    expect(free).toMatchObject({ gate: { reason: 'memory', message: expect.stringMatching(/512 MB of memory free, and one needs 1 GB free/) } })
    const disk = judgeFollowerRoom(LINUX + 'mem_total_kb=8388608\nmem_avail_kb=6291456\ndisk_free_kb=1048576\n')
    expect(disk).toMatchObject({ gate: { reason: 'disk', message: expect.stringMatching(/disk has 1 GB free, and one needs 2.5 GB/) } })
  })

  it('the probe runs for real here and says this machine\'s memory and disk', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-'))
    try {
      const out = await new Promise<string>((resolve, reject) => {
        const child = execFile('sh', ['-s'], { timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
        child.stdin!.end(roomProbeScript(`${root}/not-made-yet/root`))
      })
      const room = parseHostRoom(out)
      expect(room.memTotalMb).toBeGreaterThan(256)
      expect(room.memAvailableMb).toBeGreaterThan(0)
      expect(room.diskFreeMb).toBeGreaterThan(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('tells a file that does not run on the host from a passing install failure', () => {
    expect(installCannotRun('the walnut file does not start on this host (Linux x86_64, glibc 2.17): GLIBC_2.27 not found')).toBe(true)
    expect(installCannotRun('the walnut file failed its self-check on this host (Linux x86_64): sqlite')).toBe(true)
    expect(installCannotRun('cannot unpack the walnut file (is the disk full?)')).toBe(false)
  })
})

const b = defaultFollowerBench()

/** What the manager asked of the host that is not its server's business (sessions, commands). */
const otherWork = (h: FakeHost) => h.calls.filter((c) => c.startsWith('send ') && !c.startsWith('send server.'))

describe('host server manager: a host on by default', () => {
  it('starts a follower on a roomy host, probing it once for both the build and the room', async () => {
    const m = createHostServerManager(b.deps())
    const h = b.host()
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ enabled: true, phase: 'running' })
    expect(h.calls.filter((c) => c === 'room' || c === 'probe')).toEqual(['room'])
    expect(b.health).toEqual(['settled devbox'])
    m.stop()
  })

  it('with the experiment off a host the person turned on runs as before: no probe, no retry by itself, no Walnut Health failure', async () => {
    b.settings = { enabled: true, expose: { enabled: false, provider: null, options: {} } }
    const m = createHostServerManager(b.deps({ everyHost: () => false, firstReportMs: 30, tryLaterMs: { failed: [20] } }))
    const h = b.host()
    h.reports = false
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ phase: 'error' })
    expect(m.view('devbox').message).toMatch(/did not answer within a minute; its log is .*on the host$/)
    // No wait is set (the only way to one also sets retryAt), so nothing runs again by itself.
    expect(m.view('devbox').retryAt).toBeUndefined()
    expect(h.calls).not.toContain('room')
    expect(b.health).toEqual([])
    h.reports = true
    await m.reconcile('devbox', { retry: true })
    expect(m.view('devbox').phase).toBe('running')
    // No failure is raised; one raised while it was on would clear now.
    expect(b.health).toEqual(['settled devbox'])
    m.stop()
  })

  it('a host row that is really this computer gets no follower by default; the person\'s own switch still runs one', async () => {
    const m = createHostServerManager(b.deps())
    const h = b.host()
    h.reachesThisComputer = async () => true
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ enabled: true, phase: 'not-eligible', gate: { reason: 'this-computer' } })
    expect(m.view('devbox').gate!.recheckAt).toBeUndefined()
    expect(m.view('devbox').message).toBe('No Walnut server runs on this host by default: it is this computer, which runs Walnut already.')
    expect(h.calls).not.toContain('room')
    expect(h.uploads).toEqual([])
    expect(h.specs).toEqual([])
    m.stop()
    b.settings = { enabled: true, expose: { enabled: false, provider: null, options: {} } }
    const own = createHostServerManager(b.deps())
    await own.connected(h)
    expect(own.view('devbox').phase).toBe('running')
    own.stop()
  })

  it('a host the person turned on is not gated: no room probe', async () => {
    b.settings = { enabled: true, expose: { enabled: false, provider: null, options: {} } }
    const m = createHostServerManager(b.deps())
    const h = b.host()
    h.room = 'mem_total_kb=524288\nmem_avail_kb=100000\ndisk_free_kb=10\n'
    await m.connected(h)
    expect(m.view('devbox').phase).toBe('running')
    expect(h.calls).not.toContain('room')
    m.stop()
  })

  it('the person\'s off: nothing is probed or sent', async () => {
    b.settings = { enabled: false, expose: { enabled: false, provider: null, options: {} } }
    const m = createHostServerManager(b.deps())
    const h = b.host()
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ enabled: false, phase: 'off' })
    expect(h.calls.filter((c) => c !== 'send server.status')).toEqual([])
    expect(h.uploads).toEqual([])
  })

  it('a host not connected: nothing happens until it connects', async () => {
    const m = createHostServerManager(b.deps())
    await m.reconcile('devbox')
    expect(m.view('devbox')).toMatchObject({ enabled: true, phase: 'waiting-for-host' })
    const h = b.host()
    await m.connected(h)
    expect(m.view('devbox').phase).toBe('running')
    m.stop()
  })

  it.each([
    ['no build for its system', 'no-build', (h: FakeHost) => { h.system = 'os=Linux\narch=armv7l\n' }],
    ['too little memory', 'memory', (h: FakeHost) => { h.room = 'mem_total_kb=8388608\nmem_avail_kb=262144\ndisk_free_kb=41943040\n' }],
    ['too little disk', 'disk', (h: FakeHost) => { h.room = 'mem_total_kb=8388608\nmem_avail_kb=6291456\ndisk_free_kb=204800\n' }],
  ])('%s: no follower, and the view says why', async (_name, reason, make) => {
    const m = createHostServerManager(b.deps({ tryLaterMs: { gate: [60_000] } }))
    const h = b.host()
    make(h)
    await m.connected(h)
    const v = m.view('devbox')
    expect(v).toMatchObject({ enabled: true, phase: 'not-eligible', gate: { reason, checkedAt: expect.any(Number) } })
    expect(v.message).toMatch(/^No Walnut server runs on this host/)
    // A memory or disk gate is looked at again later; a build that does not run there, at the next connect.
    if (reason === 'no-build') expect(v.gate!.recheckAt).toBeUndefined()
    else { expect(v.gate!.recheckAt).toBeGreaterThan(Date.now()); expect(v.message).toMatch(/Walnut looks again in 1 min\.$/) }
    expect(h.uploads).toEqual([])
    expect(h.specs).toEqual([])
    expect(b.health).toEqual(['settled devbox'])
    m.stop()
  })

  it('looks again by itself once memory is freed, and starts then', async () => {
    const m = createHostServerManager(b.deps({ tryLaterMs: { gate: [40] } }))
    const h = b.host()
    h.room = 'mem_total_kb=8388608\nmem_avail_kb=262144\ndisk_free_kb=41943040\n'
    await m.connected(h)
    expect(m.view('devbox').phase).toBe('not-eligible')
    h.room = ROOMY
    await vi.waitFor(() => expect(m.view('devbox').phase).toBe('running'), { timeout: 5_000 })
    expect(m.view('devbox').gate).toBeUndefined()
    m.stop()
  })

  it('a file whose proof boot fails on the host means no follower there, until Retry, a newer build or its slow recheck', async () => {
    const m = createHostServerManager(b.deps())
    const h = b.host()
    h.installState = 'failed'
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ phase: 'not-eligible', gate: { reason: 'no-build' } })
    expect(m.view('devbox').message).toMatch(/does not start on this host .*Retry tries again, and a newer build is tried by itself\. Walnut looks again in 6 hours\.$/)
    expect(h.specs).toEqual([])
    m.stop()
  })

  it('a start that fails backs off, tells Walnut Health, and never touches the host\'s sessions or its link', async () => {
    const m = createHostServerManager(b.deps({ firstReportMs: 30, tryLaterMs: { failed: [80, 5_000] } }))
    const h = b.host()
    h.reports = false
    await m.connected(h)
    const first = m.view('devbox')
    expect(first).toMatchObject({ phase: 'error', retryAt: expect.any(Number) })
    expect(first.message).toMatch(/did not answer within a minute.*Walnut tries again in 0 s\.$/)
    expect(b.health).toEqual([expect.stringMatching(/^failed devbox: the server on the host did not answer/)])
    const configures = h.specs.length
    // It tries again by itself, later the second time.
    await vi.waitFor(() => expect(h.specs.length).toBeGreaterThan(configures), { timeout: 5_000 })
    await vi.waitFor(() => expect(m.view('devbox').message).toMatch(/tries again in 5 s\.$/), { timeout: 5_000 })
    expect(b.health.filter((x) => x.startsWith('failed'))).toHaveLength(2)
    // Only the server's own commands went to the daemon, and the link stayed up.
    expect(otherWork(h)).toEqual([])
    expect(h.connected).toBe(true)
    // The person's Retry: the server answers now, and Walnut Health hears it settled.
    h.reports = true
    await m.reconcile('devbox', { retry: true })
    expect(m.view('devbox')).toMatchObject({ phase: 'running' })
    expect(m.view('devbox').retryAt).toBeUndefined()
    expect(b.health.at(-1)).toBe('settled devbox')
    m.stop()
  })

  it('shows the upload while the program goes up, and drops it once it runs', async () => {
    const m = createHostServerManager(b.deps())
    const h = b.host()
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const run = m.connected(h)
    await vi.waitFor(() => expect(m.view('devbox').upload).toEqual({ sent: 2 ** 19, total: 2 ** 20 }))
    expect(m.view('devbox').phase).toBe('installing')
    release()
    await run
    expect(m.view('devbox').phase).toBe('running')
    expect(m.view('devbox').upload).toBeUndefined()
    m.stop()
  })

  it('a host carrying the tunnel is never gated, even short of memory', async () => {
    b.settings = { enabled: true, byDefault: true, carriesTunnel: true, expose: { enabled: true, provider: null, options: {} } }
    const m = createHostServerManager(b.deps())
    const h = b.host()
    h.room = 'mem_total_kb=1048576\nmem_avail_kb=100000\ndisk_free_kb=10\n'
    await m.connected(h)
    expect(m.view('devbox').phase).toBe('running')
    expect(h.calls).not.toContain('room')
    m.stop()
  })

  it('a follower whose first report came late is never gated on the retry by its own memory', async () => {
    const m = createHostServerManager(b.deps({ firstReportMs: 30, tryLaterMs: { failed: [60] } }))
    const h = b.host()
    h.reports = false
    await m.connected(h)
    expect(m.view('devbox').phase).toBe('error')
    expect(h.calls.filter((c) => c === 'room')).toHaveLength(1)
    // It runs now (the daemon kept it), and it holds the host's free memory.
    h.room = 'mem_total_kb=8388608\nmem_avail_kb=262144\ndisk_free_kb=41943040\n'
    h.reports = true
    await vi.waitFor(() => expect(m.view('devbox').phase).toBe('running'), { timeout: 5_000 })
    expect(h.calls.filter((c) => c === 'room')).toHaveLength(1)
    m.stop()
  })

  it('a config change elsewhere does not redo a setup that waits to try again; a change of its own settings does', async () => {
    const m = createHostServerManager(b.deps({ firstReportMs: 30, tryLaterMs: { failed: [60_000] } }))
    const h = b.host()
    h.reports = false
    await m.connected(h)
    expect(m.view('devbox').phase).toBe('error')
    const configures = h.specs.length
    await m.reconcile('devbox', { soft: true })
    await m.reconcile('devbox', { soft: true })
    expect(h.specs.length).toBe(configures)
    expect(b.health.filter((x) => x.startsWith('failed'))).toHaveLength(1)
    // The person changes this host's settings: it runs now.
    b.settings = { ...b.settings, copies: { inbox: false } }
    h.reports = true
    await m.reconcile('devbox', { soft: true })
    expect(m.view('devbox').phase).toBe('running')
    m.stop()
  })

  it('a file this computer cannot make means no follower by default; a passing failure to get it tries again', async () => {
    const none = createHostServerManager(b.deps({ hostFile: { ...b.files(), file: async () => { throw new NoHostFile('Walnut 0.6.7 has no walnut file for linux-x64 to download') } } }))
    const h = b.host()
    await none.connected(h)
    expect(none.view('devbox')).toMatchObject({ phase: 'not-eligible', gate: { reason: 'no-build' } })
    expect(none.view('devbox').message).toMatch(/^No Walnut server runs on this host: Walnut 0\.6\.7 has no walnut file for linux-x64 to download\. /)
    const flaky = createHostServerManager(b.deps({ tryLaterMs: { failed: [60_000] }, hostFile: { ...b.files(), file: async () => { throw new Error('fetch failed') } } }))
    await flaky.connected(b.host())
    expect(flaky.view('devbox')).toMatchObject({ phase: 'error', message: 'fetch failed. Walnut tries again in 1 min.' })
    expect(b.health.at(-1)).toBe('failed devbox: fetch failed (tries again)')
    flaky.stop()
  })

  it('a host that ran a follower before is not gated again (its own follower is in its memory)', async () => {
    const m = createHostServerManager(b.deps())
    const h = b.host()
    await m.connected(h)
    expect(m.view('devbox').phase).toBe('running')
    m.stop()
    h.room = 'mem_total_kb=8388608\nmem_avail_kb=262144\ndisk_free_kb=41943040\n'
    h.calls = []
    const again = createHostServerManager(b.deps())
    await again.connected(h)
    expect(again.view('devbox').phase).toBe('running')
    expect(h.calls).not.toContain('room')
    again.stop()
  })
})

describe('the floors', () => {
  it('are the measured ones', () => {
    expect(FOLLOWER_FLOORS).toEqual({ memTotalMb: 2048, memAvailableMb: 1024, diskFreeMb: 2560 })
  })
})
