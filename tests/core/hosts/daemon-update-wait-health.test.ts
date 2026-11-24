/**
 * A host's daemon update that has waited long reaches Walnut Health once
 * (src/core/hosts/daemon-update-wait-health.ts): not at every minute sweep, never as a needs-you,
 * and it recovers when the update lands. A short wait, or one the person chose, never does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { raised, recovered } = vi.hoisted(() => ({ raised: [] as Array<Record<string, unknown>>, recovered: [] as string[][] }))
// The store under health-items.ts: what was raised and recovered, and nothing written.
vi.mock('../../../src/core/notifications/store.js', () => ({
  upsertNotification: async (item: Record<string, unknown>) => { raised.push(item); return { record: item, outcome: 'inserted' } },
  recoverNotifications: async (keys: string[]) => { recovered.push(keys); return { recovered: [] } },
}))

import { _resetDaemonUpdateWaitHealthForTesting, daemonUpdateWaitItem, daemonUpdateWaitKey, noteDaemonUpdateWait } from '../../../src/core/hosts/daemon-update-wait-health.js'
import { LONG_POSTPONE_MS, LONG_SKIP_MS, type DaemonUpdateWait } from '../../../src/providers/daemon-update-wait.js'
import { audienceOf } from '../../../src/core/notifications/audience.js'

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
    expect(item.body).toMatch(/^The daemon update on Dev box waits \(since 09:00\): service\.handover: active ACP workers or relay requests must finish first\. /)
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
    // The update landed: the sweep finds no wait, and the item recovers once.
    noteDaemonUpdateWait('devbox', null, T + LONG_POSTPONE_MS + 700_000)
    noteDaemonUpdateWait('devbox', null, T + LONG_POSTPONE_MS + 760_000)
    await vi.waitFor(() => expect(recovered).toHaveLength(2), { timeout: 10_000 })
    await settle()
    expect(recovered).toEqual([[daemonUpdateWaitKey('devbox')], [daemonUpdateWaitKey('devbox')]])
  })

  it('skipped as shared past an hour is raised; held by the host\'s setting never is', async () => {
    noteDaemonUpdateWait('a', { kind: 'shared', why: 'shared, another Walnut uses it', since: T, expected: 'b' }, T + LONG_SKIP_MS)
    noteDaemonUpdateWait('b', { kind: 'held', why: 'autofix is off', since: T, expected: 'b' }, T + 50 * LONG_SKIP_MS)
    await vi.waitFor(() => expect(raised).toHaveLength(1), { timeout: 10_000 })
    await settle()
    expect(raised.map((i) => i.host)).toEqual(['a'])
  })
})
