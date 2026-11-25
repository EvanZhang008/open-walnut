/**
 * A reply is its thread's reply, on a real server with only the CLI faked (experiment
 * threads_reply_tag; src/core/org/reply-card.ts, src/lib/card-tag.ts; 2026-11-25, the user,
 * translated: "in what it returns, it adds this tag. Then it is both its reply to me and its reply
 * to the thread").
 *
 *   1. he types in a lead's chat: Walnut files the message under a new thread, and its hint gives
 *      the lead the card line with that thread's id;
 *   2. the lead's reply ends with that line (a state, a title, a summary): when its turn ends the
 *      thread's card holds them, by the lead itself, and the reply is kept under his message;
 *   3. he never sees the line: not in the chat the web reads, not in the one the phone reads, not
 *      in the answer kept on the thread;
 *   4. a decision line lands as the thread_update it stands for, and a merge line joins two threads;
 *   5. the switch off: the hint asks for nothing, a line a session still writes changes no thread,
 *      and it stays hidden everywhere.
 * No CLI runs: the test takes each message out of the queue as a CLI does and writes the chat the
 * way a CLI writes its transcript; the local daemon's file reader is served from the test's own
 * Claude home. The turn ends with the event the runner emits (its destinations too), and the line
 * is written by the turn-complete hook; the turn's status question, its order with the write, and
 * an isolated server are in tests/e2e/reply-card-real-flow.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-reply-card-line'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())
// This file plays the session's CLI itself (it takes the queued rows), so the server's runner takes
// no row here (tests/core/hand-played-cli-guard.test.ts).
vi.mock('../../src/core/session-message-queue.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/session-message-queue.js')>()
  return { ...real, markProcessing: (async () => []) as typeof real.markProcessing }
})

import { CLAUDE_HOME, WALNUT_HOME } from '../../src/constants.js'
import { encodeProjectPath } from '../../src/core/session-history.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { getQueue, markNextProcessing, removeProcessed, sendMessageToSession } from '../../src/core/session-message-queue.js'
import { prepareHintedSend } from '../../src/core/hints/hint-send.js'
import { threadsKeptNow } from '../../src/core/org/threads-kept.js'
import { replyTagNow } from '../../src/core/org/reply-card-switch.js'
import { cardTagLine } from '../../src/lib/card-tag.js'
import { beginQuietTurn, endQuietTurn } from '../../src/core/sessions/quiet-turn.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

const LEAD_SID = '77777777-6666-4777-8888-999999999999'
let base = ''
let leadId = ''

interface Row { role: string; text: string; hidden?: string }

async function setTag(on: boolean): Promise<void> {
  const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { threads_kept_by_walnut: true, threads_reply_tag: on } }) })
  expect(put.status).toBe(200)
  await vi.waitFor(() => { expect(threadsKeptNow()).toBe(true); expect(replyTagNow()).toBe(on) }, { timeout: 5000 })
}

/** The web send's own steps (routes/session-chat.ts), then the line leaves the queue as when a CLI takes it. Answers the line the model read. */
async function typeIntoChat(text: string): Promise<string> {
  const record = await getSessionByClaudeId(LEAD_SID)
  const prepared = await prepareHintedSend(LEAD_SID, record, text, { sentBy: 'person' })
  await sendMessageToSession(LEAD_SID, text, { source: 'ui', taskId: record?.taskId, enqueueMessage: prepared.enqueueText, hinted: true })
  await prepared.commit()
  const rows = await markNextProcessing(LEAD_SID)
  expect(rows).toHaveLength(1)
  await removeProcessed(LEAD_SID, rows.map((r) => r.id))
  expect(await getQueue(LEAD_SID)).toEqual([])
  return rows[0].message
}

let seq = 0
/** The chat as its CLI writes it: his line as it reached the model (hints and all), then the answer. */
async function writeChat(rows: Array<{ type: 'user' | 'assistant'; text: string }>): Promise<void> {
  const lines = rows.map((r) => {
    seq += 1
    return {
      type: r.type, uuid: `${LEAD_SID.slice(0, 8)}-0000-4000-8000-${String(seq).padStart(12, '0')}`, timestamp: new Date(Date.now() + seq).toISOString(),
      message: r.type === 'user'
        ? { role: 'user', content: [{ type: 'text', text: r.text }] }
        : { id: `msg-${seq}`, role: 'assistant', content: [{ type: 'text', text: r.text }] },
    }
  })
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(WALNUT_HOME))
  await fs.mkdir(dir, { recursive: true })
  await fs.appendFile(path.join(dir, `${LEAD_SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

/** One turn: his message as the model read it, the reply, and the turn's end as the runner says it. */
async function turn(asRead: string, reply: string): Promise<void> {
  await writeChat([{ type: 'user', text: asRead }, { type: 'assistant', text: reply }])
  bus.emit(EventNames.SESSION_RESULT, { sessionId: LEAD_SID, taskId: leadId, result: reply, isError: false }, ['main-ai', 'session-runner'], { source: 'session-runner' })
}

async function webRows(): Promise<Row[]> {
  const res = await fetch(`${base}/api/sessions/${LEAD_SID}/history`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { messages: Row[] }).messages
}

async function phoneRows(): Promise<Row[]> {
  const res = await fetch(`${base}/api/v1/sessions/${LEAD_SID}/transcript?fresh=1&rich=1`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { messages: Row[] }).messages
}

async function threads(): Promise<OrgThread[]> {
  return ((await (await fetch(`${base}/api/v1/tasks/${leadId}/threads`)).json()) as { threads: OrgThread[] }).threads
}
const threadOf = async (id: string) => (await threads()).find((t) => t.id === id)!
/** The thread his message went to: the one its hint names. */
const filedUnder = (asRead: string): string => {
  const m = /th-[0-9a-f]{6,32}/.exec(asRead)
  if (!m) throw new Error(`no thread named in:\n${asRead}`)
  return m[0]
}

const FENCE_ASK = 'How tall should the orchard fence be?'
const FENCE_REPLY = 'Two metres keeps the deer out. The posts go in on Monday.'
const SEEDS_ASK = 'Now order the seeds for spring.'
const SEEDS_REPLY = 'Two suppliers carry them. One decision is yours.'
const GATE_ASK = 'And the gate, which way should it swing?'
const GATE_REPLY = 'Inward: the path outside is narrow. This is part of the fence.'
const SHED_ASK = 'What colour for the shed?'
const SHED_REPLY = 'Green, like the gate.'

beforeAll(async () => {
  process.env.WALNUT_THREAD_JOIN_SECS = '0'
  process.env.WALNUT_THREAD_REOPEN_SECS = '0'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  vi.spyOn(sessionRunner as unknown as { processNext(sessionId: string, mode?: string): Promise<void> }, 'processNext').mockResolvedValue(undefined)
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  leadId = (await ensureProjectLead('Orchard')).id
  await createSessionRecord(LEAD_SID, leadId, 'Orchard', WALNUT_HOME)
  await updateSessionRecord(LEAD_SID, { process_status: 'stopped' })
}, 30_000)

afterAll(async () => {
  delete process.env.WALNUT_THREAD_JOIN_SECS
  delete process.env.WALNUT_THREAD_REOPEN_SECS
  await stopServer()
  vi.restoreAllMocks()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a reply is its thread\'s reply', () => {
  let fence = ''
  let seeds = ''

  it('his message is filed, and its hint gives the card line with the thread\'s id', async () => {
    await setTag(true)
    const asRead = await typeIntoChat(FENCE_ASK)
    fence = filedUnder(asRead)
    // A new thread has no title of its own: the line it is asked for carries one.
    expect(asRead).toContain(`End your reply with: ${cardTagLine(fence).replace('/>', ' title="..."/>')} (state: working, waiting, answered, done; title: a short one of your own).`)
    expect(await threadOf(fence)).toMatchObject({ state: 'new' })
    expect((await threadOf(fence)).titled).toBeFalsy()

    await turn(asRead, `${FENCE_REPLY}\n\n<walnut-card thread="${fence}" state="answered" title="Orchard fence" summary="Two metres; posts go in Monday."/>`)
    await vi.waitFor(async () => {
      expect(await threadOf(fence)).toMatchObject({ title: 'Orchard fence', titled: true, state: 'answered', reply: 'Two metres; posts go in Monday.', by: `task:${leadId}` })
    }, { timeout: 20_000, interval: 300 })
  }, 40_000)

  it('the reply is kept under his message, and he never sees the line: web chat, phone chat, the thread\'s answer', async () => {
    await vi.waitFor(async () => { expect((await threadOf(fence)).messages[0].answer?.text).toBe(FENCE_REPLY) }, { timeout: 20_000, interval: 300 })
    for (const rows of [await webRows(), await phoneRows()]) {
      const answer = rows.find((r) => r.role === 'assistant' && r.text.includes('Two metres'))
      expect(answer?.text).toBe(FENCE_REPLY)
      expect(rows.map((r) => r.text).join('\n')).not.toContain('walnut-card')
    }
    // His own message shows as he typed it: the hint that named the line is not his words.
    expect((await webRows()).find((r) => r.role === 'user')?.text).toBe(FENCE_ASK)
    expect(JSON.stringify(await threads())).not.toContain('walnut-card')
  }, 40_000)

  it('a decision line lands as the thread_update it stands for', async () => {
    const asRead = await typeIntoChat(SEEDS_ASK)
    seeds = filedUnder(asRead)
    expect(seeds).not.toBe(fence)
    await turn(asRead, `${SEEDS_REPLY}\n\n<walnut-card thread="${seeds}" state="needs" title="Spring seed order" ask="Which seed supplier?" options="Larch Seeds; Oak Seeds" kind="spending" why="Oak Seeds costs twice the budget he set"/>`)
    await vi.waitFor(async () => {
      const t = await threadOf(seeds)
      expect(t).toMatchObject({ state: 'needs', ask: 'Which seed supplier?', title: 'Spring seed order' })
      expect(t.options?.map((o) => [o.label, !!o.recommended])).toEqual([['Larch Seeds', true], ['Oak Seeds', false]])
    }, { timeout: 20_000, interval: 300 })
    expect((await webRows()).map((r) => r.text).join('\n')).not.toContain('walnut-card')
  }, 40_000)

  it('a merge line joins his new message to the thread it belongs to', async () => {
    const asRead = await typeIntoChat(GATE_ASK)
    const gate = filedUnder(asRead)
    expect(gate).not.toBe(fence)
    await turn(asRead, `${GATE_REPLY}\n\n<walnut-card thread="${gate}" merge="${fence}"/>`)
    await vi.waitFor(async () => {
      const all = await threads()
      expect(all.find((t) => t.id === gate && !t.closed && !t.mergedInto)).toBeUndefined()
      expect(all.find((t) => t.id === fence)!.messages.map((m) => m.text)).toContain(GATE_ASK)
    }, { timeout: 20_000, interval: 300 })
  }, 40_000)

  // A quiet turn (Walnut's own upkeep, sessions/quiet-turn.ts) runs no turn-end hook, so its words
  // are no reply to him and their card lines are never written (session-hooks/derive/session.ts).
  it('a quiet turn\'s card line writes nothing; the same turn end once it is not quiet does', async () => {
    const asRead = await typeIntoChat('Where should the compost bin stand?')
    const bin = filedUnder(asRead)
    const line = `<walnut-card thread="${bin}" state="answered" title="Compost bin place" summary="By the hedge."/>`
    beginQuietTurn(LEAD_SID, 'idle-compact', 'idle-compaction')
    try {
      await turn(asRead, `By the hedge.\n\n${line}`)
      await new Promise((r) => setTimeout(r, 1500))
      expect(await threadOf(bin)).toMatchObject({ state: 'new' })
      expect((await threadOf(bin)).titled).toBeFalsy()
    } finally {
      endQuietTurn(LEAD_SID, 'test')
    }
    bus.emit(EventNames.SESSION_RESULT, { sessionId: LEAD_SID, taskId: leadId, result: `By the hedge.\n\n${line}`, isError: false }, ['main-ai', 'session-runner'], { source: 'session-runner' })
    await vi.waitFor(async () => { expect(await threadOf(bin)).toMatchObject({ title: 'Compost bin place', titled: true, state: 'answered' }) }, { timeout: 20_000, interval: 300 })
  }, 40_000)

  it('switch off: the hint asks for no line, a line a session still writes changes no thread, and it stays hidden', async () => {
    await setTag(false)
    const asRead = await typeIntoChat(SHED_ASK)
    const shed = filedUnder(asRead)
    expect(asRead).not.toContain('walnut-card')
    const before = await threadOf(shed)
    await turn(asRead, `${SHED_REPLY}\n\n<walnut-card thread="${shed}" state="done" title="Shed colour" summary="Green."/>`)
    // The turn's end was read (its reply is under his message), so the line had its chance.
    await vi.waitFor(async () => { expect((await threadOf(shed)).messages[0].answer?.text).toBe(SHED_REPLY) }, { timeout: 20_000, interval: 300 })
    await new Promise((r) => setTimeout(r, 1500))
    const after = await threadOf(shed)
    expect(after.title).toBe(before.title)
    expect(after.titled).toBeFalsy()
    expect(after.closed).toBeUndefined()
    expect(after.reply).not.toBe('Green.')
    for (const rows of [await webRows(), await phoneRows()]) {
      expect(rows.find((r) => r.role === 'assistant' && r.text.includes('Green'))?.text).toBe(SHED_REPLY)
      expect(rows.map((r) => r.text).join('\n')).not.toContain('walnut-card')
    }
  }, 40_000)
})
