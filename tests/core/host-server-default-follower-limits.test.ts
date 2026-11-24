/**
 * The limits of a follower on every host by default (src/core/host-server/manager.ts with
 * try-later.ts and eligibility.ts): installs one host at a time,
 * a start before this computer's own daemon is linked, the proof boot looked at again, a failed
 * start that stops its server and its tries, total memory and a container's limit, and the Walnut
 * Health item's audience. The manager runs against the fake host of the other manager tests.
 */
import { describe, it, expect, vi } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostServerManager } from '../../src/core/host-server/manager.js'
import { judgeFollowerRoom, parseHostRoom, roomProbeScript } from '../../src/core/host-server/eligibility.js'
import { hostServerHealthItem } from '../../src/core/host-server/health-item.js'
import { audienceOf } from '../../src/core/notifications/audience.js'
import { defaultFollowerBench, LINUX, ON_BY_DEFAULT, ROOMY, TURNED_ON } from '../helpers/host-server-default-bench.js'

const b = defaultFollowerBench()
const isGz = (u: { path: string }) => u.path.endsWith('.gz')
const OFF = { ...TURNED_ON, enabled: false }

describe('the person\'s own choice over the default', () => {
  it('a follower running by default stops when the person turns it off, and stays off', async () => {
    const m = createHostServerManager(b.deps())
    const h = b.host()
    await m.connected(h)
    expect(m.view('devbox').phase).toBe('running')
    // The switch flipped off stores false (PUT /api/host-servers/:hostKey): the person's, not the default's.
    b.settings = OFF
    await m.reconcile('devbox')
    expect(m.view('devbox')).toMatchObject({ enabled: false, phase: 'off' })
    expect(h.specs.at(-1)).toBeNull()
    // A reconnect does not bring it back.
    const calls = h.calls.length
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ enabled: false, phase: 'off' })
    expect(h.calls.slice(calls).filter((c) => c === 'room' || c === 'launch')).toEqual([])
    m.stop()
  })

  it('Retry on a host short of memory looks again at once, and starts once the memory is there', async () => {
    const m = createHostServerManager(b.deps({ tryLaterMs: { gate: [3_600_000] } }))
    const h = b.host()
    h.room = 'mem_total_kb=8388608\nmem_avail_kb=262144\ndisk_free_kb=41943040\n'
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ phase: 'not-eligible', gate: { reason: 'memory' } })
    // Still short: Retry probes again and says so; the hour-long wait is not what decides.
    await m.reconcile('devbox', { retry: true })
    expect(m.view('devbox')).toMatchObject({ phase: 'not-eligible', gate: { reason: 'memory' } })
    expect(h.calls.filter((c) => c === 'room')).toHaveLength(2)
    h.room = ROOMY
    await m.reconcile('devbox', { retry: true })
    expect(m.view('devbox').phase).toBe('running')
    expect(m.view('devbox').gate).toBeUndefined()
    m.stop()
  })
})

describe('installs for the default, one host at a time', () => {
  it('a second host on by default waits for the first one\'s install; a host the person turned on never waits', async () => {
    const m = createHostServerManager(b.deps({ settingsOf: async (key) => (key === 'minebox' ? TURNED_ON : ON_BY_DEFAULT) }))
    const [first, second, mine] = [b.host('devbox'), b.host('lab'), b.host('minebox')]
    const opened: Array<() => void> = []
    for (const h of [first, second, mine]) h.gate = new Promise<void>((r) => opened.push(r))
    const runs = [m.connected(first)]
    await vi.waitFor(() => expect(first.uploads.some(isGz)).toBe(true))
    runs.push(m.connected(second), m.connected(mine))
    await vi.waitFor(() => expect(m.view('lab').message).toMatch(/^Waiting for its turn/))
    await vi.waitFor(() => expect(mine.uploads.some(isGz)).toBe(true))
    expect(second.uploads.some(isGz)).toBe(false)
    expect(m.view('lab').phase).toBe('installing')
    // The first install ends: the second one goes now.
    opened[0]!()
    await runs[0]
    expect(m.view('devbox').phase).toBe('running')
    await vi.waitFor(() => expect(second.uploads.some(isGz)).toBe(true))
    opened[1]!()
    opened[2]!()
    await Promise.all(runs)
    expect(['devbox', 'lab', 'minebox'].map((k) => m.view(k).phase)).toEqual(['running', 'running', 'running'])
    m.stop()
  })
})

describe('a start before this computer\'s own daemon is linked', () => {
  it.each([
    ['this computer after all', true, 'not-eligible'],
    ['another machine', false, 'running'],
  ] as const)('installs nothing on an unknown, and looks again: %s', async (_name, answer, phase) => {
    const m = createHostServerManager(b.deps({ tryLaterMs: { unsure: [30] } }))
    const h = b.host()
    let known: boolean | null = null
    h.reachesThisComputer = async () => known
    await m.connected(h)
    expect(m.view('devbox').phase).toBe('checking')
    expect(m.view('devbox').message).toMatch(/^Waiting to tell whether this host is this computer .* Walnut looks again in 0 s\.$/)
    expect(h.uploads).toEqual([])
    expect(h.specs).toEqual([])
    expect(h.calls).not.toContain('room')
    known = answer
    await vi.waitFor(() => expect(m.view('devbox').phase).toBe(phase), { timeout: 5_000 })
    if (answer) {
      expect(m.view('devbox').gate).toMatchObject({ reason: 'this-computer' })
      expect(h.uploads).toEqual([])
    }
    m.stop()
  })
})

describe('the proof boot and the build', () => {
  it('a proof boot that failed is looked at again every 6 hours, and the file is sent again then', async () => {
    const slow = createHostServerManager(b.deps())
    const h = b.host()
    h.installState = 'failed'
    await slow.connected(h)
    expect(slow.view('devbox')).toMatchObject({ phase: 'not-eligible', gate: { reason: 'no-build' } })
    expect(slow.view('devbox').gate!.recheckAt).toBeGreaterThan(Date.now() + 5.9 * 3_600_000)
    expect(slow.view('devbox').message).toMatch(/Walnut looks again in 6 hours\.$/)
    slow.stop()
    const m = createHostServerManager(b.deps({ tryLaterMs: { proof: [30] } }))
    const again = b.host()
    again.installState = 'failed'
    await m.connected(again)
    expect(m.view('devbox').phase).toBe('not-eligible')
    // The host's disk was full then; it is not now. The timer reinstalls as Retry does.
    await vi.waitFor(() => expect(m.view('devbox').phase).toBe('running'), { timeout: 5_000 })
    expect(again.uploads.some(isGz)).toBe(true)
    m.stop()
  })

  it('no build for its system waits for a connect, Retry or a newer build: no timer', async () => {
    const m = createHostServerManager(b.deps({ tryLaterMs: { gate: [30], proof: [30] } }))
    const h = b.host()
    h.system = 'os=Linux\narch=armv7l\n'
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ phase: 'not-eligible', gate: { reason: 'no-build' } })
    expect(m.view('devbox').gate!.recheckAt).toBeUndefined()
    m.stop()
  })
})

describe('a failed start on a host on by default', () => {
  it('stops its server, and stops trying by itself after the last step until a reconnect or Retry', async () => {
    const m = createHostServerManager(b.deps({ firstReportMs: 30, tryLaterMs: { failed: [40] } }))
    const h = b.host()
    h.reports = false
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ phase: 'error', retryAt: expect.any(Number) })
    // The daemon does not keep a server restarting there between tries.
    expect(h.specs.at(-1)).toBeNull()
    expect(h.daemonState).toBe('off')
    expect(b.health.at(-1)).toMatch(/^failed devbox: .*\(tries again\)$/)
    // The one step of this ladder runs, fails again, and then nothing is set.
    await vi.waitFor(() => expect(m.view('devbox').message).toMatch(/Walnut stopped trying by itself: a newer build, a reconnect or Retry tries again\.$/), { timeout: 5_000 })
    expect(m.view('devbox').retryAt).toBeUndefined()
    expect(h.specs.at(-1)).toBeNull()
    expect(b.health.at(-1)).toMatch(/^failed devbox: (?!.*tries again)/)
    // A config change elsewhere does not start it again.
    const configures = h.specs.length
    await m.reconcile('devbox', { soft: true })
    expect(h.specs.length).toBe(configures)
    // A reconnect does, and its ladder starts again from the first step.
    await m.connected(h)
    expect(h.specs.length).toBeGreaterThan(configures)
    expect(m.view('devbox').retryAt).toEqual(expect.any(Number))
    expect(m.view('devbox').message).toMatch(/Walnut tries again in 0 s\.$/)
    // Retry does too.
    h.reports = true
    await m.reconcile('devbox', { retry: true })
    expect(m.view('devbox').phase).toBe('running')
    m.stop()
  })
})

describe('memory: in all, and a container\'s limit', () => {
  it('too little memory in all is not looked at again on a timer; too little free is', async () => {
    const m = createHostServerManager(b.deps({ tryLaterMs: { gate: [60_000] } }))
    const h = b.host()
    h.room = 'mem_total_kb=1048576\nmem_avail_kb=900000\ndisk_free_kb=41943040\n'
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ phase: 'not-eligible', gate: { reason: 'memory' } })
    expect(m.view('devbox').gate!.recheckAt).toBeUndefined()
    expect(m.view('devbox').message).not.toMatch(/looks again/)
    m.stop()
  })

  it('judges by the smaller of the machine and its container\'s limit', () => {
    const GiB = 2 ** 30
    const small = judgeFollowerRoom(LINUX + ROOMY + `cg_limit_b=${GiB}\ncg_used_b=${GiB / 4}\n`)
    expect(small).toMatchObject({ gate: { reason: 'memory', again: false, message: expect.stringMatching(/its container allows 1 GB of memory/) } })
    const busy = judgeFollowerRoom(LINUX + ROOMY + `cg_limit_b=${4 * GiB}\ncg_used_b=${3.5 * GiB}\n`)
    expect(busy).toMatchObject({ gate: { reason: 'memory', again: true, message: expect.stringMatching(/its container has 512 MB of memory free/) } })
    // No limit (v2 reads max, which the probe drops; v1 a number near 2^63): the machine's own numbers.
    expect(parseHostRoom(ROOMY + 'cg_limit_b=9223372036854771712\ncg_used_b=1\n')).toEqual({ memTotalMb: 16384, memAvailableMb: 12288, diskFreeMb: 40960 })
    expect(parseHostRoom(ROOMY + 'cg_limit_b=\ncg_used_b=\n')).toEqual({ memTotalMb: 16384, memAvailableMb: 12288, diskFreeMb: 40960 })
  })

  it('the probe reads a cgroup v2 limit and a v1 one for real, and drops a v2 max', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'))
    const run = (cg: string) => new Promise<string>((resolve, reject) => {
      const child = execFile('sh', ['-s'], { timeout: 15_000, env: { ...process.env, WALNUT_PROBE_CGROUP: cg } }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
      child.stdin!.end(roomProbeScript(`${root}/not-made-yet/root`))
    })
    try {
      const v2 = path.join(root, 'v2')
      fs.mkdirSync(v2)
      fs.writeFileSync(path.join(v2, 'memory.max'), `${2 ** 30}\n`)
      fs.writeFileSync(path.join(v2, 'memory.current'), `${2 ** 28}\n`)
      expect(parseHostRoom(await run(v2))).toMatchObject({ memTotalMb: 1024, memAvailableMb: 768, container: true })
      const v1 = path.join(root, 'v1')
      fs.mkdirSync(path.join(v1, 'memory'), { recursive: true })
      fs.writeFileSync(path.join(v1, 'memory', 'memory.limit_in_bytes'), `${2 ** 31}\n`)
      fs.writeFileSync(path.join(v1, 'memory', 'memory.usage_in_bytes'), `${2 ** 30}\n`)
      expect(parseHostRoom(await run(v1))).toMatchObject({ memTotalMb: 2048, memAvailableMb: 1024, container: true })
      const none = path.join(root, 'none')
      fs.mkdirSync(none)
      fs.writeFileSync(path.join(none, 'memory.max'), 'max\n')
      expect(await run(none)).toMatch(/^cg_limit_b=$/m)
      expect(parseHostRoom(await run(none)).container).toBeUndefined()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the Walnut Health item', () => {
  it('goes to Walnut Health, never a popup', () => {
    expect(audienceOf(hostServerHealthItem('devbox', 'Dev box', 'the server on the host did not answer within a minute', true))).toBe('health')
    expect(audienceOf(hostServerHealthItem('devbox', 'Dev box', 'the install failed', false))).toBe('health')
  })
})
