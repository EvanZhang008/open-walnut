/**
 * One pass of the letter re-check (src/core/sessions/letter-recheck.ts): a COMPLETE task's open
 * decision letter is settled with its reason; an open task whose decision letter nobody wrote in
 * for NEEDS_RECHECK_MS gets ONE note naming it, recorded first, at most once a period; a fresh
 * letter, an answered one and a task with no session are left alone.
 *
 * Real task store and letter store in an isolated WALNUT_HOME; the session side is stubbed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'
import type { SessionRecord } from '../../src/core/types.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-letter-recheck'))
const sends: { sid: string; text: string; source?: string }[] = []
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionsForTask: async (id: string) => [{ claudeSessionId: `s-${id}`, taskId: id, process_status: 'stopped' } as SessionRecord],
}))
vi.mock('../../src/core/routines/session-target.js', () => ({ pickDeliverySession: (rows: SessionRecord[]) => rows[0] ?? null }))
let routines: { id: string; enabled: boolean }[] = []
vi.mock('../../src/core/routines/routines-core.js', () => ({ listRoutines: async () => ({ jobs: routines }) }))
vi.mock('../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: async (sid: string, text: string, o: { source?: string }) => { sends.push({ sid, text, source: o.source }) },
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { addTask, completeTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { answerLetter, getLetter, sendLetter } from '../../src/core/human-inbox/store.js'
import { runLetterRecheck } from '../../src/core/sessions/letter-recheck.js'
import { NEEDS_RECHECK_MS } from '../../src/core/user-status.js'

const ask = (taskId: string, subject: string) => sendLetter({
  subject, type: 'action_required', markdown: 'Accept it, then tap.', actions: [{ id: 'ok', label: 'Accepted' }],
  sender: { sessionId: `s-${taskId}`, host: 'local', taskId },
})

beforeAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }); await fs.mkdir(WALNUT_HOME, { recursive: true }) })
afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })
beforeEach(() => { sends.length = 0; routines = [] })

describe('a letter re-check pass', () => {
  it('settles a completed task\'s decision, wakes an open task once per period, leaves the rest', async () => {
    const done = (await addTask({ title: 'TestFlight 140' })).task
    const open = (await addTask({ title: 'Ship 141' })).task
    const stale = await ask(done.id, 'Upload blocked: accept the agreement')
    const waiting = await ask(open.id, 'Sign the tax form')
    const answered = await ask(open.id, 'Pick a build')
    await answerLetter(answered.id, { actionId: 'ok' })
    // Completed without the edge running (no watcher here): the pass catches it.
    await completeTask(done.id)
    const now = Date.now()

    // Fresh: nothing is due yet, but the completed task's letter is settled at once.
    let out = await runLetterRecheck(now)
    expect(out.settled).toEqual([stale.id])
    expect((await getLetter(stale.id))!.settled!.reason).toMatch(/"TestFlight 140" was completed/)
    expect(out.woken).toEqual([])

    // Four hours on: the open task's quiet letter brings one note, recorded first.
    out = await runLetterRecheck(now + NEEDS_RECHECK_MS + 60_000)
    expect(out.woken).toEqual([open.id])
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ sid: `s-${open.id}`, source: 'wait-until' })
    expect(sends[0].text).toContain(waiting.id)
    expect(sends[0].text).not.toContain(answered.id)
    expect(sends[0].text).toContain('"settled"')
    expect((await getTask(open.id)).letter_recheck).toMatchObject({ count: 1, letters: [waiting.id] })

    // Inside the same period: nothing again. The next one counts up.
    expect((await runLetterRecheck(now + NEEDS_RECHECK_MS + 120_000)).woken).toEqual([])
    expect((await runLetterRecheck(now + 2 * NEEDS_RECHECK_MS + 120_000)).woken).toEqual([open.id])
    expect((await getTask(open.id)).letter_recheck?.count).toBe(2)

    // Once nothing is open, the count is cleared.
    await answerLetter(waiting.id, { actionId: 'ok' })
    await runLetterRecheck(now + 3 * NEEDS_RECHECK_MS)
    expect((await getTask(open.id)).letter_recheck ?? null).toBeNull()
  })

  it('an ephemeral server never wakes a task for a letter it copied', async () => {
    const t = (await addTask({ title: 'Copied' })).task
    await ask(t.id, 'Old ask')
    const now = Date.now()
    expect((await runLetterRecheck(now + NEEDS_RECHECK_MS + 60_000, { notBefore: now + 1 })).woken).toEqual([])
  })

  it('a letter a live trigger of its task watches is left to that trigger', async () => {
    const t = (await addTask({ title: 'Fluent bit bump' })).task
    const watched = await ask(t.id, 'Approve the bump')
    await updateTaskRaw(t.id, { recheck_watch: [{ trigger: 'tr-w', watches: watched.id, at: new Date().toISOString() }] })
    routines = [{ id: 'tr-w', enabled: true }]
    const later = Date.now() + NEEDS_RECHECK_MS + 60_000
    expect((await runLetterRecheck(later)).woken).not.toContain(t.id)
    // Its trigger paused: the re-check is back, and it offers agent-ack for no change.
    routines = [{ id: 'tr-w', enabled: false }]
    expect((await runLetterRecheck(later)).woken).toContain(t.id)
    expect(sends.at(-1)!.text).toContain('<walnut-turn status="agent-ack"/>')
  })
})
