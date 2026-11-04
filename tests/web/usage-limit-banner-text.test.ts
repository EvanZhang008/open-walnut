/**
 * The usage-limit banner's words (UsageLimitBanner.tsx usageLimitBannerText) before and after the
 * reset: once the reset has passed, it says so and names Walnut's continue, never a reset to come.
 */
import { describe, expect, it } from 'vitest'
import type { SessionUsageLimit } from '@open-walnut/core'
import { limitIn, usageLimitBannerText, usageLimitContinuedText } from '../../web/src/components/sessions/UsageLimitBanner'

const T0 = Date.parse('2026-11-04T15:00:00Z')
const MIN = 60_000
const w: SessionUsageLimit = {
  state: 'waiting', engine: 'claude', window: 'five_hour', since: new Date(T0 - 60 * MIN).toISOString(),
  resetsAt: new Date(T0 + 10 * MIN).toISOString(), dueAt: new Date(T0 + 12 * MIN).toISOString(), resumes: 0, tries: 0,
}

describe('the usage-limit banner words', () => {
  it('before the reset: it resets, and Walnut continues shortly after', () => {
    const t = usageLimitBannerText(w, T0)
    expect(t.head).toBe('Claude 5-hour limit reached')
    expect(t.when).toMatch(/^resets /)
    // The continue's own time, its countdown beside it.
    expect(t.detail).toMatch(/^Walnut continues it by itself at \d{1,2}:\d{2}\u00a0[AP]M \(in 12 min\)\. Continue now tries sooner; if the limit still holds, it just waits again\.$/)
  })

  it('after the reset: it has reset, and the continue is what comes next', () => {
    const t = usageLimitBannerText(w, T0 + 11 * MIN)
    expect(t.head).toBe('Claude 5-hour limit has reset')
    expect(t.when).toMatch(/^continuing at \d{1,2}:\d{2}\u00a0[AP]M$/)
    // Why it is not continuing yet, the minute after the reset.
    // Why it is not continuing yet; the time is in the heading only.
    expect(t.detail).toMatch(/^Walnut continues it shortly after the reset, once the new window is in effect\./)
    expect(usageLimitBannerText(w, T0 + 13 * MIN).when).toBe('continuing now')
    // Turned off past the reset: the limit no longer holds it, and nothing is about to go on.
    const off = usageLimitBannerText({ ...w, state: 'off' }, T0 + 11 * MIN)
    expect(off.head).toBe('Claude 5-hour limit has reset')
    expect(off.when).toMatch(/^at \d{1,2}:\d{2}\u00a0[AP]M$/)
    expect(off.detail).toBe('Auto-continue is off, so this task now waits for you. The limit has reset: continue it whenever you want.')
    // Before the reset too: the panel says the task now waits on the user.
    // Before the reset it also says what Continue now does while the limit holds.
    expect(usageLimitBannerText({ ...w, state: 'off' }, T0).detail).toBe('Auto-continue is off, so this task now waits for you. Continue now tries it now; if the limit still holds, it stops again and waits for you.')
    expect(usageLimitBannerText({ ...w, state: 'gave_up', resumes: 2 }, T0 + 11 * MIN).detail).toMatch(/It has reset since: continue it when you want\.$/)
  })

  it('after its continue ran: one short line of one shape, who continued it and when', () => {
    const at = new Date(T0).toISOString()
    const T = String.raw`\d{1,2}:\d{2} [AP]M`
    expect(usageLimitContinuedText({ at, engine: 'claude', window: 'five_hour' }, T0))
      .toMatch(new RegExp(`^Walnut continued this session at ${T}, after the limit reset\\.$`))
    expect(usageLimitContinuedText({ at, by: 'user', engine: 'claude', window: 'five_hour' }, T0))
      .toMatch(new RegExp(`^You continued this session at ${T}\\.$`))
    // Before the reset too: the banner is gone, which says Walnut's own continue is no more.
    expect(usageLimitContinuedText({ at, by: 'user', autoCancelled: true, engine: 'claude', resetsAt: new Date(T0 + 60 * MIN).toISOString() }, T0))
      .toMatch(new RegExp(`^You continued this session at ${T}\\.$`))
    expect(usageLimitContinuedText({ at, by: 'your-message', autoCancelled: true, engine: 'claude' }, T0))
      .toMatch(new RegExp(`^Your message continued this session at ${T}\\.$`))
    expect(usageLimitContinuedText({ at, by: 'message', engine: 'claude' }, T0))
      .toMatch(new RegExp(`^A new message continued this session at ${T}\\.$`))
  })

  it('a reset read from the limit\'s words is said as an estimate', () => {
    const t = usageLimitBannerText({ ...w, engine: 'codex', resetsFrom: 'text' }, T0)
    expect(t.when).toMatch(/^resets about /)
    expect(t.detail).toContain(', and again later if the limit still holds. Continue now tries sooner.')
    expect(usageLimitBannerText(w, T0).when).not.toContain('about')
  })

  it('the last minute reads as under a minute, then now', () => {
    expect(limitIn(new Date(T0 + 20_000).toISOString(), T0)).toBe('in under a minute')
    expect(limitIn(new Date(T0 - 1).toISOString(), T0)).toBe('now')
  })
})

describe('the banner tag', () => {
  it('reads Limited before the reset, Continuing once it passed while Walnut is about to go on', async () => {
    const { passedReset } = await import('../../web/src/components/sessions/UsageLimitBanner')
    expect(passedReset(w, T0)).toBe(false)
    expect(passedReset(w, T0 + 11 * MIN)).toBe(true)
    expect(passedReset({ ...w, state: 'off' }, T0 + 11 * MIN)).toBe(false)
  })

  it('past the reset a wait that is the user\'s reads Reset, never Limited', async () => {
    const { usageLimitTag } = await import('../../web/src/components/sessions/UsageLimitBanner')
    expect(usageLimitTag(w, T0)).toBe('Limited')
    expect(usageLimitTag(w, T0 + 11 * MIN)).toBe('Continuing')
    expect(usageLimitTag({ ...w, state: 'off' }, T0)).toBe('Limited')
    expect(usageLimitTag({ ...w, state: 'off' }, T0 + 11 * MIN)).toBe('Reset')
    expect(usageLimitTag({ ...w, state: 'gave_up' }, T0 + 11 * MIN)).toBe('Reset')
  })
})
