/**
 * A local daemon upgrade waits for the new binary's fold prewarm, and the old
 * daemon keeps serving meanwhile (src/providers/fold-prewarm.ts).
 *
 * Incident 2026-10-26: a version change stopped the old daemon at once, and the
 * new one folded 8.8 GB of live streams before it listened: 7 minutes in which
 * every local session failed with "port file not created within 10s".
 *
 * The prewarm itself is stubbed here (its real run is pinned by
 * tests/providers/fold-prewarm.test.ts and the twins e2e); stopDaemon and
 * spawnDaemon are spies, so no process is signalled or started.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { needsPrewarm, runPrewarm } = vi.hoisted(() => ({ needsPrewarm: vi.fn(), runPrewarm: vi.fn() }))
vi.mock('../../src/providers/fold-prewarm.js', () => ({
  registryNeedsFoldPrewarm: needsPrewarm,
  runFoldPrewarm: runPrewarm,
}))

import { LocalDaemon } from '../../src/providers/local-daemon.js'

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
}

let tmpDir = ''

function upgradeFixture() {
  const binary = path.join(tmpDir, 'bin', 'daemon-new')
  const daemon = new LocalDaemon({ daemonDir: tmpDir, binaryPath: binary })
  const internals = daemon as unknown as Internals
  vi.spyOn(internals, 'readBinaryVersion').mockReturnValue('new-version')
  vi.spyOn(internals, 'readPortFile').mockReturnValue(32100)
  vi.spyOn(internals, 'ping').mockResolvedValue({ alive: true, version: 'old-version', capabilities: [] })
  vi.spyOn(internals, 'auditOwnerOnAdopt').mockImplementation(() => {})
  vi.spyOn(internals, 'assertNoServiceTakeover').mockImplementation(() => {})
  vi.spyOn(internals, 'writeOwnerStamp').mockImplementation(() => {})
  const busy = vi.spyOn(internals, 'readAcpBusySids').mockReturnValue([])
  const stop = vi.spyOn(internals, 'stopDaemon').mockResolvedValue(undefined)
  const start = vi.spyOn(internals, 'spawnDaemon').mockResolvedValue(32200)
  return { daemon, binary, busy, stop, start }
}

/** A prewarm the test settles by hand. */
function pendingPrewarm() {
  let settle!: { resolve: (v: unknown) => void; reject: (e: Error) => void }
  runPrewarm.mockImplementation(() => new Promise((resolve, reject) => { settle = { resolve, reject } }))
  return () => settle
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(check()).toBe(true)
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ld-prewarm-'))
  needsPrewarm.mockReset().mockResolvedValue(true)
  runPrewarm.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('LocalDaemon upgrade with a fold prewarm', () => {
  it('keeps the old daemon serving until the prewarm is over, then upgrades once', async () => {
    const settle = pendingPrewarm()
    const { daemon, binary, stop, start } = upgradeFixture()

    await expect(daemon.ensureRunning()).resolves.toBe(32100)
    expect(daemon.port).toBe(32100)
    expect(stop).not.toHaveBeenCalled()
    expect(runPrewarm).toHaveBeenCalledTimes(1)
    expect(runPrewarm.mock.calls[0][0]).toMatchObject({ binaryPath: binary, version: 'new-version', daemonDir: tmpDir })
    expect(runPrewarm.mock.calls[0][0].env.WALNUT_DAEMON_DIR).toBe(tmpDir)

    // A reconnect while it runs: still the old daemon, and no second prewarm.
    await expect(daemon.ensureRunning()).resolves.toBe(32100)
    expect(runPrewarm).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()

    settle().resolve({ outcome: 'ran', sessions: 3, written: 2, ms: 10 })
    await until(() => start.mock.calls.length === 1)
    expect(stop).toHaveBeenCalledTimes(1)
    await until(() => daemon.port === 32200)
    expect(runPrewarm).toHaveBeenCalledTimes(1)
  })

  it('a failed prewarm still lets the upgrade go ahead', async () => {
    const settle = pendingPrewarm()
    const { daemon, stop, start } = upgradeFixture()
    await expect(daemon.ensureRunning()).resolves.toBe(32100)
    settle().reject(new Error('fold prewarm exceeded 600s'))
    await until(() => start.mock.calls.length === 1)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('no stream worth preparing: the upgrade goes ahead at once', async () => {
    needsPrewarm.mockResolvedValue(false)
    const { daemon, stop, start } = upgradeFixture()
    await expect(daemon.ensureRunning()).resolves.toBe(32200)
    expect(runPrewarm).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('open ACP turns still defer first, and the prewarm starts only once they close', async () => {
    const settle = pendingPrewarm()
    const { daemon, busy, stop } = upgradeFixture()
    busy.mockReturnValue(['acp-1'])
    await expect(daemon.ensureRunning()).resolves.toBe(32100)
    expect(runPrewarm).not.toHaveBeenCalled()
    busy.mockReturnValue([])
    await expect(daemon.ensureRunning()).resolves.toBe(32100)
    expect(runPrewarm).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
    settle().resolve({ outcome: 'ran', ms: 1 })
    await until(() => stop.mock.calls.length === 1)
  })

  it('the same version never prewarms twice in one server', async () => {
    runPrewarm.mockResolvedValue({ outcome: 'ran', ms: 1 })
    const { daemon, start } = upgradeFixture()
    await expect(daemon.ensureRunning()).resolves.toBe(32100)
    await until(() => start.mock.calls.length === 1 && daemon.starting === null)
    // A later mismatch for the same version (the new daemon died and an old one is back).
    await daemon.ensureRunning()
    expect(runPrewarm).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(2)
  })
})
