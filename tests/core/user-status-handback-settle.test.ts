/**
 * A hand-back with nothing asked waits HANDBACK_SETTLE_MS before the stored user status reads
 * Needs you (src/core/user-status-sync.ts). 2026-10-28: 134 of 519 moves into NEED_ACTION were
 * undone by a new turn within 30 s, and each one turned the task red on the Org page for a few
 * seconds ("the ORG webpage is really flaky, flashing"). A real ask (a letter) is never held.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-user-status-handback-settle'))

import { WALNUT_HOME } from '../../src/constants.js'
import { addTask, getTask, updateTask } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { sendLetter } from '../../src/core/human-inbox/store.js'
import { syncUserStatuses, handBackSettlesAt, HANDBACK_SETTLE_MS, stopUserStatusSync } from '../../src/core/user-status-sync.js'
import { HANDED_BACK_ASK } from '../../src/core/user-status.js'

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  stopUserStatusSync()
})

afterAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

async function workingTask(title: string, sid: string) {
  const t = (await addTask({ title, project: 'Acme' })).task
  await createSessionRecord(sid, t.id, 'Acme')
  await updateSessionRecord(sid, { process_status: 'running' })
  await updateTask(t.id, { phase: 'IN_PROGRESS' })
  await syncUserStatuses(new Set([t.id]))
  expect((await getTask(t.id)).user_status?.state).toBe('working')
  return t
}

/** As a turn end does: the CLI idles and the reconciler hands the task back. */
async function handBack(id: string, sid: string) {
  await updateSessionRecord(sid, { process_status: 'idle' })
  await updateTask(id, { phase: 'NEED_ACTION' })
}

describe('hand-back settle hold', () => {
  it('keeps the last status during the hold, then reads Needs you', async () => {
    const t = await workingTask('Turn ended, nothing asked', 'sess-settle-1')
    await handBack(t.id, 'sess-settle-1')
    const moved = Date.parse((await getTask(t.id)).phase_changed_at!)

    expect(await syncUserStatuses(new Set([t.id]), moved + 1_000)).toBe(0)
    expect((await getTask(t.id)).user_status?.state).toBe('working')

    await syncUserStatuses(new Set([t.id]), moved + HANDBACK_SETTLE_MS + 1)
    expect((await getTask(t.id)).user_status).toMatchObject({ state: 'needs', source: 'session', ask: HANDED_BACK_ASK })
  })

  it('never writes Needs you for a hand-back a new turn undoes inside the hold', async () => {
    const t = await workingTask('Woken again at once', 'sess-settle-2')
    await handBack(t.id, 'sess-settle-2')
    const moved = Date.parse((await getTask(t.id)).phase_changed_at!)
    await syncUserStatuses(new Set([t.id]), moved + 2_000)
    expect((await getTask(t.id)).user_status?.state).toBe('working')
    // The CLI's follow-up turn starts.
    await updateSessionRecord('sess-settle-2', { process_status: 'running' })
    await updateTask(t.id, { phase: 'IN_PROGRESS' })
    await syncUserStatuses(new Set([t.id]), moved + 4_000)
    // Past the hold: it is working, and never read Needs you on the way.
    await syncUserStatuses(new Set([t.id]), moved + HANDBACK_SETTLE_MS + 1)
    expect((await getTask(t.id)).user_status?.state).toBe('working')
  })

  it('does not hold a real ask', async () => {
    // The sync keeps the inbox it read until a letter event (none here: the sync is not started).
    const t = (await addTask({ title: 'Asks by letter', project: 'Acme' })).task
    await createSessionRecord('sess-settle-3', t.id, 'Acme')
    await updateSessionRecord('sess-settle-3', { process_status: 'running' })
    await updateTask(t.id, { phase: 'IN_PROGRESS' })
    await sendLetter({
      subject: 'Pick a design', type: 'action_required', markdown: 'A or B?',
      actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      sender: { sessionId: 'sess-settle-3', taskId: t.id },
    } as never)
    stopUserStatusSync() // drops the kept facts, as the letter event does
    await syncUserStatuses(new Set([t.id]))
    expect((await getTask(t.id)).user_status?.state).toBe('working')
    await handBack(t.id, 'sess-settle-3')
    const moved = Date.parse((await getTask(t.id)).phase_changed_at!)
    await syncUserStatuses(new Set([t.id]), moved + 500)
    expect((await getTask(t.id)).user_status).toMatchObject({ state: 'needs', source: 'letter', ask: 'Pick a design' })
  })

  it('handBackSettlesAt: only a turn end of a task with a session, only inside the hold', () => {
    const now = Date.parse('2026-10-28T10:00:00Z')
    const bare = { state: 'needs' as const, source: 'session' as const, ask: HANDED_BACK_ASK }
    const fresh = { phase_changed_at: new Date(now - 5_000).toISOString(), user_status: { state: 'working' as const } }
    expect(handBackSettlesAt(fresh, bare, now, true)).toBe(now - 5_000 + HANDBACK_SETTLE_MS)
    expect(handBackSettlesAt({ ...fresh, user_status: { state: 'waiting', kind: 'other' } }, bare, now, true)).toBe(now - 5_000 + HANDBACK_SETTLE_MS)
    expect(handBackSettlesAt({ ...fresh, phase_changed_at: new Date(now - HANDBACK_SETTLE_MS - 1).toISOString() }, bare, now, true)).toBeNull()
    expect(handBackSettlesAt({ ...fresh, user_status: { state: 'needs', source: 'letter', ask: 'x' } }, bare, now, true)).toBeNull()
    expect(handBackSettlesAt(fresh, { ...bare, ask: 'Pick a design' }, now, true)).toBeNull()
    expect(handBackSettlesAt({ user_status: fresh.user_status }, bare, now, true)).toBeNull()
    // A person or a lead moving a task by hand: no session, or not started yet, or never derived.
    expect(handBackSettlesAt(fresh, bare, now, false)).toBeNull()
    expect(handBackSettlesAt({ ...fresh, user_status: { state: 'waiting', kind: 'not-started' } }, bare, now, true)).toBeNull()
    expect(handBackSettlesAt({ phase_changed_at: fresh.phase_changed_at }, bare, now, true)).toBeNull()
  })

  it('a task with no session set to NEED_ACTION by hand reads Needs you at once', async () => {
    const t = (await addTask({ title: 'Moved by a person', project: 'Acme' })).task
    await updateTask(t.id, { phase: 'IN_PROGRESS' })
    await syncUserStatuses(new Set([t.id]))
    await updateTask(t.id, { phase: 'NEED_ACTION' })
    const moved = Date.parse((await getTask(t.id)).phase_changed_at!)
    await syncUserStatuses(new Set([t.id]), moved + 500)
    expect((await getTask(t.id)).user_status?.state).toBe('needs')
  })
})
