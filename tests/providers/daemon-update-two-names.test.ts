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
import { acpUpgradeHoldFlushedForTest, setAcpUpgradeHoldFileForTest } from '../../src/providers/acp-upgrade-hold.js'
import type { NothingChanged } from '../../src/providers/daemon-update-claim.js'

const NAMES = async () => ['clouddev', 'newdev']

describe('a busy daemon with two host names', () => {
  let dir = ''
  let holds = ''
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'two-names-'))
    holds = path.join(dir, 'holds.json')
    setAcpUpgradeHoldFileForTest(holds)
    vi.useFakeTimers()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await acpUpgradeHoldFlushedForTest()
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

  /** A leader restart (a deploy): the claims in memory are gone, the hold clocks are read back from disk. */
  const restart = async () => {
    await acpUpgradeHoldFlushedForTest()
    resetDaemonUpdateClaims({ restart: true })
    setAcpUpgradeHoldFileForTest(holds)
  }

  /** One try of one name, as both paths take it; `end` is how its own try ends when it gets the claim. */
  const tryOnce = async (name: string, now: number, end: () => true | NothingChanged, log: string[]): Promise<boolean> => {
    vi.setSystemTime(now)
    if (await daemonUpdateHeldBy(name, NAMES, now)) { log.push(`${name} defers`); return false }
    const claim = await claimDaemonUpdate(name, NAMES, now)
    if ('heldBy' in claim) { log.push(`${name} defers`); return false }
    const how = end()
    claim.release(how)
    log.push(`${name} ${how === true ? 'updated' : how}`)
    return how === true
  }

  it.each([
    ['no restart', 0],
    ['a leader restart before every try of newdev', 1],
  ])("newdev's every try fails on its own link (SSH login refused): clouddev goes at its next try (%s)", async (_what, restartEvery) => {
    // 2026-11-24 14:15Z: newdev's uploads waited on an SSH login that was refused (auth) at every try,
    // each try kept the claim 'held', and clouddev read "its update there was just refused" every minute.
    const start = new Date(2026, 10, 24, 14, 15).getTime()
    const log: string[] = []
    let updatedAt: number | null = null
    for (let minute = 0; minute < 30 && updatedAt === null; minute++) {
      const now = start + minute * 60_000
      if (minute % 2 === 0) {
        if (restartEvery) await restart()
        await tryOnce('newdev', now, () => 'own-path', log)
      }
      if (await tryOnce('clouddev', now + 20_000, () => true, log)) updatedAt = now + 20_000
    }
    expect(updatedAt, log.join('\n')).toBe(start + 20_000)
    expect(log).not.toContain('clouddev defers')
  })

  it('newdev refused by the host at every try, the leader restarting every few minutes: clouddev still takes its turn within UPDATE_CLAIM_TURN_MS', async () => {
    // The turn count used to live in memory only, so a deploy every few minutes started it over and only
    // the 3 h overdue clock bounded clouddev's wait. The worst order: each restart right before newdev's try.
    const start = new Date(2026, 10, 24, 14, 15).getTime()
    const log: string[] = []
    let updatedAt: number | null = null
    for (let minute = 0; minute < 3 * 60 && updatedAt === null; minute++) {
      const now = start + minute * 60_000
      if (minute % 2 === 0) {
        if (minute % 6 === 0) await restart()
        await tryOnce('newdev', now, () => 'held', log)
      }
      if (await tryOnce('clouddev', now + 20_000, () => true, log)) updatedAt = now + 20_000
    }
    expect(updatedAt, log.slice(-6).join('\n')).not.toBeNull()
    expect(updatedAt! - start).toBeLessThanOrEqual(UPDATE_CLAIM_TURN_MS + 2 * 60_000)
    // It did defer first: a host refusal still holds the other name within its turn.
    expect(log[1]).toBe('clouddev defers')
  })
})
