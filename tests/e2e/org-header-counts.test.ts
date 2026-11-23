/**
 * An Org node's header counts and its side bar's sections, on a real server, before and after the
 * node's own session starts (2026-11-20: on an isolated Walnut the CEO's header read "1 Needs you"
 * until the CEO was started, then "0 threads · 3 Working · 1 Not started" while its Tasks panel
 * still held the worker's ask under Needs you).
 *
 * The rule (2026-11-03, the user: "the little red should be thread instead of need u, also, even
 * if no thread, show 0 thread"): a node that keeps Threads (the CEO, a VP) leads its header with its
 * threads and draws no Needs you pill; its tasks' asks are in its Tasks. That is what the node IS,
 * so the header reads the same before its task exists and once it runs. Every count the header
 * shows is the one its side bar's section shows, both made from orgTaskTabs over each task's own
 * user_status.
 *
 * The page's own model is run on the server's task list (the Org page builds its tree from
 * GET /api/tasks too). Only the Claude CLI is mocked: no CLI runs here; sessions are records.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-org-header-counts'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { buildOrgTree } from '../../src/core/org/org-tree.js'
import type { Task } from '../../src/core/types.js'
import { buildChannels, type ChannelRow } from '../../web/src/components/org/org-channels-model.js'
import { allTasksSections, headerPills, nodeKeepsThreads, orgTaskTabs, ownAskFirst, sectionCount } from '../../web/src/components/org/org-task-tabs.js'

let base = ''
let leadId = ''
const ASK = 'Plant the pears in the north bed or the south bed?'

async function api<T = Record<string, any>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

async function until(what: string, ok: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 20_000
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** What one node's page draws: its header (threads chip and state pills) and its side bar's section counts. */
interface NodeView { keepsThreads: boolean; pills: Record<string, number>; sections: Record<string, number>; tabs: Record<string, number> }

function viewOf(row: ChannelRow, rows: readonly ChannelRow[], tasks: readonly Task[]): NodeView {
  const tabs = orgTaskTabs(row, rows, tasks, Date.now())
  const contact = row.contactId ? tasks.find((t) => t.id === row.contactId) : undefined
  const keepsThreads = nodeKeepsThreads(row, contact)
  const pills = Object.fromEntries(headerPills(tabs, 0, keepsThreads).map((p) => [p.tab, p.n]))
  const sections = Object.fromEntries(allTasksSections(tabs, ownAskFirst(tabs.needs, row.contactId), 0).map((s) => [s.tab, sectionCount(s, 0)]))
  return {
    keepsThreads, pills, sections,
    tabs: { needs: tabs.needs.length, working: tabs.working.length, waiting: tabs.waiting.length, notstarted: tabs.notstarted.length },
  }
}

async function page(): Promise<{ main: ChannelRow; vp: ChannelRow; ceo: NodeView; vpView: NodeView }> {
  const { json } = await api<{ tasks: Task[] }>('GET', '/api/tasks?slim=1')
  const tasks = json.tasks
  const { main, rows } = buildChannels(buildOrgTree(tasks), tasks, () => null)
  const vp = rows.find((r) => r.contactId === leadId)!
  expect(vp, 'the VP row').toBeTruthy()
  return { main, vp, ceo: viewOf(main, rows, tasks), vpView: viewOf(vp, rows, tasks) }
}

/** Every count both draw is the same number: the header's pill is the section's heading. */
function expectAgree(v: NodeView): void {
  for (const [tab, n] of Object.entries(v.pills)) expect(v.sections[tab], `header ${tab} vs its section`).toBe(n)
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const vp = await api('POST', '/api/v1/org/projects', { name: 'Orchard' })
  expect(vp.status, JSON.stringify(vp.json)).toBe(201)
  leadId = vp.json.task.id
  // A worker that asked the user (its turn report said needs-you), one at work, one never started.
  const asks = (await addTask({ title: 'Plant the pear trees', project: 'Orchard', parent_task_id: leadId } as never)).task
  await createSessionRecord('sess-pear-0001', asks.id, 'Orchard', WALNUT_HOME)
  await updateSessionRecord('sess-pear-0001', { process_status: 'idle' } as never)
  await updateTaskRaw(asks.id, { phase: 'NEED_ACTION', status_report: { state: 'needs', ask: ASK, at: new Date().toISOString() } } as never, { emitEvent: true, source: 'status-report' })
  const works = (await addTask({ title: 'Mend the orchard fence', project: 'Orchard', parent_task_id: leadId } as never)).task
  await createSessionRecord('sess-fence-0001', works.id, 'Orchard', WALNUT_HOME)
  await updateSessionRecord('sess-fence-0001', { process_status: 'running' } as never)
  await updateTaskRaw(works.id, { phase: 'IN_PROGRESS' } as never, { emitEvent: true, source: 'status-report' })
  await addTask({ title: 'Order new ladders', project: 'Orchard', parent_task_id: leadId } as never)
  await until('the ask is derived', async () => (await getTask(asks.id)).user_status?.state === 'needs')
  await until('the worker is derived working', async () => (await getTask(works.id)).user_status?.state === 'working')
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('an Org node\'s header and its Tasks agree, before and after its session starts', () => {
  let before: Awaited<ReturnType<typeof page>>

  it('before the CEO starts: the header leads with its threads, no Needs you pill; Tasks holds the ask', async () => {
    before = await page()
    expect(before.main.contactId, 'no Main task yet').toBeUndefined()
    for (const v of [before.ceo, before.vpView]) {
      expect(v.keepsThreads).toBe(true)
      expect(v.pills.needs, 'a node that keeps Threads draws no Needs you pill').toBeUndefined()
      expect(v.sections.needs, 'the worker\'s ask is in its Tasks').toBe(1)
      // Working and waiting only (2430d9d476, the user's "xx working, yy waiting"): what nobody
      // started stays in its own Tasks section, never a count in the header.
      expect(v.pills).toMatchObject({ working: 1 })
      expect(v.pills.notstarted, 'no "not started" count in the header').toBeUndefined()
      expect(v.tabs.notstarted, 'the task nobody started is still in Tasks').toBe(1)
      expectAgree(v)
    }
  })

  it('once the CEO\'s task exists and its session starts, both read exactly as before', async () => {
    const made = await api('POST', '/api/v1/org/main')
    expect(made.status, JSON.stringify(made.json)).toBeLessThan(300)
    const mainId = made.json.task.id as string
    await createSessionRecord('sess-ceo-0001', mainId, made.json.task.project ?? '', WALNUT_HOME)
    await updateSessionRecord('sess-ceo-0001', { process_status: 'idle' } as never)
    // What a start writes on the task: its session (the CLI itself is not run here).
    await updateTaskRaw(mainId, { session_id: 'sess-ceo-0001', session_ids: ['sess-ceo-0001'], phase: 'IN_PROGRESS' } as never, { emitEvent: true, source: 'test' })
    await until('the CEO holds its session', async () => (await getTask(mainId)).session_id === 'sess-ceo-0001')
    const after = await page()
    expect(after.main.contactId).toBe(mainId)
    expect(after.ceo).toEqual(before.ceo)
    expect(after.vpView).toEqual(before.vpView)
  })

  it('a node that keeps no Threads (the Inbox row) shows the same Needs you the side bar counts', async () => {
    const inboxAsk = (await addTask({ title: 'Renew the library card' })).task
    await createSessionRecord('sess-card-0001', inboxAsk.id, '', WALNUT_HOME)
    await updateSessionRecord('sess-card-0001', { process_status: 'idle' } as never)
    await updateTaskRaw(inboxAsk.id, { phase: 'NEED_ACTION', status_report: { state: 'needs', ask: 'Renew online or at the desk?', at: new Date().toISOString() } } as never, { emitEvent: true, source: 'status-report' })
    await until('the Inbox ask is derived', async () => (await getTask(inboxAsk.id)).user_status?.state === 'needs')
    const { json } = await api<{ tasks: Task[] }>('GET', '/api/tasks?slim=1')
    const { rows } = buildChannels(buildOrgTree(json.tasks), json.tasks, () => null)
    const inbox = rows.find((r) => r.kind === 'project' && r.project === '')
    expect(inbox, 'the Inbox row').toBeTruthy()
    const v = viewOf(inbox!, rows, json.tasks)
    expect(v.keepsThreads).toBe(false)
    expect(v.pills.needs).toBe(1)
    expect(v.sections.needs).toBe(1)
    expectAgree(v)
  })
})
