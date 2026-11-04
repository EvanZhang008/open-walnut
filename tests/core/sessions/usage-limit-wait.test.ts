/**
 * The usage-limit wait (src/core/sessions/usage-limit-wait.ts) on a hand-run clock: a turn the
 * subscription's usage limit stopped waits for the reset, continues once then, reopens on a later
 * reset, counts a try on the same one and gives up after LIMIT_MAX_TRIES; a person's message, a
 * stop or the user's "Don't auto-continue" end it. Plus the words every surface reads
 * (usage-limit-text.ts, usage-limit-model.ts, user-status.ts).
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-usage-limit-wait'))

import { EventNames } from '../../../src/core/event-bus.js'
import type { BusEvent } from '../../../src/core/event-bus.js'
import {
  UsageLimitWaiter, LIMIT_CONTINUE_TEXT, LIMIT_CONTINUE_NOW_TEXT, recordInUsageLimit, usageLimitOfRecord, type UsageLimitWaitDeps,
} from '../../../src/core/sessions/usage-limit-wait.js'
import {
  LIMIT_MAX_TRIES, limitDueAt, limitName, claudeUsageLimitFacts, blockedLimitOf, usageLimitTakes, type UsageLimitFacts,
} from '../../../src/core/sessions/usage-limit-model.js'
import { matchesUsageLimitText, parseUsageLimitReset, usageLimitSentence } from '../../../src/providers/usage-limit-text.js'
import { classifyTurnError } from '../../../src/providers/daemon-core.js'
import { matchesRetryExhaustion } from '../../../src/core/session-auto-continue.js'
import { AUTO_CONTINUE_SOURCE } from '../../../src/core/session-auto-continue.js'
import { deriveUserStatus, limitedLine } from '../../../src/core/user-status.js'
import type { SessionRecord, SessionUsageLimit } from '../../../src/core/types.js'
import { beginQuietTurn, resetQuietTurnsForTest } from '../../../src/core/sessions/quiet-turn.js'

const SID = 'sess-limit-1'
const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.parse('2026-11-04T14:00:00Z')
const CLAUDE_TEXT = "You've hit your session limit · resets 3pm (UTC)"

describe('the usage-limit words', () => {
  const limited = [
    CLAUDE_TEXT,
    "You've hit your weekly limit · resets Nov 6, 3pm (America/Los_Angeles)",
    'You’ve hit your Opus limit · resets 5:30am (Europe/Berlin)',
    "You've hit your limit · resets 3pm",
    "You're out of extra usage · resets 3pm (UTC)",
    'Claude AI usage limit reached|1762282800',
    "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM.",
    "You've hit your usage limit. Try again at Nov 5th, 2026 3:05 PM.",
    "You've hit your usage limit. Try again later.",
    "You've hit your usage limit for gpt-6-codex. Switch to another model now, or try again in 2 hours 13 minutes.",
    'usageLimitExceeded',
  ]
  const notLimited = [
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}',
    'API Error: Rate limit reached',
    'Request timed out',
    'API Error: Connection refused (ECONNREFUSED)',
    'Prompt is too long',
    // Another provider's or a gateway's per-minute limit: retried, never a wait for a window.
    "API Error: You've hit your rate limit, retry in 20s",
    "You've hit your request rate limit for this minute",
    'The disk usage limit for the volume was reached in a test fixture string',
  ]

  it('names every CLI stop of the usage limit, and no plain API rate limit', () => {
    for (const t of limited) expect(matchesUsageLimitText(t), t).toBe(true)
    for (const t of notLimited) expect(matchesUsageLimitText(t), t).toBe(false)
  })

  it('every usage-limit stop is terminal for the daemon retry and auto-continue (the wait owns it)', () => {
    for (const t of limited) {
      expect(classifyTurnError(t), t).toBe('terminal')
      expect(matchesRetryExhaustion(t), t).toBe(false)
    }
    // A plain API rate limit stays the retry layers'.
    expect(classifyTurnError(notLimited[0])).toBe('retryable')
  })

  it('reads the reset each CLI writes', () => {
    const now = T0 // 14:00 UTC
    expect(parseUsageLimitReset(CLAUDE_TEXT, now)).toBe(Date.parse('2026-11-04T15:00:00Z'))
    // A time already past today is tomorrow's.
    expect(parseUsageLimitReset("You've hit your session limit · resets 9am (UTC)", now)).toBe(Date.parse('2026-11-05T09:00:00Z'))
    expect(parseUsageLimitReset("You've hit your session limit · resets 3:30pm (America/Los_Angeles)", now)).toBe(Date.parse('2026-11-04T23:30:00Z'))
    expect(parseUsageLimitReset("You've hit your weekly limit · resets Nov 6, 3pm (America/Los_Angeles)", now)).toBe(Date.parse('2026-11-06T23:00:00Z'))
    expect(parseUsageLimitReset('Claude AI usage limit reached|1762282800', now)).toBe(1762282800_000)
    expect(parseUsageLimitReset('...or try again at 3:05 PM.', now, 'UTC')).toBe(Date.parse('2026-11-04T15:05:00Z'))
    expect(parseUsageLimitReset('Try again at Nov 5th, 2026 3:05 PM.', now, 'Asia/Tokyo')).toBe(Date.parse('2026-11-05T06:05:00Z'))
    expect(parseUsageLimitReset('or try again in 2 hours 13 minutes.', now)).toBe(now + 2 * HOUR + 13 * MIN)
    expect(parseUsageLimitReset('Try again later.', now)).toBeUndefined()
    expect(parseUsageLimitReset(null, now)).toBeUndefined()
  })

  it('takes only the provider\'s words out of a longer answer', () => {
    expect(usageLimitSentence("I updated the parser.\n\nYou've hit your usage limit. Try again at 3:05 PM."))
      .toBe("You've hit your usage limit. Try again at 3:05 PM.")
    expect(usageLimitSentence('Working on it.')).toBeNull()
  })

  it('a rejected reading alone is no stop; the blocked reply or the words are', () => {
    const rejected = { resetsAt: T0 + 3 * HOUR, window: 'seven_day' }
    // The CLI switched model and went on, then the turn failed for another reason.
    expect(claudeUsageLimitFacts(rejected, 'API Error: Request timed out', T0, matchesUsageLimitText, parseUsageLimitReset)).toBeUndefined()
    expect(claudeUsageLimitFacts({ ...rejected, blocked: true }, 'API Error: Request timed out', T0, matchesUsageLimitText, parseUsageLimitReset))
      .toMatchObject({ engine: 'claude', resetsAt: T0 + 3 * HOUR, resetsFrom: 'event' })
  })

  it('a turn whose own work runs on is not the wait\'s', () => {
    const usageLimit = { engine: 'claude' }
    expect(usageLimitTakes({ usageLimit })).toBe(true)
    for (const f of ['interrupted', 'teamActive', 'backgroundActive', 'detachedBgActive', 'wakeupPending']) {
      expect(usageLimitTakes({ usageLimit, [f]: true }), f).toBe(false)
    }
  })

  it('Claude facts prefer the limit event, then the words', () => {
    const blocked = blockedLimitOf({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: T0 + 3 * HOUR, overageStatus: 'rejected' })
    expect(blocked).toEqual({ resetsAt: T0 + 3 * HOUR, window: 'seven_day' })
    expect(blockedLimitOf({ status: 'rejected', overageStatus: 'allowed' })).toBe('allowed')
    expect(blockedLimitOf({ status: 'allowed_warning' })).toBe('allowed')
    const fromEvent = claudeUsageLimitFacts(blocked as { resetsAt: number }, CLAUDE_TEXT, T0, matchesUsageLimitText, parseUsageLimitReset)
    expect(fromEvent).toMatchObject({ engine: 'claude', window: 'seven_day', resetsAt: T0 + 3 * HOUR, resetsFrom: 'event' })
    const fromText = claudeUsageLimitFacts(null, CLAUDE_TEXT, T0, matchesUsageLimitText, parseUsageLimitReset)
    expect(fromText).toMatchObject({ engine: 'claude', window: 'five_hour', resetsAt: Date.parse('2026-11-04T15:00:00Z'), resetsFrom: 'text' })
    expect(claudeUsageLimitFacts(null, 'Request timed out', T0, matchesUsageLimitText, parseUsageLimitReset)).toBeUndefined()
  })

  it('names the limit the way a person says it', () => {
    expect(limitName({ engine: 'claude', window: 'five_hour' })).toBe('Claude 5-hour limit')
    expect(limitName({ engine: 'claude', window: 'seven_day' })).toBe('Claude weekly limit')
    expect(limitName({ engine: 'codex' })).toBe('Codex usage limit')
    expect(limitName({ engine: 'claude', window: 'overage' })).toBe('Claude extra usage')
  })

  it('continues a minute past the reset, spread per session; with no reset, on the backoff', () => {
    const at = limitDueAt({ resetsAt: new Date(T0 + HOUR).toISOString(), tries: 0 }, SID, T0)
    expect(at).toBeGreaterThanOrEqual(T0 + HOUR + MIN)
    expect(at).toBeLessThanOrEqual(T0 + HOUR + MIN + 45_000)
    expect(limitDueAt({ tries: 0 }, SID, T0)).toBe(T0 + 30 * MIN)
    expect(limitDueAt({ tries: 3 }, SID, T0)).toBe(T0 + 120 * MIN)
    expect(limitDueAt({ tries: 40 }, SID, T0)).toBe(T0 + 240 * MIN)
  })
})

function rig(opts: { holdsOff?: () => string | null; hostReset?: number; sendStartsNoTurn?: boolean; onHoldsOff?: () => void } = {}) {
  let now = T0
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let nextId = 1
  const rec: SessionRecord = {
    claudeSessionId: SID, taskId: 'task-1', project: 'P', process_status: 'error', mode: 'bypass',
    host: '__local__', cwd: '/work/repo', errorMessage: CLAUDE_TEXT,
  } as unknown as SessionRecord
  const sent: Array<{ text: string; source: string }> = []
  const notes: string[] = []
  const handedBack: string[] = []
  const released: string[] = []
  const deps: UsageLimitWaitDeps = {
    now: () => now,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id as unknown as ReturnType<typeof setTimeout> },
    clearTimer: (h) => { const i = timers.findIndex((t) => t.id === (h as unknown as number)); if (i >= 0) timers.splice(i, 1) },
    getSession: async () => rec,
    listSessions: async () => [rec],
    patchWait: async (_sid, fn) => { const next = fn(rec.usageLimit); if (next) rec.usageLimit = next; else delete rec.usageLimit },
    // A continue starts a turn (its own end is the test's next limited() or cleanTurn()).
    send: async (_sid, text, o) => { sent.push({ text, source: o.source }); if (!opts.sendStartsNoTurn) rec.process_status = 'running' },
    note: (_sid, _task, text) => { notes.push(text) },
    hostReset: async () => (opts.hostReset ? { resetsAt: opts.hostReset, window: 'five_hour' } : null),
    handBack: async (_rec, w) => { handedBack.push(w.state) },
    holdsOff: async () => { opts.onHoldsOff?.(); return opts.holdsOff?.() ?? null },
    release: async (_rec, why) => { released.push(why) },
    setContinued: async (_sid, note) => { if (note) rec.usageLimitContinued = note; else delete rec.usageLimitContinued },
  }
  const waiter = new UsageLimitWaiter(deps)
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      await flush()
      timers.sort((a, b) => a.at - b.at)
      const t = timers[0]
      if (!t || t.at > end) break
      timers.shift()
      now = t.at
      t.fn()
    }
    now = end
    await flush()
  }
  const ev = (name: string, data: Record<string, unknown>, source?: string): BusEvent =>
    ({ name, data: { sessionId: SID, ...data }, source } as unknown as BusEvent)
  const limited = async (facts: Partial<UsageLimitFacts> = {}) => {
    rec.process_status = 'error'
    waiter.handleEvent(ev(EventNames.SESSION_RESULT, { isError: true, result: CLAUDE_TEXT, usageLimit: { engine: 'claude', window: 'five_hour', ...facts } }))
    await flush()
  }
  const cleanTurn = async () => {
    rec.process_status = 'idle'
    waiter.handleEvent(ev(EventNames.SESSION_RESULT, { isError: false, result: 'done' }))
    await flush()
  }
  return { rec, sent, notes, handedBack, released, waiter, advance, limited, cleanTurn, ev, flush, setNow: (t: number) => { now = t }, now: () => now }
}

describe('the usage-limit wait', () => {
  it('waits for the reset, continues once then, and a clean turn closes it', async () => {
    const r = rig()
    await r.limited({ resetsAt: T0 + 2 * HOUR, resetsFrom: 'event' })
    expect(r.rec.usageLimit).toMatchObject({ state: 'waiting', engine: 'claude', window: 'five_hour', resumes: 0, tries: 0, resetsFrom: 'event' })
    await r.advance(2 * HOUR)
    expect(r.sent).toEqual([]) // before reset + a minute, nothing goes out
    await r.advance(2 * MIN)
    expect(r.sent).toEqual([{ text: LIMIT_CONTINUE_TEXT, source: AUTO_CONTINUE_SOURCE }])
    expect(r.rec.usageLimit?.state).toBe('resumed')
    expect(r.notes[0]).toContain('Claude 5-hour limit reset')
    await r.cleanTurn()
    expect(r.rec.usageLimit).toBeUndefined()
    await r.advance(10 * HOUR)
    expect(r.sent).toHaveLength(1)
  })

  it("Walnut's own idle compaction (a quiet turn) neither opens a wait nor closes one", async () => {
    try {
      const r = rig()
      beginQuietTurn(SID, 'idle-compact', 'idle-compact')
      await r.limited({ resetsAt: T0 + 2 * HOUR, resetsFrom: 'event' })
      expect(r.rec.usageLimit).toBeUndefined()
      resetQuietTurnsForTest()
      await r.limited({ resetsAt: T0 + 2 * HOUR, resetsFrom: 'event' })
      expect(r.rec.usageLimit?.state).toBe('waiting')
      beginQuietTurn(SID, 'idle-compact', 'idle-compact')
      await r.cleanTurn()
      expect(r.rec.usageLimit?.state).toBe('waiting')
    } finally { resetQuietTurnsForTest() }
  })

  it('once its own continue ran, the session says Walnut continued it, until someone sends or the user dismisses it', async () => {
    const r = rig()
    await r.limited({ resetsAt: T0 + HOUR, resetsFrom: 'event' })
    await r.advance(HOUR + 3 * MIN)
    const resumedAt = r.rec.usageLimit?.resumedAt
    expect(r.rec.usageLimit).toMatchObject({ state: 'resumed', resumedBy: 'walnut' })
    await r.cleanTurn()
    expect(r.rec.usageLimitContinued).toEqual({ at: resumedAt, by: 'walnut', engine: 'claude', window: 'five_hour', resetsAt: new Date(T0 + HOUR).toISOString() })
    // A message from anyone but Walnut's continue: the note has said what it had to.
    r.waiter.handleEvent(r.ev(EventNames.SESSION_SEND, {}, 'web-ui'))
    await r.flush()
    expect(r.rec.usageLimitContinued).toBeUndefined()

    await r.limited({ resetsAt: r.now() + HOUR, resetsFrom: 'event' })
    await r.advance(HOUR + 3 * MIN)
    await r.cleanTurn()
    expect(r.rec.usageLimitContinued).toBeDefined()
    expect(await r.waiter.act(SID, 'dismiss')).toMatchObject({ ok: true })
    expect(r.rec.usageLimitContinued).toBeUndefined()
  })

  it('the user\'s own Continue now leaves the same note, saying it was theirs', async () => {
    const r = rig()
    await r.limited({ resetsAt: T0 + HOUR, resetsFrom: 'event' })
    await r.waiter.act(SID, 'continue')
    expect(r.rec.usageLimit).toMatchObject({ state: 'resumed', resumedBy: 'user' })
    await r.cleanTurn()
    expect(r.rec.usageLimit).toBeUndefined()
    expect(r.rec.usageLimitContinued).toMatchObject({ engine: 'claude', by: 'user' })
    // It came before the reset Walnut would have continued it at: the note says that continue is off.
    expect(r.rec.usageLimitContinued?.autoCancelled).toBe(true)
  })

  it('a Continue now on a wait the user turned off cancels no auto-continue, and says none', async () => {
    const r = rig()
    await r.limited({ resetsAt: T0 + HOUR, resetsFrom: 'event' })
    await r.waiter.act(SID, 'off')
    await r.waiter.act(SID, 'continue')
    expect(r.rec.usageLimit?.resumedEarly).toBeUndefined()
    await r.cleanTurn()
    expect(r.rec.usageLimitContinued).toMatchObject({ by: 'user' })
    expect(r.rec.usageLimitContinued?.autoCancelled).toBeUndefined()
  })

  it('a later reset after the continue is a new window; the same one counts a try, then gives up', async () => {
    const r = rig()
    await r.limited({ resetsAt: T0 + HOUR })
    await r.advance(HOUR + 2 * MIN)
    expect(r.sent).toHaveLength(1)
    // The 5-hour window reset, the weekly one stops it now: wait for that one, tries stay 0.
    await r.limited({ resetsAt: T0 + 30 * HOUR, window: 'seven_day' })
    expect(r.rec.usageLimit).toMatchObject({ state: 'waiting', window: 'seven_day', tries: 0, resumes: 1 })
    await r.advance(30 * HOUR)
    expect(r.sent).toHaveLength(2)
    // Refused again with no later reset: a try each time, on the backoff, until it gives up.
    for (let i = 1; i < LIMIT_MAX_TRIES; i++) {
      await r.limited({ resetsAt: T0 + 30 * HOUR })
      expect(r.rec.usageLimit).toMatchObject({ state: 'waiting', tries: i })
      await r.advance(5 * HOUR)
    }
    await r.limited({ resetsAt: T0 + 30 * HOUR })
    expect(r.rec.usageLimit?.state).toBe('gave_up')
    expect(r.handedBack).toEqual(['gave_up'])
    const sentAtGiveUp = r.sent.length
    await r.advance(48 * HOUR)
    expect(r.sent).toHaveLength(sentAtGiveUp)
  })

  it('with no reset in the words, takes the host\'s last reading', async () => {
    const r = rig({ hostReset: T0 + 90 * MIN })
    await r.limited({})
    expect(r.rec.usageLimit).toMatchObject({ resetsFrom: 'host', resetsAt: new Date(T0 + 90 * MIN).toISOString() })
  })

  it('with no reset at all, tries again after 30 minutes', async () => {
    const r = rig()
    await r.limited({})
    expect(r.rec.usageLimit?.resetsAt).toBeUndefined()
    await r.advance(29 * MIN)
    expect(r.sent).toEqual([])
    await r.advance(2 * MIN)
    expect(r.sent).toHaveLength(1)
  })

  it("a person's message ends it: no continue behind them", async () => {
    const r = rig()
    await r.limited({ resetsAt: T0 + HOUR })
    r.waiter.handleEvent(r.ev(EventNames.SESSION_MESSAGE_QUEUED, { message: 'I will take it' }, 'ui'))
    await r.flush()
    expect(r.rec.usageLimit).toBeUndefined()
    // The panel says their message took it on, and that Walnut will not continue it.
    expect(r.rec.usageLimitContinued).toMatchObject({ by: 'your-message', autoCancelled: true, engine: 'claude' })
    // The same message's second event keeps that note; a later message clears it.
    r.waiter.handleEvent(r.ev(EventNames.SESSION_SEND, { message: 'I will take it' }, 'ui'))
    await r.flush()
    expect(r.rec.usageLimitContinued).toMatchObject({ by: 'your-message' })
    await r.advance(3 * HOUR)
    expect(r.sent).toEqual([])
    r.waiter.handleEvent(r.ev(EventNames.SESSION_SEND, { message: 'next' }, 'ui'))
    await r.flush()
    expect(r.rec.usageLimitContinued).toBeUndefined()
  })

  it('another task\'s message, or one into a wait turned off, says so in its own words', async () => {
    const r = rig()
    await r.limited({ resetsAt: T0 + HOUR })
    r.waiter.handleEvent(r.ev(EventNames.SESSION_SEND, { message: 'peer' }, 'agent'))
    await r.flush()
    expect(r.rec.usageLimitContinued).toMatchObject({ by: 'message', autoCancelled: true })
    const off = rig()
    await off.limited({ resetsAt: T0 + HOUR })
    expect(await off.waiter.act(SID, 'off')).toMatchObject({ ok: true })
    off.waiter.handleEvent(off.ev(EventNames.SESSION_SEND, { message: 'go' }, 'ui'))
    await off.flush()
    expect(off.rec.usageLimitContinued).toMatchObject({ by: 'your-message' })
    expect(off.rec.usageLimitContinued?.autoCancelled).toBeUndefined()
  })

  it('its own continue and another wait\'s do not end it', async () => {
    const r = rig()
    await r.limited({ resetsAt: T0 + HOUR })
    r.waiter.handleEvent(r.ev(EventNames.SESSION_MESSAGE_QUEUED, { message: 'continue' }, AUTO_CONTINUE_SOURCE))
    await r.flush()
    expect(r.rec.usageLimit?.state).toBe('waiting')
  })

  it('a stop, a closed task or a stopped team ends it at the reset', async () => {
    let off: string | null = null
    const r = rig({ holdsOff: () => off })
    await r.limited({ resetsAt: T0 + HOUR })
    off = 'task-complete'
    await r.advance(2 * HOUR)
    expect(r.sent).toEqual([])
    expect(r.rec.usageLimit).toBeUndefined()
  })

  it("the user's Don't auto-continue holds it, Continue after reset re-arms it, Continue now sends at once", async () => {
    const r = rig()
    await r.limited({ resetsAt: T0 + HOUR })
    const off = await r.waiter.act(SID, 'off')
    expect(off).toMatchObject({ ok: true, usageLimit: { state: 'off' } })
    expect(r.handedBack).toEqual(['off'])
    await r.advance(3 * HOUR)
    expect(r.sent).toEqual([])
    // Its limit stops again while off (someone else's turn would have closed it first): still off.
    await r.limited({ resetsAt: T0 + 5 * HOUR })
    expect(r.rec.usageLimit?.state).toBe('off')

    const on = await r.waiter.act(SID, 'auto')
    expect(on).toMatchObject({ ok: true, usageLimit: { state: 'waiting' } })
    await r.waiter.act(SID, 'off')

    const now = await r.waiter.act(SID, 'continue')
    expect(now.ok).toBe(true)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0].source).toBe(AUTO_CONTINUE_SOURCE)
    expect(r.sent[0].text).toContain(LIMIT_CONTINUE_NOW_TEXT)
    // The user's own Continue now is named as theirs in the chat, never "auto continue".
    expect(r.sent[0].text).toContain('from="Walnut (your Continue now)"')
    expect(r.sent[0].text).not.toContain('auto continue')
    expect(r.notes.at(-1)).toContain('as you asked')
    expect(r.rec.usageLimit?.state).toBe('resumed')
  })

  it('refuses an action on a session the limit did not stop', async () => {
    const r = rig()
    expect(await r.waiter.act(SID, 'continue')).toEqual({ ok: false, error: 'this session is not stopped by a usage limit' })
  })

  it('a continue that started no turn waits again', async () => {
    const r = rig({ sendStartsNoTurn: true })
    await r.limited({ resetsAt: T0 + HOUR })
    await r.advance(HOUR + 2 * MIN)
    expect(r.rec.usageLimit?.state).toBe('resumed')
    r.rec.process_status = 'stopped'
    await r.advance(6 * MIN)
    expect(r.rec.usageLimit).toMatchObject({ state: 'waiting', tries: 1 })
  })

  it('picks up an open wait after a restart', async () => {
    const r = rig()
    r.rec.usageLimit = { state: 'waiting', engine: 'claude', since: new Date(T0).toISOString(), resumes: 0, tries: 0, dueAt: new Date(T0 + 10 * MIN).toISOString() }
    expect(await r.waiter.resumeOpen()).toBe(1)
    await r.advance(11 * MIN)
    expect(r.sent).toHaveLength(1)
  })

  it('holds the turn-end notices while it waits, and lets them go once the continue ran', () => {
    const base = { process_status: 'error', errorMessage: CLAUDE_TEXT } as SessionRecord
    const w: SessionUsageLimit = { state: 'waiting', engine: 'claude', since: new Date(T0).toISOString(), resumes: 0, tries: 0 }
    expect(recordInUsageLimit({ ...base, usageLimit: w })).toBe(true)
    expect(recordInUsageLimit({ ...base, process_status: 'idle', usageLimit: { ...w, state: 'resumed' } })).toBe(false)
    expect(recordInUsageLimit({ ...base, usageLimit: { ...w, state: 'off' } })).toBe(false)
    expect(usageLimitOfRecord({ ...base, process_status: 'idle', usageLimit: { ...w, state: 'resumed' } } as SessionRecord)).toBeUndefined()
  })
})

describe('the usage-limit wait, around it', () => {
  it("a person's stop ends it at once, not at the reset, and hands the held turn end back", async () => {
    let off: string | null = null
    const r = rig({ holdsOff: () => off })
    await r.limited({ resetsAt: T0 + 30 * HOUR, window: 'seven_day' })
    off = 'person-stopped'
    r.rec.process_status = 'stopped'
    r.waiter.handleEvent(r.ev(EventNames.SESSION_STATUS_CHANGED, {}))
    await r.advance(5_000)
    expect(r.rec.usageLimit).toBeUndefined()
    expect(r.released).toEqual(['person-stopped'])
    expect(r.sent).toEqual([])
  })

  it('a closed task ends it on the task event', async () => {
    let off: string | null = null
    const r = rig({ holdsOff: () => off })
    await r.limited({ resetsAt: T0 + 30 * HOUR })
    off = 'task-complete'
    r.waiter.handleEvent(r.ev(EventNames.TASK_COMPLETED, { taskId: 'task-1' }))
    await r.advance(5_000)
    expect(r.rec.usageLimit).toBeUndefined()
    expect(r.released).toEqual([])
  })

  it('a team stop holds it, and team_resume lets it continue', async () => {
    let off: string | null = 'team-stopped'
    const r = rig({ holdsOff: () => off })
    await r.limited({ resetsAt: T0 + HOUR })
    await r.advance(3 * HOUR)
    expect(r.sent).toEqual([])
    expect(r.rec.usageLimit?.state).toBe('waiting')
    off = null
    r.waiter.handleEvent(r.ev(EventNames.TASK_UPDATED, { taskId: 'task-1' }))
    await r.advance(5_000)
    expect(r.sent).toHaveLength(1)
  })

  it("a message that comes in while it looks gets no continue behind it", async () => {
    let r: ReturnType<typeof rig>
    let once = true
    r = rig({
      onHoldsOff: () => {
        if (!once) return
        once = false
        r.waiter.handleEvent(r.ev(EventNames.SESSION_MESSAGE_QUEUED, { message: 'mine now' }, 'web-ui'))
      },
    })
    await r.limited({ resetsAt: T0 + HOUR })
    await r.advance(HOUR + 2 * MIN)
    expect(r.sent).toEqual([])
    expect(r.rec.usageLimit).toBeUndefined()
  })

  it('its continued turn ended while the server was away: closed, never a second continue', async () => {
    const r = rig()
    r.rec.usageLimit = {
      state: 'resumed', engine: 'claude', since: new Date(T0 - HOUR).toISOString(), resumes: 1, tries: 0,
      resumedAt: new Date(T0 - 10 * MIN).toISOString(),
    }
    r.rec.process_status = 'idle'
    ;(r.rec as { last_status_change?: string }).last_status_change = new Date(T0 - 5 * MIN).toISOString()
    expect(await r.waiter.resumeOpen()).toBe(1)
    await r.advance(10 * HOUR)
    expect(r.sent).toEqual([])
    expect(r.rec.usageLimit).toBeUndefined()
  })

  it('Continue now is refused while its continue is in', async () => {
    const r = rig({ sendStartsNoTurn: true })
    await r.limited({ resetsAt: T0 + HOUR })
    expect((await r.waiter.act(SID, 'continue')).ok).toBe(true)
    expect(await r.waiter.act(SID, 'continue')).toEqual({ ok: false, error: 'it is already continuing' })
    expect(r.sent).toHaveLength(1)
  })

  it('waits already due at boot spread out after the hosts reconnect', async () => {
    const r = rig()
    r.rec.usageLimit = { state: 'waiting', engine: 'claude', since: new Date(T0 - 6 * HOUR).toISOString(), resumes: 0, tries: 0, dueAt: new Date(T0 - HOUR).toISOString() }
    await r.waiter.resumeOpen()
    await r.advance(55_000)
    expect(r.sent).toEqual([])
    await r.advance(60_000)
    expect(r.sent).toHaveLength(1)
  })
})

describe('the status every surface reads', () => {
  const input = (usageLimit: SessionUsageLimit) => ({
    phase: 'IN_PROGRESS' as const, status: 'in_progress', hasSession: true, processStatus: 'error', usageLimit,
  })
  const w: SessionUsageLimit = {
    state: 'waiting', engine: 'claude', window: 'five_hour', since: new Date(T0).toISOString(),
    resetsAt: new Date(T0 + HOUR).toISOString(), dueAt: new Date(T0 + HOUR + MIN).toISOString(), resumes: 0, tries: 0,
  }

  it('reads Waiting, Limited until the reset, while Walnut continues it', () => {
    const s = deriveUserStatus(input(w) as never, T0)
    expect(s.state).toBe('waiting')
    expect(s.kind).toBe('time')
    expect(s.until).toBe(w.resetsAt)
    expect(s.limit).toMatchObject({ engine: 'claude', auto: true, resetsAt: w.resetsAt })
    expect(s.waitingOn).toContain('Claude 5-hour limit resets')
    expect(limitedLine(s, T0)).toMatch(/^Limited · resets \d{1,2}:\d{2}\s[AP]M$/)
    // The time never wraps apart from its AM/PM (or its weekday).
    expect(limitedLine(s, T0)!.split('resets ')[1]).not.toContain(' ')
    expect(limitedLine({ ...s, limit: { ...s.limit!, resetsAt: new Date(T0 + 30 * HOUR).toISOString() } }, T0)!.split('resets ')[1]).not.toContain(' ')
  })

  it('a reset read from the limit\'s words reads "about" on the row too, as on the banner', () => {
    const s = deriveUserStatus(input({ ...w, resetsFrom: 'text' }) as never, T0)
    expect(s.limit?.estimate).toBe(true)
    expect(limitedLine(s, T0)).toMatch(/^Limited · resets about \d{1,2}:\d{2}\s[AP]M$/)
    expect(deriveUserStatus(input(w) as never, T0).limit?.estimate).toBeUndefined()
  })

  it('reads Needs you once the user turned it off, or it gave up', () => {
    const off = deriveUserStatus(input({ ...w, state: 'off' }) as never, T0)
    expect(off.state).toBe('needs')
    expect(off.ask).toContain('Auto-continue off')
    expect(off.limit?.auto).toBe(false)
    expect(limitedLine(off, T0)).toBeNull()
    // What it is first, so a row cut to one line still says it; then the reset.
    expect(off.ask).toMatch(/^Auto-continue off · resets \d{1,2}:\d{2}\s[AP]M\. The Claude 5-hour limit stopped it/)
    expect(deriveUserStatus(input({ ...w, state: 'off', resetsAt: undefined }) as never, T0).ask).toMatch(/^Auto-continue off\. /)
    // A choice waits on the user (continue now or at the reset), not a failure to look at.
    expect(off.category).toBe('decide')
    const gave = deriveUserStatus(input({ ...w, state: 'gave_up', resumes: 6 }) as never, T0)
    expect(gave.state).toBe('needs')
    expect(gave.category).toBe('decide')
    expect(gave.ask).toMatch(/^Limited, still refusing · resets /)
  })

  it('past the reset the row names the continue, not a reset gone by', () => {
    const s = deriveUserStatus(input(w) as never, T0)
    expect(limitedLine(s, T0 + HOUR + 10_000)).toMatch(/^Continuing · at \d{1,2}:\d{2}\s[AP]M$/)
    expect(limitedLine(s, T0 + HOUR + 2 * MIN)).toBe('Continuing · shortly')
    const noReset = { ...s, limit: { ...s.limit!, resetsAt: undefined } }
    expect(limitedLine(noReset, T0)).toMatch(/^Limited · tries again /)
  })

  it('once its continue went in, it reads Working at once, never Limited', () => {
    const s = deriveUserStatus(input({ ...w, state: 'resumed', resumedAt: new Date(T0).toISOString() } as SessionUsageLimit) as never, T0)
    expect(s.state).toBe('working')
    expect(s.now).toBe('Continuing after the usage limit')
    expect(limitedLine(s, T0)).toBeNull()
  })

  it('a running turn is Working, whatever the wait says', () => {
    expect(deriveUserStatus({ ...input(w), processStatus: 'running' } as never, T0).state).toBe('working')
  })
})
