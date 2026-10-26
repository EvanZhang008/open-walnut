/**
 * /api/v1/org end to end, on a real server (src/web/routes/org-v1.ts):
 *   - the main agent's task is made once, even when asked for at the same moment
 *   - a project with 2+ teams gets ONE local, hidden lead on first contact; one
 *     team is talked to directly; the Inbox never gets a lead
 *   - GET /org/reports answers per node (main → projects, lead → teams, task → workers)
 *   - the main agent's update note: what moved since Main was made, one line per
 *     moved project, silent again once told
 *   - one VP for two projects (POST /org/vp): no task changes project, the workers
 *     report to the new lead, the lead that lets go is asked to hand over and Walnut
 *     closes it when that turn ends (at once when it has no session); giving the
 *     project back first withdraws an unread handover and keeps the lead
 * Only the Claude CLI is mocked (no session is started here).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-org-v1'))

import path from 'node:path'
import { PROJECTS_MEMORY_DIR, WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, completeTask, deleteTask, getTask, listTasks, setProjectMetadata, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { _setDigestFoldMsForTesting, buildHandoverText, pendingOrgDigest } from '../../src/core/org/org-store.js'
import { deleteMessage, getQueue } from '../../src/core/session-message-queue.js'
import { __pendingHandovers, __setHandoverSettleMs } from '../../src/core/org/handover-close.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { taskDepth } from '../../src/core/sessions/subtask-limits.js'
import { buildSessionContext } from '../../src/core/sessions/session-context.js'
import { sendLetter } from '../../src/core/human-inbox/store.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

let server: HttpServer
let port: number

async function api<T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://localhost:${port}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

/**
 * Makes a task need the user the way a session does (an unanswered action_required letter
 * from it), then waits until the server's status sync wrote it: a turn that only ended
 * (NEED_ACTION) is waiting, never "waiting on the user" (src/core/user-status.ts).
 */
async function waitUserState(taskId: string, state: string): Promise<void> {
  const until = Date.now() + 15_000
  while ((await getTask(taskId)).user_status?.state !== state) {
    if (Date.now() > until) throw new Error(`${taskId} never reached ${state}: ${JSON.stringify((await getTask(taskId)).user_status ?? null)}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function askUser(taskId: string, subject: string): Promise<void> {
  await sendLetter({
    subject, type: 'action_required', markdown: subject,
    actions: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    sender: { taskId },
  } as never)
  await waitUserState(taskId, 'needs')
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('/api/v1/org', () => {
  it('makes the main agent once, however many ask at the same moment', async () => {
    const answers = await Promise.all([1, 2, 3].map(() => api<{ task: { id: string } }>('POST', '/org/main')))
    for (const a of answers) expect(a.status).toBe(200)
    const ids = new Set(answers.map((a) => a.json.task.id))
    expect(ids.size).toBe(1)
    const main = await getTask([...ids][0]!)
    expect(main).toMatchObject({ title: 'Main', project: 'Ask Walnut', source: 'local', walnut_agent: true, org_role: 'main' })
    expect(main.pinned).toBeFalsy()
    const again = await api<{ task: { id: string } }>('POST', '/org/main')
    expect(again.json.task.id).toBe(main.id)
  })

  it('a project with two teams gets one local lead on first contact; one team is talked to directly', async () => {
    const a = (await addTask({ title: 'Fix the reconnect bug', project: 'Walnut' })).task
    const b = (await addTask({ title: 'Ship the org chart', project: 'Walnut' })).task
    const single = (await addTask({ title: 'Book the lab recheck', project: 'Health' })).task

    const tree = await api<{ tree: { projects: { project: string; needsLead: boolean; contactId?: string }[] } }>('GET', '/org')
    expect(tree.json.tree.projects.find((p) => p.project === 'Walnut')).toMatchObject({ needsLead: true })
    expect(tree.json.tree.projects.find((p) => p.project === 'Walnut')?.contactId).toBeUndefined()
    expect(tree.json.tree.projects.find((p) => p.project === 'Health')).toMatchObject({ needsLead: false, contactId: single.id })

    const contacts = await Promise.all([1, 2, 3].map(() => api<{ task: { id: string; org_role?: string }; kind: string; started: boolean }>('POST', '/org/contact', { to: 'walnut' })))
    const leadIds = new Set(contacts.map((c) => c.json.task.id))
    expect(leadIds.size).toBe(1)
    expect(contacts[0]!.json).toMatchObject({ kind: 'lead', started: false, task: { org_role: 'lead' } })
    const lead = await getTask([...leadIds][0]!)
    expect(lead).toMatchObject({ title: 'Walnut lead', project: 'Walnut', source: 'local', org_role: 'lead' })
    expect(lead.parent_task_id).toBeFalsy()
    // No folder of its own; the contact says where a chat with it would start: a project with
    // no folder runs in its memory folder, as every task start does.
    expect(lead.cwd).toBeUndefined()
    for (const c of contacts) expect(c.json).toMatchObject({ started: false, launch: { cwd: path.join(PROJECTS_MEMORY_DIR, 'walnut'), host: null } })
    // The teams were not touched: no parent link, same project.
    for (const id of [a.id, b.id]) expect((await getTask(id)).parent_task_id).toBeFalsy()
    expect((await listTasks()).filter((x) => x.org_role === 'lead')).toHaveLength(1)

    const health = await api<{ task: { id: string }; kind: string }>('POST', '/org/contact', { to: 'Health' })
    expect(health.json).toMatchObject({ kind: 'team', task: { id: single.id } })

    const byId = await api<{ task: { id: string }; kind: string }>('POST', '/org/contact', { to: a.id })
    expect(byId.json).toMatchObject({ kind: 'task', task: { id: a.id } })
  })

  it('a lead\'s launch follows its project and is never written to the lead', async () => {
    type Contact = { task: { id: string }; started: boolean; launch?: { cwd: string; host: string | null } }
    const own = path.join(WALNUT_HOME, 'repos', 'site')
    await updateConfig({ hosts: { devbox: { label: 'Dev box', hostname: 'org-devbox.invalid', user: 'someone' } } })
    for (const [project, settings] of [
      ['Site', { default_cwd: own }],
      ['Remote', { default_cwd: '/home/dev/app', default_host: 'devbox' }],
      ['Nowhere', { default_cwd: '/home/dev/app', default_host: 'gone-host' }],
      ['Bare', { default_host: 'devbox' }],
    ] as const) {
      await setProjectMetadata(project, settings)
      for (const title of ['One', 'Two']) await addTask({ title: `${project} ${title}`, project })
    }
    const site = await api<Contact>('POST', '/org/contact', { to: 'Site' })
    expect(site.json.launch).toEqual({ cwd: own, host: null })
    // The project's folder moves: the lead follows it, since nothing was recorded on the lead.
    const moved = path.join(WALNUT_HOME, 'repos', 'site-2')
    await setProjectMetadata('Site', { default_cwd: moved })
    expect((await api<Contact>('POST', '/org/contact', { to: 'Site' })).json.launch).toEqual({ cwd: moved, host: null })
    expect((await getTask(site.json.task.id)).cwd).toBeUndefined()
    // Another host: the pair rides together. An unknown host, or a host with no folder,
    // would refuse to start, so there is no place to offer (the chat asks for a folder).
    expect((await api<Contact>('POST', '/org/contact', { to: 'Remote' })).json.launch).toEqual({ cwd: '/home/dev/app', host: 'devbox' })
    const nowhere = await api<Contact>('POST', '/org/contact', { to: 'Nowhere' })
    expect(nowhere.status).toBe(200)
    expect(nowhere.json.launch).toBeUndefined()
    expect((await api<Contact>('POST', '/org/contact', { to: 'Bare' })).json.launch).toBeUndefined()

    // A lead from before (v1 copied the project's folder in) keeps it, paired with the project's host.
    for (const title of ['One', 'Two']) await addTask({ title: `Older ${title}`, project: 'Older' })
    await setProjectMetadata('Older', { default_cwd: '/home/dev/older', default_host: 'devbox' })
    const older = (await addTask({ title: 'Older lead', project: 'Older', source: 'local', org_role: 'lead', cwd: '/home/dev/older-then' })).task
    const byId = await api<Contact>('POST', '/org/contact', { to: older.id })
    expect(byId.json).toMatchObject({ task: { id: older.id }, launch: { cwd: '/home/dev/older-then', host: 'devbox' } })

    // A started lead is talked to in its session: no launch.
    await updateTaskRaw(older.id, { session_id: 'org-launch-started' })
    const started = await api<Contact>('POST', '/org/contact', { to: older.id })
    expect(started.json.started).toBe(true)
    expect(started.json.launch).toBeUndefined()

    // The later tests count projects: leave none of these behind.
    for (const t of await listTasks()) {
      if (['Site', 'Remote', 'Nowhere', 'Bare', 'Older'].includes(t.project ?? '')) await deleteTask(t.id)
    }
    await updateConfig({ hosts: {} })
  })

  it('the Inbox has no lead; an unknown contact is a 404 that names it', async () => {
    await addTask({ title: 'inbox one', project: '' })
    await addTask({ title: 'inbox two', project: '' })
    const inbox = await api<{ code?: string }>('POST', '/org/contact', { to: 'Inbox' })
    expect(inbox.status).toBe(400)
    expect(inbox.json.code).toBe('no_lead_for_inbox')
    const unknown = await api<{ code?: string; error?: string }>('POST', '/org/contact', { to: 'no-such-project' })
    expect(unknown.status).toBe(404)
    expect(unknown.json.error).toContain('no-such-project')
  })

  it('reports per node: main → projects with their contact, lead → teams, task → workers', async () => {
    const leader = (await addTask({ title: 'Ticket investigation', project: 'Tickets' })).task
    const w1 = (await addTask({ title: 'ticket A', project: 'Tickets', parent_task_id: leader.id })).task
    await addTask({ title: 'ticket B', project: 'Tickets', parent_task_id: leader.id })

    const main = await api<{ of: string; rows: { title: string; contact?: { id?: string; kind: string }; teams?: unknown[] }[] }>('GET', '/org/reports')
    expect(main.json.of).toBe('main')
    const titles = main.json.rows.map((r) => r.title)
    expect(titles).toEqual(expect.arrayContaining(['Walnut', 'Health', 'Tickets', 'Inbox']))
    expect(titles.at(-1)).toBe('Inbox')
    expect(main.json.rows.find((r) => r.title === 'Walnut')?.contact).toMatchObject({ kind: 'lead' })
    expect(main.json.rows.find((r) => r.title === 'Tickets')?.contact).toMatchObject({ kind: 'team', id: leader.id })
    expect(main.json.rows.find((r) => r.title === 'Inbox')?.contact).toBeUndefined()
    expect(main.json.rows.find((r) => r.title === 'Inbox')?.teams).toHaveLength(2)

    const leadId = (await listTasks()).find((x) => x.org_role === 'lead')!.id
    const lead = await api<{ rows: { title: string; kind: string }[] }>('GET', `/org/reports?of=${leadId}`)
    expect(lead.json.rows.map((r) => r.title).sort()).toEqual(['Fix the reconnect bug', 'Ship the org chart'])
    expect(lead.json.rows.every((r) => r.kind === 'team')).toBe(true)

    const team = await api<{ rows: { id: string; kind: string }[] }>('GET', `/org/reports?of=${leader.id}`)
    expect(team.json.rows).toHaveLength(2)
    expect(team.json.rows.map((r) => r.id)).toContain(w1.id)

    const missing = await api('GET', '/org/reports?of=nope-nope')
    expect(missing.status).toBe(404)
  })

  it('a lead is not a level of work: what it files is top-level for the depth limit', async () => {
    const leadId = (await listTasks()).find((x) => x.org_role === 'lead')!.id
    const child = (await addTask({ title: 'filed by the lead', project: 'Walnut', parent_task_id: leadId })).task
    const grandchild = (await addTask({ title: 'its worker', project: 'Walnut', parent_task_id: child.id })).task
    expect(await taskDepth(child.id)).toBe(0)
    expect(await taskDepth(grandchild.id)).toBe(1)
    // And in the org it is one of the project's teams, not hidden under the lead.
    const tree = await api<{ tree: { projects: { project: string; teams: { id: string }[] }[] } }>('GET', '/org')
    expect(tree.json.tree.projects.find((p) => p.project === 'Walnut')!.teams.map((t) => t.id)).toContain(child.id)
  })

  it('a lead someone closed is reopened on the next contact, not replaced', async () => {
    const lead = (await listTasks()).find((x) => x.org_role === 'lead' && x.project === 'Walnut')!
    await completeTask(lead.id)
    const tree = await api<{ tree: { projects: { project: string; lead?: { id: string }; needsLead: boolean }[] } }>('GET', '/org')
    expect(tree.json.tree.projects.find((p) => p.project === 'Walnut')).toMatchObject({ needsLead: true })
    expect(tree.json.tree.projects.find((p) => p.project === 'Walnut')?.lead).toBeUndefined()
    const again = await api<{ task: { id: string; phase: string } }>('POST', '/org/contact', { to: 'Walnut' })
    expect(again.status).toBe(200)
    expect(again.json.task.id).toBe(lead.id)
    expect(again.json.task.phase).not.toBe('COMPLETE')
    expect((await listTasks()).filter((x) => x.org_role === 'lead' && x.project === 'Walnut')).toHaveLength(1)
  })

  it('tells the main agent and a lead who they are at spawn', async () => {
    const leadId = (await listTasks()).find((x) => x.org_role === 'lead')!.id
    const mainId = (await listTasks()).find((x) => x.org_role === 'main')!.id
    const mainCtx = (await buildSessionContext(mainId)).systemPrompt
    expect(mainCtx).toContain('You are the user\'s main agent')
    expect(mainCtx).toContain('org_send')
    const leadCtx = (await buildSessionContext(leadId)).systemPrompt
    expect(leadCtx).toContain('Your task is the lead of project "Walnut"')
    const plain = (await buildSessionContext((await listTasks()).find((x) => x.title === 'ticket A')!.id)).systemPrompt
    expect(plain).not.toContain('main agent, the head')
    expect(plain).not.toContain('is the lead of project')
  })

  it('the main agent\'s note: what moved since Main was made, one line per project, silent once told', async () => {
    const mainId = (await listTasks()).find((x) => x.org_role === 'main')!.id
    const sid = '11111111-2222-4333-8444-555555555555'
    await createSessionRecord(sid, mainId, 'Ask Walnut', WALNUT_HOME)
    // No fold window here: this test is about what a note says (the next one is about when).
    _setDigestFoldMsForTesting(0)
    try {
      // Main was made before any work existed, so its first note already names the new work.
      const first = await pendingOrgDigest(sid, Date.now())
      expect(first).not.toBeNull()
      expect(first!.text).toMatch(/- Walnut: \d+ new/)
      expect(first!.text).toContain('- Health: 1 new')
      await first!.markTold()
      expect(await pendingOrgDigest(sid, Date.now() + 500)).toBeNull()

      const done = (await listTasks()).find((x) => x.title === 'Book the lab recheck')!
      await completeTask(done.id)
      await addTask({ title: 'a new walnut task', project: 'Walnut' })
      const note = await pendingOrgDigest(sid, Date.now() + 1000)
      expect(note).not.toBeNull()
      expect(note!.text).toContain('kind="notification"')
      expect(note!.text).toContain('outcome="org-update"')
      expect(note!.text).toContain('- Health: 1 done')
      expect(note!.text).toContain('- Walnut: 1 new')
      expect(note!.text).not.toContain('Tickets')
      expect(note!.text).not.toContain('Needs the user now')
      // A second send after the first carries no second note.
      expect(await pendingOrgDigest(sid, Date.now() + 1500)).toBeNull()
      await note!.markTold()

      // Two sends at the same moment: exactly one carries the note.
      const asks = (await addTask({ title: 'a walnut task that needs the user', project: 'Walnut' })).task
      await updateTask(asks.id, { phase: 'NEED_ACTION' }, { source: 'api' })
      await askUser(asks.id, 'Ship it today?')
      const racing = await Promise.all([pendingOrgDigest(sid, Date.now() + 1800), pendingOrgDigest(sid, Date.now() + 1800)])
      expect(racing.filter(Boolean)).toHaveLength(1)
      await racing.find(Boolean)!.markTold()
      expect(await pendingOrgDigest(sid, Date.now() + 2000)).toBeNull()
    } finally {
      _setDigestFoldMsForTesting(null)
    }

    // Any other session never gets one, and pays one indexed read to learn that.
    const other = '22222222-3333-4444-8555-666666666666'
    const health = (await listTasks()).find((x) => x.title === 'Book the lab recheck')!
    await createSessionRecord(other, health.id, 'Health', WALNUT_HOME)
    expect(await pendingOrgDigest(other)).toBeNull()
  })

  it('count moves wait for the fold window; what newly needs the user rides the next message, once', async () => {
    // Main's session from the test above; this one is last, so what it makes stays.
    const sid = '11111111-2222-4333-8444-555555555555'
    const FOLD = 5_000
    _setDigestFoldMsForTesting(FOLD)
    try {
      const t0 = Date.now()
      // A task that asks the user moves a count: inside the window it says nothing, after it the note comes.
      const handed = (await addTask({ title: 'handed back to the user', project: 'Walnut' })).task
      await updateTask(handed.id, { phase: 'NEED_ACTION' }, { source: 'api' })
      await askUser(handed.id, 'Which host?')
      expect(await pendingOrgDigest(sid, t0 + 1_000)).toBeNull()
      const folded = await pendingOrgDigest(sid, t0 + FOLD + 2_500)
      expect(folded!.text).toMatch(/Org update since \d+ min ago:\n- Walnut: [^\n]*waiting on the user/)
      expect(folded!.text).not.toContain('Needs the user now')
      await folded!.markTold()
      const told = t0 + FOLD + 2_500

      // A worker that asks the user a question: told on the next message, the counts still folded.
      const asking = (await addTask({ title: 'asks a question', project: 'Walnut' })).task
      const askSid = '33333333-4444-4555-8666-777777777777'
      await createSessionRecord(askSid, asking.id, 'Walnut', WALNUT_HOME)
      await updateTaskRaw(asking.id, { session_id: askSid })
      await updateTask(asking.id, { phase: 'NEED_ACTION' }, { source: 'api' })
      await updateSessionRecord(askSid, { pendingPermission: { requestId: 'rq-q1', toolName: 'AskUserQuestion', receivedAt: new Date().toISOString() } })
      const racing = await Promise.all([pendingOrgDigest(sid, told + 100), pendingOrgDigest(sid, told + 100)])
      expect(racing.filter(Boolean)).toHaveLength(1)
      const alert = racing.find(Boolean)!
      expect(alert.text).toContain('Org update:\nNeeds the user now:\n- Walnut: "asks a question" asks the user a question\n')
      expect(alert.text).toContain('Tell the user what is under "Needs the user now"')
      expect(alert.text).not.toContain('waiting on the user')
      await alert.markTold()
      // Told once: the same prompt is not news, and the count move still waits.
      expect(await pendingOrgDigest(sid, told + 200)).toBeNull()

      // A worker whose session failed is news too, also inside the window.
      const broken = (await addTask({ title: 'fails', project: 'Walnut' })).task
      const brokenSid = '44444444-5555-4666-8777-888888888888'
      await createSessionRecord(brokenSid, broken.id, 'Walnut', WALNUT_HOME)
      await updateTaskRaw(broken.id, { session_id: brokenSid })
      await updateSessionRecord(brokenSid, { process_status: 'error' })
      // As the session runtime does when a session fails: the record, then the status event.
      bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: brokenSid, process_status: 'error' }, ['web-ui'], { source: 'session-tracker' })
      const failed = await pendingOrgDigest(sid, told + 300)
      expect(failed!.text).toContain('- Walnut: "fails" stopped on an error')
      expect(failed!.text).not.toContain('asks a question')
      await failed!.markTold()

      // A lost host is Walnut's to recover (auto-resume), not news for the user.
      const flaky = (await addTask({ title: 'loses its host', project: 'Walnut' })).task
      const flakySid = '55555555-6666-4777-8888-999999999999'
      await createSessionRecord(flakySid, flaky.id, 'Walnut', WALNUT_HOME)
      await updateTaskRaw(flaky.id, { session_id: flakySid })
      await updateSessionRecord(flakySid, { process_status: 'error', status_reason: 'remote_unreachable' })
      expect(await pendingOrgDigest(sid, told + 400)).toBeNull()
      // The failed one is resumed and fails again: a second failure is told again.
      await updateSessionRecord(brokenSid, { process_status: 'running' })
      await updateSessionRecord(brokenSid, { process_status: 'error' })
      const twice = await pendingOrgDigest(sid, told + 450)
      expect(twice!.text).toContain('- Walnut: "fails" stopped on an error')
      expect(twice!.text).not.toContain('loses its host')
      await twice!.markTold()
      // The host stays lost for 20 minutes (recovery gave up): now it is the user's.
      const lost = new Date(told - 20 * 60_000).toISOString()
      await updateSessionRecord(flakySid, { status_history: [{ timestamp: lost, process_status: 'error', reason: 'remote_unreachable', changed_by: 'health-monitor' }] })
      const stuck = await pendingOrgDigest(sid, told + 460)
      expect(stuck!.text).toContain('- Walnut: "loses its host" stopped on an error')
      await stuck!.markTold()

      // The window passes: the folded counts come, without the alerts already told. The counts
      // are the stored user status, so wait for the server's sync to have derived the prompt and the failure.
      await waitUserState(asking.id, 'needs')
      await waitUserState(broken.id, 'needs')
      const later = await pendingOrgDigest(sid, told + FOLD + 500)
      expect(later!.text).toMatch(/- Walnut: [^\n]*waiting on the user/)
      expect(later!.text).not.toContain('Needs the user now')
      await later!.markTold()

      // A new prompt on the same task is a new alert.
      await updateSessionRecord(askSid, { pendingPermission: { requestId: 'rq-q2', toolName: 'Bash', receivedAt: new Date().toISOString() } })
      const again = await pendingOrgDigest(sid, told + FOLD + 600)
      expect(again!.text).toContain('- Walnut: "asks a question" waits for the user to approve Bash')
      await again!.markTold()
    } finally {
      _setDigestFoldMsForTesting(null)
    }
  })

  describe('one VP for several projects', () => {
    type VpAnswer = { project: string; vp: string; lead?: { id: string; title: string }; closed: string[]; handover: string[]; moved: string[]; unchanged?: boolean }
    type Tree = { tree: { projects: { project: string; vp?: string; contactId?: string; lead?: { id: string } }[] } }
    const node = async (name: string) => (await api<Tree>('GET', '/org')).json.tree.projects.find((p) => p.project === name)

    const leadSid = '44444444-5555-4666-8777-888888888888'
    const handoverRows = async () => (await getQueue(leadSid)).filter((m) => m.message.includes('outcome="handover"'))

    it('puts a project under another VP: no task moves, the workers follow, the old lead is asked to hand over', async () => {
      const g1 = (await addTask({ title: 'Plant the beds', project: 'Garden' })).task
      const g2 = (await addTask({ title: 'Fix the fence', project: 'Garden' })).task
      const s1 = (await addTask({ title: 'Collect seeds', project: 'Seeds' })).task
      const s2 = (await addTask({ title: 'Label the jars', project: 'Seeds' })).task
      const seedsLead = (await api<{ task: { id: string } }>('POST', '/org/contact', { to: 'Seeds' })).json.task.id
      // A worker the Seeds lead filed, and a session the lead talks in (it waits on a prompt,
      // so the handover is queued behind it and nothing is spawned).
      const worker = (await addTask({ title: 'Sort the packets', project: 'Seeds', parent_task_id: seedsLead })).task
      await createSessionRecord(leadSid, seedsLead, 'Seeds', WALNUT_HOME)
      await updateTaskRaw(seedsLead, { session_id: leadSid })
      await updateSessionRecord(leadSid, { pendingPermission: { requestId: 'rq-vp1', toolName: 'Bash', receivedAt: new Date().toISOString() } })

      const res = await api<VpAnswer>('POST', '/org/vp', { project: 'seeds', vp: 'Garden' })
      expect(res.status).toBe(200)
      const gardenLead = await getTask(res.json.lead!.id)
      expect(gardenLead).toMatchObject({ title: 'Garden lead', project: 'Garden', org_role: 'lead', org_leads: ['Seeds'] })
      expect(gardenLead.description).toBe('Leads the work in projects "Garden" and "Seeds" and reports it to the main agent. Made by Walnut.')
      expect(res.json).toMatchObject({ project: 'Seeds', vp: 'Garden', moved: [worker.id], handover: [seedsLead], closed: [] })
      // Nothing changed project; the worker reports to the Garden lead now.
      for (const t of [g1, g2, s1, s2]) expect((await getTask(t.id)).project).toBe(t.project)
      expect((await getTask(worker.id)).parent_task_id).toBe(gardenLead.id)
      // Both projects still stand; Seeds is talked to through the Garden lead.
      expect(await node('Seeds')).toMatchObject({ vp: 'Garden', contactId: gardenLead.id, lead: { id: gardenLead.id } })
      expect((await node('Garden'))?.vp).toBeUndefined()
      const contact = await api<{ task: { id: string } }>('POST', '/org/contact', { to: 'Seeds' })
      expect(contact.json.task.id).toBe(gardenLead.id)
      // The Seeds lead is asked to sum up its work for the Garden lead; Walnut closes it later.
      const queued = (await handoverRows()).map((m) => m.message).join('\n')
      expect(queued).toContain(`under "Garden lead" (${gardenLead.id})`)
      expect(queued).toContain(`walnut tools call org_send '{"to":"${gardenLead.id}","title":"Handover: Seeds"`)
      expect(queued).not.toContain('task_complete')
      expect((await getTask(seedsLead)).phase).not.toBe('COMPLETE')
      expect(__pendingHandovers().map((p) => p.taskId)).toEqual([seedsLead])
      // The lead's reports list both projects' teams; its prompt names both.
      const reports = await api<{ rows: { id: string }[] }>('GET', `/org/reports?of=${gardenLead.id}`)
      expect(reports.json.rows.map((r) => r.id)).toEqual(expect.arrayContaining([g1.id, g2.id, s1.id, s2.id]))
      expect((await buildSessionContext(gardenLead.id)).systemPrompt).toContain('lead of projects "Garden" and "Seeds" (each stays its own project)')
      // The same drop again changes nothing.
      expect((await api<VpAnswer>('POST', '/org/vp', { project: 'Seeds', vp: 'Garden' })).json.unchanged).toBe(true)
    })

    it('giving it back before the handover was read withdraws it and keeps the lead', async () => {
      const seedsLead = (await listTasks()).find((t) => t.org_role === 'lead' && t.project === 'Seeds')!
      const gardenLead = (await listTasks()).find((t) => t.org_role === 'lead' && t.project === 'Garden')!
      const worker = (await listTasks()).find((t) => t.title === 'Sort the packets')!
      const back = await api<VpAnswer>('POST', '/org/vp', { project: 'Seeds', vp: '' })
      expect(back.json).toMatchObject({ project: 'Seeds', vp: '', lead: { id: seedsLead.id }, moved: [worker.id] })
      expect(await handoverRows()).toHaveLength(0)
      expect(__pendingHandovers()).toHaveLength(0)
      expect((await getTask(seedsLead.id)).phase).not.toBe('COMPLETE')
      expect((await getTask(worker.id)).parent_task_id).toBe(seedsLead.id)
      expect((await getTask(gardenLead.id)).org_leads).toBeUndefined()
      expect((await getTask(gardenLead.id)).description).toBe('Leads the work in project "Garden" and reports it to the main agent. Made by Walnut.')
      expect(await node('Seeds')).toMatchObject({ contactId: seedsLead.id })
      expect((await node('Seeds'))?.vp).toBeUndefined()
    })

    it('a lead that read its handover is closed by Walnut when that turn ends', async () => {
      const seedsLead = (await listTasks()).find((t) => t.org_role === 'lead' && t.project === 'Seeds')!
      __setHandoverSettleMs(0)
      try {
        const res = await api<VpAnswer>('POST', '/org/vp', { project: 'Seeds', vp: 'Garden' })
        expect(res.json.handover).toEqual([seedsLead.id])
        const [row] = await handoverRows()
        expect(row).toBeDefined()
        // A turn that ends with the notice still queued (unread) closes nothing.
        bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: leadSid, process_status: 'idle' }, ['*'])
        await new Promise((r) => setTimeout(r, 300))
        expect((await getTask(seedsLead.id)).phase).not.toBe('COMPLETE')
        // Read (the row leaves the queue), then the turn ends: Walnut closes the lead.
        await deleteMessage(leadSid, row!.id)
        bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: leadSid, process_status: 'idle' }, ['*'])
        await expect.poll(async () => (await getTask(seedsLead.id)).phase, { timeout: 5_000 }).toBe('COMPLETE')
        expect(__pendingHandovers()).toHaveLength(0)
      } finally {
        __setHandoverSettleMs()
      }
    })

    it('gives a closed lead back its project, and a lead with no session is closed rather than asked', async () => {
      const gardenLead = (await listTasks()).find((t) => t.org_role === 'lead' && t.project === 'Garden')!
      const seedsLead = (await listTasks()).find((t) => t.org_role === 'lead' && t.project === 'Seeds')!
      const worker = (await listTasks()).find((t) => t.title === 'Sort the packets')!
      const back = await api<VpAnswer>('POST', '/org/vp', { project: 'Seeds', vp: '' })
      expect(back.status).toBe(200)
      expect(back.json).toMatchObject({ project: 'Seeds', vp: '', lead: { id: seedsLead.id }, moved: [worker.id] })
      expect((await getTask(seedsLead.id)).phase).toBe('TODO')
      expect((await getTask(worker.id)).parent_task_id).toBe(seedsLead.id)
      expect((await node('Seeds'))?.contactId).toBe(seedsLead.id)

      // A take-over whose own lead never talked: nothing to hand over, so it is closed at once.
      const res = await api<VpAnswer>('POST', '/org/vp', { project: 'Garden', vp: 'Seeds' })
      expect(res.json).toMatchObject({ vp: 'Seeds', lead: { id: seedsLead.id }, closed: [gardenLead.id], handover: [] })
      expect((await getTask(gardenLead.id)).phase).toBe('COMPLETE')
      expect((await getTask(seedsLead.id)).org_leads).toEqual(['Garden'])
    })

    it('a lead may file work in every project it leads', async () => {
      const seedsLead = (await listTasks()).find((t) => t.org_role === 'lead' && t.project === 'Seeds')!
      const sid = '55555555-6666-4777-8888-999999999999'
      await createSessionRecord(sid, seedsLead.id, 'Seeds', WALNUT_HOME)
      const create = (project: string) => fetch(`http://localhost:${port}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': sid },
        body: JSON.stringify({ title: `Filed in ${project}`, project }),
      })
      expect((await create('Garden')).status).toBe(201)
      expect((await create('Health')).status).toBe(409)
    })

    it('a project name with a quote still makes a command the shell can run', () => {
      const text = buildHandoverText({ project: "Bob's garden", led: ["Bob's garden"], ends: true, from: { id: 'a' }, to: { id: 'b', title: 'Garden lead' } })
      const arg = /walnut tools call org_send '(.*)'$/m.exec(text)![1]!
      // The shell joins 'a'\''b' into a'b.
      expect(arg.split("'\\''").join("'")).toBe(JSON.stringify({ to: 'b', title: "Handover: Bob's garden", text: '<your summary>', expect_reply: false }))
    })

    it('refuses the Inbox, an unknown project and a bad body', async () => {
      expect((await api('POST', '/org/vp', { project: '', vp: 'Seeds' })).status).toBe(400)
      expect((await api('POST', '/org/vp', { project: 'Seeds', vp: 'Inbox' })).status).toBe(400)
      expect((await api('POST', '/org/vp', { project: 'No such project', vp: 'Seeds' })).status).toBe(404)
      expect((await api('POST', '/org/vp', { project: 'Seeds', vp: 'No such project' })).status).toBe(404)
      expect((await api('POST', '/org/vp', { project: 'Seeds', vp: 7 })).status).toBe(400)
    })
  })
})
