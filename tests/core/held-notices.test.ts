/**
 * A background notice never starts a turn of its own (src/core/sessions/held-notices.ts,
 * 2026-10-30: half of a lead's turns were an agent-ack to a notice that only said something
 * moved). A request past its deadline and its reminder ride the session's next message; people read Walnut's own notices as "System".
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { _clearHeldNotices, holdNotice, pendingHeldNotices } from '../../src/core/sessions/held-notices.js'
import { parseSessionEnvelopes, systemSender } from '../../src/lib/history-session-envelope.js'

beforeEach(() => { _clearHeldNotices() })

describe('a background notice rides the next message', () => {
  it('a held notice waits for the next message, taken once', async () => {
    holdNotice('lead-1', 'overdue:rq-1', 'NOTICE A')
    holdNotice('lead-1', 'overdue:rq-2', 'NOTICE B')
    const p = (await pendingHeldNotices('lead-1'))!
    expect(p.text).toBe('NOTICE A\n\nNOTICE B')
    // Taken on read: a second send at the same time carries nothing.
    expect(await pendingHeldNotices('lead-1')).toBeNull()
  })

  it('a newer notice of the same key replaces the held one; a message that did not carry them puts them back', async () => {
    holdNotice('lead-1', 'k', 'OLD')
    holdNotice('lead-1', 'k', 'NEW')
    const p = (await pendingHeldNotices('lead-1'))!
    expect(p.text).toBe('NEW')
    holdNotice('lead-1', 'k2', 'LATER')
    p.release()
    expect((await pendingHeldNotices('lead-1'))!.text).toBe('LATER\n\nNEW')
  })

  it('a notice held past three days is dropped unread', async () => {
    holdNotice('lead-1', 'k', 'OLD', { now: Date.now() - 4 * 24 * 3_600_000 })
    expect(await pendingHeldNotices('lead-1')).toBeNull()
  })

  it('a notice its news overtook (the request got its reply) is dropped, not sent stale', async () => {
    holdNotice('lead-1', 'request-timeout:rq-1', 'PAST ITS DEADLINE', { validIf: async () => false })
    holdNotice('lead-1', 'request-timeout:rq-2', 'STILL OPEN', { validIf: async () => true })
    expect((await pendingHeldNotices('lead-1'))!.text).toBe('STILL OPEN')
  })
})

describe('people read Walnut\'s own notices as System', () => {
  it('maps Walnut and Walnut: <check> only', () => {
    expect(systemSender('Walnut')).toBe('System')
    expect(systemSender('Walnut: re-check')).toBe('System: re-check')
    expect(systemSender('Walnut lead')).toBe('Walnut lead')
    expect(systemSender('Trigger: CI watch')).toBe('Trigger: CI watch')
    expect(systemSender(undefined)).toBeUndefined()
  })

  it('a re-check trigger is named System in the timeline', () => {
    const segs = parseSessionEnvelopes('<walnut-message kind="trigger" from="Walnut: re-check" note="is what you asked the user still needed">\nCheck it.\n</walnut-message>')
    const env = segs?.find((s) => s.kind === 'envelope')
    expect(env && env.kind === 'envelope' ? env.envelope.peer.title : null).toBe('System: re-check')
  })
})
