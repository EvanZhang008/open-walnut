/**
 * One matter is one ask of the user across teams, against a real server (src/core/ask-matter.ts,
 * src/core/same-ask-tree.ts, src/core/sessions/matter-news.ts). 2026-11-18, two real cases:
 *  - a ticket triage leader's letter asked the user who deletes a dangling DNS record of a ticket,
 *    and the task imported for that ticket (another project, no shared leader) asked him again;
 *  - the leader's letter asked the user to switch traffic back by hand, while the task imported for
 *    that alarm watched the automatic switch back, and later reported it done.
 * Covered outlets: a status ask, a decision letter, a Board choice, the fold of two statuses, the
 * turn-end status question, and the note to an asker when another team reports after its ask.
 * Ticket ids and hosts are invented. Only the session message send is stubbed (its argument checked).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-same-matter-ask'))
const sent: Array<{ sid: string; text: string }> = []
vi.mock('../../src/core/session-message-queue.js', async (orig) => ({
  ...(await orig() as object),
  sendMessageToSession: vi.fn(async (sid: string, text: string) => { sent.push({ sid, text }); return { queued: true } }),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, listTasks, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { syncUserStatuses } from '../../src/core/user-status-sync.js'
import { sameAskQuestionFor } from '../../src/core/same-ask-tree.js'
import { runMatterNews } from '../../src/core/sessions/matter-news.js'

let base = ''
let n = 0

async function making(title: string, project: string, tags: string[] = []): Promise<{ id: string; sid: string }> {
  n += 1
  const id = (await addTask({ title, project, ...(tags.length ? { tags } : {}) } as never)).task.id
  const sid = `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`
  await createSessionRecord(sid, id, project, WALNUT_HOME)
  await updateSessionRecord(sid, { process_status: 'idle' } as never)
  await updateTaskRaw(id, { session_id: sid } as never, { source: 'test' })
  await new Promise((r) => setTimeout(r, 15))
  return { id, sid }
}

/** A status written as a session's turn end would (no write check), for the fold and the reports. */
async function reported(id: string, report: Record<string, unknown>): Promise<void> {
  if (report.state === 'needs') await updateTask(id, { phase: 'NEED_ACTION' })
  await updateTaskRaw(id, { status_report: { at: new Date().toISOString(), rule: 2, ...report } } as never, { source: 'test' })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await syncUserStatuses(null, Date.now() + 60_000)
}

async function call(method: string, url: string, body: unknown, callerSid?: string): Promise<Response> {
  return fetch(`${base}${url}`, {
    method, headers: { 'content-type': 'application/json', ...(callerSid ? { 'x-walnut-caller-sid': callerSid } : {}) }, body: JSON.stringify(body),
  })
}
const idOf = async (res: Response) => { const b = (await res.json()) as { id?: string; letter?: { id: string } }; return b.letter?.id ?? b.id! }
const kind = { user_kind: 'cloud_delete', user_kind_why: 'It deletes a production DNS record' }

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'config.yaml'), 'ssh_login_hint: run acmelogin on this Mac\n')
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a decision about one ticket is asked once across teams (2026-11-18, the DNS record)', () => {
  let lead: { id: string; sid: string }
  let finding: { id: string; sid: string }
  let letter = ''

  beforeAll(async () => {
    lead = await making('Ticket triage lead', 'Platform Team', ['ticket:https://tickets.example.com/TKT-1001'])
    finding = await making('Scanner finding: subdomain delegation is dangling', 'teammate-import',
      ['ticket:TKT-1101', 'ticket-id:00000000-0000-4000-8000-000000000101', 'ticket:https://tickets.example.com/00000000-0000-4000-8000-000000000101'])
  })

  it("the second team's status ask, in other words, is refused naming the first team's open letter", async () => {
    const sent1 = await call('POST', '/api/v1/human-inbox', {
      type: 'action_required', subject: 'Another dangling dev delegation record: may a teammate delete it?',
      markdown: 'New high-severity ticket **TKT-1101**: the record points at a zone that is gone. Recommended: a teammate deletes it and you review.',
      actions: [{ id: 'teammate', label: 'A teammate deletes it, I review' }, { id: 'me', label: 'I delete it' }], ...kind,
    }, lead.sid)
    expect(sent1.status, await sent1.clone().text()).toBe(201)
    letter = await idOf(sent1)
    // Not one word of the letter's subject: only the ticket ties them.
    const again = await call('PUT', `/api/v1/tasks/${finding.id}/report`, { state: 'needs', ask: 'Who removes the stale NS entry: a colleague with your review, or me with write access?', ...kind }, finding.sid)
    expect(again.status).toBe(409)
    const why = JSON.stringify(await again.json())
    expect(why).toContain(letter)
    expect(why).toContain(lead.id)
    expect(why).toContain('TKT-1101')
    // The same in a letter of its own.
    const asLetter = await call('POST', '/api/v1/human-inbox', { type: 'action_required', subject: 'Approve removing the stale NS entry?', markdown: 'It is the record of this ticket.', actions: [{ id: 'yes', label: 'Yes' }], ...kind }, finding.sid)
    expect(asLetter.status).toBe(409)
  })

  it('the turn-end status question names the other team\'s letter, so the session does not ask in its chat either', async () => {
    const q = await sameAskQuestionFor(finding.id)
    expect(q).toContain(letter)
    expect(q).toContain('about TKT-1101')
  })

  it('a Board choice about the ticket is refused the same way; another matter goes as before', async () => {
    const owner = await making('Ops board owner', 'Ops Board')
    const html = (title: string) => `<html><body><h1>Ops</h1><walnut-choice id="pick1" title="${title}" options="a:Yes,b:No"></walnut-choice></body></html>`
    const refused = await call('PUT', `/api/v1/tasks/${owner.id}/board`, { html: html('Delete the TKT-1101 record now?') }, owner.sid)
    expect(refused.status).toBe(409)
    expect(JSON.stringify(await refused.json())).toContain(letter)
    const other = await call('PUT', `/api/v1/tasks/${owner.id}/board`, { html: html('Pick the on-call rotation for December?') }, owner.sid)
    expect(other.status, await other.clone().text()).toBe(200)
    // A choice added by an edit is checked too.
    const added = await call('POST', `/api/v1/tasks/${owner.id}/board/edits`, { edits: [{ old: '</body>', new: '<walnut-choice id="pick2" title="Remove the TKT-1101 record?" options="a:Yes,b:No"></walnut-choice></body>' }] }, owner.sid)
    expect(added.status).toBe(409)
    expect(JSON.stringify(await added.json())).toContain('Choice not added')
    // A choice already on the Board is not checked again when the page is edited around it.
    const edited = await call('POST', `/api/v1/tasks/${owner.id}/board/edits`, { edits: [{ old: '<h1>Ops</h1>', new: '<h1>Ops TKT-1101</h1>' }] }, owner.sid)
    expect(edited.status, await edited.clone().text()).toBe(200)
  })

  it('with same_ask_reason it goes; two statuses about the ticket then show once, the older task', async () => {
    const own = await call('PUT', `/api/v1/tasks/${finding.id}/report`, { state: 'needs', ask: 'Who removes the stale NS entry?', same_ask_reason: 'The lead handed the ticket to this task and settles its letter', ...kind }, finding.sid)
    expect(own.status, await own.clone().text()).toBe(200)
    const { setArchived } = await import('../../src/core/human-inbox/store.js')
    await setArchived(letter, true)
    await settle()
    // The lead asks it again later in its own status, naming the ticket: refused, naming the finding's ask.
    const lead2 = await call('PUT', `/api/v1/tasks/${lead.id}/report`, { state: 'needs', ask: 'Only one thing for you: who deletes the TKT-1101 record? Reply 1 or 2.', ...kind }, lead.sid)
    expect(lead2.status).toBe(409)
    expect(JSON.stringify(await lead2.json())).toContain(finding.id)
    // Both statuses written past the check (turn ends): one Needs you.
    await reported(lead.id, { state: 'needs', ask: 'Only one thing for you: who deletes the TKT-1101 record? Reply 1 or 2.', ask_own: { kind: 'cloud_delete', why: 'It deletes a production DNS record' } })
    await reported(finding.id, { state: 'needs', ask: 'Who removes the stale NS entry?', ask_own: { kind: 'cloud_delete', why: 'It deletes a production DNS record' } })
    await settle()
    const states = [(await getTask(lead.id)).user_status, (await getTask(finding.id)).user_status]
    expect(states.filter((s) => s?.state === 'needs')).toHaveLength(1)
    expect((await getTask(finding.id)).user_status).toMatchObject({ state: 'waiting', sameAsk: { id: lead.id } })
  })

  it('an ask given a reason stays apart in the fold too', async () => {
    const second = await making('Second finding on the ticket', 'teammate-import', ['ticket:TKT-1101'])
    const res = await call('PUT', `/api/v1/tasks/${second.id}/report`, { state: 'needs', ask: 'Approve the zone transfer this ticket also needs?', same_ask_reason: 'A separate change on the same ticket that the user must approve too', ...kind }, second.sid)
    expect(res.status, await res.clone().text()).toBe(200)
    await settle()
    expect((await getTask(second.id)).user_status?.state).toBe('needs')
  })

  it('an ask about an unrelated ticket of another team is not touched', async () => {
    const x = await making('Unrelated finding', 'teammate-import', ['ticket:TKT-1999'])
    const res = await call('PUT', `/api/v1/tasks/${x.id}/report`, { state: 'needs', ask: 'Who removes the stale NS entry for this other zone?', ...kind }, x.sid)
    expect(res.status, await res.clone().text()).toBe(200)
  })
})

describe('an ask to do what another team reported on (2026-11-18, the switch back)', () => {
  let lead: { id: string; sid: string }
  let alarm: { id: string; sid: string }

  beforeAll(async () => {
    for (const t of await listTasks()) await updateTaskRaw(t.id, { phase: 'COMPLETE' } as never, { source: 'test' })
    lead = await making('Ticket triage lead (2)', 'Platform Team')
    alarm = await making('Alarm: traffic moved off zone one - switch back', 'teammate-import',
      ['ticket:TKT-2201', 'ticket:https://tickets.example.com/TKT-2202', 'ticket:https://tickets.example.com/TKT-2203'])
  })

  it("the letter is held until the asker reads the other team's latest word; with a reason it goes", async () => {
    await reported(alarm.id, { state: 'working', now: 'The automatic switch back is on by default and is in its 15-minute wait window' })
    await settle()
    expect((await getTask(alarm.id)).user_status?.now).toContain('automatic switch back')
    const body = { type: 'action_required', subject: 'The zone has recovered: you need to run the switch back by hand', markdown: 'Wait for ticket TKT-2202 to close, then follow its steps; the alarm ticket is TKT-2203.', actions: [{ id: 'ok', label: 'I run the switch back by hand' }], user_kind: 'irreversible', user_kind_why: 'A production write that is hard to undo' }
    const held = await call('POST', '/api/v1/human-inbox', body, lead.sid)
    expect(held.status).toBe(409)
    const why = JSON.stringify(await held.json())
    expect(why).toContain(alarm.id)
    expect(why).toContain('automatic switch back')
    const after = await call('POST', '/api/v1/human-inbox', { ...body, same_ask_reason: 'Read the alarm task: its automatic switch back is stuck, so a manual one is needed' }, lead.sid)
    expect(after.status, await after.clone().text()).toBe(201)
  })

  it('a report after the ask brings one note to the asker, never twice', async () => {
    sent.length = 0
    await new Promise((r) => setTimeout(r, 20))
    await reported(alarm.id, { state: 'working', now: 'The automatic switch back moved the traffic back at 19:13Z; every component reads 0' })
    await settle()
    const woken = await runMatterNews(Date.now())
    expect(woken).toContain(lead.id)
    const note = sent.find((m) => m.sid === lead.sid)
    expect(note?.text).toContain('moved the traffic back')
    expect(note?.text).toContain(alarm.id)
    expect(note?.text).toContain('settle the letter')
    expect(await runMatterNews(Date.now())).not.toContain(lead.id)
    // Its finish is news again, once.
    sent.length = 0
    await updateTaskRaw(alarm.id, { phase: 'COMPLETE', result_report: { result: 'Switched back on its own; the alarm cleared at 19:20Z', at: new Date().toISOString() } } as never, { source: 'test' })
    expect(await runMatterNews(Date.now())).toContain(lead.id)
    expect(sent.find((m) => m.sid === lead.sid)?.text).toContain('the alarm cleared')
    expect(await runMatterNews(Date.now())).not.toContain(lead.id)
  })

  it('the ask a task already shows, written again, is not held for news it saw when it was new', async () => {
    const other = await making('Alarm: zone two', 'teammate-import', ['ticket:TKT-1303'])
    await reported(other.id, { state: 'working', now: 'Zone two traffic is back' })
    await settle()
    const ask = { state: 'needs', ask: 'Confirm the zone two rollback window TKT-1303?', user_kind: 'irreversible', user_kind_why: 'A production write that is hard to undo' }
    const first = await call('PUT', `/api/v1/tasks/${lead.id}/report`, ask, lead.sid)
    expect(first.status).toBe(409)
    const reasoned = await call('PUT', `/api/v1/tasks/${lead.id}/report`, { ...ask, same_ask_reason: 'Read the zone two task: the rollback window is still the user\'s call' }, lead.sid)
    expect(reasoned.status, await reasoned.clone().text()).toBe(200)
    const again = await call('PUT', `/api/v1/tasks/${lead.id}/report`, ask, lead.sid)
    expect(again.status, await again.clone().text()).toBe(200)
  })
})
