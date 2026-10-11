/**
 * GET /api/v1/sessions/:id/chat-earlier: the part of a chat that came before one
 * of its lane sessions.
 *
 * The defect: every phone chat became an ask (lane-ask-link.ts), and the Mac opens
 * an ask on its main session's panel, which shows that session's transcript only.
 * An older phone chat whose history lives in chat-history (or in an archived lane
 * session), and whose main session is a later warm one, opened on the Mac as a
 * blank page: 8 of 99 chat asks on real data. The phone was fine: it reads the
 * whole assembly (GET /conversations/:id/messages). This route serves the same
 * assembly, stopped where the session begins.
 *
 * Real: Express server, api-v1 router, conversation registry + chat-history store,
 * session records in SQLite, the transcript read pipeline against JSONL on disk.
 * Mocked: constants (temp dirs) and the '__local__' daemon file reader (it expands
 * `~/.claude` with the process HOME, so it cannot see the mocked CLAUDE_HOME).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-chat-earlier'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME, CLAUDE_HOME, conversationFile } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../../src/core/session-history.js'
import type { ChatEntry, ChatHistoryStore } from '../../../src/core/types.js'

const LANE_CWD = '/Users/test/chat-earlier'

let server: HttpServer
let port: number

const apiUrl = (p: string): string => `http://localhost:${port}${p}`

interface Earlier {
  agentId?: string
  conversationId?: string
  messages: Array<{ id: string; role: string; text: string; createdAt: string; kind?: string }>
}

async function createConv(): Promise<string> {
  const res = await fetch(apiUrl('/api/v1/conversations'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  expect(res.status).toBe(201)
  return (await res.json() as { id: string }).id
}

async function getEarlier(sessionId: string): Promise<Earlier> {
  const res = await fetch(apiUrl(`/api/v1/sessions/${sessionId}/chat-earlier`))
  expect(res.status).toBe(200)
  return await res.json() as Earlier
}

const texts = (e: Earlier): string[] => e.messages.map((m) => `${m.role}:${m.kind ?? 'text'}:${m.text}`)

async function writeJsonl(sessionId: string, lines: unknown[]): Promise<void> {
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(LANE_CWD))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

async function seedLaneSession(
  convId: string,
  sessionId: string,
  startedAt: string,
  opts: { archived?: boolean; archiveReason?: string; lane?: string } = {},
): Promise<void> {
  await createSessionRecord(sessionId, '', '', LANE_CWD, {
    title: 'Lane session',
    lane: opts.lane ?? `chat:general:${convId}`,
    initialProcessStatus: 'idle',
  })
  await updateSessionRecord(sessionId, {
    startedAt,
    lastActiveAt: startedAt,
    ...(opts.archived ? { archived: true, archive_reason: opts.archiveReason ?? 'remote_conversation_lost' } : {}),
  })
}

async function writeChatHistory(convId: string, entries: ChatEntry[]): Promise<void> {
  const store: ChatHistoryStore = {
    version: 2, lastUpdated: new Date().toISOString(), compactionCount: 0, compactionSummary: null, entries,
  }
  const file = conversationFile('general', convId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(store))
}

const at = (minute: number, second = 0): string => new Date(Date.UTC(2026, 7, 1, 10, minute, second)).toISOString()
const userEntry = (text: string, timestamp: string): ChatEntry =>
  ({ tag: 'ai', role: 'user', content: text, displayText: text, timestamp })
const asstEntry = (text: string, timestamp: string): ChatEntry =>
  ({ tag: 'ai', role: 'assistant', content: [{ type: 'text', text }], timestamp })
let seq = 0
const userLine = (text: string, timestamp: string) => ({
  type: 'user', uuid: `u-${++seq}`, timestamp, message: { role: 'user', content: text },
})
const asstLine = (text: string, timestamp: string) => ({
  type: 'assistant', uuid: `a-${++seq}`, timestamp,
  message: { role: 'assistant', id: `msg-${seq}`, content: [{ type: 'text', text }] },
})

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

describe('GET /api/v1/sessions/:id/chat-earlier', () => {
  it('serves an old phone chat ahead of a later warm session that never ran a turn', async () => {
    const convId = await createConv()
    await writeChatHistory(convId, [
      userEntry('How should frozen dumplings be boiled?', at(0)),
      asstEntry('Straight from the freezer, three rounds of cold water.', at(1)),
      userEntry('And for how long?', at(2)),
      asstEntry('About eight minutes in all.', at(3)),
    ])
    // Opened again weeks later: the warm mint, no JSONL at all.
    await seedLaneSession(convId, 'earlier-warm-1', new Date(Date.UTC(2026, 8, 20)).toISOString())

    const earlier = await getEarlier('earlier-warm-1')
    expect(earlier.agentId).toBe('general')
    expect(earlier.conversationId).toBe(convId)
    expect(texts(earlier)).toEqual([
      'user:text:How should frozen dumplings be boiled?',
      'assistant:text:Straight from the freezer, three rounds of cold water.',
      'user:text:And for how long?',
      'assistant:text:About eight minutes in all.',
    ])
    expect(earlier.messages.every((m) => m.createdAt.length > 0)).toBe(true)
  })

  it("serves the older lane segments and their prefix, never the session's own turns or later ones", async () => {
    const convId = await createConv()
    await writeChatHistory(convId, [userEntry('Pre-lane question', at(0)), asstEntry('Pre-lane answer', at(1))])
    await seedLaneSession(convId, 'earlier-old-1', at(10), { archived: true })
    await writeJsonl('earlier-old-1', [userLine('Archived question', at(10, 5)), asstLine('Archived answer', at(11))])
    await seedLaneSession(convId, 'earlier-main-1', at(20))
    await writeJsonl('earlier-main-1', [userLine('Main question', at(20, 5)), asstLine('Main answer', at(21))])
    await seedLaneSession(convId, 'earlier-new-1', at(30))
    await writeJsonl('earlier-new-1', [userLine('Newer question', at(30, 5)), asstLine('Newer answer', at(31))])

    expect(texts(await getEarlier('earlier-main-1'))).toEqual([
      'user:text:Pre-lane question',
      'assistant:text:Pre-lane answer',
      'user:text:Archived question',
      'assistant:text:Archived answer',
    ])
    // The oldest session has only the pre-lane prefix before it.
    expect(texts(await getEarlier('earlier-old-1'))).toEqual([
      'user:text:Pre-lane question',
      'assistant:text:Pre-lane answer',
    ])
  })

  it("does not repeat the phone's eager first message, which lands just before the mint", async () => {
    const convId = await createConv()
    // The phone writes the message to chat-history, then the lane mints with it.
    await writeChatHistory(convId, [userEntry('Is the dishwasher drain blocked?', at(40, 0))])
    await seedLaneSession(convId, 'earlier-fresh-1', at(40, 1))
    await writeJsonl('earlier-fresh-1', [
      userLine('Is the dishwasher drain blocked?', at(40, 2)),
      asstLine('Check the filter first.', at(40, 9)),
    ])

    expect((await getEarlier('earlier-fresh-1')).messages).toEqual([])
  })

  it('keeps nothing from before a clear', async () => {
    const convId = await createConv()
    await writeChatHistory(convId, [userEntry('Forget this', at(50)), asstEntry('Forgotten', at(51))])
    await seedLaneSession(convId, 'earlier-cleared-1', at(52), { archived: true, archiveReason: 'chat_cleared' })
    await writeJsonl('earlier-cleared-1', [userLine('Cleared question', at(52, 5)), asstLine('Cleared answer', at(53))])
    await seedLaneSession(convId, 'earlier-after-clear-1', at(55))

    expect((await getEarlier('earlier-after-clear-1')).messages).toEqual([])
  })

  it('answers an empty list for a session that is not a chat lane', async () => {
    await createSessionRecord('earlier-plain-1', 'task-1', 'proj', LANE_CWD, { title: 'Coding session' })
    expect(await getEarlier('earlier-plain-1')).toEqual({ messages: [] })
    expect(await getEarlier('earlier-unknown-1')).toEqual({ messages: [] })
  })
})
