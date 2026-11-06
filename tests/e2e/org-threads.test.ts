/**
 * An Org node's Threads on a real server (src/core/org/thread-capture.ts, threads-model.ts,
 * routes src/web/routes/org-threads-v1.ts): the user's own requests to a lead, one thread per
 * subject (2026-11-01, the user: "if my multiple ask is about the same thread, add it below that
 * thread").
 *
 *   1. a message the user types into the lead's chat is filed as a thread, and the same message
 *      tells the lead which one (the `threads` hint), with no turn of its own;
 *   2. a second ask: its own thread at first, the first named as open with how to merge; the lead
 *      merges it (`merge_into`), writer recorded; a wrong merge is split back out;
 *   3. a Follow up names its thread: filed there; a retry of the same words is one message;
 *   4. the user's Acknowledge closes it, the lead is told once on his next message; asking again
 *      through the closed thread's Follow up opens a new thread that follows it;
 *   5. a letter he answers with a note is filed too, a choice alone is not;
 *   6. a worker keeps no Threads: its chat files nothing and its routes refuse;
 *   7. the lead's chat reply lands under his message by itself when its turn ends (the transcript
 *      on disk), and the lead cannot close that thread until he reacts (2026-11-01, the user: "I
 *      had not replied ... you cannot remove it"); then it can;
 *   8. a thread the lead opens itself (thread_create) takes his reply typed through its Follow up;
 *      a closed thread leaves the open list and is counted instead.
 * Only the Claude CLI is mocked (no CLI runs: the messages wait in the queue), and the local
 * daemon's file reader is served from the test's own Claude home.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-org-threads'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { CLAUDE_HOME, WALNUT_HOME } from '../../src/constants.js'
import { encodeProjectPath } from '../../src/core/session-history.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, listTasksByIds } from '../../src/core/task-manager.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { getQueue, sendMessageToSession } from '../../src/core/session-message-queue.js'
import { prepareHintedSend } from '../../src/core/hints/hint-send.js'
import { buildLetterDeliveryText } from '../../src/core/human-inbox/letter-ops.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

const LEAD_SID = '55555555-6666-4777-8888-999999999999'
const WORKER_SID = '55555555-6666-4777-8888-000000000001'
let base = ''
let leadId = ''
let workerId = ''

/** The web send's own steps (routes/session-chat.ts): hints composed, queued, then committed. */
async function typeIntoChat(sid: string, text: string, threadId?: string, extra: { threadKey?: string; threads?: boolean } = {}): Promise<string> {
  const record = await getSessionByClaudeId(sid)
  const prepared = await prepareHintedSend(sid, record, text, { sentBy: 'person', ...(threadId ? { threadId } : {}), ...extra })
  await sendMessageToSession(sid, text, { source: 'ui', taskId: record?.taskId, enqueueMessage: prepared.enqueueText, hinted: true })
  await prepared.commit()
  return prepared.enqueueText
}

async function threads(id = leadId): Promise<OrgThread[]> {
  const res = await fetch(`${base}/api/v1/tasks/${id}/threads`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { threads: OrgThread[] }).threads
}

async function patch(id: string, body: unknown, sid?: string): Promise<Response> {
  return fetch(`${base}/api/v1/tasks/${leadId}/threads/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) }, body: JSON.stringify(body),
  })
}

const hintOf = (text: string) => /Walnut \(threads\):([\s\S]*?)<\/system-reminder>/.exec(text)?.[1] ?? ''

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  workerId = (await addTask({ title: 'Hint labels', project: 'Garden' })).task.id
  leadId = (await ensureProjectLead('Garden')).id
  await createSessionRecord(LEAD_SID, leadId, 'Garden', WALNUT_HOME)
  await updateSessionRecord(LEAD_SID, { process_status: 'stopped' })
  await createSessionRecord(WORKER_SID, workerId, 'Garden', WALNUT_HOME)
  await updateSessionRecord(WORKER_SID, { process_status: 'stopped' })
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('Org Threads', () => {
  let first: OrgThread
  let second: OrgThread

  it('a message typed into the lead\'s chat is filed as a thread, and the same message tells the lead which one', async () => {
    const sent = await typeIntoChat(LEAD_SID, '[Images attached — use the Read tool to view them]\n- /tmp/open-walnut/images/1-a.png\n\nThe Org page is a mess: add a Threads view, one per request')
    const list = await threads()
    expect(list).toHaveLength(1)
    first = list[0]
    expect(first.title).toBe('The Org page is a mess: add a Threads view, one per request')
    expect(first.state).toBe('new')
    expect(first.messages[0]).toMatchObject({ via: 'chat', images: ['/tmp/open-walnut/images/1-a.png'] })
    // Told in the message itself: no turn of its own, no other queue row.
    expect(hintOf(sent)).toContain(`new thread ${first.id}`)
    expect((await getQueue(LEAD_SID))).toHaveLength(1)
    // On disk where the store says.
    const disk = JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'org', 'threads', `${leadId}.json`), 'utf8')) as { threads: OrgThread[] }
    expect(disk.threads.map((t) => t.id)).toEqual([first.id])
  })

  it('a second ask about the same subject: named open with how to merge; the lead merges it, and a wrong merge splits back out', async () => {
    const sent = await typeIntoChat(LEAD_SID, 'and asks about the same thing go under one thread')
    const hint = hintOf(sent)
    expect(hint).toContain(`${first.id} "${first.title}"`)
    expect(hint).toContain('merge_into')
    second = (await threads()).find((t) => t.id !== first.id)!
    expect(hint).toContain(`new thread ${second.id}`)
    // The lead's session puts it under the first thread and titles it.
    const merged = await patch(second.id, { merge_into: first.id }, LEAD_SID)
    expect(merged.status).toBe(200)
    expect((await patch(first.id, { title: 'Org: Threads view', state: 'working', add_tasks: [workerId] }, LEAD_SID)).status).toBe(200)
    let list = await threads()
    expect(list).toHaveLength(1)
    expect(list[0].messages.map((m) => m.text)).toEqual(['The Org page is a mess: add a Threads view, one per request', 'and asks about the same thing go under one thread'])
    expect(list[0]).toMatchObject({ title: 'Org: Threads view', titled: true, state: 'working', tasks: [workerId], by: `task:${leadId}` })
    // The user splits a message the lead merged wrongly.
    const res = await fetch(`${base}/api/v1/tasks/${leadId}/threads/${first.id}/split`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: list[0].messages[1].id }),
    })
    expect(res.status).toBe(201)
    list = await threads()
    expect(list).toHaveLength(2)
    const split = list.find((t) => t.id !== first.id)!
    expect(split.by).toBe('human')
    // And merges back, as the lead would after hearing it.
    expect((await patch(split.id, { merge_into: first.id }, LEAD_SID)).status).toBe(200)
    expect(await threads()).toHaveLength(1)
  })

  it('a Follow up is filed under its thread; a retry of one send is one message; a side question and a Retry file nothing', async () => {
    const sent = await typeIntoChat(LEAD_SID, 'also show pictures in the thread', first.id, { threadKey: 'qm-phone-1' })
    expect(hintOf(sent)).toContain(`follow-up in thread ${first.id}`)
    // The phone retries the same send (same qm- id): filed once, and the lead hears it is a repeat.
    const retry = await typeIntoChat(LEAD_SID, 'also show pictures in the thread', first.id, { threadKey: 'qm-phone-1' })
    expect(hintOf(retry)).toContain('already filed under thread')
    await typeIntoChat(LEAD_SID, 'a side question beside the chat', undefined, { threads: false })
    const list = await threads()
    expect(list).toHaveLength(1)
    expect(list[0].messages.map((m) => m.via)).toEqual(['chat', 'chat', 'follow-up'])
  })

  it('Acknowledge closes it; the lead hears once; asking again through it opens a thread that follows it', async () => {
    expect((await patch(first.id, { close: 'acked' })).status).toBe(200)
    expect((await threads())[0].closed).toMatchObject({ how: 'acked', by: 'human' })
    const next = await typeIntoChat(LEAD_SID, 'Rich output should not be built in')
    expect(hintOf(next)).toContain(`Closed since: ${first.id} (by him)`)
    const after = await typeIntoChat(LEAD_SID, 'one more, unrelated')
    expect(hintOf(after)).not.toContain('Closed since')
    const again = await typeIntoChat(LEAD_SID, 'the Threads view lost my pictures', first.id)
    expect(hintOf(again)).toContain(`asks again about closed ${first.id}`)
    const list = await threads()
    const follows = list.find((t) => t.follows === first.id)
    expect(follows?.messages[0].text).toBe('the Threads view lost my pictures')
    // Merging into the closed one is refused: a new ask stays its own thread.
    const refused = await patch(follows!.id, { merge_into: first.id }, LEAD_SID)
    expect(refused.status).toBe(409)
    // Reopen brings it back.
    expect((await patch(first.id, { reopen: true })).status).toBe(200)
    expect((await threads()).find((t) => t.id === first.id)?.closed).toBeUndefined()
  })

  it('a letter answered with a note is filed; a choice alone is not', async () => {
    const before = (await threads()).length
    await sendMessageToSession(LEAD_SID, buildLetterDeliveryText({ id: 'lt-1', subject: 'Website: ten designs' }, { choice: 'Pick', text: 'combine 1 and 10' }), { source: 'human-inbox', taskId: leadId })
    await sendMessageToSession(LEAD_SID, buildLetterDeliveryText({ id: 'lt-2', subject: 'Deploy now?' }, { choice: 'Yes' }), { source: 'human-inbox', taskId: leadId })
    const list = await threads()
    expect(list).toHaveLength(before + 1)
    const letter = list.find((t) => t.messages[0].via === 'letter')
    expect(letter?.messages[0]).toMatchObject({ text: 'combine 1 and 10', about: 'Website: ten designs' })
    // The queued letter answer carries the hint too.
    const row = (await getQueue(LEAD_SID)).find((m) => m.message.includes('lt-1'))
    expect(hintOf(row?.message ?? '')).toContain(`new thread ${letter!.id}`)
  })

  it('a worker keeps no Threads: its chat files nothing, its routes refuse; bad input is refused', async () => {
    const sent = await typeIntoChat(WORKER_SID, 'please fix the labels')
    expect(hintOf(sent)).toBe('')
    const res = await fetch(`${base}/api/v1/tasks/${workerId}/threads`)
    expect(res.status).toBe(409)
    await expect(fs.access(path.join(WALNUT_HOME, 'org', 'threads', `${workerId}.json`))).rejects.toThrow()
    expect((await patch(first.id, { state: 'done' })).status).toBe(400)
    expect((await patch('th-ffffffffffff', { state: 'working' })).status).toBe(404)
    expect((await patch(first.id, {})).status).toBe(400)
    // A merge goes alone: anything else would be written onto a thread the merge removes.
    expect((await patch(first.id, { title: 'x', merge_into: 'th-ffffffffffff' })).status).toBe(400)
  })

  it('the lead\'s chat reply lands under his message when its turn ends; it cannot close it until he reacts', async () => {
    const ask = 'what is the small model?'
    await typeIntoChat(LEAD_SID, ask)
    const t = (await threads()).find((x) => x.messages[0]?.text === ask)!
    expect(t.messages[0].sid).toBe(LEAD_SID)
    // The lead's chat on disk: his message, a notice, then its reply (Claude's JSONL).
    const base0 = Date.parse(t.messages[0].at)
    const ts = (s: number) => new Date(base0 + s * 1000).toISOString()
    const lines = [
      { type: 'user', uuid: 'u-1', timestamp: ts(0.05), message: { role: 'user', content: [{ type: 'text', text: ask }] } },
      { type: 'assistant', uuid: 'a-1', timestamp: ts(0.1), message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'The fast model in the local config, for titles and summaries.' }] } },
    ]
    const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(WALNUT_HOME))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, `${LEAD_SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    bus.emit(EventNames.SESSION_RESULT, { sessionId: LEAD_SID, taskId: leadId, result: 'done' }, ['web-ui'], { source: 'test' })
    await expect.poll(async () => (await threads()).find((x) => x.id === t.id)?.messages[0].answer?.text, { timeout: 15_000 })
      .toBe('The fast model in the local config, for titles and summaries.')
    // He said nothing since: the lead's close and known mark are refused, the thread stays open.
    const refused = await patch(t.id, { close: 'acked' }, LEAD_SID)
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error?: { code?: string } }).error?.code ?? '').toBe('not_reacted')
    expect((await patch(t.id, { known: 'all' }, LEAD_SID)).status).toBe(409)
    expect((await threads()).find((x) => x.id === t.id)?.closed).toBeUndefined()
    // He reacts in the thread: now the lead may close it.
    await typeIntoChat(LEAD_SID, 'ok, thanks', t.id)
    const closed = await patch(t.id, { close: 'acked' }, LEAD_SID)
    expect(closed.status, await closed.clone().text()).toBe(200)
  })

  it('a message filed before Walnut kept its session gets its answer from the lead\'s own chat, even with the lead\'s session slot empty', async () => {
    const ask = 'which port does the preview use?'
    // The lead's session slot is empty, as a long-lived lead's can be (a link that failed); its
    // session record still names the task (prod 2026-11-01: none of 60 older messages got an answer).
    expect((await listTasksByIds([leadId]))[0].session_id).toBeUndefined()
    await typeIntoChat(LEAD_SID, ask)
    // The shape the threads filed before this build have: no session on the message.
    const file = path.join(WALNUT_HOME, 'org', 'threads', `${leadId}.json`)
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { threads: OrgThread[] }
    const t = raw.threads.find((x) => x.messages[0]?.text === ask)!
    delete (t.messages[0] as { sid?: string }).sid
    await fs.writeFile(file, JSON.stringify(raw))
    const base0 = Date.parse(t.messages[0].at)
    const ts = (s: number) => new Date(base0 + s * 1000).toISOString()
    const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(WALNUT_HOME))
    await fs.appendFile(path.join(dir, `${LEAD_SID}.jsonl`), [
      { type: 'user', uuid: 'u-p1', timestamp: ts(0.05), message: { role: 'user', content: [{ type: 'text', text: ask }] } },
      { type: 'assistant', uuid: 'a-p1', timestamp: ts(0.1), message: { id: 'msg-p1', role: 'assistant', content: [{ type: 'text', text: 'Port 5174, the dev proxy.' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n')
    // No turn end: reading the Threads page reads the answer (at most every 15 s).
    await expect.poll(async () => (await threads()).find((x) => x.id === t.id)?.messages[0].answer?.text, { timeout: 40_000, interval: 2_000 })
      .toBe('Port 5174, the dev proxy.')
  })

  it('a thread the lead opens itself takes his reply through its Follow up; closed ones leave the open list', async () => {
    const res = await fetch(`${base}/api/v1/tasks/${leadId}/threads/open`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': LEAD_SID },
      body: JSON.stringify({ title: 'Mail: the meetup asks about the talk', text: 'Confirm the slot by Friday?', from: 'mail', ref: 'Talk slot', user_kind: 'user_own', user_kind_why: 'It is his mail and his calendar' }),
    })
    expect(res.status).toBe(201)
    const opened = ((await res.json()) as { thread: OrgThread }).thread
    expect(opened).toMatchObject({ state: 'needs', messages: [], opener: { from: 'mail', by: `task:${leadId}` } })
    const sent = await typeIntoChat(LEAD_SID, 'yes, confirm it', opened.id)
    expect(hintOf(sent)).toContain(`follow-up in thread ${opened.id}`)
    const now = (await threads()).find((x) => x.id === opened.id)!
    expect(now.messages.map((m) => m.text)).toEqual(['yes, confirm it'])
    expect(now.state).toBe('working')
    // Bad input is refused.
    const bad = await fetch(`${base}/api/v1/tasks/${leadId}/threads/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x', text: 'y', from: 'fax' }) })
    expect(bad.status).toBe(400)
    // The open list leaves the closed ones out and counts them.
    const open = await fetch(`${base}/api/v1/tasks/${leadId}/threads?open=1`)
    const body = (await open.json()) as { threads: OrgThread[]; closed_count: number }
    expect(body.threads.every((x) => !x.closed)).toBe(true)
    expect(body.closed_count).toBeGreaterThan(0)
  })

  it('a thread waiting on him is counted on the lead as its threads, never as its own Needs you; once answered it only counts', async () => {
    // 2026-11-03, the user: "the little red should be thread instead of need u, also, even if no
    // thread, show 0 thread" (4ea0b2f06, replacing bc63ca220's Needs you for a waiting thread).
    const res = await fetch(`${base}/api/v1/tasks/${leadId}/threads/open`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': LEAD_SID },
      body: JSON.stringify({ title: 'Pick one of three header designs', text: 'Which one?', from: 'node', user_kind: 'user_own', user_kind_why: 'He asked to pick the design himself' }),
    })
    expect(res.status).toBe(201)
    const opened = ((await res.json()) as { thread: OrgThread }).thread
    const { syncUserStatuses } = await import('../../src/core/user-status-sync.js')
    const statusOf = async () => { await syncUserStatuses(new Set([leadId])); return (await listTasksByIds([leadId]))[0]!.user_status }
    await expect.poll(async () => (await statusOf())?.threads).toMatchObject({ needs: 1, id: opened.id })
    // The node's own status is never Needs you for it, and names no thread as its ask.
    expect((await statusOf())!.state).not.toBe('needs')
    expect((await statusOf())!.source).not.toBe('thread')
    // Answered: no longer waiting on him; still shown, so still counted.
    expect((await patch(opened.id, { state: 'answered', reply: 'Picked design 1 as you said' }, LEAD_SID)).status).toBe(200)
    await expect.poll(async () => (await statusOf())?.threads?.needs).toBe(0)
    expect((await statusOf())!.threads?.shown).toBeGreaterThan(0)
  })
})

describe('a question for the user names which of their kinds it is', () => {
  const post = (path: string, sid: string | undefined, body: unknown, method = 'POST') => fetch(`${base}/api/v1${path}`, {
    method, headers: { 'content-type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) }, body: JSON.stringify(body),
  })
  const letter = (sid: string | undefined, extra: Record<string, unknown> = {}) => post('/human-inbox', sid, {
    type: 'action_required', subject: 'Reinstall the main build on the simulator?', markdown: 'A test overwrote it.',
    actions: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], ...extra,
  })

  it('a lead\'s decision letter without a kind is refused, with the kinds and the never-his list', async () => {
    const res = await letter(LEAD_SID)
    expect(res.status).toBe(409)
    const text = JSON.stringify(await res.json())
    expect(text).toContain('user_kind')
    for (const kind of ['outward', 'spending', 'credentials', 'permissions', 'cloud_delete', 'irreversible', 'user_info', 'user_own']) expect(text).toContain(kind)
    expect(text).toContain('undoing something an agent broke or changed')
    expect(text).toContain('choosing between reasonable options')
  })

  it('a kind with no reason, or a kind that is not one, is refused too', async () => {
    expect((await letter(LEAD_SID, { user_kind: 'outward' })).status).toBe(409)
    expect((await letter(LEAD_SID, { user_kind: 'outward', user_kind_why: 'short' })).status).toBe(409)
    expect((await letter(LEAD_SID, { user_kind: 'convenience', user_kind_why: 'It would be nice to ask them' })).status).toBe(409)
  })

  it('with a kind and a reason it goes out, the reason leads the body, and the kind fields are not stored', async () => {
    const res = await letter(LEAD_SID, { user_kind: 'outward', user_kind_why: 'It posts to a public channel as them' })
    expect(res.status).toBe(201)
    const sent = await res.json() as { id: string }
    const got = (await (await fetch(`${base}/api/v1/human-inbox/${sent.id}`)).json() as { letter: Record<string, unknown> }).letter
    expect(JSON.stringify(got)).toContain('Yours to decide (an outward message or post): It posts to a public channel as them')
    expect(JSON.stringify(got)).toContain('A test overwrote it.')
    expect(JSON.stringify(got)).not.toContain('user_kind_why')
  })

  it('a worker\'s letter is judged too; a report letter, a plugin\'s letter and no caller are not; user_asked does not skip it', async () => {
    expect((await letter(WORKER_SID)).status).toBe(409)
    expect((await letter(LEAD_SID, { user_asked: true })).status).toBe(409)
    expect((await letter(WORKER_SID, { user_kind: 'credentials', user_kind_why: 'It needs a key only he holds' })).status).toBe(201)
    expect((await letter(LEAD_SID, { type: 'info', actions: undefined, subject: 'FYI', markdown: 'Done.' })).status).toBe(201)
    expect((await letter(undefined)).status).toBe(201)
  })

  it('a thread an agent opens waiting on the user, or moves to needs, names a kind; the user\'s own writes and a thread already waiting are not asked', async () => {
    const open = (extra: Record<string, unknown> = {}) => post(`/tasks/${leadId}/threads/open`, LEAD_SID, { title: 'Reinstall the build?', text: 'A test overwrote it', from: 'node', ...extra })
    const refused = await open()
    expect(refused.status).toBe(409)
    expect(JSON.stringify(await refused.json())).toContain('user_kind')
    // Opened as answered: nothing is handed to him.
    const answered = await open({ state: 'answered' })
    expect(answered.status).toBe(201)
    const id = ((await answered.json()) as { thread: OrgThread }).thread.id
    // Moved to needs by the lead: asked; with a kind: allowed; again while waiting: not asked.
    const move = (extra: Record<string, unknown> = {}, sid: string | null = LEAD_SID) => post(`/tasks/${leadId}/threads/${id}`, sid ?? undefined, { state: 'needs', ...extra }, 'PATCH')
    expect((await move()).status).toBe(409)
    expect((await move({ user_kind: 'spending', user_kind_why: 'It buys a paid plan for the team' })).status).toBe(200)
    expect((await move({ reply: 'Still waiting on the plan choice' })).status).toBe(200)
    const after = (await threads()).find((t) => t.id === id)!
    expect(after.state).toBe('needs')
    expect(JSON.stringify(after)).not.toContain('user_kind')
    // The user's own change (no caller) is never asked.
    expect((await post(`/tasks/${leadId}/threads/${id}`, undefined, { state: 'answered' }, 'PATCH')).status).toBe(200)
    expect((await move({}, null)).status).toBe(200)
  })
})

describe('a phone Follow up names its thread through POST /api/v1/sessions/:id/messages', () => {
  it('is filed under that thread; a malformed thread id is ignored, never refused', async () => {
    await typeIntoChat(LEAD_SID, 'Rename the export button on the phone')
    const opened = (await threads()).find((t) => t.title === 'Rename the export button on the phone')
    expect(opened).toBeTruthy()
    const send = (body: unknown) => fetch(`${base}/api/v1/sessions/${LEAD_SID}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const res = await send({ text: 'and keep its icon', threadId: opened!.id, messageId: 'qm-phone-follow-1' })
    expect(res.status).toBe(202)
    const after = (await threads()).find((t) => t.id === opened!.id)!
    expect(after.messages.map((m) => [m.via, m.text])).toEqual([['chat', 'Rename the export button on the phone'], ['follow-up', 'and keep its icon']])
    // An older or broken client's id: the send still goes, filed the way a plain message is.
    expect((await send({ text: 'one more thing about exports', threadId: 'not-a-thread' })).status).toBe(202)
    expect((await threads()).find((t) => t.id === opened!.id)!.messages.some((m) => m.text === 'one more thing about exports' && m.via === 'follow-up')).toBe(false)
  })
})
