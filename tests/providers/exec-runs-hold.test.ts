/**
 * A daemon update waits for the host_exec runs on that host (src/providers/exec-runs-hold.ts).
 * 2026-11-03: a deploy updated a Mac's daemon while a task on a Linux box ran the iOS tests
 * there through host_exec; the run wrote to the old daemon's pipes and ended with it.
 *
 * Pinned here: the reason and the ask, the local daemon's upgrade (unmanaged and managed),
 * and the daemon twins: hello says how many runs go on, and a service handover refuses while
 * one runs. The SSH and host network paths are pinned in
 * daemon-connection-deferred-upgrade.test.ts and daemon-net-update.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { needsPrewarm } = vi.hoisted(() => ({ needsPrewarm: vi.fn() }))
vi.mock('../../src/providers/fold-prewarm.js', () => ({ registryNeedsFoldPrewarm: needsPrewarm, runFoldPrewarm: vi.fn() }))

import { WebSocketServer } from 'ws'
import { EXEC_UPGRADE_HOLD_MAX_MS, daemonBusyRefusal, execRunsHold, execRunsProven, execRunsReason, execRunsWait } from '../../src/providers/exec-runs-hold.js'
import { setAcpUpgradeHoldFileForTest } from '../../src/providers/acp-upgrade-hold.js'
import { LocalDaemon } from '../../src/providers/local-daemon.js'
import { log } from '../../src/logging/index.js'

let clockDir = ''
beforeEach(() => {
  clockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-exec-hold-clock-'))
  setAcpUpgradeHoldFileForTest(path.join(clockDir, 'hold.json'))
})
afterEach(() => {
  setAcpUpgradeHoldFileForTest(null)
  fs.rmSync(clockDir, { recursive: true, force: true })
})

describe('execRunsReason, execRunsHold', () => {
  it('names the runs, and nothing for none or a value that is not a count', () => {
    expect(execRunsReason(1)).toBe('1 host_exec run on the host would end with the daemon')
    expect(execRunsReason(3)).toBe('3 host_exec runs on the host would end with the daemon')
    for (const n of [0, -1, undefined, null, '2', Number.NaN]) expect(execRunsReason(n)).toBeNull()
  })

  it('asks a live daemon with host_exec, counts only the running jobs, and holds nothing on a failed ask', async () => {
    const send = vi.fn(async () => ({ ok: true, jobs: [{ running: true }, { running: false }, { running: true }] }))
    expect(await execRunsHold({ connected: true, hasCapability: (c) => c === 'host-exec-v1', send }, 'h')).toBe('2 host_exec runs on the host would end with the daemon')
    expect(send).toHaveBeenCalledWith('exec.list', {}, 10_000)
    expect(await execRunsHold({ connected: true, hasCapability: () => true, send: async () => ({ ok: true, jobs: [] }) }, 'h')).toBeNull()
    expect(await execRunsHold({ connected: true, hasCapability: () => true, send: async () => { throw new Error('timed out') } }, 'h')).toBeNull()
    const never = vi.fn()
    expect(await execRunsHold({ connected: false, hasCapability: () => true, send: never }, 'h')).toBeNull()
    expect(await execRunsHold({ connected: true, hasCapability: () => false, send: never }, 'h')).toBeNull()
    expect(never).not.toHaveBeenCalled()
  })

  it('the wait has an end: a host that kept runs going for EXEC_UPGRADE_HOLD_MAX_MS is updated anyway, and its clock starts over once none runs', () => {
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const t0 = 1_800_000_000_000
    const why = '1 host_exec run on the host would end with the daemon'
    // Asked every 10 minutes (the recheck runs every minute; a gap over 15 minutes starts the clock over).
    for (let t = t0; t < t0 + EXEC_UPGRADE_HOLD_MAX_MS; t += 10 * 60_000) expect(execRunsWait('mac', why, t)).toBe(why)
    expect(execRunsWait('mac', why, t0 + EXEC_UPGRADE_HOLD_MAX_MS + 1)).toBeNull()
    expect(warn.mock.calls.filter(([m]) => /goes ahead over host_exec runs/.test(String(m)))).toHaveLength(1)
    // Another host has its own clock; a check with no run ends this one's.
    expect(execRunsWait('devbox', why, t0 + EXEC_UPGRADE_HOLD_MAX_MS + 1)).toBe(why)
    expect(execRunsWait('mac', null, t0 + EXEC_UPGRADE_HOLD_MAX_MS + 2)).toBeNull()
    expect(execRunsWait('mac', why, t0 + EXEC_UPGRADE_HOLD_MAX_MS + 3)).toBe(why)
  })

  it('reads a busy refusal the way the service CLI waits one out', async () => {
    const { handoverBusy } = await import('../../src/providers/daemon-service-cli.js')
    for (const text of ['service.handover: running host_exec jobs must finish first', 'Daemon has active operations; retry after they finish', 'service.handover: active ACP workers or relay requests must finish first']) {
      expect(daemonBusyRefusal(new Error(`Managed daemon update failed: ${text}`))).toBe(true)
      expect(handoverBusy(new Error(text))).toBe(true)
    }
    expect(daemonBusyRefusal(new Error('Managed daemon update failed: the new daemon did not start'))).toBe(false)
    // The daemon's drain that ran out resumed and changed nothing: asked again too (the CLI does not wait it out).
    const drain = 'Service preparation timed out; existing work is still running, retry after it finishes'
    expect(daemonBusyRefusal(new Error(`Managed daemon update failed: ${drain}`))).toBe(true)
    expect(handoverBusy(new Error(drain))).toBe(false)
  })
})

interface Internals {
  readBinaryVersion(): string
  readPortFile(): number | null
  ping(port: number): Promise<unknown>
  readAcpBusySids(): string[]
  auditOwnerOnAdopt(): void
  stopDaemon(): Promise<void>
  spawnDaemon(binaryPath: string): Promise<number>
  assertNoServiceTakeover(): void
  writeOwnerStamp(): void
  updateManagedDaemon(binaryPath: string, expected: string): Promise<number | null>
  scheduleUpgradeRecheck(): void
}

describe('LocalDaemon upgrade', () => {
  let tmpDir = ''
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ld-execruns-'))
    needsPrewarm.mockReset().mockResolvedValue(false)
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function fixture(hello: Record<string, unknown>) {
    const daemon = new LocalDaemon({ daemonDir: tmpDir, binaryPath: path.join(tmpDir, 'bin', 'daemon-new') })
    const i = daemon as unknown as Internals
    vi.spyOn(i, 'readBinaryVersion').mockReturnValue('new-version')
    vi.spyOn(i, 'readPortFile').mockReturnValue(32100)
    const ping = vi.spyOn(i, 'ping').mockResolvedValue({ alive: true, version: 'old-version', capabilities: [], ...hello })
    vi.spyOn(i, 'auditOwnerOnAdopt').mockImplementation(() => {})
    vi.spyOn(i, 'assertNoServiceTakeover').mockImplementation(() => {})
    vi.spyOn(i, 'writeOwnerStamp').mockImplementation(() => {})
    vi.spyOn(i, 'readAcpBusySids').mockReturnValue([])
    const recheck = vi.spyOn(i, 'scheduleUpgradeRecheck').mockImplementation(() => {})
    const stop = vi.spyOn(i, 'stopDaemon').mockResolvedValue(undefined)
    const start = vi.spyOn(i, 'spawnDaemon').mockResolvedValue(32200)
    const managed = vi.spyOn(i, 'updateManagedDaemon').mockResolvedValue(32300)
    return { daemon, ping, recheck, stop, start, managed }
  }

  it('keeps an older daemon with a host_exec run serving and asks again on the clock; goes ahead once none runs', async () => {
    const f = fixture({ execRunning: 1 })
    await expect(f.daemon.ensureRunning()).resolves.toBe(32100)
    expect(f.daemon.port).toBe(32100)
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled()
    expect(f.recheck).toHaveBeenCalledTimes(1)

    f.ping.mockResolvedValue({ alive: true, version: 'old-version', capabilities: [], execRunning: 0 })
    await expect(f.daemon.ensureRunning()).resolves.toBe(32200)
    expect(f.stop).toHaveBeenCalledTimes(1)
  })

  it('a managed daemon with a run is not asked to update either', async () => {
    const f = fixture({ execRunning: 2, capabilities: ['cron-supervision-v1'] })
    await expect(f.daemon.ensureRunning()).resolves.toBe(32100)
    expect(f.managed).not.toHaveBeenCalled()
    expect(f.recheck).toHaveBeenCalledTimes(1)
    f.ping.mockResolvedValueOnce({ alive: true, version: 'old-version', capabilities: ['cron-supervision-v1'] })
      .mockResolvedValue({ alive: true, version: 'new-version', capabilities: ['cron-supervision-v1'] })
    // No run now: the update runs beside the daemon that serves, which the start adopts at once.
    await expect(f.daemon.ensureRunning()).resolves.toBe(32100)
    await f.daemon.managedUpdatePending
    expect(f.managed).toHaveBeenCalledTimes(1)
  })

  it('a daemon without host_exec (no count, no exec.list) is updated as before', async () => {
    const f = fixture({})
    await expect(f.daemon.ensureRunning()).resolves.toBe(32200)
    expect(f.recheck).not.toHaveBeenCalled()
  })

  it('a managed update the daemon refused as busy keeps it serving and asks again on the clock', async () => {
    const f = fixture({ execRunning: 0, capabilities: ['cron-supervision-v1'] })
    f.managed.mockResolvedValue('busy' as never)
    await expect(f.daemon.ensureRunning()).resolves.toBe(32100)
    await f.daemon.managedUpdatePending
    expect(f.managed).toHaveBeenCalledTimes(1)
    expect(f.recheck).toHaveBeenCalledTimes(1)
  })

  it('ping asks a daemon older than the count for its runs on the same socket', async () => {
    // The first deploy of this fix meets the previous daemon: host-exec-v1 and exec.list, no execRunning.
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    const asked: string[] = []
    let jobs: unknown = [{ jobId: 'hx-ios', running: true }, { jobId: 'hx-done', running: false }]
    wss.on('connection', (sock) => sock.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { id: number; cmd: string }
      asked.push(m.cmd)
      // Events come first, as a live daemon pushes them to every client.
      sock.send(JSON.stringify({ event: 'session:status', sessionId: 's1' }))
      if (m.cmd === 'hello') sock.send(JSON.stringify({ id: m.id, ok: true, version: 'old-version', capabilities: ['host-exec-v1'], instanceId: 'd-1' }))
      if (m.cmd === 'exec.list') sock.send(JSON.stringify({ id: m.id, ok: true, jobs }))
    }))
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    try {
      const daemon = new LocalDaemon({ daemonDir: tmpDir, binaryPath: path.join(tmpDir, 'bin', 'daemon-new') })
      const ping = (daemon as unknown as { ping(port: number, ms?: number): Promise<{ alive: boolean; execRunning?: number; version?: string }> }).ping.bind(daemon)
      expect(await ping(port)).toMatchObject({ alive: true, version: 'old-version', execRunning: 1 })
      expect(asked).toEqual(['hello', 'exec.list'])
      jobs = undefined
      expect(await ping(port)).toMatchObject({ alive: true, execRunning: 0 })
    } finally {
      await new Promise<void>((r) => wss.close(() => r()))
    }
  })

  it('a list that never answers still reads the daemon as alive, with no count', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    wss.on('connection', (sock) => sock.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { id: number; cmd: string }
      if (m.cmd === 'hello') sock.send(JSON.stringify({ id: m.id, ok: true, version: 'old-version', capabilities: ['host-exec-v1'] }))
    }))
    await new Promise<void>((r) => wss.once('listening', () => r()))
    try {
      const daemon = new LocalDaemon({ daemonDir: tmpDir, binaryPath: path.join(tmpDir, 'bin', 'daemon-new') })
      const ping = (daemon as unknown as { ping(port: number, ms?: number): Promise<{ alive: boolean; execRunning?: number }> }).ping.bind(daemon)
      const r = await ping((wss.address() as { port: number }).port, 300)
      expect(r.alive).toBe(true)
      expect(r.execRunning).toBeUndefined()
    } finally {
      await new Promise<void>((r) => wss.close(() => r()))
    }
  })
})

describe('the daemon twins', () => {
  const twins = ['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts']
  it.each(twins)('%s: hello says how many host_exec runs go on, and a service handover refuses while one runs', (file) => {
    const src = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8')
    expect(src).toMatch(/execRunning: hostExec\.running\(\)/)
    const handover = src.slice(src.search(/function cmdServiceHandover\(/))
    const refusal = handover.search(/running host_exec jobs must finish first/)
    expect(refusal).toBeGreaterThan(0)
    // Before the drain pauses anything: a refusal changes nothing.
    expect(refusal).toBeLessThan(handover.search(/daemonCommands\.pause\(/))
  })

  it('the refusal reads as a busy daemon to every caller that waits one out', async () => {
    const { handoverBusy } = await import('../../src/providers/daemon-service-cli.js')
    expect(handoverBusy(new Error('service.handover: running host_exec jobs must finish first'))).toBe(true)
  })
})

describe('execRunsProven (a stop that must prove nothing runs)', () => {
  const link = (caps: string[], reply: unknown) => {
    const send = vi.fn(async () => reply)
    return { send, hasCapability: (cap: string) => caps.includes(cap) }
  }

  it('counts the running jobs a daemon with host_exec lists', async () => {
    await expect(execRunsProven(link(['host-exec-v1'], { jobs: [{ running: true }, { running: false }] }), 1_000)).resolves.toBe(1)
    await expect(execRunsProven(link(['host-exec-v1'], { jobs: [] }), 1_000)).resolves.toBe(0)
  })

  it('reads a daemon without host_exec as running none, and never asks it', async () => {
    const l = link([], { ok: false, error: 'exec.list unsupported: host-exec-core sidecar not loaded' })
    await expect(execRunsProven(l, 1_000)).resolves.toBe(0)
    expect(l.send).not.toHaveBeenCalled()
  })

  it('gives no answer (null) when a daemon with host_exec does not list its jobs', async () => {
    await expect(execRunsProven(link(['host-exec-v1'], { ok: false, error: 'busy' }), 1_000)).resolves.toBeNull()
    await expect(execRunsProven(link(['host-exec-v1'], null), 1_000)).resolves.toBeNull()
  })
})
