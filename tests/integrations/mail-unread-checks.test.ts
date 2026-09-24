/**
 * Who may ask a provider what is unread, and when (`unread-checks.ts`).
 *
 * Three callers share one question: the poll loop on every tick, a page a person just opened, and the
 * Refresh button. What is pinned here is what keeps that cheap and honest: one clock and one call in
 * flight per folder, the order a page asks in, and the rule for when the end of a check is announced.
 */
import { describe, expect, it } from 'vitest'
import {
  UNREAD_CHECK_GAP_MS,
  UnreadChecks,
  type UnreadCheckResult,
  type UnreadCheckSettled,
} from '../../src/integrations/mail/unread-checks.js'

interface Harness {
  checks: UnreadChecks
  calls: Array<{ accountId: string; mailboxId: string; limit: number }>
  settled: UnreadCheckSettled[]
  clock: { at: number }
  /** Resolve the oldest pending call with this result. */
  answer(result: UnreadCheckResult): void
  pending(): number
}

function harness(): Harness {
  const clock = { at: 1_000_000 }
  const calls: Harness['calls'] = []
  const settled: UnreadCheckSettled[] = []
  const waiters: Array<(result: UnreadCheckResult) => void> = []
  const checks = new UnreadChecks({
    now: () => clock.at,
    run: (accountId, mailboxId, options) => {
      calls.push({ accountId, mailboxId, limit: options.limit })
      return new Promise<UnreadCheckResult>((resolve) => { waiters.push(resolve) })
    },
    settled: (event) => { settled.push(event) },
  })
  return {
    checks, calls, settled, clock,
    answer: (result) => { waiters.shift()!(result) },
    pending: () => waiters.length,
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('one clock and one call per folder', () => {
  it('joins the running check instead of asking twice', async () => {
    const h = harness()
    const first = h.checks.start('a', 'inbox', { limit: 50, deadlineMs: 8_000 })
    const second = h.checks.start('a', 'inbox', { limit: 10, deadlineMs: 8_000, force: true })
    expect(h.calls).toHaveLength(1)
    expect(second).toBe(first)
    h.answer({ cleared: 0, failed: false })
    expect(await second).toEqual({ cleared: 0, failed: false })
  })

  it('does not ask the same folder again within the gap, and does after it', async () => {
    const h = harness()
    h.checks.start('a', 'inbox', { limit: 50, deadlineMs: 8_000 })
    h.answer({ cleared: 0, failed: false })
    await flush()
    h.clock.at += UNREAD_CHECK_GAP_MS - 1
    expect(h.checks.start('a', 'inbox', { limit: 50, deadlineMs: 8_000 })).toBeNull()
    expect(h.checks.isDue('a', 'inbox')).toBe(false)
    h.clock.at += 1
    expect(h.checks.start('a', 'inbox', { limit: 50, deadlineMs: 8_000 })).not.toBeNull()
    expect(h.calls).toHaveLength(2)
  })

  it('lets a human refresh skip the gap', async () => {
    const h = harness()
    h.checks.start('a', 'inbox', { limit: 50, deadlineMs: 8_000 })
    h.answer({ cleared: 0, failed: false })
    await flush()
    expect(h.checks.start('a', 'inbox', { limit: 50, deadlineMs: 8_000, force: true })).not.toBeNull()
    expect(h.calls).toHaveLength(2)
  })

  it('keeps the folders of different accounts apart', () => {
    const h = harness()
    h.checks.start('a', 'inbox', { limit: 50, deadlineMs: 8_000 })
    h.checks.start('b', 'inbox', { limit: 50, deadlineMs: 8_000 })
    expect(h.calls.map((one) => one.accountId)).toEqual(['a', 'b'])
  })

  it('counts a check that threw as failed and still frees the folder', async () => {
    const clock = { at: 0 }
    const settled: UnreadCheckSettled[] = []
    const checks = new UnreadChecks({
      now: () => clock.at,
      run: () => Promise.reject(new Error('the helper died')),
      settled: (event) => { settled.push(event) },
    })
    const done = checks.start('a', 'inbox', { limit: 50, deadlineMs: 8_000 })!
    checks.announce([{ accountId: 'a', mailboxId: 'inbox' }])
    expect(await done).toEqual({ cleared: 0, failed: true })
    expect(settled).toEqual([{ accountId: 'a', mailboxId: 'inbox', cleared: 0, failed: true }])
    expect(checks.runningAmong([{ accountId: 'a', mailboxId: 'inbox' }])).toEqual([])
  })

  it('forgets the clock of an account whose provider registered again', async () => {
    const h = harness()
    h.checks.start('a', 'inbox', { limit: 50, deadlineMs: 8_000 })
    h.checks.start('b', 'inbox', { limit: 50, deadlineMs: 8_000 })
    h.answer({ cleared: 0, failed: false })
    h.answer({ cleared: 0, failed: false })
    await flush()
    h.checks.forget('a')
    expect(h.checks.isDue('a', 'inbox')).toBe(true)
    expect(h.checks.isDue('b', 'inbox')).toBe(false)
    h.checks.forget()
    expect(h.checks.isDue('b', 'inbox')).toBe(true)
  })
})

describe('when the end of a check is said out loud', () => {
  it('says nothing about a quiet check nobody was told about', async () => {
    const h = harness()
    const done = h.checks.start('a', 'inbox', { limit: 50, deadlineMs: 8_000 })!
    h.answer({ cleared: 0, failed: false })
    await done
    expect(h.settled, 'a quiet tick must not become a heartbeat event').toEqual([])
  })

  it('always says so when it cleared rows', async () => {
    const h = harness()
    const done = h.checks.start('a', 'inbox', { limit: 50, deadlineMs: 8_000 })!
    h.answer({ cleared: 3, failed: false })
    await done
    expect(h.settled).toEqual([{ accountId: 'a', mailboxId: 'inbox', cleared: 3 }])
  })

  it('always ends a check a page named, even with nothing cleared', async () => {
    const h = harness()
    const done = h.checks.start('a', 'inbox', { limit: 50, deadlineMs: 8_000 })!
    h.checks.announce([{ accountId: 'a', mailboxId: 'inbox' }])
    h.answer({ cleared: 0, failed: false })
    await done
    expect(h.settled, 'the console is showing Checking… and is owed an end').toEqual([
      { accountId: 'a', mailboxId: 'inbox', cleared: 0 },
    ])
  })

  it('reports the running checks among a page\'s folders, in the page\'s order', () => {
    const h = harness()
    h.checks.start('b', 'inbox', { limit: 50, deadlineMs: 8_000 })
    h.checks.start('a', 'inbox', { limit: 50, deadlineMs: 8_000 })
    const running = h.checks.runningAmong([
      { accountId: 'a', mailboxId: 'inbox' }, { accountId: 'c', mailboxId: 'inbox' }, { accountId: 'b', mailboxId: 'inbox' },
    ])
    expect(running.map((one) => one.accountId)).toEqual(['a', 'b'])
  })
})

describe('which folders a page asks about first', () => {
  const folder = (accountId: string, providerUnread: number, cachedUnread: number) => ({
    accountId, mailboxId: 'inbox', providerUnread, cachedUnread,
  })

  it('asks a folder whose badge agrees too, because a badge can be stale', () => {
    const h = harness()
    expect(h.checks.pick([folder('a', 4, 4)], 2).map((one) => one.accountId)).toEqual(['a'])
  })

  it('takes the biggest disagreement first, then the folder asked longest ago, and stops at the bound', async () => {
    const h = harness()
    h.checks.start('recent', 'inbox', { limit: 50, deadlineMs: 8_000 })
    h.answer({ cleared: 0, failed: false })
    await flush()
    h.clock.at += UNREAD_CHECK_GAP_MS + 5
    const chosen = h.checks.pick(
      [folder('recent', 3, 3), folder('never', 3, 3), folder('wrong', 4, 12), folder('bit-wrong', 1, 2)],
      3,
    )
    expect(chosen.map((one) => one.accountId)).toEqual(['wrong', 'bit-wrong', 'never'])
  })

  it('leaves out folders asked within the gap and folders already running', async () => {
    const h = harness()
    h.checks.start('done', 'inbox', { limit: 50, deadlineMs: 8_000 })
    h.answer({ cleared: 0, failed: false })
    await flush()
    h.checks.start('busy', 'inbox', { limit: 50, deadlineMs: 8_000 })
    const chosen = h.checks.pick([folder('done', 1, 5), folder('busy', 1, 5), folder('free', 0, 0)], 2)
    expect(chosen.map((one) => one.accountId)).toEqual(['free'])
    expect(h.checks.pick([folder('done', 1, 5)], 2, true).map((one) => one.accountId), 'Refresh skips the gap').toEqual(['done'])
  })

  it('a bound of zero asks nobody', () => {
    const h = harness()
    expect(h.checks.pick([folder('a', 4, 12)], 0)).toEqual([])
  })
})
