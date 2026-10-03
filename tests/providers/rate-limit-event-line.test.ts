/**
 * A `rate_limit_event` line on a session's stream (Claude Code writes one for
 * a claude.ai sign-in when its usage window moves) used to fall into the
 * unknown-event catch-all and render an "unknown event" system block in the
 * chat. It is now a known type: the reading goes to the per-host store under the
 * session's host, nothing reaches the chat timeline, and a replayed line (an
 * old one re-read after a reattach) is not recorded as new.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js'
import { classifyTopLevel } from '../../src/providers/claude-stream-event-map.js'
import {
  readSubscriptionLimits, subscriptionLimitsFile, _flushSubscriptionLimitsForTest, _resetSubscriptionLimitsForTest, _setSignInResolverForTest,
} from '../../src/core/sessions/subscription-limits.js'
import fs from 'node:fs/promises'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const feed = (session: ClaudeCodeSession, obj: unknown, v?: number) => (session as any).handleStreamLine(JSON.stringify(obj), v)

const T0 = Math.floor(Date.now() / 1000) + 3600
const RATE_LIMIT_LINE = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning', resetsAt: T0, rateLimitType: 'five_hour', utilization: 0.91,
    isUsingOverage: false, surpassedThreshold: 0.9,
    unifiedWindows: { five_hour: { utilization: 0.91, resetsAt: T0 }, seven_day: { utilization: 0.4, resetsAt: T0 + 400_000 } },
  },
  uuid: '1b0e4b0c-0000-4000-8000-000000000001',
  session_id: 'sid-limit',
}

function collect(): { unknown: BusEvent[]; chat: BusEvent[]; limits: BusEvent[] } {
  const out = { unknown: [] as BusEvent[], chat: [] as BusEvent[], limits: [] as BusEvent[] }
  const chatNames = new Set<string>([
    EventNames.SESSION_TEXT_DELTA, EventNames.SESSION_TOOL_USE, EventNames.SESSION_TOOL_RESULT, EventNames.SESSION_SYSTEM_EVENT,
  ])
  bus.subscribe('rate-limit-line-test', (e) => {
    if (e.name === EventNames.SESSION_UNKNOWN_EVENT) out.unknown.push(e)
    else if (e.name === EventNames.HOST_SUBSCRIPTION_LIMITS) out.limits.push(e)
    else if (chatNames.has(e.name)) out.chat.push(e)
  }, { global: true })
  return out
}

describe('rate_limit_event stream line', () => {
  let session: ClaudeCodeSession

  beforeEach(async () => {
    bus.clear()
    _resetSubscriptionLimitsForTest()
    // Each case starts with no reading on disk either (the store persists).
    await fs.rm(subscriptionLimitsFile(), { force: true })
    _setSignInResolverForTest(async () => undefined)
    session = new ClaudeCodeSession('task-limit', 'proj', 'true')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(session as any).claudeSessionId = 'sid-limit'
  })

  afterEach(() => {
    bus.clear()
    _resetSubscriptionLimitsForTest()
  })

  it('is a known top-level type', () => {
    expect(classifyTopLevel('rate_limit_event')).toBe('parse')
  })

  it('a local session files the reading under this machine, with no chat row and no unknown event', async () => {
    const seen = collect()
    feed(session, RATE_LIMIT_LINE)
    await _flushSubscriptionLimitsForTest()
    expect(seen.unknown).toEqual([])
    expect(seen.chat).toEqual([])
    expect(seen.limits).toHaveLength(1)
    const [frame] = await readSubscriptionLimits()
    expect(frame.host).toBe('__local__')
    expect(frame.windows.five_hour).toMatchObject({ utilization: 0.91, resetsAt: T0 * 1000, sessionId: 'sid-limit' })
    expect(frame.windows.seven_day).toMatchObject({ utilization: 0.4 })
    expect(frame.current).toMatchObject({ status: 'allowed_warning', type: 'five_hour' })
  })

  it('a remote session files it under its host alias', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(session as any)._host = 'devbox'
    feed(session, RATE_LIMIT_LINE)
    await _flushSubscriptionLimitsForTest()
    expect((await readSubscriptionLimits()).map((f) => f.host)).toEqual(['devbox'])
  })

  it('a replayed line (at or below the consumed watermark) is not recorded again', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(session as any)._consumedOffset = 5000
    const seen = collect()
    feed(session, RATE_LIMIT_LINE, 4000)
    await _flushSubscriptionLimitsForTest()
    expect(seen.limits).toEqual([])
    expect(await readSubscriptionLimits()).toEqual([])
    // A new line past the watermark is.
    feed(session, RATE_LIMIT_LINE, 6000)
    await _flushSubscriptionLimitsForTest()
    expect(seen.limits).toHaveLength(1)
  })

  it('a malformed rate_limit_event is dropped quietly (still not an unknown-event block)', async () => {
    const seen = collect()
    feed(session, { type: 'rate_limit_event', rate_limit_info: { status: 'nonsense' } })
    await _flushSubscriptionLimitsForTest()
    expect(seen.unknown).toEqual([])
    expect(seen.limits).toEqual([])
  })
})
