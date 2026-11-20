/**
 * The thread line on a real server (experiment reply_thread_line; src/core/org/reply-thread.ts,
 * reply-thread-index.ts): the rows the web (`GET /api/sessions/:id/history`) and the phone
 * (`GET /api/v1/sessions/:id/transcript`, `/history`) read carry the thread his message was filed
 * under, as that thread is when the rows are read.
 *
 *   1. two messages about two subjects: each user row carries its own thread (the one its threads
 *      hint named), and the answer after each carries the same;
 *   2. a renamed thread reads under its new title; a closed one still carries its line;
 *   3. a thread merged into another: his row follows his message there;
 *   4. a thread that moved to another lead: the row names that lead as the holder;
 *   5. a message filed nowhere (a worker's chat, a peer's note) carries none;
 *   6. the experiment off: no row carries a thread (today's rows exactly).
 * Only the Claude CLI is mocked (no CLI runs: the messages wait in the queue), and the local
 * daemon's file reader is served from the test's own Claude home.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-reply-thread-line'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { CLAUDE_HOME, WALNUT_HOME } from '../../src/constants.js'
import { encodeProjectPath } from '../../src/core/session-history.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { addTask } from '../../src/core/task-manager.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { sendMessageToSession } from '../../src/core/session-message-queue.js'
import { prepareHintedSend } from '../../src/core/hints/hint-send.js'
import { moveThread } from '../../src/core/org/threads-store.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'
import type { ReplyThread } from '../../src/core/org/reply-thread.js'

const LEAD_SID = '66666666-6666-4777-8888-999999999999'
const WORKER_SID = '66666666-6666-4777-8888-000000000001'
let base = ''
let leadId = ''
let otherLeadId = ''
let workerId = ''

interface Row { role: string; text: string; thread?: ReplyThread }

async function setFlag(on: boolean): Promise<void> {
  const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { reply_thread_line: on } }) })
  expect(put.status).toBe(200)
}

/** The web send's own steps (routes/session-chat.ts): hints composed, queued, then committed. */
async function typeIntoChat(sid: string, text: string): Promise<string> {
  const record = await getSessionByClaudeId(sid)
  const prepared = await prepareHintedSend(sid, record, text, { sentBy: 'person' })
  await sendMessageToSession(sid, text, { source: 'ui', taskId: record?.taskId, enqueueMessage: prepared.enqueueText, hinted: true })
  await prepared.commit()
  return prepared.enqueueText
}

/** The chat as its CLI writes it: his line as it reached the model (hints and all), then the answer. */
async function writeChat(sid: string, rows: Array<{ type: 'user' | 'assistant'; text: string }>, append = true): Promise<void> {
  const lines = rows.map((r, i) => ({
    type: r.type, uuid: `${sid.slice(0, 8)}-0000-4000-8000-${String(Date.now()).slice(-8)}${String(i).padStart(4, '0')}`, timestamp: new Date().toISOString(),
    message: r.type === 'user'
      ? { role: 'user', content: [{ type: 'text', text: r.text }] }
      : { id: `msg-${Date.now()}-${i}`, role: 'assistant', content: [{ type: 'text', text: r.text }] },
  }))
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(WALNUT_HOME))
  await fs.mkdir(dir, { recursive: true })
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  await (append ? fs.appendFile : fs.writeFile)(path.join(dir, `${sid}.jsonl`), body)
}

async function webRows(sid = LEAD_SID): Promise<Row[]> {
  const res = await fetch(`${base}/api/sessions/${sid}/history`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { messages: Row[] }).messages
}

async function phoneRows(sid = LEAD_SID): Promise<Row[]> {
  const res = await fetch(`${base}/api/v1/sessions/${sid}/transcript?fresh=1&rich=1`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { messages: Row[] }).messages
}

async function phoneHistory(sid = LEAD_SID): Promise<Row[]> {
  const res = await fetch(`${base}/api/v1/sessions/${sid}/history`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { messages: Row[] }).messages
}

async function threads(id = leadId): Promise<OrgThread[]> {
  return ((await (await fetch(`${base}/api/v1/tasks/${id}/threads`)).json()) as { threads: OrgThread[] }).threads
}

async function patch(id: string, body: unknown): Promise<void> {
  const res = await fetch(`${base}/api/v1/tasks/${leadId}/threads/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': LEAD_SID }, body: JSON.stringify(body) })
  expect(res.status, await res.clone().text()).toBe(200)
}

const rowOf = (rows: Row[], text: string) => rows.find((r) => r.text.includes(text))

const FOLDERS = 'what should the two folders be called?'
const SHORTCUT = 'add a global shortcut for the quick menu'

beforeAll(async () => {
  process.env.WALNUT_THREAD_JOIN_SECS = '0'
  process.env.WALNUT_THREAD_REOPEN_SECS = '0'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  vi.spyOn(sessionRunner as unknown as { processNext(sessionId: string, mode?: string): Promise<void> }, 'processNext').mockResolvedValue(undefined)
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  workerId = (await addTask({ title: 'Folder names', project: 'Orchard' })).task.id
  leadId = (await ensureProjectLead('Orchard')).id
  otherLeadId = (await ensureProjectLead('Meadow')).id
  await createSessionRecord(LEAD_SID, leadId, 'Orchard', WALNUT_HOME)
  await updateSessionRecord(LEAD_SID, { process_status: 'stopped' })
  await createSessionRecord(WORKER_SID, workerId, 'Orchard', WALNUT_HOME)
  await updateSessionRecord(WORKER_SID, { process_status: 'stopped' })
  await setFlag(true)
})

afterAll(async () => {
  delete process.env.WALNUT_THREAD_JOIN_SECS
  delete process.env.WALNUT_THREAD_REOPEN_SECS
  await stopServer()
  vi.restoreAllMocks()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the thread line on the rows clients read', () => {
  let folders = ''
  let shortcut = ''

  it('two subjects: each message and its answer carry their own thread, on the web and the phone', async () => {
    await writeChat(LEAD_SID, [{ type: 'user', text: await typeIntoChat(LEAD_SID, FOLDERS) }, { type: 'assistant', text: 'Call them Shared and Projects.' }], false)
    await writeChat(LEAD_SID, [{ type: 'user', text: await typeIntoChat(LEAD_SID, SHORTCUT) }, { type: 'assistant', text: 'Looking at the menu code.' }, { type: 'assistant', text: 'Cmd+K opens it now.' }])
    const list = await threads()
    folders = list.find((t) => t.messages.some((m) => m.text === FOLDERS))!.id
    shortcut = list.find((t) => t.messages.some((m) => m.text === SHORTCUT))!.id
    expect(folders).not.toBe(shortcut)
    for (const rows of [await webRows(), await phoneRows(), await phoneHistory()]) {
      expect(rowOf(rows, FOLDERS)?.thread).toMatchObject({ id: folders, title: expect.stringContaining('two folders') })
      expect(rowOf(rows, 'Call them Shared')?.thread?.id).toBe(folders)
      expect(rowOf(rows, SHORTCUT)?.thread?.id).toBe(shortcut)
      // The answer's line sits under its last words only, once.
      expect(rowOf(rows, 'Cmd+K opens it')?.thread?.id).toBe(shortcut)
      expect(rows.filter((r) => r.role === 'assistant' && r.thread?.id === shortcut)).toHaveLength(1)
      expect(rowOf(rows, FOLDERS)?.thread?.node).toBeUndefined()
    }
  })

  it('a renamed thread reads under its new title; a closed one still has its line', async () => {
    await patch(folders, { title: 'Folder names' })
    expect(rowOf(await webRows(), FOLDERS)?.thread).toMatchObject({ id: folders, title: 'Folder names' })
    await fetch(`${base}/api/v1/tasks/${leadId}/threads/${folders}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ close: 'acked' }) })
    expect(rowOf(await phoneRows(), FOLDERS)?.thread).toMatchObject({ id: folders, title: 'Folder names', closed: true })
    await fetch(`${base}/api/v1/tasks/${leadId}/threads/${folders}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reopen: true }) })
  })

  it('a thread merged into another: his row follows his message there', async () => {
    const third = 'and the shortcut should work in the side panel too'
    await writeChat(LEAD_SID, [{ type: 'user', text: await typeIntoChat(LEAD_SID, third) }])
    const own = (await threads()).find((t) => t.messages.some((m) => m.text === third))!.id
    expect(own).not.toBe(shortcut)
    expect(rowOf(await webRows(), third)?.thread?.id).toBe(own)
    await patch(own, { merge_into: shortcut })
    expect(rowOf(await webRows(), third)?.thread).toMatchObject({ id: shortcut })
  })

  it('a thread that moved to another lead: the row names the lead that holds it now', async () => {
    const lead = (await threads()).find((t) => t.id === folders)!
    await moveThread({ from: { task: leadId, title: 'Orchard' }, to: { task: otherLeadId, title: 'Meadow' }, threadId: lead.id, by: 'human', kind: 'hand' })
    const row = rowOf(await webRows(), FOLDERS)
    expect(row?.thread).toMatchObject({ id: folders, node: otherLeadId, title: 'Folder names' })
    expect(row?.thread?.closed).toBeUndefined()
  })

  it('a message filed nowhere carries no line: a worker\'s chat, a peer\'s note', async () => {
    await writeChat(WORKER_SID, [{ type: 'user', text: await typeIntoChat(WORKER_SID, 'rename the folders please') }, { type: 'assistant', text: 'Renamed.' }], false)
    for (const r of await webRows(WORKER_SID)) expect(r.thread).toBeUndefined()
    await writeChat(LEAD_SID, [{ type: 'user', text: '<walnut-message from-task="peer-1" kind="message">A peer note</walnut-message>' }, { type: 'assistant', text: 'Thanks, peer.' }])
    const rows = await webRows()
    expect(rowOf(rows, 'Thanks, peer')?.thread).toBeUndefined()
  })

  it('the experiment off: no row carries a thread', async () => {
    await setFlag(false)
    for (const rows of [await webRows(), await phoneRows(), await phoneHistory()]) {
      expect(rows.length).toBeGreaterThan(3)
      for (const r of rows) expect(r.thread).toBeUndefined()
    }
    await setFlag(true)
  })
})
