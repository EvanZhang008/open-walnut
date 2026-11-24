/**
 * One daemon update at a time per daemon, whichever of its host names starts it
 * (src/providers/daemon-update-claim.ts). 2026-11-22: clouddev (host network) and newdev (SSH),
 * one daemon, each updated it on its own; 4.66 GB went up in a day for updates that failed on
 * the other's lock.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acpUpgradeHoldFlushedForTest, setAcpUpgradeHoldFileForTest } from '../../src/providers/acp-upgrade-hold.js'
import {
  UPDATE_CLAIM_MAX_MS, UPDATE_CLAIM_SETTLE_MS, UPDATE_CLAIM_TURN_MS, claimDaemonUpdate, daemonUpdateHeldBy, peerUpdatingWhy, resetDaemonUpdateClaims,
} from '../../src/providers/daemon-update-claim.js'

afterEach(() => resetDaemonUpdateClaims())

const names = (...n: string[]) => async () => n

describe('claimDaemonUpdate', () => {
  it('a claim holds the daemon for its other names, never for itself or another daemon', async () => {
    const c = await claimDaemonUpdate('clouddev', names('clouddev', 'newdev'), 1_000)
    expect('heldBy' in c).toBe(false)
    expect(await claimDaemonUpdate('newdev', names('clouddev', 'newdev'), 1_001)).toEqual({ heldBy: 'clouddev' })
    expect(await daemonUpdateHeldBy('newdev', names('newdev', 'clouddev'), 1_001)).toBe('clouddev')
    expect(await daemonUpdateHeldBy('clouddev', names('clouddev', 'newdev'), 1_001)).toBeNull()
    expect(await daemonUpdateHeldBy('olddev', names('olddev'), 1_001)).toBeNull()
  })

  it('reads no names while nothing else is claimed (the common case costs no I/O)', async () => {
    const read = vi.fn(async () => ['a', 'b'])
    const mine = await claimDaemonUpdate('a', read)
    expect('heldBy' in mine).toBe(false)
    expect(await daemonUpdateHeldBy('a', read)).toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect(await daemonUpdateHeldBy('b', read)).toBe('a')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('names that cannot be read are just this one: the update is not held by them', async () => {
    await claimDaemonUpdate('clouddev', names('clouddev'))
    expect(await claimDaemonUpdate('newdev', async () => { throw new Error('profile unreadable') })).not.toHaveProperty('heldBy')
  })

  it('an update that went through holds the others for the settle window only; one that failed frees them at once', async () => {
    const ok = await claimDaemonUpdate('clouddev', names('newdev'))
    if ('heldBy' in ok) throw new Error('unexpected')
    ok.release(true)
    expect(await daemonUpdateHeldBy('newdev', names('clouddev'), Date.now() + UPDATE_CLAIM_SETTLE_MS - 5_000)).toBe('clouddev')
    expect(await daemonUpdateHeldBy('newdev', names('clouddev'), Date.now() + UPDATE_CLAIM_SETTLE_MS + 5_000)).toBeNull()
    const bad = await claimDaemonUpdate('newdev', names('clouddev'))
    if ('heldBy' in bad) throw new Error('unexpected')
    bad.release(false)
    bad.release(true) // a second release changes nothing
    expect(await daemonUpdateHeldBy('clouddev', names('newdev'))).toBeNull()
  })

  it('a claim nobody released (a server stopped mid-update) lets go after its bound', async () => {
    await claimDaemonUpdate('clouddev', names('newdev'), 0)
    expect(await daemonUpdateHeldBy('newdev', names('clouddev'), UPDATE_CLAIM_MAX_MS - 1)).toBe('clouddev')
    expect(await daemonUpdateHeldBy('newdev', names('clouddev'), UPDATE_CLAIM_MAX_MS + 1)).toBeNull()
  })

  it('two names asking at once: the one whose names came back second sees the first claim', async () => {
    await claimDaemonUpdate('olddev', names('olddev'))   // some other claim: both read their names
    let open!: () => void
    const slow = () => new Promise<string[]>((r) => { open = () => r(['newdev', 'clouddev']) })
    const second = claimDaemonUpdate('newdev', slow)
    const first = await claimDaemonUpdate('clouddev', names('clouddev', 'newdev'))
    expect('heldBy' in first).toBe(false)
    open()
    expect(await second).toEqual({ heldBy: 'clouddev' })
  })

  it('a host name with spaces or Unicode is a name like any other', async () => {
    const name = 'Studio’s Mac \u{1F680}'
    await claimDaemonUpdate(name, names('studio'))
    expect(await daemonUpdateHeldBy('studio', names(name))).toBe(name)
    expect(peerUpdatingWhy(name)).toBe(`${name} reaches the same daemon and is updating it now`)
  })
})

describe('turns: a refused try never holds the other names for good (2026-11-24)', () => {
  const both = names('clouddev', 'newdev')

  it('a try under way holds the others; once refused it holds them only within their turn, and never an overdue one', async () => {
    const t0 = Date.now()
    const a = await claimDaemonUpdate('newdev', both, t0)
    if ('heldBy' in a) throw new Error('unexpected')
    expect(await daemonUpdateHeldBy('clouddev', both, t0 + 1_000, { overdue: true })).toBe('newdev')
    expect(peerUpdatingWhy('newdev')).toBe('newdev reaches the same daemon and is updating it now')
    a.release('held')
    expect(peerUpdatingWhy('newdev')).toMatch(/its update there was just refused; this name takes its turn within 15 min/)
    expect(await daemonUpdateHeldBy('clouddev', both, Date.now(), { overdue: true })).toBeNull()
    expect(await daemonUpdateHeldBy('clouddev', both, Date.now())).toBe('newdev')
  })

  it('one name whose every try is refused, asking again every two minutes, and the other asking every minute: the other gets its turn by UPDATE_CLAIM_TURN_MS', async () => {
    // newdev claims, is refused after a minute (service.handover: active ACP workers), and asks again a minute later.
    vi.useFakeTimers()
    try {
      const start = Date.now()
      let clouddevClaimedAt: number | null = null
      let held: Awaited<ReturnType<typeof claimDaemonUpdate>> | null = null
      for (let minute = 0; minute < 60 && clouddevClaimedAt === null; minute++) {
        const now = start + minute * 60_000
        vi.setSystemTime(now)
        if (minute % 2 === 0) {
          held = await claimDaemonUpdate('newdev', both, now)
        } else if (held && !('heldBy' in held)) {
          held.release('held')
        }
        const mine = await claimDaemonUpdate('clouddev', both, now + 30_000)
        if (!('heldBy' in mine)) clouddevClaimedAt = now + 30_000
      }
      expect(clouddevClaimedAt).not.toBeNull()
      expect(clouddevClaimedAt! - start).toBeLessThanOrEqual(UPDATE_CLAIM_TURN_MS + UPDATE_CLAIM_MAX_MS)
    } finally { vi.useRealTimers() }
  })
})

describe('whose side said no: only a refusal by the host holds the other names (2026-11-24)', () => {
  const both = names('clouddev', 'newdev')

  it("a try that failed on this name's own way there ('own-path') frees the claim at once, as a failure does", async () => {
    const t0 = Date.now()
    const a = await claimDaemonUpdate('newdev', both, t0)
    if ('heldBy' in a) throw new Error('unexpected')
    a.release('own-path')
    expect(await daemonUpdateHeldBy('clouddev', both, t0 + 1_000)).toBeNull()
    expect(await claimDaemonUpdate('clouddev', both, t0 + 1_000)).not.toHaveProperty('heldBy')
  })

  it('the turn count survives a leader restart: a name past its turn goes, though the claims were forgotten', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-turns-'))
    const file = path.join(dir, 'holds.json')
    setAcpUpgradeHoldFileForTest(file)
    vi.useFakeTimers()
    try {
      const t0 = Date.now()
      const refusedTry = async (now: number) => {
        vi.setSystemTime(now)
        const c = await claimDaemonUpdate('newdev', both, now)
        if ('heldBy' in c) throw new Error('unexpected')
        c.release('held')
      }
      await refusedTry(t0)
      expect(await daemonUpdateHeldBy('clouddev', both, t0 + 1_000)).toBe('newdev')
      // A restart: the claims are gone, the turn row is read back from disk.
      await acpUpgradeHoldFlushedForTest()
      resetDaemonUpdateClaims({ restart: true })
      setAcpUpgradeHoldFileForTest(file)
      await refusedTry(t0 + UPDATE_CLAIM_TURN_MS - 60_000)
      expect(await daemonUpdateHeldBy('clouddev', both, t0 + UPDATE_CLAIM_TURN_MS - 30_000)).toBe('newdev')
      await acpUpgradeHoldFlushedForTest()
      resetDaemonUpdateClaims({ restart: true })
      setAcpUpgradeHoldFileForTest(file)
      await refusedTry(t0 + UPDATE_CLAIM_TURN_MS + 60_000)
      // Deferred since t0 across both restarts: its turn came.
      expect(await daemonUpdateHeldBy('clouddev', both, t0 + UPDATE_CLAIM_TURN_MS + 61_000)).toBeNull()
      // A full reset (tests) drops the turns too: a fresh row holds again.
      resetDaemonUpdateClaims()
      await refusedTry(t0 + UPDATE_CLAIM_TURN_MS + 120_000)
      expect(await daemonUpdateHeldBy('clouddev', both, t0 + UPDATE_CLAIM_TURN_MS + 121_000)).toBe('newdev')
    } finally {
      vi.useRealTimers()
      await acpUpgradeHoldFlushedForTest()
      setAcpUpgradeHoldFileForTest(null)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
