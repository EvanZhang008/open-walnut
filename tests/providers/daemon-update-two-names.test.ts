/**
 * One busy daemon reached under two host names updates within a bound (2026-11-24: clouddev, a host
 * network link, and newdev, an SSH link to the same machine and daemon). The machine always ran ACP
 * workers, so the daemon refused every plain swap ("service.handover: active ACP workers or relay
 * requests must finish first"). newdev tried every two minutes and was refused; its claim stayed for
 * the settle window after each refusal and newdev took it again at its next try, so clouddev read
 * "newdev reaches the same daemon and is updating it, or just did" at every try and never went, even
 * once its own update was overdue (daemon-update-behind.ts), when it would have gone over the work.
 *
 * What's real: the update claim (daemon-update-claim.ts) and the overdue clock (daemon-update-behind.ts,
 * kept in a temp file). What's faked: the daemon, which refuses every swap that is not forced, and the
 * two update paths, reduced to their order of steps: the overdue verdict, the peer check, the claim, the
 * swap, the release. newdev is the worst case: its forced tries are spent, so it never forces.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claimDaemonUpdate, daemonUpdateHeldBy, resetDaemonUpdateClaims, UPDATE_CLAIM_MAX_MS, UPDATE_CLAIM_TURN_MS } from '../../src/providers/daemon-update-claim.js'
import { DAEMON_UPDATE_BEHIND_MAX_MS, daemonUpdateOverdue } from '../../src/providers/daemon-update-behind.js'
import { setAcpUpgradeHoldFileForTest } from '../../src/providers/acp-upgrade-hold.js'

const NAMES = async () => ['clouddev', 'newdev']

describe('a busy daemon with two host names', () => {
  let dir = ''
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'two-names-'))
    setAcpUpgradeHoldFileForTest(path.join(dir, 'holds.json'))
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetDaemonUpdateClaims()
    setAcpUpgradeHoldFileForTest(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('one path always refused and never forcing: the other goes over the work once overdue, within the bound', async () => {
    const start = new Date(2026, 10, 24, 1, 57).getTime()
    let running = 'build-old'
    const daemon = { swap: (forced: boolean) => { if (forced) running = 'build-new'; return forced } }
    const log: string[] = []
    /** One try of one name, in the order both paths take: verdict, peer check, claim, swap, release. */
    const attempt = async (name: string, now: number, canForce: boolean): Promise<void> => {
      vi.setSystemTime(now)
      const behind = daemonUpdateOverdue(name, running, running !== 'build-new', now)
      if (running === 'build-new') return
      const ask = { overdue: behind.overdue }
      if (await daemonUpdateHeldBy(name, NAMES, now, ask)) { log.push(`${name} defers`); return }
      const claim = await claimDaemonUpdate(name, NAMES, now, ask)
      if ('heldBy' in claim) { log.push(`${name} defers`); return }
      const ok = daemon.swap(canForce && behind.overdue)
      claim.release(ok ? true : 'held')
      log.push(`${name} ${ok ? 'updated' : 'refused'}`)
    }
    let updatedAt: number | null = null
    for (let minute = 0; minute < 8 * 60 && updatedAt === null; minute++) {
      const now = start + minute * 60_000
      // newdev (SSH) asks every two minutes and is always refused; clouddev (host network) every minute.
      if (minute % 2 === 0) await attempt('newdev', now, false)
      await attempt('clouddev', now + 20_000, true)
      if (running === 'build-new') updatedAt = now + 20_000
    }
    expect(updatedAt, log.slice(-6).join('\n')).not.toBeNull()
    // Overdue at the bound, then at most one turn and one try under way.
    expect(updatedAt! - start).toBeLessThanOrEqual(DAEMON_UPDATE_BEHIND_MAX_MS + UPDATE_CLAIM_TURN_MS + UPDATE_CLAIM_MAX_MS)
    // Both names tried while it was not overdue: turns, not one name holding the other for hours.
    expect(log, [...new Set(log)].join(',')).toContain('clouddev refused')
  })
})
