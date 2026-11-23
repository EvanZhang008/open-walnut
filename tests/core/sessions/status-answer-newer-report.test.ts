/**
 * A status answer never replaces a report written after what it knew (2026-11-23: a person's needs
 * report, put 2 s after a fixture turn ended, was overwritten 3 s later by that turn's "done"
 * answer; the taskbar card then read "Can close: The result is ready" instead of the ask).
 *
 * The class: every writer of task.status_report. Only the report route (always the newest word)
 * and the status answer (guarded here by storedIsNewer) write it; a new writer fails the guards in
 * tests/core/answered-turn-stays-needs.test.ts and tests/core/sessions/turn-end-ask-ratchet.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-status-answer-newer-report'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask, getTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { applyStatusAnswer, storedIsNewer } from '../../../src/core/sessions/status-question.js'
import { setTaskReport } from '../../../src/core/sessions/report-set.js'
import type { StatusReport } from '../../../src/core/user-status.js'

const T = Date.parse('2026-11-23T13:04:29.303Z')
const iso = (ms: number) => new Date(ms).toISOString()
const done = (atMs: number): StatusReport => ({ state: 'done', now: 'The fixture turn finished.', at: iso(atMs) })

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('storedIsNewer', () => {
  it('reads the turn a report is about, falling back to when it was written', () => {
    expect(storedIsNewer({ at: iso(T + 5000), turn_ended_at: iso(T) }, T)).toBe(false)
    expect(storedIsNewer({ at: iso(T + 2000), turn_ended_at: iso(T + 2000) }, T)).toBe(true)
    expect(storedIsNewer({ at: iso(T + 2000) }, T)).toBe(true)
    expect(storedIsNewer({ at: iso(T - 2000) }, T)).toBe(false)
    expect(storedIsNewer(null, T)).toBe(false)
    // No basis (a mid-turn question with no ask time): nothing is held out.
    expect(storedIsNewer({ at: iso(T + 2000) }, Number.NaN)).toBe(false)
  })
})

describe('a status answer and a newer report', () => {
  async function taskWithSession(title: string) {
    const task = (await addTask({ title, project: 'Garden' })).task
    await updateTaskRaw(task.id, { phase: 'IN_PROGRESS', session_id: 'sid-turn' }, { source: 'test' })
    return task.id
  }

  it('keeps a person\'s report put after the turn the answer is about', async () => {
    const id = await taskWithSession('Taskbar entry')
    await setTaskReport(id, { state: 'needs', ask: 'Read notes.txt:2-3 first' }, null, T + 2000)
    const stored = await applyStatusAnswer(id, 'sid-turn', done(T + 5000), T)
    expect(stored).toBe(false)
    const after = (await getTask(id)).status_report
    expect(after?.state).toBe('needs')
    expect(after?.ask).toBe('Read notes.txt:2-3 first')
  })

  it('a later turn\'s answer still replaces it', async () => {
    const id = await taskWithSession('Later turn')
    await setTaskReport(id, { state: 'needs', ask: 'Read notes.txt:2-3 first' }, null, T + 2000)
    expect(await applyStatusAnswer(id, 'sid-turn', done(T + 9000), T + 6000)).toBe(true)
    expect((await getTask(id)).status_report?.state).toBe('done')
  })

  it('an answer of the same turn asked again replaces the first one', async () => {
    const id = await taskWithSession('Asked again')
    expect(await applyStatusAnswer(id, 'sid-turn', { state: 'working', now: 'Still on it', at: iso(T + 3000) }, T)).toBe(true)
    expect(await applyStatusAnswer(id, 'sid-turn', done(T + 8000), T)).toBe(true)
    expect((await getTask(id)).status_report?.state).toBe('done')
  })

  it('a mid-turn answer keeps a report put after it was asked', async () => {
    const id = await taskWithSession('Mid turn')
    await setTaskReport(id, { state: 'needs', ask: 'Pick the design' }, null, T + 2000)
    expect(await applyStatusAnswer(id, 'sid-turn', done(T + 4000), T - 60_000, { midTurn: true, askedAtMs: T + 1000 })).toBe(false)
    expect((await getTask(id)).status_report?.state).toBe('needs')
  })
})
