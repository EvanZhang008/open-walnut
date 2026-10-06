/**
 * The note the wait_until clock sends when it runs out (src/core/task-wait-wake.ts).
 *
 * 2026-10-05, the user: a trigger may be wrong or miss the event, so the clock is
 * short and running out is a check on the trigger. The note names each trigger
 * on the task with its state and last check, and asks the session to look at the
 * thing itself before it parks again.
 */
import { describe, expect, it } from 'vitest'
import { buildWaitWakeBody, describeWatchingTrigger, type WatchingTrigger } from '../../src/core/task-wait-wake.js'

const NOW = Date.parse('2026-10-05T18:00:00Z')
const until = 'Oct 5, 2026, 11:00 AM'
const trigger = (over: Partial<WatchingTrigger> = {}): WatchingTrigger => ({
  id: 'rt_1', name: 'PR 77 review', everyMs: 300_000, state: 'armed', fires: 0, ...over,
})

describe('describeWatchingTrigger', () => {
  it('says the state, the cadence, the fire count and the last check', () => {
    expect(describeWatchingTrigger(trigger({ lastCheck: { atMs: NOW - 4 * 60_000, outcome: 'quiet', reason: 'fire-false' } }), NOW))
      .toBe('- "PR 77 review" (rt_1): armed, every 5m, fired 0 times; last check 4 min ago: quiet (the check found nothing to fire on).')
    expect(describeWatchingTrigger(trigger({ fires: 1, everyMs: 3 * 3_600_000, lastCheck: { atMs: NOW - 5 * 3_600_000, outcome: 'fired', items: 2 } }), NOW))
      .toBe('- "PR 77 review" (rt_1): armed, every 3h, fired 1 time; last check 5h ago: fired with 2 new item(s).')
  })

  it('calls out the shapes that mean the trigger cannot be working', () => {
    expect(describeWatchingTrigger(trigger({ state: 'paused' }), NOW)).toContain('PAUSED, so it is not checking at all')
    expect(describeWatchingTrigger(trigger({ state: 'stopped' }), NOW)).toContain('STOPPED after its check kept failing')
    expect(describeWatchingTrigger(trigger(), NOW)).toContain('it has not reported a single check yet')
    const err = describeWatchingTrigger(trigger({ lastCheck: { atMs: NOW - 60_000, outcome: 'error', error: 'x'.repeat(500) } }), NOW)
    expect(err).toContain('error (')
    expect(err.length).toBeLessThan(320)
    expect(describeWatchingTrigger(trigger({ lastCheck: { atMs: NOW, outcome: 'quiet', reason: 'all-seen' } }), NOW))
      .toContain('only items it had already delivered')
    expect(describeWatchingTrigger(trigger({ lastCheck: { atMs: NOW, outcome: 'quiet', reason: 'rate-limited' } }), NOW))
      .toContain('held back by its fire budget')
  })

  it('keeps a trigger with no name or interval readable', () => {
    expect(describeWatchingTrigger({ id: 'rt_9', state: 'armed', fires: 3 }, NOW))
      .toBe('- rt_9: armed, on an unknown interval, fired 3 times; it has not reported a single check yet.')
  })

  it('keeps a Unicode name intact', () => {
    // Test data: "review" in Chinese, as a user-named trigger.
    expect(describeWatchingTrigger(trigger({ name: '\u5ba1\u6838' }), NOW)).toContain('"\u5ba1\u6838" (rt_1)')
  })
})

describe('buildWaitWakeBody', () => {
  it('with a trigger: both causes, the trigger, the three checks, and a short re-park with no word to the user', () => {
    const body = buildWaitWakeBody({ until, nowMs: NOW, triggers: [trigger()] })
    expect(body.startsWith(`The wait on this task ran until ${until}, and nothing brought it back before then.`)).toBe(true)
    expect(body).toContain('Either the thing it waits on has not happened yet, or the trigger missed it')
    expect(body).toContain('Triggers on this task:\n- "PR 77 review" (rt_1)')
    expect(body).toContain('1. Look at the thing itself')
    expect(body).toContain('2. If it happened and no fire came, the trigger is wrong.')
    expect(body).toContain('trigger_test')
    expect(body).toContain('3. If it has not happened, is the trigger still sound')
    expect(body).toContain('park again (task_update phase=WAITING) with a wait_until for when you now expect it, kept short; that needs no word to the user.')
    expect(body).toContain('tell the user in one line and leave it with them')
  })

  it('lists at most five triggers and counts the rest', () => {
    const many = Array.from({ length: 7 }, (_, i) => trigger({ id: `rt_${i}`, name: `Watch ${i}` }))
    const body = buildWaitWakeBody({ until, nowMs: NOW, triggers: many })
    expect(body.match(/^- "Watch \d"/gm)).toHaveLength(5)
    expect(body).toContain('- and 2 more (trigger_list)')
  })

  it('with no trigger: the plain note, no checklist', () => {
    const body = buildWaitWakeBody({ until, nowMs: NOW, triggers: [] })
    expect(body).toBe(`The wait on this task ran until ${until}, and nothing brought it back before then. No trigger watches it. `
      + 'Take it from here: check what it was waiting for, do what is next, and tell the user where things stand.')
  })
})
