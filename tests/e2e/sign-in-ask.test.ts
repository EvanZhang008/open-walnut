/**
 * One sign-in is one ask, and an ask answered above stays answered, against a real server
 * (src/core/sign-in-ask.ts, src/core/same-ask.ts). 2026-11-05: five tasks in three teams each asked
 * the user to run his login command, each in its own words and flags, while he had signed in long
 * before; and a task asked the user again a date Main had already decided in a plain message.
 *
 *  - five sign-in asks worded five ways, in three projects: one shows, four wait on it;
 *  - a sixth one put on the user from outside (a report line, a letter) is refused, naming it;
 *  - a checker's word that sign-in works takes every one of them off the user, and refuses a new one;
 *  - an open sign-in letter is the one place: they wait on it;
 *  - an answer above holds for the same ask reworded and for one part of it asked again (status,
 *    report line, a letter item), and a second answer keeps the first;
 *  - a lead's plain message to a task with an open ask says answers_ask is what takes it off.
 * The login command is invented (config ssh_login_hint). Only the Claude CLI is mocked.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-sign-in-ask'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, listTasks, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { syncUserStatuses } from '../../src/core/user-status-sync.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { checkStatuses } from '../../src/core/status-consistency.js'

let base = ''
let n = 0

async function asking(title: string, ask: string | null, project: string, parent?: string): Promise<{ id: string; sid: string }> {
  n += 1
  const id = (await addTask({ title, project, ...(parent ? { parent_task_id: parent } : {}) } as never)).task.id
  const sid = `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-eeeeeeeeeeee`
  await createSessionRecord(sid, id, project, WALNUT_HOME)
  await updateSessionRecord(sid, { process_status: 'idle' } as never)
  await updateTaskRaw(id, { session_id: sid } as never, { source: 'test' })
  if (ask) await report(id, ask)
  // Created apart, so "the one asked first" is fixed.
  await new Promise((r) => setTimeout(r, 15))
  return { id, sid }
}

async function report(id: string, ask: string, kind = 'credentials'): Promise<void> {
  await updateTask(id, { phase: 'NEED_ACTION' })
  await new Promise((r) => setTimeout(r, 5))
  await updateTaskRaw(id, { status_report: { state: 'needs', ask, ask_own: { kind, why: 'Only he can sign in' }, at: new Date().toISOString(), rule: 2 } } as never, { source: 'test' })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await syncUserStatuses(null, Date.now() + 60_000)
}

async function call(method: string, url: string, body: unknown, callerSid?: string): Promise<Response> {
  return fetch(`${base}${url}`, {
    method, headers: { 'content-type': 'application/json', ...(callerSid ? { 'x-walnut-caller-sid': callerSid } : {}) }, body: JSON.stringify(body),
  })
}

const LOCAL = () => path.join(WALNUT_HOME, 'local')
async function writeLocal(name: string, value: unknown): Promise<void> {
  await fs.mkdir(LOCAL(), { recursive: true })
  await fs.writeFile(path.join(LOCAL(), name), JSON.stringify(value))
}

// Five real asks of one night, the command renamed: other words, other flags, three teams, one in Chinese ("run it on the Mac, then tell me").
const ASKS: Array<[string, string]> = [
  ['Plugin', 'Please run `acmelogin -s` on the dev box so the build can pull packages'],
  ['Plugin', 'Needs you: please run acmelogin on the cloud box'],
  ['Insights', 'Run acmelogin -o, then tell me and I continue the report'],
  ['Events', '\u8bf7\u5728 Mac \u4e0a\u8fd0\u884c acmelogin -s\uff0c\u7136\u540e\u544a\u8bc9\u6211'],
  ['Insights', 'Your login expired on the build host: sign in again so the tests can run'],
]

let tasks: Array<{ id: string; sid: string }> = []

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'config.yaml'), 'ssh_login_hint: run acmelogin -o on this Mac\n')
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  for (const [i, [project, ask]] of ASKS.entries()) tasks.push(await asking(`${project} work ${i}`, ask, project))
  await settle()
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

const statusOfId = async (id: string) => (await getTask(id)).user_status
const ids = () => tasks.map((t) => t.id)

describe('one sign-in is one ask, whatever its words or team', () => {
  it('five sign-in asks show once: the first asked; the rest wait on it', async () => {
    const all = (await listTasks()).filter((t) => ids().includes(t.id))
    expect(all.filter((t) => t.user_status?.state === 'needs').map((t) => t.id)).toEqual([tasks[0]!.id])
    for (const t of tasks.slice(1)) {
      expect(await statusOfId(t.id)).toMatchObject({ state: 'waiting', sameAsk: { id: tasks[0]!.id, signIn: true } })
      expect((await statusOfId(t.id))?.waitingOn).toContain("the user's sign-in, asked once in")
    }
    expect((await checkStatuses()).filter((m) => ids().includes(m.taskId))).toEqual([])
  })

  it('a sixth put on the user from outside is refused, naming the one that asks', async () => {
    const sixth = await asking('Docs work', null, 'Docs')
    const line = await call('PUT', `/api/v1/tasks/${sixth.id}/report`, { state: 'needs', ask: 'Please re-authenticate with acmelogin --refresh', user_kind: 'credentials', user_kind_why: 'Only he can sign in' }, sixth.sid)
    expect(line.status).toBe(409)
    expect(JSON.stringify(await line.json())).toMatch(new RegExp(`same_ask[\\s\\S]*${tasks[0]!.id}`))
    const letter = await call('POST', '/api/v1/human-inbox', { type: 'action_required', subject: 'Run acmelogin -o --refresh on the Mac', markdown: 'The dev box refuses packages.', actions: [{ id: 'done', label: 'Done' }], user_kind: 'credentials', user_kind_why: 'Only he can sign in' }, sixth.sid)
    expect(letter.status).toBe(409)
    // Not a sign-in ask: goes as before.
    const other = await call('PUT', `/api/v1/tasks/${sixth.id}/report`, { state: 'needs', ask: 'Review the login page copy before it ships', user_kind: 'user_own', user_kind_why: 'He owns the copy' }, sixth.sid)
    expect(other.status, await other.clone().text()).toBe(200)
  })

  it('an open sign-in letter is the one place: every sign-in ask waits on it; archived, it is not', async () => {
    const sent = await call('POST', '/api/v1/human-inbox', { type: 'review', subject: 'SSH sign-in to Dev box failed', markdown: 'Sign in on this Mac.' })
    expect(sent.status, await sent.clone().text()).toBe(201)
    const sentBody = (await sent.json()) as { id?: string; letter?: { id: string } }
    const letterId = sentBody.letter?.id ?? sentBody.id!
    await writeLocal('host-auth-alert.json', { version: 1, episodes: [{ key: 'login', opKey: 'op-1', letterId, openedAt: Date.now(), hosts: ['devbox'] }] })
    await settle()
    for (const t of tasks) expect((await statusOfId(t.id))?.state).not.toBe('needs')
    expect((await statusOfId(tasks[0]!.id))?.waitingOn).toContain(letterId)
    const { setArchived } = await import('../../src/core/human-inbox/store.js')
    await setArchived(letterId, true)
    await settle()
    expect((await statusOfId(tasks[0]!.id))?.state).toBe('needs')
    await fs.rm(path.join(LOCAL(), 'host-auth-alert.json'))
  })

  it('a parent and its subtask both asking a sign-in never wait on each other', async () => {
    const parent = await asking('Relay platform', 'Run acmelogin -o so the relay can deploy', 'Relay')
    const kid = await asking('Relay deploy', 'Please run acmelogin on the build host', 'Relay', parent.id)
    await settle()
    const p = await statusOfId(parent.id)
    const k = await statusOfId(kid.id)
    // The subtask waits on the sign-in asked first, in another team, never on its own parent; the
    // parent on its subtask or that same first one: one sign-in, one Needs you, and no circle.
    expect([kid.id, tasks[0]!.id]).toContain(p?.sameAsk?.id)
    expect(k?.sameAsk?.id).toBe(tasks[0]!.id)
    const all = (await listTasks()).filter((t) => [...ids(), parent.id, kid.id].includes(t.id))
    expect(all.filter((t) => t.user_status?.state === 'needs').map((t) => t.id)).toEqual([tasks[0]!.id])
  })

  it("a checker's word that sign-in works takes them off the user, and refuses a new one", async () => {
    await writeLocal('sign-in-state.json', { ok: true, checkedAt: new Date().toISOString(), by: 'the sign-in plugin' })
    await settle()
    for (const t of tasks) expect((await statusOfId(t.id))?.state).not.toBe('needs')
    expect((await statusOfId(tasks[0]!.id))?.waitingOn).toContain('sign-in works (checked')
    const res = await call('PUT', `/api/v1/tasks/${tasks[2]!.id}/report`, { state: 'needs', ask: 'Please sign in again with acmelogin', user_kind: 'credentials', user_kind_why: 'Only he can sign in' }, tasks[2]!.sid)
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain('sign-in works')
    // A word older than the freshness window counts for nothing: the ask shows again (once).
    await writeLocal('sign-in-state.json', { ok: true, checkedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() })
    await settle()
    expect((await listTasks()).filter((t) => ids().includes(t.id) && t.user_status?.state === 'needs').map((t) => t.id)).toEqual([tasks[0]!.id])
    await fs.rm(path.join(LOCAL(), 'sign-in-state.json'))
  })
})

describe('an ask answered above stays answered (2026-11-05)', () => {
  const LEAD_SID = 'cccccccc-aaaa-4bbb-8ccc-eeeeeeeeeeee'
  const SIX = 'Decide for the review: the launch month, the owner team, the budget line, the region list, the beta date and the rollback owner'
  let lead = ''
  let worker: { id: string; sid: string }

  beforeAll(async () => {
    lead = (await ensureProjectLead('Lantern')).id
    await createSessionRecord(LEAD_SID, lead, 'Lantern', WALNUT_HOME)
    await updateSessionRecord(LEAD_SID, { process_status: 'idle' } as never)
    worker = await asking('Meadow review prep', null, 'Lantern', lead)
    await report(worker.id, SIX, 'user_own')
    await settle()
  })

  it("a lead's plain message to a task with an open ask says answers_ask is what takes it off", async () => {
    const res = await call('POST', '/api/v1/messages', { to: worker.id, title: 'Dates', text: 'Use milestone 9 for the launch.', expect_reply: false }, LEAD_SID)
    expect(res.status, await res.clone().text()).toBe(202)
    // The op's outcome turns it into "send answers_ask: true" (ops/work.ts).
    expect(((await res.json()) as { openAsk?: string }).openAsk).toBe(SIX)
  })

  it('the answer holds for one part of it asked again, in a report or a letter item, and a second answer keeps the first', async () => {
    const res = await call('POST', '/api/v1/messages', { to: worker.id, title: 'Decided', text: 'Launch month: milestone 9, low confidence. The rest as proposed.', answers_ask: true, expect_reply: false }, LEAD_SID)
    expect(res.status, await res.clone().text()).toBe(202)
    const recorded = (await getTask(worker.id)).ask_answered!
    await updateTaskRaw(worker.id, { ask_answered: { ...recorded, at: new Date(Date.now() + 120_000).toISOString() }, asks_answered: [{ ...recorded, at: new Date(Date.now() + 120_000).toISOString() }] } as never, { source: 'test' })
    // One part of it, in other words, from its own next turn: not on the user again.
    await updateSessionRecord(worker.sid, { process_status: 'idle' } as never)
    await report(worker.id, 'Decide the launch month for the review', 'user_own')
    await settle()
    expect(await statusOfId(worker.id)).toMatchObject({ state: 'waiting', answeredFor: { by: lead } })
    // The same part as one item of a decision letter: refused, quoting the answer.
    const letter = await call('POST', '/api/v1/human-inbox', {
      type: 'action_required', subject: 'Three open points for the review', markdown: '1. Pick the review room\n2. Decide the launch month for the review\n3. Name a second reviewer',
      actions: [{ id: 'ok', label: 'OK' }],
    }, worker.sid)
    expect(letter.status).toBe(409)
    expect(JSON.stringify(await letter.json())).toContain('milestone 9')
    // A second answer of another ask keeps the first.
    await updateSessionRecord(worker.sid, { process_status: 'idle' } as never)
    await report(worker.id, 'Pick the review room for Thursday', 'user_own')
    await settle()
    const second = await call('POST', '/api/v1/messages', { to: worker.id, title: 'Room', text: 'Room 4.', answers_ask: true, expect_reply: false }, LEAD_SID)
    expect(second.status, await second.clone().text()).toBe(202)
    const kept = (await getTask(worker.id)).asks_answered ?? []
    expect(kept.map((a) => a.text)).toEqual(['Launch month: milestone 9, low confidence. The rest as proposed.', 'Room 4.'])
  })
})
