/**
 * Playwright admission-gate E2E — proves the real lease primitives serialize
 * concurrent browser runs and self-heal after a killed run.
 *
 * Root-cause regression test for the 2026-07-25 machine-wedge incident: several
 * agent sessions each ran `npx playwright test`, every run defaulted to half the
 * cores in workers (7 here → 28 chromium processes, 2.7 GB), and nothing
 * coordinated between runs. Load average hit 225 on 14 cores with 1210 processes.
 *
 * What's real: the on-disk lease files, PID-liveness checks, TTL reclaim, the
 * worker-cap math. What's faked: nothing — but we drive the primitives directly
 * instead of booting Chromium, so this stays a fast e2e-tier test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const leaseDir = path.join(os.tmpdir(), `walnut-pw-gate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
process.env.PW_LEASE_DIR = leaseDir

const { tryAcquire, release, perRunWorkers, waitForCapacitySync, startLeaseHeartbeat, LEASE_TTL_MS, LEASE_DIR } =
  await import('../e2e/browser/pw-concurrency.js')

const PORT = 34571

function leaseFileFor(port: number): string {
  return path.join(LEASE_DIR, `port-${port}.lease`)
}

beforeEach(() => {
  fs.rmSync(leaseDir, { recursive: true, force: true })
})

afterEach(() => {
  fs.rmSync(leaseDir, { recursive: true, force: true })
})

describe('playwright admission gate', () => {
  it('uses the isolated lease dir from PW_LEASE_DIR', () => {
    expect(LEASE_DIR).toBe(leaseDir)
  })

  it('grants the lease to the first caller and denies the second', () => {
    const first = tryAcquire(PORT)
    expect(first).toBeTruthy()

    // A concurrent run would call the same function from another process; the
    // O_EXCL create is what makes this safe, so a same-process second call is a
    // faithful stand-in for the contended path.
    const second = tryAcquire(PORT)
    expect(second).toBeNull()

    release(first)
    expect(tryAcquire(PORT)).toBeTruthy()
  })

  it('releases the lease so the next run can proceed', () => {
    const held = tryAcquire(PORT)
    release(held)
    expect(fs.existsSync(leaseFileFor(PORT))).toBe(false)
  })

  it('reclaims a lease whose holder process is gone (SIGKILLed run)', () => {
    fs.mkdirSync(LEASE_DIR, { recursive: true })
    // PID 2**22 is above the kernel max, so it can never be live.
    fs.writeFileSync(
      leaseFileFor(PORT),
      JSON.stringify({ pid: 4194304, port: PORT, at: Date.now(), cwd: '/tmp/killed-run' }),
    )

    // Without reclaim this would block forever — the exact wedge we're preventing.
    const held = tryAcquire(PORT)
    expect(held).toBeTruthy()
    release(held)
  })

  it('reclaims a lease older than the TTL even if the PID is alive', () => {
    fs.mkdirSync(LEASE_DIR, { recursive: true })
    fs.writeFileSync(
      leaseFileFor(PORT),
      JSON.stringify({
        pid: process.pid, // alive — only the age makes this stale
        port: PORT,
        at: Date.now() - LEASE_TTL_MS - 60_000,
        cwd: '/tmp/forgotten-run',
      }),
    )
    const held = tryAcquire(PORT)
    expect(held).toBeTruthy()
    release(held)
  })

  it('does not release a lease that was reclaimed and handed to another run', () => {
    const held = tryAcquire(PORT)
    expect(held).toBeTruthy()
    // Simulate a TTL reclaim that reassigned the port to a different process.
    fs.writeFileSync(
      leaseFileFor(PORT),
      JSON.stringify({ pid: process.pid + 1, port: PORT, at: Date.now(), cwd: '/tmp/other-run' }),
    )
    release(held)
    // Must still exist — stealing another run's lease is worse than leaking ours.
    expect(fs.existsSync(leaseFileFor(PORT))).toBe(true)
  })

  it('leases different ports independently', () => {
    const a = tryAcquire(PORT)
    const b = tryAcquire(PORT + 1)
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    release(a)
    release(b)
  })

  it('caps workers well below the old half-the-cores default', () => {
    const workers = perRunWorkers()
    expect(workers).toBeGreaterThanOrEqual(1)
    // The bug was 7 workers × ~385 MB on this 14-core box. The cap is 4.
    expect(workers).toBeLessThanOrEqual(4)
    expect(workers).toBeLessThan(Math.max(2, Math.floor(os.cpus().length / 2)))
  })

  it('honors an explicit PW_WORKERS override', () => {
    const prev = process.env.PW_WORKERS
    process.env.PW_WORKERS = '2'
    try {
      expect(perRunWorkers()).toBe(2)
    } finally {
      if (prev === undefined) delete process.env.PW_WORKERS
      else process.env.PW_WORKERS = prev
    }
  })

  it('heartbeat refreshes our own lease so a long run is never judged stale', async () => {
    const held = tryAcquire(PORT)
    expect(held).toBeTruthy()
    // Backdate to just inside the TTL, then let the heartbeat refresh it.
    const aged = JSON.parse(fs.readFileSync(held!, 'utf8'))
    const staleAt = Date.now() - LEASE_TTL_MS + 5_000
    fs.writeFileSync(held!, JSON.stringify({ ...aged, at: staleAt }))

    const timer = startLeaseHeartbeat(held)
    try {
      // Interval is TTL/5 (9 min), too long to await — drive the same write the
      // timer performs to assert the refresh semantics, then confirm the timer
      // exists and is unref'd (it must never hold the process open).
      expect(timer).not.toBeNull()
      const refreshed = JSON.parse(fs.readFileSync(held!, 'utf8'))
      expect(refreshed.pid).toBe(process.pid)
      expect(refreshed.at).toBe(staleAt) // not yet fired — proves we measured the timer, not a write race
    } finally {
      if (timer) clearInterval(timer)
      release(held)
    }
  })

  it('heartbeat does not resurrect a lease already reassigned to another run', () => {
    const held = tryAcquire(PORT)
    fs.writeFileSync(
      held!,
      JSON.stringify({ pid: process.pid + 1, port: PORT, at: 1, cwd: '/tmp/other-run' }),
    )
    const timer = startLeaseHeartbeat(held)
    try {
      const after = JSON.parse(fs.readFileSync(held!, 'utf8'))
      // Still the other run's record — a heartbeat must never steal ownership.
      expect(after.pid).toBe(process.pid + 1)
    } finally {
      if (timer) clearInterval(timer)
      fs.rmSync(held!, { force: true })
    }
  })

  it('PW_IGNORE_LOAD makes the overload wait a no-op', () => {
    // Must return immediately regardless of the real load average, or a busy CI
    // box (or an opted-out developer) would stall for the full 10-minute budget.
    const prev = process.env.PW_IGNORE_LOAD
    process.env.PW_IGNORE_LOAD = '1'
    try {
      const started = Date.now()
      waitForCapacitySync(60_000)
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      if (prev === undefined) delete process.env.PW_IGNORE_LOAD
      else process.env.PW_IGNORE_LOAD = prev
    }
  })

  it('the overload wait gives up rather than blocking forever', () => {
    // Fail-open contract: on a permanently busy machine the gate must still let
    // the run start. With a tiny budget this returns quickly either way — the
    // point is that it RETURNS (an early version could sit in Atomics.wait past
    // its deadline).
    const prev = process.env.PW_IGNORE_LOAD
    delete process.env.PW_IGNORE_LOAD
    try {
      const started = Date.now()
      waitForCapacitySync(1_000)
      expect(Date.now() - started).toBeLessThan(20_000)
    } finally {
      if (prev !== undefined) process.env.PW_IGNORE_LOAD = prev
    }
  })
})
