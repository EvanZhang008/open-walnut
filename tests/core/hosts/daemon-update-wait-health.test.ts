/**
 * A host's daemon update that has waited long reaches Walnut Health once
 * (src/core/hosts/daemon-update-wait-health.ts): not at every minute sweep, never as a needs-you,
 * and it recovers when the update lands. A short wait, or one the person chose, never does.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { raised, recovered } = vi.hoisted(() => ({ raised: [] as Array<Record<string, unknown>>, recovered: [] as string[][] }))
// The store under health-items.ts: what was raised and recovered, and nothing written.
vi.mock('../../../src/core/notifications/store.js', () => ({
  upsertNotification: async (item: Record<string, unknown>) => { raised.push(item); return { record: item, outcome: 'inserted' } },
  recoverNotifications: async (keys: string[]) => { recovered.push(keys); return { recovered: [] } },
}))

import { RECOVER_AFTER_SWEEPS, _resetDaemonUpdateWaitHealthForTesting, daemonUpdateWaitItem, daemonUpdateWaitKey, forgetDaemonUpdateWaits, noteDaemonUpdateWait } from '../../../src/core/hosts/daemon-update-wait-health.js'
import { LONG_POSTPONE_MS, LONG_SKIP_MS, endUpdateWait, noteUpdateWait, type DaemonUpdateWait, type DaemonUpdateWaitKind } from '../../../src/providers/daemon-update-wait.js'
import { audienceOf } from '../../../src/core/notifications/audience.js'
import { setAcpUpgradeHoldFileForTest } from '../../../src/providers/acp-upgrade-hold.js'

const T = new Date(2026, 10, 24, 9, 0).getTime()
const settle = () => new Promise((r) => setTimeout(r, 300))
const postponed: DaemonUpdateWait = { kind: 'postponed', why: 'waiting: service.handover: active ACP workers or relay requests must finish first', since: T, expected: 'build-new' }

beforeEach(() => {
  raised.length = 0
  recovered.length = 0
  _resetDaemonUpdateWaitHealthForTesting()
})

describe('Walnut Health for an update that waits long', () => {
  it('is one Walnut Health item per host, in the sentence the host card says, never a needs-you', () => {
    const item = daemonUpdateWaitItem('devbox', 'Dev box', postponed)
    expect(item).toMatchObject({ kind: 'operation-error', severity: 'warning', category: 'Sessions', host: 'devbox', dedupKey: daemonUpdateWaitKey('devbox'), recoveryKey: daemonUpdateWaitKey('devbox') })
    expect(item.title).toBe('The daemon on Dev box still waits for its update')
    expect(item.body).toMatch(/^The daemon update on Dev box waits \(since (Nov 24, )?9:00 AM\): service\.handover: active ACP workers or relay requests must finish first\. /)
    expect(audienceOf(item as never)).toBe('health')
  })

  it('a long wait is raised once over many sweeps, and recovers when the update lands', async () => {
    // Before the bound: nothing raised (one recovery look for an item an earlier process left).
    noteDaemonUpdateWait('devbox', postponed, T + LONG_POSTPONE_MS - 60_000)
    await settle()
    expect(raised).toEqual([])
    expect(recovered).toEqual([[daemonUpdateWaitKey('devbox')]])
    for (let i = 0; i < 5; i++) noteDaemonUpdateWait('devbox', postponed, T + LONG_POSTPONE_MS + i * 60_000)
    await vi.waitFor(() => expect(raised).toHaveLength(1), { timeout: 10_000 })
    await settle()
    expect(raised).toHaveLength(1)
    // Its reason changes while the same build still waits: still one item.
    noteDaemonUpdateWait('devbox', { ...postponed, why: 'waiting: 1 host_exec run on the host would end with the daemon' }, T + LONG_POSTPONE_MS + 600_000)
    await settle()
    expect(raised).toHaveLength(1)
    // The update landed (endUpdateWait): the sweep finds no wait, and the item recovers at once, once.
    endUpdateWait('devbox')
    noteDaemonUpdateWait('devbox', null, T + LONG_POSTPONE_MS + 700_000)
    noteDaemonUpdateWait('devbox', null, T + LONG_POSTPONE_MS + 760_000)
    await vi.waitFor(() => expect(recovered).toHaveLength(2), { timeout: 10_000 })
    await settle()
    expect(recovered).toEqual([[daemonUpdateWaitKey('devbox')], [daemonUpdateWaitKey('devbox')]])
  })

  it('a connected host that reads no wait for a sweep while its update still waits keeps its item (no raise and recover loop)', async () => {
    // The real gap: SSH makes its decision again every minute (clearUpgradeRecheck), the host network
    // updater says "the host is not connected" for a round and settles 20 s after a reconnect.
    noteDaemonUpdateWait('busybox', postponed, T + LONG_POSTPONE_MS)
    await vi.waitFor(() => expect(raised).toHaveLength(1), { timeout: 10_000 })
    for (let round = 0; round < 5; round++) {
      noteDaemonUpdateWait('busybox', null, T + LONG_POSTPONE_MS + (2 * round + 1) * 60_000)
      noteDaemonUpdateWait('busybox', postponed, T + LONG_POSTPONE_MS + (2 * round + 2) * 60_000)
    }
    await settle()
    expect(recovered).toEqual([])
    expect(raised).toHaveLength(1)
    // No wait for RECOVER_AFTER_SWEEPS sweeps in a row: it is over (a host that runs the build, read late).
    for (let i = 1; i <= RECOVER_AFTER_SWEEPS; i++) noteDaemonUpdateWait('busybox', null, T + LONG_POSTPONE_MS + (20 + i) * 60_000)
    await vi.waitFor(() => expect(recovered).toEqual([[daemonUpdateWaitKey('busybox')]]), { timeout: 10_000 })
  })

  it('only a wait that means something went wrong reaches Health; the person\'s choice and the host\'s steady facts never do', async () => {
    const never: DaemonUpdateWaitKind[] = ['shared', 'unmanaged', 'old-daemon', 'platform-unknown', 'no-binary', 'held', 'turned-off', 'service-set']
    const raisedKinds: DaemonUpdateWaitKind[] = ['gave-up', 'contested', 'refused']
    for (const kind of [...never, ...raisedKinds]) noteDaemonUpdateWait(`h-${kind}`, { kind, why: 'why', since: T, expected: 'b' }, T + 50 * LONG_SKIP_MS)
    await vi.waitFor(() => expect(raised).toHaveLength(raisedKinds.length), { timeout: 10_000 })
    await settle()
    expect(raised.map((i) => i.host).sort()).toEqual(raisedKinds.map((k) => `h-${k}`).sort())
  })

  it('a host removed from the config recovers its item and loses its clocks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-gone-'))
    setAcpUpgradeHoldFileForTest(path.join(dir, 'holds.json'))
    expect(noteUpdateWait('gone', 'postponed', 'busy', 'b9', T).since).toBe(T)
    noteDaemonUpdateWait('gone', postponed, T + LONG_POSTPONE_MS)
    noteDaemonUpdateWait('kept', postponed, T + LONG_POSTPONE_MS)
    await vi.waitFor(() => expect(raised).toHaveLength(2), { timeout: 10_000 })
    forgetDaemonUpdateWaits(new Set(['kept']))
    await vi.waitFor(() => expect(recovered).toEqual([[daemonUpdateWaitKey('gone')]]), { timeout: 10_000 })
    // Its clock went: a wait there again starts now.
    expect(noteUpdateWait('gone', 'postponed', 'busy', 'b9', T + 999).since).toBe(T + 999)
    setAcpUpgradeHoldFileForTest(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
