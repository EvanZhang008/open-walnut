/**
 * A lead hears what moved in its teams before its next message (src/core/org/team-note.ts), on a
 * real server: the words come from each task's own status report through the user-status sync,
 * never from a worker writing to its lead.
 *   - the first message says where the teams stand now
 *   - nothing moved: no note; a turn that only ended is no news
 *   - new words, a task that needs the user, a finished task, a new task: one note, told once
 *   - the note rides the queued row of an ordinary send, and only that one
 * Only the Claude CLI is mocked (no session is started here).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-org-team-note'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, completeTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { ensureProjectLead, pendingOrgDigest } from '../../src/core/org/org-store.js'
import { _resetTeamNoteClaimsForTesting } from '../../src/core/org/team-note.js'
import { deleteMessage, getQueue, sendMessageToSession } from '../../src/core/session-message-queue.js'
import { sendLetter } from '../../src/core/human-inbox/store.js'

const LEAD_SID = '33333333-4444-4555-8666-777777777777'

async function until(what: string, ok: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 15_000
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** A turn's own report, as the session hook stores it; the server's sync derives the status. */
async function report(taskId: string, now: string, atMs: number): Promise<void> {
  await updateTaskRaw(taskId, {
    status_report: { state: 'waiting', waiting_kind: 'you', waiting_on: 'You, no rush', now, at: new Date(atMs).toISOString() },
  }, { emitEvent: true, source: 'status-report' })
  await until(`${taskId} reads "${now}"`, async () => (await getTask(taskId)).user_status?.now === now)
}

let leadId = ''
const ids: Record<string, string> = {}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await startServer({ port: 0, dev: true })
  for (const title of ['Renew the permit', 'Plan the beds']) ids[title] = (await addTask({ title, project: 'Garden' })).task.id
  ids['Order seeds'] = (await addTask({ title: 'Order seeds', project: 'Garden', parent_task_id: ids['Plan the beds'] })).task.id
  leadId = (await ensureProjectLead('Garden')).id
  await createSessionRecord(LEAD_SID, leadId, 'Garden', WALNUT_HOME)
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a lead\'s team note', () => {
  it('first says where the teams stand, then only what moved, each once', async () => {
    const t0 = Date.now()
    await report(ids['Renew the permit']!, 'Sent the form to the office.', t0 - 60_000)

    const first = await pendingOrgDigest(LEAD_SID, t0)
    expect(first).not.toBeNull()
    expect(first!.text).toContain('outcome="org-update"')
    expect(first!.text).toContain(`about-task="${leadId}"`)
    expect(first!.text).toContain('Your teams now, from their own status:')
    expect(first!.text).toContain('"Renew the permit" (waiting, 1 min ago): Sent the form to the office.')
    await first!.markTold()
    expect(await pendingOrgDigest(LEAD_SID, t0 + 500)).toBeNull()

    // A turn that only ended moves the phase, not the news.
    await updateTask(ids['Plan the beds']!, { phase: 'NEED_ACTION' }, { source: 'api' })
    expect(await pendingOrgDigest(LEAD_SID, t0 + 800)).toBeNull()

    // The task the user's example was about: new words, a worker that needs the user, one done, one new.
    await report(ids['Renew the permit']!, 'The identity check passed; only your signature is left.', t0 + 1_000)
    await sendLetter({
      subject: 'Which supplier?', type: 'action_required', markdown: 'A or B?',
      actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], sender: { taskId: ids['Order seeds'] },
    } as never)
    await until('the worker needs the user', async () => (await getTask(ids['Order seeds']!)).user_status?.state === 'needs')
    const fresh = (await addTask({ title: 'Fix the fence', project: 'Garden' })).task.id
    await completeTask(ids['Plan the beds']!)
    // A task the lead was never told about finished before it heard of it: not "done" news.
    await completeTask(fresh)

    _resetTeamNoteClaimsForTesting()
    const note = await pendingOrgDigest(LEAD_SID, t0 + 61_000)
    expect(note).not.toBeNull()
    expect(note!.text).toContain('Team update (last note 1 min ago)')
    expect(note!.text).toContain('Needs the user:\n- "Order seeds": Which supplier?')
    expect(note!.text).toContain('Changed:\n- "Renew the permit" (waiting, 1 min ago): The identity check passed; only your signature is left.')
    expect(note!.text).toContain('Done: "Plan the beds"')
    expect(note!.text).not.toContain('Fix the fence')
    // Two sends at the same moment: one carries it.
    expect(await pendingOrgDigest(LEAD_SID, t0 + 61_100)).toBeNull()
    await note!.markTold()
    expect(await pendingOrgDigest(LEAD_SID, t0 + 61_200)).toBeNull()
  })

  it('rides the queued row of an ordinary send, and only that one', async () => {
    await report(ids['Renew the permit']!, 'Signed copy received; filing it now.', Date.now())
    _resetTeamNoteClaimsForTesting()
    const sent = await sendMessageToSession(LEAD_SID, 'How is Garden going?', { source: 'peer' })
    const rows = await getQueue(LEAD_SID)
    const row = rows.find((m) => m.id === sent.id)!
    expect(row.message).toContain('outcome="org-update"')
    expect(row.message).toContain('Signed copy received; filing it now.')
    // The note goes in front of the message, in the same row.
    expect(row.message.indexOf('outcome="org-update"')).toBeLessThan(row.message.indexOf('How is Garden going?'))
    const again = await sendMessageToSession(LEAD_SID, 'And the fence?', { source: 'peer' })
    const second = (await getQueue(LEAD_SID)).find((m) => m.id === again.id)
    // A repeat may collapse onto the queued row; a row of its own carries no second note.
    if (second && second.id !== row.id) expect(second.message).not.toContain('outcome="org-update"')
    for (const m of await getQueue(LEAD_SID)) await deleteMessage(LEAD_SID, m.id)
  })

  it('any other session never gets one', async () => {
    const other = '44444444-5555-4666-8777-888888888888'
    await createSessionRecord(other, ids['Renew the permit']!, 'Garden', WALNUT_HOME)
    expect(await pendingOrgDigest(other)).toBeNull()
  })
})
