/**
 * GET /api/v1/conversations/:id/messages on a LANE-BOUND conversation: a phone
 * message's user row names the `messageId` it was POSTed under (send-once gate r1,
 * MEDIUM-2), so the phone gives its own pending or failed copy up for that row by
 * id, never by its words or by timing.
 *
 * A lane row comes from the CLI's transcript, which knows nothing of the id; the id
 * is on the message's compat copy in chat history, written just before the CLI got
 * the text. Pinned here, against JSONL on disk and the real read pipeline:
 *
 *  - the row of each phone message carries its id, the opening message included
 *    (its compat copy is the one the assembly drops as the lane's leading overlap);
 *  - an identical EARLIER message from another surface (no compat id) is not given
 *    the id, and two identical phone messages take one row each, in order;
 *  - a copy whose row the CLI has not written yet names no row at all.
 *
 * Harness from api-v1-lane-messages.test.ts: real startServer, the api-v1 router,
 * session records in SQLite, buildSessionTranscript over JSONL written to the
 * mocked CLAUDE_HOME. Mocked: constants (temp dirs) and the '__local__' daemon file
 * reader (it expands `~/.claude` with its own HOME). Imports nothing the send-once
 * change adds, so a tree without it fails here by behavior.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-row-message-id-lane'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME, CLAUDE_HOME, conversationFile } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../../src/core/session-history.js'
import type { ChatEntry, ChatHistoryStore } from '../../../src/core/types.js'

const LANE_CWD = '/Users/test/row-message-id-lane'

let server: HttpServer
let port: number

const apiUrl = (p: string): string => `http://localhost:${port}${p}`

interface V1Message { id: string; role: string; text: string; kind?: string; messageId?: string }

async function createConv(): Promise<string> {
  const res = await fetch(apiUrl('/api/v1/conversations'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })
  expect(res.status).toBe(201)
  return (await res.json() as { id: string }).id
}

async function getMessages(convId: string): Promise<V1Message[]> {
  const res = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages?limit=50`))
  expect(res.status).toBe(200)
  return await res.json() as V1Message[]
}

/** One minute after a fixed instant, `n` times: every timestamp is exact. */
const at = (n: number): string => new Date(Date.UTC(2026, 8, 1, 12, n)).toISOString()

async function writeJsonl(sessionId: string, lines: unknown[]): Promise<void> {
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(LANE_CWD))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

async function seedLane(convId: string, sessionId: string, startedAt: string): Promise<void> {
  await createSessionRecord(sessionId, '', '', LANE_CWD, {
    title: 'Lane session', lane: `chat:general:${convId}`, initialProcessStatus: 'idle',
  })
  await updateSessionRecord(sessionId, { startedAt })
}

async function writeChatHistory(convId: string, entries: ChatEntry[]): Promise<void> {
  const store: ChatHistoryStore = {
    version: 2, lastUpdated: new Date().toISOString(), compactionCount: 0, compactionSummary: null, entries,
  }
  const file = conversationFile('general', convId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(store))
}

let seq = 0
const userLine = (text: string, timestamp: string) => ({
  type: 'user', uuid: `u-${++seq}`, timestamp, message: { role: 'user', content: text },
})
const asstLine = (text: string, timestamp: string) => ({
  type: 'assistant', uuid: `a-${++seq}`, timestamp,
  message: { role: 'assistant', id: `msg-${seq}`, content: [{ type: 'text', text }] },
})
/** A phone message's compat copy, as runApiV1Turn writes it (messageId included). */
const phoneCopy = (text: string, timestamp: string, messageId: string): ChatEntry =>
  ({ tag: 'ai', role: 'user', content: text, displayText: text, timestamp, turnId: `turn-${messageId}`, messageId })
const answerCopy = (text: string, timestamp: string): ChatEntry =>
  ({ tag: 'ai', role: 'assistant', content: [{ type: 'text', text }], timestamp })

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a lane row names the message id of the phone message it is', () => {
  it('the opening message and a later one carry their ids', async () => {
    const convId = await createConv()
    const sid = 'row-id-lane-opening'
    // The production order: the copy (minute 0) is written before the lane record
    // is stamped (minute 1), and the CLI writes its row after that.
    await writeChatHistory(convId, [
      phoneCopy('plan my week', at(0), 'qm-mobile-week-1'),
      answerCopy('here is a plan', at(3)),
      phoneCopy('and the weekend', at(4), 'qm-mobile-week-2'),
      answerCopy('the weekend is free', at(6)),
    ])
    await seedLane(convId, sid, at(1))
    await writeJsonl(sid, [
      userLine('plan my week', at(2)), asstLine('here is a plan', at(3)),
      userLine('and the weekend', at(5)), asstLine('the weekend is free', at(6)),
    ])
    const rows = await getMessages(convId)
    expect(rows.map((m) => [m.role, m.text, m.messageId ?? null])).toEqual([
      ['user', 'plan my week', 'qm-mobile-week-1'],
      ['assistant', 'here is a plan', null],
      ['user', 'and the weekend', 'qm-mobile-week-2'],
      ['assistant', 'the weekend is free', null],
    ])
  }, 30_000)

  it('an identical earlier message keeps no id, and two identical phone messages take one row each', async () => {
    const convId = await createConv()
    const sid = 'row-id-lane-identical'
    await seedLane(convId, sid, at(0))
    await writeChatHistory(convId, [
      // Minute 1's "ok" came from the Mac's session panel: no compat copy at all.
      phoneCopy('ok', at(3), 'qm-mobile-ok-1'),
      phoneCopy('ok', at(6), 'qm-mobile-ok-2'),
    ])
    await writeJsonl(sid, [
      userLine('ok', at(1)), asstLine('first', at(2)),
      userLine('ok', at(4)), asstLine('second', at(5)),
      userLine('ok', at(7)), asstLine('third', at(8)),
    ])
    const users = (await getMessages(convId)).filter((m) => m.role === 'user')
    expect(users.map((m) => m.messageId ?? null)).toEqual([null, 'qm-mobile-ok-1', 'qm-mobile-ok-2'])
  }, 30_000)

  it('a message the prefix shows under its id lends that id to no lane row of the same words', async () => {
    const convId = await createConv()
    const sid = 'row-id-lane-prefix-shown'
    // Minute 0: an "ok" from the phone, answered before any lane existed, so its row
    // is in the prefix and carries its id. Minute 6: an "ok" typed into the lane on
    // the Mac (no compat copy): another message, with no id of its own.
    await writeChatHistory(convId, [
      phoneCopy('ok', at(0), 'qm-mobile-prefix-ok'),
      answerCopy('noted before the lane', at(1)),
    ])
    await seedLane(convId, sid, at(3))
    await writeJsonl(sid, [
      userLine('start the lane', at(4)), asstLine('lane started', at(5)),
      userLine('ok', at(6)), asstLine('noted in the lane', at(7)),
    ])
    const users = (await getMessages(convId)).filter((m) => m.role === 'user')
    expect(users.map((m) => [m.text, m.messageId ?? null])).toEqual([
      ['ok', 'qm-mobile-prefix-ok'],
      ['start the lane', null],
      ['ok', null],
    ])
  }, 30_000)

  it('a copy whose row the CLI has not written yet names no row', async () => {
    const convId = await createConv()
    const sid = 'row-id-lane-unwritten'
    await seedLane(convId, sid, at(0))
    await writeChatHistory(convId, [
      phoneCopy('first question', at(1), 'qm-mobile-q-1'),
      phoneCopy('second question', at(5), 'qm-mobile-q-2'),
    ])
    await writeJsonl(sid, [userLine('first question', at(2)), asstLine('first answer', at(3))])
    const rows = await getMessages(convId)
    expect(rows.filter((m) => m.messageId).map((m) => [m.text, m.messageId])).toEqual([
      ['first question', 'qm-mobile-q-1'],
    ])
  }, 30_000)
})
