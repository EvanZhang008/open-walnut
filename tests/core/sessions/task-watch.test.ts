/**
 * A watch on a task (src/core/sessions/task-watch.ts), with only the CLI faked: its clock bounds,
 * every status the task gives restarts it, a completion ends it; when it runs out on a long turn
 * Walnut asks the status mid-turn and the answer rides the watcher's next message; an idle task
 * with nothing new since its last word is not asked.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-task-watch'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import { addTask, getTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { parseWatchEvery, runWatchPass, watchDueAt, watchLine } from '../../../src/core/sessions/task-watch.js'
import { clearRiding, pendingRiding } from '../../../src/core/sessions/status-riding.js'

const SID = 'watch-target-session'
const WATCHER_SID = 'watch-watcher-session'
const ANSWER = 'FOR_USER_STATE: working\nFOR_USER_NOW: Running the slow suite.\nFOR_USER_NEXT: I fix what fails.'

describe('the clock', () => {
  it('takes 10 minutes to 7 days', () => {
    expect(parseWatchEvery('30m')).toBe(30 * 60_000)
    expect(parseWatchEvery('3h')).toBe(3 * 3_600_000)
    expect(parseWatchEvery('1d')).toBe(86_400_000)
    expect(() => parseWatchEvery('5m')).toThrow(/between/)
    expect(() => parseWatchEvery('8d')).toThrow(/between/)
    expect(() => parseWatchEvery('soon')).toThrow(/duration/)
  })

  it('restarts with every status the task gives, and ends with a completion', () => {
    const watch = { by: 'vp', every_ms: 3_600_000, set_at: '2026-10-31T10:00:00.000Z' }
    expect(watchDueAt({ watch } as never)).toBe(Date.parse('2026-10-31T11:00:00.000Z'))
    expect(watchDueAt({ watch, status_report: { state: 'working', at: '2026-10-31T10:40:00.000Z' } } as never)).toBe(Date.parse('2026-10-31T11:40:00.000Z'))
    expect(watchDueAt({ watch: { ...watch, polled_at: '2026-10-31T12:00:00.000Z' } } as never)).toBe(Date.parse('2026-10-31T13:00:00.000Z'))
    expect(watchDueAt({ watch, phase: 'COMPLETE' } as never)).toBeNull()
    // Completed after it was set and reopened since: still over.
    expect(watchDueAt({ watch, phase: 'IN_PROGRESS', completed_at: '2026-10-31T10:30:00.000Z' } as never)).toBeNull()
    expect(watchDueAt({} as never)).toBeNull()
  })
})

describe('when it runs out', () => {
  let watched = ''
  let watcher = ''
  const fake = { sessionId: SID, askSideQuestion: vi.fn(async () => ANSWER), detach: () => {}, kill: () => {}, get active() { return true } }
  const sessions = () => (sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions
  const active = () => (sessionRunner as unknown as { activeProcessing: Set<string> }).activeProcessing

  beforeAll(async () => {
    clearRiding()
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    watcher = (await addTask({ title: 'Garden VP', project: 'Garden' })).task.id
    await updateTaskRaw(watcher, { org_role: 'lead', phase: 'IN_PROGRESS' }, { source: 'test' })
    await createSessionRecord(WATCHER_SID, watcher, 'Garden')
    await updateSessionRecord(WATCHER_SID, { process_status: 'idle' })
    watched = (await addTask({ title: 'Run the slow suite', project: 'Garden' })).task.id
    await updateTaskRaw(watched, { phase: 'IN_PROGRESS' }, { source: 'test' })
    await createSessionRecord(SID, watched, 'Garden')
    sessions().set(SID, fake)
  })
  afterAll(async () => {
    sessions().delete(SID)
    active().delete(SID)
    clearRiding()
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  })

  it('a long turn is asked mid-turn and the answer rides the watcher next message', async () => {
    const setAt = Date.now() - 2 * 3_600_000
    await updateTaskRaw(watched, { watch: { by: watcher, every_ms: 3_600_000, set_at: new Date(setAt).toISOString() } }, { source: 'test' })
    await updateSessionRecord(SID, { process_status: 'running' })
    active().add(SID)
    const now = Date.now()
    expect(await runWatchPass(now)).toEqual([watched])
    expect(fake.askSideQuestion).toHaveBeenCalledTimes(1)
    const t = await getTask(watched)
    expect(t.status_report).toMatchObject({ state: 'working', now: 'Running the slow suite.' })
    expect(t.watch?.polled_at).toBe(new Date(now).toISOString())
    const ride = pendingRiding(WATCHER_SID)!.text
    expect(ride).toContain('Your watch on "Run the slow suite"')
    expect(ride).toContain('Now: Running the slow suite.')
    // Not due again until the clock runs out once more.
    expect(await runWatchPass(now + 60_000)).toEqual([])
    active().delete(SID)
  })

  it('an idle task with nothing new since its last word is not asked; the clock restarts', async () => {
    await updateSessionRecord(SID, { process_status: 'idle', last_status_change: new Date(Date.now() - 3 * 3_600_000).toISOString() })
    const later = Date.now() + 2 * 3_600_000
    expect(await runWatchPass(later)).toEqual([])
    expect(fake.askSideQuestion).toHaveBeenCalledTimes(1)
    expect((await getTask(watched)).watch?.polled_at).toBe(new Date(later).toISOString())
  })

  it('a watcher that finished ends the watch', async () => {
    await updateTaskRaw(watcher, { phase: 'COMPLETE' }, { source: 'test' })
    expect(await runWatchPass(Date.now() + 9 * 3_600_000)).toEqual([])
    expect((await getTask(watched)).watch ?? null).toBeNull()
    await updateTaskRaw(watcher, { phase: 'IN_PROGRESS' }, { source: 'test' })
  })

  it('the line names its state and words', () => {
    expect(watchLine({ id: 't', title: 'X', status_report: { state: 'needs', ask: 'Pick A or B?', at: '' }, user_status: { state: 'needs' } } as never, Date.parse('2026-10-31T10:05:00Z')))
      .toBe('- Your watch on "X" (t) ran out at 10:05 UTC and Walnut asked it: needs. It asks the user: "Pick A or B?".')
  })
})
