/**
 * The Board reminder clock (src/core/boards/board-reminders.ts): one timer for
 * the nearest deadline, re-checked at least hourly, fed by a boot scan and by
 * BOARD_CHANGED. Real board files in an isolated home; the only fake is the send
 * core, so a delivery is observed at the exact call that would make it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-board-reminders'))

const performSessionSendMock = vi.fn()
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()
  return { ...orig, performSessionSend: (...args: unknown[]) => performSessionSendMock(...args) }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { SendError } from '../../../src/core/sessions/session-send-core.js'
import { getBoard, setBoardHtml } from '../../../src/core/boards/board-store.js'
import { setBoardReminder } from '../../../src/core/boards/board-items.js'
import {
  BOARD_REMINDER_MAX_ATTEMPTS,
  BOARD_REMINDER_RETRY_MS,
  loadBoardReminders,
  reminderDeadline,
  startBoardReminders,
  stopBoardReminders,
  sweepBoardReminders,
  trackedBoardReminders,
} from '../../../src/core/boards/board-reminders.js'

const T = 'mt0abc12-lead'
const MIN = 60_000
const HOUR = 60 * MIN
const PAGE = '<walnut-choice id="when" title="Deploy timing" options="a:Wait,b:Now"></walnut-choice>'
  + '<walnut-thread id="cause-a" title="Cause A"></walnut-thread>'

const realSetTimeout = globalThis.setTimeout
/** Real time for real file I/O while the clock's own timers are fake. */
async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = performance.now() + ms
  while (!(await check())) {
    if (performance.now() > end) throw new Error('condition not met in time')
    await new Promise((r) => realSetTimeout(r, 10))
  }
}

const sends = () => performSessionSendMock.mock.calls.map((c) => c[0] as { to: string; text: string; expectReply?: boolean })

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  performSessionSendMock.mockReset()
  performSessionSendMock.mockResolvedValue({ delivery: 'queued', targetSessionId: 'lead-session' })
  await setBoardHtml(T, PAGE, { by: 'task:lead' })
})

afterEach(async () => {
  stopBoardReminders()
  vi.useRealTimers()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('reminderDeadline', () => {
  it('its time until it fires; then a retry slot per failed attempt; null once delivered, out of attempts or malformed', () => {
    const at = '2026-10-02T16:00:00.000Z'
    const fired = '2026-10-02T16:00:01.000Z'
    expect(reminderDeadline({ at })).toBe(Date.parse(at))
    expect(reminderDeadline({ at, fired_at: fired })).toBe(Date.parse(fired))
    expect(reminderDeadline({ at, fired_at: fired, attempts: 2 })).toBe(Date.parse(fired) + 2 * BOARD_REMINDER_RETRY_MS)
    expect(reminderDeadline({ at, fired_at: fired, attempts: BOARD_REMINDER_MAX_ATTEMPTS })).toBeNull()
    expect(reminderDeadline({ at, fired_at: fired, delivered_at: fired })).toBeNull()
    expect(reminderDeadline({ at: 'not a time' })).toBeNull()
  })
})

describe('the timer (fake clock)', () => {
  it('fires once at the deadline, not before, and never again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const at = new Date(Date.now() + 10 * MIN).toISOString()
    await setBoardReminder(T, 'when', { at, note: 'after lunch' }, { by: 'human' })
    startBoardReminders()
    await loadBoardReminders()
    expect([...trackedBoardReminders().keys()]).toEqual([`${T}/when`])

    await vi.advanceTimersByTimeAsync(10 * MIN - 2_000)
    expect(performSessionSendMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    await until(async () => !!(await getBoard(T))!.reminders.when?.delivered_at)

    expect(sends()).toHaveLength(1)
    expect(sends()[0]).toMatchObject({ to: T, expectReply: false })
    expect(sends()[0].text).toContain('A reminder the user set on your Board is due: "Deploy timing" (choice when), note:\n\n> after lunch')
    expect(sends()[0].text).toContain('Raise it with the user now')
    const rem = (await getBoard(T))!.reminders.when
    expect(rem).toMatchObject({ at, fired_at: expect.any(String), delivered_at: expect.any(String) })
    expect(Date.parse(rem.fired_at!)).toBeGreaterThanOrEqual(Date.parse(at))

    await vi.advanceTimersByTimeAsync(5 * HOUR)
    await new Promise((r) => realSetTimeout(r, 100))
    expect(sends()).toHaveLength(1)
    expect(trackedBoardReminders().size).toBe(0)
  })

  it('a far deadline is re-checked hourly, so a Mac that slept past it catches up on wake', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const at = new Date(Date.now() + 5 * HOUR).toISOString()
    await setBoardReminder(T, 'cause-a', { at }, { by: 'human' })
    startBoardReminders()
    await loadBoardReminders()
    // The machine sleeps 6 hours: the wall clock jumps, no timer ran.
    vi.setSystemTime(Date.now() + 6 * HOUR)
    expect(performSessionSendMock).not.toHaveBeenCalled()
    // On wake, the pending timer (armed at most an hour out) runs and finds it overdue.
    await vi.advanceTimersByTimeAsync(HOUR)
    await until(() => performSessionSendMock.mock.calls.length === 1)
    expect(sends()[0].text).toContain('"Cause A" (thread cause-a)')
  })

  it('a cleared reminder never fires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    startBoardReminders()
    await setBoardReminder(T, 'when', { at: new Date(Date.now() + 10 * MIN).toISOString() }, { by: 'human' })
    await until(() => trackedBoardReminders().size === 1)
    await setBoardReminder(T, 'when', { at: null }, { by: 'human' })
    await until(() => trackedBoardReminders().size === 0)
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    await new Promise((r) => realSetTimeout(r, 100))
    expect(performSessionSendMock).not.toHaveBeenCalled()
  })
})

describe('the sweep', () => {
  it('a restart catches up: the boot scan finds one that came due while Walnut was down', async () => {
    const now = Date.now()
    await setBoardReminder(T, 'when', { at: new Date(now - 30 * MIN).toISOString() }, { by: 'human', nowMs: now - HOUR })
    stopBoardReminders()
    expect(trackedBoardReminders().size).toBe(0)
    await loadBoardReminders()
    expect([...trackedBoardReminders().keys()]).toEqual([`${T}/when`])
    expect(await sweepBoardReminders(now)).toEqual([`${T}/when`])
    expect(sends()).toHaveLength(1)
    // A second boot after delivery finds nothing to do.
    stopBoardReminders()
    await loadBoardReminders()
    expect(trackedBoardReminders().size).toBe(0)
  })

  it('a reminder cleared after it was tracked is left alone (the sweep re-reads the board)', async () => {
    const now = Date.now()
    await setBoardReminder(T, 'when', { at: new Date(now + MIN).toISOString() }, { by: 'human' })
    await loadBoardReminders()
    await setBoardReminder(T, 'when', { at: null }, { by: 'human' })
    expect(await sweepBoardReminders(now + 2 * MIN)).toEqual([])
    expect(performSessionSendMock).not.toHaveBeenCalled()
  })

  it('delivery failures retry a few times, a retry slot apart, then stop; never in a tight loop', async () => {
    performSessionSendMock.mockRejectedValue(new SendError('task_has_no_session', 'not started', 409))
    const now = Date.now()
    await setBoardReminder(T, 'when', { at: new Date(now + MIN).toISOString() }, { by: 'human' })
    await loadBoardReminders()
    const due = now + 2 * MIN
    await sweepBoardReminders(due)
    expect(performSessionSendMock).toHaveBeenCalledTimes(1)
    expect((await getBoard(T))!.reminders.when).toMatchObject({ fired_at: new Date(due).toISOString(), attempts: 1 })
    expect((await getBoard(T))!.reminders.when).not.toHaveProperty('delivered_at')
    // Sweeping again right away does nothing: the next try waits a retry slot.
    await sweepBoardReminders(due + 1_000)
    expect(performSessionSendMock).toHaveBeenCalledTimes(1)
    for (let i = 1; i < BOARD_REMINDER_MAX_ATTEMPTS + 3; i++) await sweepBoardReminders(due + i * BOARD_REMINDER_RETRY_MS)
    expect(performSessionSendMock).toHaveBeenCalledTimes(BOARD_REMINDER_MAX_ATTEMPTS)
    expect((await getBoard(T))!.reminders.when.attempts).toBe(BOARD_REMINDER_MAX_ATTEMPTS)
    expect(trackedBoardReminders().size).toBe(0)
    // The count lives in the board file: a restart does not start over.
    await loadBoardReminders()
    expect(trackedBoardReminders().size).toBe(0)
  })

  it('a failure that then succeeds is delivered once and marked so', async () => {
    performSessionSendMock.mockRejectedValueOnce(new Error('boom'))
    const now = Date.now()
    await setBoardReminder(T, 'cause-a', { at: new Date(now + MIN).toISOString() }, { by: 'task:lead' })
    await loadBoardReminders()
    await sweepBoardReminders(now + 2 * MIN)
    await sweepBoardReminders(now + 2 * MIN + BOARD_REMINDER_RETRY_MS)
    expect(performSessionSendMock).toHaveBeenCalledTimes(2)
    expect((await getBoard(T))!.reminders['cause-a']).toMatchObject({ attempts: 1, delivered_at: expect.any(String) })
    // A reminder a leader set for the user says so.
    expect(sends()[1].text).toMatch(/^A reminder task lead set for the user on your Board is due/)
    await sweepBoardReminders(now + 10 * HOUR)
    expect(performSessionSendMock).toHaveBeenCalledTimes(2)
  })

  it('an ephemeral server never fires the reminders it copied from the real Walnut, only its own', async () => {
    const now = Date.now()
    await setBoardReminder(T, 'when', { at: new Date(now - MIN).toISOString() }, { by: 'human', nowMs: now - HOUR })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(now + 1_000)
    startBoardReminders({ ephemeral: true })
    await loadBoardReminders()
    expect(trackedBoardReminders().size).toBe(0)
    await setBoardReminder(T, 'cause-a', { at: new Date(Date.now() + 10 * MIN).toISOString() }, { by: 'human' })
    await until(() => trackedBoardReminders().size === 1)
    expect([...trackedBoardReminders().keys()]).toEqual([`${T}/cause-a`])
    await vi.advanceTimersByTimeAsync(10 * MIN)
    await until(() => performSessionSendMock.mock.calls.length === 1)
    expect(sends()[0].text).toContain('(thread cause-a)')
    expect((await getBoard(T))!.reminders.when).not.toHaveProperty('fired_at')
  })

  it('a deleted board drops its deadlines', async () => {
    startBoardReminders()
    await setBoardReminder(T, 'when', { at: new Date(Date.now() + HOUR).toISOString() }, { by: 'human' })
    await until(() => trackedBoardReminders().size === 1)
    const { deleteBoard } = await import('../../../src/core/boards/board-store.js')
    await deleteBoard(T)
    await until(() => trackedBoardReminders().size === 0)
  })
})
