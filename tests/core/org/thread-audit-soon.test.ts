/**
 * The thread check reads a node soon after its threads changed (src/core/org/thread-audit.ts
 * auditSoon, runThreadAuditSoon), instead of at its next six hours. 2026-11-26, real use: a second
 * card on a matter he had just asked about stood 84 minutes until the clock came by.
 *
 * The wiring and the timing, with the clock's own timers faked: which changes arm a read, one read
 * per node however many changes come in, the wait after a read, and a stop that leaves nothing
 * armed. What a read does on a real server: tests/e2e/thread-one-reply.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-thread-audit-soon'))

import { bus, EventNames } from '../../../src/core/event-bus.js'
import {
  auditSoon, hasPairForHim, resetThreadAuditSoonForTests, runThreadAuditSoon, soonWait, startThreadAudit, threadAuditClockRuns, threadAuditSoonWaiting,
  SOON_FLOOR_MS, SOON_MS, SOON_QUIET_MAX_MS, SOON_QUIET_MS,
} from '../../../src/core/org/thread-audit.js'
import type { OrgThreadsChangedEvent } from '../../../src/core/event-types.js'

const NODE = 'orchard-soon-node'
const changed = (kind: OrgThreadsChangedEvent['kind'], taskId = NODE) =>
  bus.emit(EventNames.ORG_THREADS_CHANGED, { taskId, kind }, ['web-ui'], { source: 'org-threads' })

beforeEach(() => {
  vi.useFakeTimers()
  resetThreadAuditSoonForTests()
})
afterEach(() => {
  resetThreadAuditSoonForTests()
  vi.useRealTimers()
})

describe('when a node is read after its threads changed', () => {
  it('90 seconds on, and never within ten minutes of its last read', () => {
    const now = Date.parse('2026-11-26T12:00:00Z')
    expect(soonWait(undefined, now)).toBe(SOON_MS)
    expect(soonWait(now - SOON_FLOOR_MS - 1, now)).toBe(SOON_MS)
    expect(soonWait(now - 60_000, now)).toBe(SOON_FLOOR_MS - 60_000)
    expect(SOON_MS).toBeLessThan(SOON_FLOOR_MS)
    // The wait for him to leave the chat is asked again a few times, never for ever.
    expect(SOON_QUIET_MS).toBeLessThan(SOON_QUIET_MAX_MS)
  })

  it('only a node holding two or more cards he can see has a pair to compare', () => {
    const now = Date.parse('2026-11-26T12:00:00Z')
    const iso = (ms: number) => new Date(now + ms).toISOString()
    const t = (state: string, more: Record<string, unknown> = {}) => ({ state, messages: [], ...more }) as never
    expect(hasPairForHim([t('answered'), t('needs')], now)).toBe(true)
    expect(hasPairForHim([t('answered')], now)).toBe(false)
    // What he does not see is no card: the node's move, set aside now, closed or moved away.
    expect(hasPairForHim([t('answered'), t('working'), t('pending'), t('new')], now)).toBe(false)
    expect(hasPairForHim([t('answered'), t('answered', { closed: { at: iso(-1000) } }), t('answered', { movedTo: { task: 'y' } }), t('needs', { snoozed: { until: iso(3_600_000), at: iso(-1000) } })], now)).toBe(false)
    // A card whose time aside has run out is in his sight again.
    expect(hasPairForHim([t('answered'), t('needs', { snoozed: { until: iso(-60_000), at: iso(-3_600_000) } })], now)).toBe(true)
  })
})

describe('the changes that arm a read', () => {
  it('an answer landed, a line was written or threads were joined; one read per node, whatever came in', () => {
    const handle = startThreadAudit()
    try {
      for (const kind of ['filed', 'opened', 'split', 'swept', 'moved', 'below'] as const) changed(kind)
      expect(threadAuditSoonWaiting()).toEqual([])
      changed('answered')
      changed('updated')
      changed('merged')
      changed('updated', 'orchard-other-node')
      expect(threadAuditSoonWaiting().sort()).toEqual([NODE, 'orchard-other-node'].sort())
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2)
      // A read already armed is not armed again.
      expect(auditSoon(NODE)).toBe(false)
    } finally {
      handle.stop()
    }
    // The stop leaves no read armed and hears no change.
    expect(threadAuditSoonWaiting()).toEqual([])
    expect(threadAuditClockRuns()).toBe(false)
    changed('answered')
    expect(threadAuditSoonWaiting()).toEqual([])
  })

  it('nothing is armed on an ephemeral server or with the clock turned off', () => {
    const was = process.env.WALNUT_THREAD_AUDIT
    try {
      for (const start of [() => startThreadAudit({ ephemeral: true }), () => { process.env.WALNUT_THREAD_AUDIT = '0'; return startThreadAudit() }]) {
        const handle = start()
        changed('answered')
        expect(threadAuditSoonWaiting()).toEqual([])
        handle.stop()
      }
    } finally {
      if (was === undefined) delete process.env.WALNUT_THREAD_AUDIT
      else process.env.WALNUT_THREAD_AUDIT = was
    }
  })

  it('the read leaves at its time; one that read nothing starts no ten-minute wait', async () => {
    expect(auditSoon(NODE)).toBe(true)
    await vi.advanceTimersByTimeAsync(SOON_MS - 1)
    expect(threadAuditSoonWaiting()).toEqual([NODE])
    await vi.advanceTimersByTimeAsync(1)
    // Gone to its read, which finds the switch off here and reads nothing: the next change is read 90 seconds on again.
    expect(threadAuditSoonWaiting()).toEqual([])
    expect(auditSoon(NODE)).toBe(true)
    await vi.advanceTimersByTimeAsync(SOON_MS - 1)
    expect(threadAuditSoonWaiting()).toEqual([NODE])
    await vi.advanceTimersByTimeAsync(1)
    expect(threadAuditSoonWaiting()).toEqual([])
  })

  it('with the switch off a read does nothing', async () => {
    vi.useRealTimers()
    expect(await runThreadAuditSoon(NODE)).toBeNull()
  })
})
