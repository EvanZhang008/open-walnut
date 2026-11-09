/**
 * Who wrote an Org thread's summary, first post and answers, on a real server (routes
 * src/web/routes/org-threads-v1.ts, src/core/org/thread-caller.ts, thread-answers.ts; 2026-11-07:
 * a summary's path opened on the node's current machine, though an older session on another host
 * wrote it).
 *
 *  1. a summary written by an earlier remote writer keeps that session and host
 *     while the node runs a local session, through its pin, its state move with the same words
 *     and the user's close; new words take their new writer;
 *  2. a `sid`, `host`, `by` or `reply_sid` in the body is never read: the caller's own session
 *     record decides;
 *  3. a header that names no session Walnut knows leaves the writer unknown (no session, no host);
 *     no header is the user, whose words are the primary's;
 *  4. a first post records its opener's verified session the same way;
 *  5. an answer to a message that names no session is read from the node's own chat and keeps
 *     that chat's session, the one actually read.
 * Only the Claude CLI is mocked (no CLI runs), and the local daemon's file reader is served from
 * the test's own Claude home.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-org-thread-source'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { CLAUDE_HOME, WALNUT_HOME } from '../../src/constants.js'
import { encodeProjectPath } from '../../src/core/session-history.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, linkSessionSlot } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

const OLD_REMOTE_SID = '77777777-6666-4777-8888-000000000001'
const NEW_LOCAL_SID = '77777777-6666-4777-8888-000000000002'
const UNKNOWN_SID = '77777777-6666-4777-8888-0000000000ff'
let base = ''
let leadId = ''
let oldWriterId = ''

async function threads(): Promise<OrgThread[]> {
  const res = await fetch(`${base}/api/v1/tasks/${leadId}/threads`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { threads: OrgThread[] }).threads
}
const thread = async (id: string) => (await threads()).find((t) => t.id === id)!

async function call(method: string, url: string, body: unknown, sid?: string): Promise<Record<string, any>> {
  const res = await fetch(`${base}/api/v1/tasks/${leadId}/threads${url}`, {
    method, headers: { 'content-type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) }, body: JSON.stringify(body),
  })
  const text = await res.text()
  expect(res.ok, `${method} ${url}: ${res.status} ${text}`).toBe(true)
  return JSON.parse(text)
}

/** One of his messages filed the way the phone's import does (no session on it). */
async function fileAsk(text: string): Promise<OrgThread> {
  return (await call('POST', '', { text })).thread as OrgThread
}

const replySource = (t: OrgThread) => ({ reply: t.reply, reply_by: t.reply_by, reply_sid: t.reply_sid, reply_host: t.reply_host })

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  await addTask({ title: 'Notes page', project: 'Orchard' })
  leadId = (await ensureProjectLead('Orchard')).id
  // A previous writer remains on its own task; the node's current session is local.
  oldWriterId = (await addTask({ title: 'Previous notes writer', project: 'Orchard' })).task.id
  await createSessionRecord(OLD_REMOTE_SID, oldWriterId, 'Orchard', '/home/me/orchard', { host: 'devbox' })
  await updateSessionRecord(OLD_REMOTE_SID, { process_status: 'stopped', archived: true, archive_reason: 'user' })
  await createSessionRecord(NEW_LOCAL_SID, leadId, 'Orchard', WALNUT_HOME)
  await updateSessionRecord(NEW_LOCAL_SID, { process_status: 'stopped' })
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('who wrote an Org thread\'s words', () => {
  it('a summary keeps its old remote writer after the lead moved to a local session, through pin, state and close', async () => {
    const t = await fileAsk('where are the notes?')
    await call('PATCH', `/${t.id}`, { title: 'Notes', state: 'answered', reply: 'Notes in /home/me/orchard/notes.txt:2' }, OLD_REMOTE_SID)
    const written = { reply: 'Notes in /home/me/orchard/notes.txt:2', reply_by: `task:${oldWriterId}`, reply_sid: OLD_REMOTE_SID, reply_host: 'devbox' }
    expect(replySource(await thread(t.id))).toEqual(written)
    // The lead now runs its local session.
    await linkSessionSlot(leadId, NEW_LOCAL_SID, 'exec')
    await call('PATCH', `/${t.id}`, { pin: true }, NEW_LOCAL_SID)
    await call('PATCH', `/${t.id}`, { state: 'answered', reply: 'Notes in /home/me/orchard/notes.txt:2' }, NEW_LOCAL_SID)
    await call('PATCH', `/${t.id}`, { pin: false })
    await call('PATCH', `/${t.id}`, { close: 'acked' })
    const closed = await thread(t.id)
    expect(closed.closed?.how).toBe('acked')
    expect(replySource(closed)).toEqual(written)
    // New words take their new writer, on this machine.
    await call('PATCH', `/${t.id}`, { reopen: true, reply: 'Moved the notes to /Users/me/notes.txt' }, NEW_LOCAL_SID)
    expect(replySource(await thread(t.id))).toEqual({ reply: 'Moved the notes to /Users/me/notes.txt', reply_by: `task:${leadId}`, reply_sid: NEW_LOCAL_SID, reply_host: '__local__' })
  })

  it('a writer named in the body is never read; the caller\'s own record decides', async () => {
    const t = await fileAsk('and the design?')
    await call('PATCH', `/${t.id}`, {
      reply: 'Design in /home/me/orchard/design.png', reply_sid: 'forged-sid', reply_host: 'evil', reply_by: 'human', sid: 'forged-sid', host: 'evil', by: 'human',
    }, OLD_REMOTE_SID)
    expect(replySource(await thread(t.id))).toEqual({ reply: 'Design in /home/me/orchard/design.png', reply_by: `task:${oldWriterId}`, reply_sid: OLD_REMOTE_SID, reply_host: 'devbox' })
  })

  it('an engine-replaced caller keeps no authority or asserted source', async () => {
    await updateSessionRecord(OLD_REMOTE_SID, { archive_reason: 'engine_switched:claude' })
    try {
      const t = await fileAsk('check the replaced caller')
      await call('PATCH', `/${t.id}`, { reply: 'Replaced caller at /home/me/old.txt', reply_sid: OLD_REMOTE_SID, reply_host: 'devbox' }, OLD_REMOTE_SID)
      expect(replySource(await thread(t.id))).toEqual({ reply: 'Replaced caller at /home/me/old.txt', reply_by: 'agent', reply_sid: undefined, reply_host: undefined })
    } finally {
      await updateSessionRecord(OLD_REMOTE_SID, { archive_reason: 'user' })
    }
  })

  it('a header Walnut cannot place leaves the writer unknown; no header is the user, on the primary', async () => {
    const t = await fileAsk('which port?')
    await call('PATCH', `/${t.id}`, { reply: 'Port 5174', sid: OLD_REMOTE_SID, host: 'devbox' }, UNKNOWN_SID)
    expect(replySource(await thread(t.id))).toEqual({ reply: 'Port 5174', reply_by: 'agent', reply_sid: undefined, reply_host: undefined })
    await call('PATCH', `/${t.id}`, { reply: 'Port 5175, I checked', reply_sid: OLD_REMOTE_SID })
    expect(replySource(await thread(t.id))).toEqual({ reply: 'Port 5175, I checked', reply_by: 'human', reply_sid: undefined, reply_host: undefined })
  })

  it('a first post records its opener\'s verified session, never one in the body', async () => {
    const opened = (await call('POST', '/open', {
      title: 'Invoice', text: 'The invoice is at /home/me/orchard/invoice.pdf', from: 'mail', state: 'answered', sid: 'forged-sid', host: 'evil',
    }, OLD_REMOTE_SID)).thread as OrgThread
    expect(opened.opener).toMatchObject({ by: `task:${oldWriterId}`, sid: OLD_REMOTE_SID, host: 'devbox' })
    const unknown = (await call('POST', '/open', { title: 'Note', text: 'From somewhere', from: 'node', state: 'answered' }, UNKNOWN_SID)).thread as OrgThread
    expect(unknown.opener?.by).toBe('agent')
    expect(unknown.opener?.sid).toBeUndefined()
    expect(unknown.opener?.host).toBeUndefined()
  })

  it('an answer to a message that names no session keeps the session whose chat it was read from', async () => {
    const ask = 'is the preview up?'
    const t = await fileAsk(ask)
    expect(t.messages[0].sid).toBeUndefined()
    const base0 = Date.parse(t.messages[0].at)
    const ts = (s: number) => new Date(base0 + s * 1000).toISOString()
    const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(WALNUT_HOME))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, `${NEW_LOCAL_SID}.jsonl`), [
      { type: 'user', uuid: 'u-s1', timestamp: ts(0.05), message: { role: 'user', content: [{ type: 'text', text: ask }] } },
      { type: 'assistant', uuid: 'a-s1', timestamp: ts(0.1), message: { id: 'msg-s1', role: 'assistant', content: [{ type: 'text', text: 'Yes, at /Users/me/preview.log' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n')
    // Reading the Threads page reads the answer from the node's own chat (at most every 15 s).
    await expect.poll(async () => (await thread(t.id)).messages[0].answer?.text, { timeout: 40_000, interval: 2_000 }).toBe('Yes, at /Users/me/preview.log')
    const answer = (await thread(t.id)).messages[0].answer!
    expect(answer.sid).toBe(NEW_LOCAL_SID)
    expect(answer.host).toBe('__local__')
    // The message itself still names no session: the answer's writer is not written onto it.
    expect((await thread(t.id)).messages[0].sid).toBeUndefined()
  })
})
