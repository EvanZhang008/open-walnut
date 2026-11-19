/**
 * The daemon upgrade's wait for open ACP turns ends (src/providers/acp-upgrade-hold.ts): the
 * clock is kept on disk per host, so a new server (every deploy) continues it, and a host whose
 * turns stayed open past the limit gets its upgrade.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ACP_BUSY_STALE_MS, ACP_UPGRADE_HOLD_MAX_MS, ACP_UPGRADE_HOLD_STALE_MS, acpTurnsHold, acpTurnsReason, acpUpgradeHoldFlushedForTest, acpUpgradeHolds, openAcpTurns, setAcpUpgradeHoldFileForTest,
} from '../../src/providers/acp-upgrade-hold.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hold-'))
  setAcpUpgradeHoldFileForTest(path.join(dir, 'acp-upgrade-hold.json'))
})
afterEach(() => {
  setAcpUpgradeHoldFileForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('acpUpgradeHolds', () => {
  /** The minute re-checks of a deferral that lasts from `from` to `to`. */
  const deferEveryMinute = (host: string, from: number, to: number) => {
    let last = { holds: true, heldMs: 0 }
    for (let t = from; t <= to; t += 60_000) last = acpUpgradeHolds(host, true, t)
    return last
  }

  it('holds while turns are open, up to the limit counted from the first deferral, then lets the upgrade go', async () => {
    const t0 = 1_800_000_000_000
    expect(acpUpgradeHolds('devbox', true, t0)).toEqual({ holds: true, heldMs: 0 })
    expect(deferEveryMinute('devbox', t0 + 60_000, t0 + ACP_UPGRADE_HOLD_MAX_MS - 60_000)).toEqual({ holds: true, heldMs: ACP_UPGRADE_HOLD_MAX_MS - 60_000 })
    expect(acpUpgradeHolds('devbox', true, t0 + ACP_UPGRADE_HOLD_MAX_MS)).toEqual({ holds: false, heldMs: ACP_UPGRADE_HOLD_MAX_MS })
    // Another host keeps its own clock.
    expect((acpUpgradeHolds('laptop', true, t0 + ACP_UPGRADE_HOLD_MAX_MS)).holds).toBe(true)
  })

  it('a check with no open turn starts the clock over; the clock is on disk, so a new server keeps it', async () => {
    const t0 = 1_800_000_000_000
    acpUpgradeHolds('devbox', true, t0)
    await acpUpgradeHoldFlushedForTest()
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'acp-upgrade-hold.json'), 'utf8')) as Record<string, unknown>
    expect(stored.devbox).toEqual({ since: t0, seen: t0 })
    // A new server reads it back.
    setAcpUpgradeHoldFileForTest(path.join(dir, 'acp-upgrade-hold.json'))
    expect(acpUpgradeHolds('devbox', true, t0 + 500)).toEqual({ holds: true, heldMs: 500 })
    expect(acpUpgradeHolds('devbox', false, t0 + 1_000)).toEqual({ holds: false, heldMs: 0 })
    expect(acpUpgradeHolds('devbox', true, t0 + ACP_UPGRADE_HOLD_MAX_MS + 5)).toEqual({ holds: true, heldMs: 0 })
  })

  it('a deferral not seen again for a while ended some other way: a later one starts its own clock', async () => {
    const t0 = 1_800_000_000_000
    acpUpgradeHolds('devbox', true, t0)
    // Days later (the daemon came back on the new build meanwhile): no upgrade over turns just opened.
    expect(acpUpgradeHolds('devbox', true, t0 + 3 * 86_400_000)).toEqual({ holds: true, heldMs: 0 })
    expect(acpUpgradeHolds('devbox', true, t0 + 3 * 86_400_000 + 60_000)).toEqual({ holds: true, heldMs: 60_000 })
    // A gap longer than the re-checks ever leave starts it over too.
    expect(acpUpgradeHolds('devbox', true, t0 + 3 * 86_400_000 + 60_000 + ACP_UPGRADE_HOLD_STALE_MS)).toEqual({ holds: true, heldMs: 0 })
  })
})

// The one reader of acp-busy.json every update path uses (this Mac, an SSH host, a host network machine).
describe('openAcpTurns, acpTurnsHold', () => {
  const now = 1_800_000_000_000
  const file = (busySids: unknown, updatedAt: unknown) => JSON.stringify({ busySids, updatedAt })

  it('names the open turns of a fresh file, and nothing for a stale, empty, missing or unreadable one', () => {
    expect(openAcpTurns(file(['a', 'b'], now - 1_000), now)).toEqual(['a', 'b'])
    expect(openAcpTurns(file(['a', 7, null], now), now)).toEqual(['a'])
    expect(openAcpTurns(file(['a'], now - ACP_BUSY_STALE_MS), now)).toEqual([])
    expect(openAcpTurns(file(['a'], 'yesterday'), now)).toEqual([])
    expect(openAcpTurns(file('a', now), now)).toEqual([])
    for (const raw of [null, undefined, '', '  \n', '{not json']) expect(openAcpTurns(raw, now)).toEqual([])
  })

  it('holds on the per-host clock, ends that clock once nothing is open, and says why in words', () => {
    expect(acpTurnsHold('devbox', file(['a'], now), now)).toEqual({ busySids: ['a'], holds: true, heldMs: 0 })
    expect(acpTurnsHold('devbox', file(['a'], now + 60_000), now + 60_000)).toEqual({ busySids: ['a'], holds: true, heldMs: 60_000 })
    expect(acpTurnsHold('devbox', file([], now + 120_000), now + 120_000)).toEqual({ busySids: [], holds: false, heldMs: 0 })
    expect(acpTurnsHold('devbox', file(['a'], now + 180_000), now + 180_000)).toEqual({ busySids: ['a'], holds: true, heldMs: 0 })
    expect(acpTurnsReason(['a'])).toBe('1 ACP turn open on the host would end with the daemon')
    expect(acpTurnsReason(['a', 'b'])).toBe('2 ACP turns open on the host would end with the daemon')
    expect(acpTurnsReason([])).toBeNull()
  })
})
