/**
 * A lead hears what moved in its teams before its next message (src/core/org/team-note.ts), on a
 * real server: the words come from each task's own status report through the user-status sync,
 * never from a worker writing to its lead.
 *   - the first message says where the teams stand now
 *   - nothing moved: no note; a turn that only ended is no news
 *   - a task that needs the user, a finished task: one note, told once; new progress words and a
 *     new task are no news
 *   - a note with nothing the lead must act on waits an hour after the last; a wait on the lead goes at once
 *   - the note rides the queued row of an ordinary send, and only that one
 *   - a worker that waits on the lead wakes it with the note, once (lead-waits.ts)
 *   - an ask into a team task from outside the team is listed; the team's own is not (team-asks.ts)
 *   - one question asked over several messages is one line, in the question's own words
 *   - after a compaction the lead reads its teams back in full (open-items.ts)
 * Only the Claude CLI is mocked (no session is started here).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-org-team-note'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, completeTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { ensureProjectLead, pendingOrgDigest } from '../../src/core/org/org-store.js'
import { _resetTeamNoteClaimsForTesting, _setTeamNoteGapMsForTesting } from '../../src/core/org/team-note.js'
import { deleteMessage, getQueue, sendMessageToSession } from '../../src/core/session-message-queue.js'
import { sendLetter } from '../../src/core/human-inbox/store.js'
import { _setLeadWaitClocksForTesting, tellLead } from '../../src/core/org/lead-waits.js'
import { noteTeamAsk, pendingTeamAsks } from '../../src/core/org/team-asks.js'
import { collectOpenItems } from '../../src/core/sessions/open-items.js'

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
  // The hour between notes is its own case below; the rest read each note as it comes.
  _setTeamNoteGapMsForTesting(0)
})

afterAll(async () => {
  _setTeamNoteGapMsForTesting()
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

    // New words (progress, no news), a worker that needs the user, one done, one new (no news).
    await report(ids['Renew the permit']!, 'The identity check passed; only your signature is left.', t0 + 1_000)
    // Its turn ends on the user (its own status), with a decision letter that says what.
    await updateTask(ids['Order seeds']!, { phase: 'NEED_ACTION' }, { source: 'api' })
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
    expect(note!.text).not.toContain('The identity check passed')
    expect(note!.text).toContain('Done: "Plan the beds"')
    expect(note!.text).not.toContain('Fix the fence')
    expect(note!.text).not.toMatch(/\(working[,)]/)
    // Two sends at the same moment: one carries it.
    expect(await pendingOrgDigest(LEAD_SID, t0 + 61_100)).toBeNull()
    await note!.markTold()
    expect(await pendingOrgDigest(LEAD_SID, t0 + 61_200)).toBeNull()
  })

  it('rides the queued row of an ordinary send, and only that one', async () => {
    // Progress words alone: no note.
    await report(ids['Renew the permit']!, 'Signed copy received; filing it now.', Date.now())
    _resetTeamNoteClaimsForTesting()
    const quiet = await sendMessageToSession(LEAD_SID, 'Anything new?', { source: 'peer' })
    expect((await getQueue(LEAD_SID)).find((m) => m.id === quiet.id)?.message).not.toContain('outcome="org-update"')
    for (const m of await getQueue(LEAD_SID)) await deleteMessage(LEAD_SID, m.id)
    await completeTask(ids['Renew the permit']!)
    _resetTeamNoteClaimsForTesting()
    const sent = await sendMessageToSession(LEAD_SID, 'How is Garden going?', { source: 'peer' })
    const rows = await getQueue(LEAD_SID)
    const row = rows.find((m) => m.id === sent.id)!
    expect(row.message).toContain('outcome="org-update"')
    expect(row.message).toContain('Done: "Renew the permit"')
    expect(row.message).not.toContain('Signed copy received')
    // The note goes in front of the message, in the same row.
    expect(row.message.indexOf('outcome="org-update"')).toBeLessThan(row.message.indexOf('How is Garden going?'))
    const again = await sendMessageToSession(LEAD_SID, 'And the fence?', { source: 'peer' })
    const second = (await getQueue(LEAD_SID)).find((m) => m.id === again.id)
    // A repeat may collapse onto the queued row; a row of its own carries no second note.
    if (second && second.id !== row.id) expect(second.message).not.toContain('outcome="org-update"')
    for (const m of await getQueue(LEAD_SID)) await deleteMessage(LEAD_SID, m.id)
  })

  it('a first look that told nothing starts no hour', async () => {
    _setTeamNoteGapMsForTesting()
    try {
      const quietLead = (await ensureProjectLead('Pond')).id
      const sid = '88888888-9999-4aaa-8bbb-cccccccccccc'
      await createSessionRecord(sid, quietLead, 'Pond', WALNUT_HOME)
      const pump = (await addTask({ title: 'Clean the pump', project: 'Pond' })).task.id
      const t0 = Date.now()
      _resetTeamNoteClaimsForTesting()
      expect(await pendingOrgDigest(sid, t0)).toBeNull()
      await completeTask(pump)
      _resetTeamNoteClaimsForTesting()
      const note = await pendingOrgDigest(sid, t0 + 5 * 60_000)
      expect(note?.text).toContain('Done: "Clean the pump"')
      await note!.markTold()
    } finally {
      _setTeamNoteGapMsForTesting(0)
    }
  })

  it('any other session never gets one', async () => {
    const other = '44444444-5555-4666-8777-888888888888'
    await createSessionRecord(other, ids['Renew the permit']!, 'Garden', WALNUT_HOME)
    expect(await pendingOrgDigest(other)).toBeNull()
  })
})

describe('the hour between notes', () => {
  afterAll(() => { _setTeamNoteGapMsForTesting(0) })

  it('a note with nothing to act on waits an hour after the last, then carries all that piled up; a wait on the lead goes at once', async () => {
    _setTeamNoteGapMsForTesting()
    // Two hours after the note the case before told, on the clock the plan reads.
    const t0 = Date.now() + 2 * 60 * 60_000
    // A note just went out.
    const a = (await addTask({ title: 'Mulch the path', project: 'Garden' })).task.id
    await updateTask(a, { phase: 'NEED_ACTION' }, { source: 'api' })
    await sendLetter({ subject: 'Bark or straw?', type: 'action_required', markdown: 'Which?', actions: [{ id: 'b', label: 'Bark' }], sender: { taskId: a } } as never)
    await until('it needs the user', async () => (await getTask(a)).user_status?.state === 'needs')
    _resetTeamNoteClaimsForTesting()
    const first = await pendingOrgDigest(LEAD_SID, t0)
    expect(first?.text).toContain('"Mulch the path": Bark or straw?')
    await first!.markTold()
    // Something done ten minutes later is held, and so is a second thing at forty minutes.
    await completeTask(a)
    _resetTeamNoteClaimsForTesting()
    expect(await pendingOrgDigest(LEAD_SID, t0 + 10 * 60_000)).toBeNull()
    const b = (await addTask({ title: 'Sharpen the shears', project: 'Garden' })).task.id
    await updateTask(b, { phase: 'NEED_ACTION' }, { source: 'api' })
    await sendLetter({ subject: 'New blades?', type: 'action_required', markdown: 'Buy?', actions: [{ id: 'y', label: 'Yes' }], sender: { taskId: b } } as never)
    await until('it needs the user', async () => (await getTask(b)).user_status?.state === 'needs')
    _resetTeamNoteClaimsForTesting()
    expect(await pendingOrgDigest(LEAD_SID, t0 + 40 * 60_000)).toBeNull()
    // An hour after the last note: one note with both.
    _resetTeamNoteClaimsForTesting()
    const hour = await pendingOrgDigest(LEAD_SID, t0 + 60 * 60_000 + 1_000)
    expect(hour?.text).toContain('Done: "Mulch the path"')
    expect(hour?.text).toContain('"Sharpen the shears": New blades?')
    await hour!.markTold()
    // A worker waiting on the lead a minute later is not held.
    const c = (await addTask({ title: 'Oil the hinge', project: 'Garden', parent_task_id: leadId })).task.id
    await updateTask(c, { phase: 'WAITING' }, { source: 'api' })
    await updateTaskRaw(c, { status_report: { state: 'done', now: 'Oiled both hinges.', at: new Date(Date.now() + 1_000).toISOString() } }, { emitEvent: true, source: 'status-report' })
    await until('the worker waits on its lead', async () => (await getTask(c)).user_status?.kind === 'lead')
    _resetTeamNoteClaimsForTesting()
    const now = await pendingOrgDigest(LEAD_SID, t0 + 61 * 60_000 + 1_000)
    expect(now?.text).toContain('Waiting on you:')
    expect(now?.text).toContain('"Oil the hinge"')
    await now!.markTold()
    await completeTask(b)
    await completeTask(c)
    _resetTeamNoteClaimsForTesting()
    // Leaves the next cases a told state with these gone.
    const rest = await pendingOrgDigest(LEAD_SID, t0 + 3 * 60 * 60_000)
    await rest?.markTold()
  })
})

describe('what reaches the lead without a message from anyone', () => {
  it('a worker that waits on the lead wakes it with the note, once', async () => {
    // The watcher's own timer stays long here, so the test's call is the one that tells it.
    _setLeadWaitClocksForTesting(10 * 60_000, 0)
    const hose = (await addTask({ title: 'Check the hose', project: 'Garden', parent_task_id: leadId })).task.id
    // Its turn said it is done, which parks it for its lead to check the result
    // (sessions/report-phase.ts), and the status says on whom it waits (src/core/user-status.ts).
    await updateTask(hose, { phase: 'WAITING' }, { source: 'api' })
    await updateTaskRaw(hose, { status_report: { state: 'done', now: 'The hose holds; replaced one clamp.', at: new Date(Date.now() + 1_000).toISOString() } },
      { emitEvent: true, source: 'status-report' })
    await until('the worker waits on its lead', async () => (await getTask(hose)).user_status?.kind === 'lead')
    _resetTeamNoteClaimsForTesting()
    expect(await tellLead(leadId)).toBe(true)
    const row = (await getQueue(LEAD_SID)).find((m) => m.message.includes('Waiting on you:'))
    expect(row?.message).toContain('"Check the hose"')
    expect(row?.message).toContain('It said: The hose holds; replaced one clamp.')
    expect(row?.message).toContain('You lead "Garden".')
    // Told: nothing wakes it again for the same wait.
    expect(await tellLead(leadId)).toBe(false)
    for (const m of await getQueue(LEAD_SID)) await deleteMessage(LEAD_SID, m.id)
    _setLeadWaitClocksForTesting()
  })

  it('an ask into a team task from outside the team is the lead\'s to know; the team\'s own is not', async () => {
    const sid = '55555555-6666-4777-8888-999999999999'
    const roses = (await addTask({ title: 'Water the roses', project: 'Garden' })).task.id
    await createSessionRecord(sid, roses, 'Garden', WALNUT_HOME)
    await sendMessageToSession(sid, 'Please also renew the parking permit.\nIt runs out in May.', { source: 'ui' })
    await until('the ask is recorded', async () => (await pendingTeamAsks(leadId)).length === 1)
    // The lead's own message to its worker is the team working.
    const own = `<walnut-message kind="peer-note" from="Garden lead [33333333]" from-task="${leadId}" title="Next step">\nGo on\n</walnut-message>`
    await noteTeamAsk(sid, 'Go on', own, 'peer')
    // The main agent's is from outside.
    const main = '<walnut-message kind="peer-note" from="Main [3ea08ceb]" from-task="main-task" title="Check the fence too">\nAlso the fence.\n</walnut-message>'
    await noteTeamAsk(sid, 'Also the fence.', main, 'peer')
    expect((await pendingTeamAsks(leadId)).map((a) => [a.from, a.gist])).toEqual([
      ['the user', 'Please also renew the parking permit.'], ['Main', 'Check the fence too'],
    ])
    _resetTeamNoteClaimsForTesting()
    const note = await pendingOrgDigest(LEAD_SID)
    expect(note!.text).toContain('Asked of your teams by others:\n- "Water the roses": the user is talking with it in its own chat (just now): "Please also renew the parking permit."; Main added (just now): "Check the fence too"\n')
    await note!.markTold()
    expect(await pendingTeamAsks(leadId)).toEqual([])
    for (const m of await getQueue(sid)) await deleteMessage(sid, m.id)
  })

  it('one question asked over several messages is one line, in the question\'s own words', async () => {
    // 2026-10-27, the org's reflection: a lead's note listed "[Question Q12]" / "[Question Q13]" six times.
    const sid = '66666666-7777-4888-9999-aaaaaaaaaaaa'
    const beds = (await addTask({ title: 'Plan the raised beds', project: 'Garden' })).task.id
    await createSessionRecord(sid, beds, 'Garden', WALNUT_HOME)
    const now = new Date().toISOString()
    await updateSessionRecord(sid, { threadMeta: [{ headId: 'head-12', status: 'open', seq: 12, question: 'How deep should the beds be?\nFor carrots.', title: 'Bed depth', updatedAt: now }] })
    const banner = (n: number) => `[Question Q${n}]\nThis message is question ${n} of this conversation. Begin your reply with the line "[Q${n}]" (nothing else on that line) so the reply is filed under question ${n}.\n[/Question Q${n}]`
    // Each one recorded before the next goes in (a recording runs beside its send).
    const counted = async () => (await pendingTeamAsks(leadId)).reduce((n, a) => n + (a.count ?? 1), 0)
    const say = async (text: string, total: number) => {
      await sendMessageToSession(sid, text, { source: 'ui' })
      await until(`${total} messages counted`, async () => (await counted()) === total)
    }
    // The question's first message here is a follow-up: the line still shows the question's own words.
    await say(`${banner(12)}\n\nand for potatoes?`, 1)
    await say(`${banner(12)}\n\nand for carrots?`, 2)
    await say(`${banner(13)}\n\n(Back to the earlier question about \u201cSoil\u201d)\n\n> Mix in compost.\n\nHow much compost?`, 3)
    await say(`${banner(12)}\n\nand for leeks?`, 4)
    await say('(Back to the main conversation)\n\nOrder the timber too.', 5)
    await say('Pine is fine.', 6)
    expect((await pendingTeamAsks(leadId)).map((a) => [a.question ?? null, a.latest ? `${a.gist} / ${a.latest}` : a.gist, a.count ?? 1])).toEqual([
      [13, 'How much compost?', 1], [12, 'How deep should the beds be?', 3], [null, 'Order the timber too. / Pine is fine.', 2],
    ])
    _resetTeamNoteClaimsForTesting()
    const note = await pendingOrgDigest(LEAD_SID)
    const asked = note!.text.slice(note!.text.indexOf('Asked of your teams by others:'))
    // One line for the task, however many questions and messages it was.
    expect(asked).toMatch(/^Asked of your teams by others:\n- "Plan the raised beds": the user is talking with it in its own chat \(6 messages, the latest just now\): "Pine is fine\."\n(?!- "Plan)/)
    expect(note!.text).not.toContain('[Question')
    // A message that comes in while the note is on its way is not cleared with it: the next note tells it.
    await say('And stain it.', 7)
    await note!.markTold()
    expect((await pendingTeamAsks(leadId)).map((a) => [a.gist, a.count, a.latest])).toEqual([['And stain it.', 1, undefined]])
    _resetTeamNoteClaimsForTesting()
    const next = await pendingOrgDigest(LEAD_SID)
    expect(next!.text).toContain('- "Plan the raised beds": the user is talking with it in its own chat (just now): "And stain it."\n')
    await next!.markTold()
    expect(await pendingTeamAsks(leadId)).toEqual([])
    for (const m of await getQueue(sid)) await deleteMessage(sid, m.id)
  })

  it('what the user said in a task\'s own chat that the task answered is no ask of the team', async () => {
    const sid = '77777777-8888-4999-aaaa-bbbbbbbbbbbb'
    const hedge = (await addTask({ title: 'Trim the hedge', project: 'Garden' })).task.id
    await createSessionRecord(sid, hedge, 'Garden', WALNUT_HOME)
    await sendMessageToSession(sid, 'Keep it at waist height.', { source: 'ui' })
    await until('the ask is recorded', async () => (await pendingTeamAsks(leadId)).some((a) => a.taskId === hedge))
    // A failed delivery or a reap moves the session's status, which is no answer: still listed.
    await updateSessionRecord(sid, { process_status: 'idle', last_status_change: new Date(Date.now() + 1000).toISOString() })
    _resetTeamNoteClaimsForTesting()
    const before = await pendingOrgDigest(LEAD_SID)
    expect(before?.text ?? '').toContain('"Trim the hedge": the user is talking with it in its own chat')
    _resetTeamNoteClaimsForTesting()
    // Its turn-end report came after the message: it answered.
    // A report read after the message about a turn that ended before it answers nothing.
    await updateTaskRaw(hedge, { status_report: { state: 'done', now: 'Trimmed', at: new Date(Date.now() + 1000).toISOString(), turn_ended_at: new Date(Date.now() - 60_000).toISOString() } })
    _resetTeamNoteClaimsForTesting()
    const stale = await pendingOrgDigest(LEAD_SID)
    expect(stale?.text ?? '').toContain('"Trim the hedge": the user is talking with it in its own chat')
    await updateTaskRaw(hedge, { status_report: { state: 'done', now: 'Trimmed to waist height', at: new Date(Date.now() + 1000).toISOString(), turn_ended_at: new Date(Date.now() + 1000).toISOString() } })
    _resetTeamNoteClaimsForTesting()
    const note = await pendingOrgDigest(LEAD_SID)
    expect(note?.text ?? '').not.toContain('"Trim the hedge": the user')
    await note?.markTold()
    expect((await pendingTeamAsks(leadId)).some((a) => a.taskId === hedge)).toBe(false)
    for (const m of await getQueue(sid)) await deleteMessage(sid, m.id)
  })

  it('after a compaction the lead reads its teams back in full', async () => {
    const items = await collectOpenItems(LEAD_SID, Date.now(), { afterCompaction: true })
    expect(items.text).toContain('Your teams now, from their own status:')
    expect(items.text).toContain('You lead "Garden".')
    expect(items.text).toContain('"Check the hose"')
  })
})

