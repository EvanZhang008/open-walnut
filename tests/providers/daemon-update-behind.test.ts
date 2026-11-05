/**
 * The one bound on a daemon update (src/providers/daemon-update-behind.ts): counted from when the
 * host was first seen on another build, whatever the reason each check found, kept on disk, and
 * cleared once the host runs this build. 2026-11-05: reasons taking turns restarted every per-reason
 * clock, and clouddev stayed on an old daemon for about 17.6 hours.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acpUpgradeHoldFlushedForTest, acpUpgradeHolds, setAcpUpgradeHoldFileForTest } from '../../src/providers/acp-upgrade-hold.js'
import { DAEMON_UPDATE_BEHIND_MAX_MS, DAEMON_UPDATE_BEHIND_STALE_MS, daemonUpdateOverdue } from '../../src/providers/daemon-update-behind.js'
import { execRunsWait } from '../../src/providers/exec-runs-hold.js'

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-behind-'))
  file = path.join(dir, 'acp-upgrade-hold.json')
  setAcpUpgradeHoldFileForTest(file)
})
afterEach(() => {
  setAcpUpgradeHoldFileForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

const t0 = 1_800_000_000_000
const MIN = 60_000

describe('daemonUpdateOverdue', () => {
  it('reasons taking turns never restart it: overdue after the bound though each reason\'s own clock keeps starting over', () => {
    let last = { overdue: false, behindMs: 0 }
    for (let t = t0; t < t0 + DAEMON_UPDATE_BEHIND_MAX_MS; t += MIN) {
      // Every other check sees host_exec runs, the others see none (another reason held them).
      const runs = (t - t0) / MIN % 2 === 0
      expect(execRunsWait('devbox', runs ? '1 host_exec run(s) on the host would end with the daemon' : null, t)).toBe(runs ? '1 host_exec run(s) on the host would end with the daemon' : null)
      last = daemonUpdateOverdue('devbox', 'old-build', true, t)
      expect(last.overdue).toBe(false)
    }
    expect(last.behindMs).toBe(DAEMON_UPDATE_BEHIND_MAX_MS - MIN)
    // The per-reason clock is still young: it alone would hold for hours more.
    expect(acpUpgradeHolds('devbox', true, t0 + DAEMON_UPDATE_BEHIND_MAX_MS).holds).toBe(true)
    expect(daemonUpdateOverdue('devbox', 'old-build', true, t0 + DAEMON_UPDATE_BEHIND_MAX_MS)).toEqual({ overdue: true, behindMs: DAEMON_UPDATE_BEHIND_MAX_MS })
    // Each host has its own.
    expect(daemonUpdateOverdue('laptop', 'old-build', true, t0 + DAEMON_UPDATE_BEHIND_MAX_MS).overdue).toBe(false)
  })

  it('kept on disk, so a new server (every deploy) continues it; the host on this build clears it', async () => {
    daemonUpdateOverdue('devbox', 'old-build', true, t0)
    daemonUpdateOverdue('devbox', 'old-build', true, t0 + 10 * MIN)
    await acpUpgradeHoldFlushedForTest()
    setAcpUpgradeHoldFileForTest(file)
    expect(daemonUpdateOverdue('devbox', 'old-build', true, t0 + 20 * MIN)).toEqual({ overdue: false, behindMs: 20 * MIN })
    expect(daemonUpdateOverdue('devbox', 'old-build', false, t0 + 21 * MIN)).toEqual({ overdue: false, behindMs: 0 })
    expect(daemonUpdateOverdue('devbox', 'old-build', true, t0 + 22 * MIN)).toEqual({ overdue: false, behindMs: 0 })
  })

  it('an update that landed starts it over, even on a build already old again after a deploy', () => {
    // The review's case: behind 3 h, updated to A, then a deploy expects B before any check saw A.
    for (let t = t0; t <= t0 + DAEMON_UPDATE_BEHIND_MAX_MS; t += 30 * MIN) daemonUpdateOverdue('devbox', 'old-build', true, t)
    expect(daemonUpdateOverdue('devbox', 'old-build', true, t0 + DAEMON_UPDATE_BEHIND_MAX_MS).overdue).toBe(true)
    const after = t0 + DAEMON_UPDATE_BEHIND_MAX_MS + MIN
    expect(daemonUpdateOverdue('devbox', 'build-a', true, after)).toEqual({ overdue: false, behindMs: 0 })
    // The old build's clock is gone: a host that went back to it starts over too.
    expect(daemonUpdateOverdue('devbox', 'old-build', true, after + MIN)).toEqual({ overdue: false, behindMs: 0 })
  })

  it('a host not checked for a long while starts over, but the longest recheck gap does not', () => {
    daemonUpdateOverdue('devbox', 'old-build', true, t0)
    expect(daemonUpdateOverdue('devbox', 'old-build', true, t0 + 20 * MIN).behindMs).toBe(20 * MIN)
    const later = t0 + 20 * MIN + DAEMON_UPDATE_BEHIND_STALE_MS
    expect(daemonUpdateOverdue('devbox', 'old-build', true, later)).toEqual({ overdue: false, behindMs: 0 })
  })
})
