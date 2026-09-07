/**
 * GET /api/v1/conversations/:id/messages for a LANE-BOUND conversation (primary box).
 *
 * The defect: a Personal AI turn sent from the web console runs inside a
 * lane-bound `claude` CLI session, whose transcript lives in the CLI's JSONL and
 * is never written to Walnut's chat-history store. The phone read chat-history
 * only, so it got `[]` (HTTP 200, 2 bytes) on such a conversation while the list
 * endpoint reported `messageCount: 11` from the index row — measured on a live
 * box: 24 of 64 non-empty conversations.
 *
 * The answer is an APPEND-ONLY assembly (see the block comment in api-v1.ts):
 * pre-lane chat history, then every lane session's FULL transcript oldest-first,
 * archived ones included. What each case here pins down:
 *
 *  - the lane transcript is what the phone sees, in the mobile shape, with the
 *    same positional-cursor paging the chat-history branch has;
 *  - those positional ids are STABLE while the lane grows (the first version read
 *    a sliding 100-row tail, so one new turn re-pointed every id and "load older"
 *    handed the phone rows it was already showing);
 *  - an ARCHIVED lane (a `--resume` that lost its CLI conversation) still
 *    contributes, and its turns come first;
 *  - a long answer is NOT clipped (the sweep's 4000-char clip is for the slim
 *    projection, not for the conversation the user reads);
 *  - chat-history rows that predate the first lane are the prefix, and lane-era
 *    copies in chat-history are never rendered twice;
 *  - a conversation with no lane is byte-for-byte unchanged;
 *  - the primary-side relay action answers exactly what the route answers;
 *  - duplicated index rows collapse to the newest, and a rename lands on it.
 *
 * Real: Express server (startServer), the api-v1 router, the conversation
 * registry + chat-history store, session records in SQLite, and the whole
 * transcript read pipeline (buildSessionTranscript → readSessionHistoryTail →
 * DaemonFileReader → parseSessionMessages) against JSONL written to disk.
 * Mocked: constants (temp dirs), the agent loop (never invoked — no turn is
 * posted), and the '__local__' daemon file reader, which in production expands
 * `~/.claude` via its own process HOME and so cannot see fixtures under the
 * mocked CLAUDE_HOME.
 *
 * Sibling (cloud replica + bridge relay): api-v1-lane-messages-cloud.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-lane-messages'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

// No test here posts a turn; the mock exists so a regression that starts one
// can never reach a real provider.
vi.mock('../../../src/agent/loop.js', () => ({
  runAgentLoop: vi.fn(async () => ({ messages: [], newMessages: [], response: '', aborted: false })),
}))

import {
  WALNUT_HOME, CLAUDE_HOME, conversationFile, conversationIndexFile,
} from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../../src/core/session-history.js'
import { handleSessionControlRelay } from '../../../src/core/sessions/session-controls.js'
import * as chatHistory from '../../../src/core/chat-history.js'
import { renameConversation, listConversations } from '../../../src/core/conversations.js'
import { log } from '../../../src/logging/index.js'
import type { ChatEntry, ChatHistoryStore, ConversationIndex } from '../../../src/core/types.js'

/** The lane session's cwd — lane records are seeded with one, and it is what
 *  locates the JSONL (`~/.claude/projects/<encoded cwd>/<sid>.jsonl`). */
const LANE_CWD = '/Users/test/lane-messages'

let server: HttpServer
let port: number

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

interface V1Message {
  id: string
  role: string
  text: string
  createdAt?: string
  kind?: string
  source?: string
  detail?: string
  resultPreview?: string
}

async function createConv(): Promise<string> {
  const res = await fetch(apiUrl('/api/v1/conversations'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(201)
  return (await res.json() as { id: string }).id
}

async function getMessages(convId: string, qs = ''): Promise<V1Message[]> {
  const res = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages${qs}`))
  expect(res.status).toBe(200)
  return await res.json() as V1Message[]
}

/**
 * Write a session's JSONL. `mtimeMs` is set explicitly because the history reader
 * caches parses by mtime — two writes inside the same millisecond would serve the
 * first parse for the second file, and the growth test would pass for the wrong
 * reason.
 */
async function writeJsonl(sessionId: string, lines: unknown[], mtimeMs?: number): Promise<void> {
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(LANE_CWD))
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${sessionId}.jsonl`)
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  if (mtimeMs !== undefined) await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs))
}

/** Bind a session record to this conversation's lane, the way the real mint does
 *  (personal-ai-lane.ts) minus 'awaiting_spawn' — the pre-spawn short-circuit is
 *  for a record whose CLI never came up, and these have transcripts. */
async function seedLaneSession(
  convId: string,
  sessionId: string,
  opts: {
    startedAt?: string
    lastActiveAt?: string
    archived?: boolean
    /** Defaults to the lane-break reason, which must stay INCLUDED. */
    archiveReason?: string
  } = {},
): Promise<void> {
  await createSessionRecord(sessionId, '', '', LANE_CWD, {
    title: 'Lane session',
    lane: `chat:general:${convId}`,
    initialProcessStatus: 'idle',
  })
  if (opts.startedAt || opts.lastActiveAt || opts.archived) {
    await updateSessionRecord(sessionId, {
      ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
      ...(opts.lastActiveAt ? { lastActiveAt: opts.lastActiveAt } : {}),
      ...(opts.archived
        ? { archived: true, archive_reason: opts.archiveReason ?? 'remote_conversation_lost' }
        : {}),
    })
  }
}

let seq = 0
const T = () => new Date(Date.UTC(2026, 0, 1, 0, ++seq)).toISOString()
const userLine = (text: string) => ({
  type: 'user', uuid: `u-${++seq}`, timestamp: T(),
  message: { role: 'user', content: text },
})
const asstLine = (text: string) => ({
  type: 'assistant', uuid: `a-${++seq}`, timestamp: T(),
  message: { role: 'assistant', id: `msg-${seq}`, content: [{ type: 'text', text }] },
})
const toolLine = (toolUseId: string) => ({
  type: 'assistant', uuid: `t-${++seq}`, timestamp: T(),
  message: {
    role: 'assistant', id: `msg-${seq}`,
    content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'echo hi' } }],
  },
})
const toolResultLine = (toolUseId: string) => ({
  type: 'user', uuid: `tr-${++seq}`, timestamp: T(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'hi' }] },
})

/** `turns` question/answer pairs — 2 rows each, so >50 turns exceeds the slim
 *  projection's 100-row tail (the cap this route must not inherit). */
function turnLines(turns: number, tag: string): unknown[] {
  const out: unknown[] = []
  for (let i = 0; i < turns; i++) {
    out.push(userLine(`${tag} Q${i}`))
    out.push(asstLine(`${tag} A${i}`))
  }
  return out
}

/** Write a conversation's chat-history store directly, so entry timestamps (which
 *  decide the pre-lane cut) are exact instead of "whenever the test ran". */
async function writeChatHistory(convId: string, entries: ChatEntry[]): Promise<void> {
  const store: ChatHistoryStore = {
    version: 2,
    lastUpdated: new Date().toISOString(),
    compactionCount: 0,
    compactionSummary: null,
    entries,
  }
  const file = conversationFile('general', convId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(store))
}

async function readChatHistoryEntries(convId: string): Promise<ChatEntry[]> {
  try {
    const raw = await fs.readFile(conversationFile('general', convId), 'utf-8')
    return (JSON.parse(raw) as ChatHistoryStore).entries ?? []
  } catch {
    return [] // never written = empty, which is the state this asserts
  }
}

const userEntry = (text: string, timestamp: string): ChatEntry =>
  ({ tag: 'ai', role: 'user', content: text, displayText: text, timestamp })
const asstEntry = (text: string, timestamp: string): ChatEntry =>
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

describe('lane-bound conversation (empty chat history)', () => {
  it("serves the lane session's transcript, and pages it the same way", async () => {
    const convId = await createConv()
    const sessionId = 'lane-messages-sid-1'
    await seedLaneSession(convId, sessionId)
    await writeJsonl(sessionId, [
      userLine('first question'),
      asstLine('first answer'),
      userLine('second question'),
      toolLine('tu-1'),
      toolResultLine('tu-1'),
      asstLine('final answer'),
    ])

    // Precondition: chat-history for this conversation really is empty, so
    // everything below can only have come from the lane transcript.
    expect(await readChatHistoryEntries(convId)).toEqual([])

    const all = await getMessages(convId, '?limit=50')
    expect(all.map((m) => `${m.role}:${m.kind ?? 'text'}:${m.text}`)).toEqual([
      'user:text:first question',
      'assistant:text:first answer',
      'user:text:second question',
      'assistant:tool:Bash',
      'assistant:text:final answer',
    ])
    // Positional ids — the cursor space the iOS client pages back through.
    expect(all.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
    // The tool row keeps the additive card fields the mobile shape carries.
    const tool = all[3]
    expect(tool.detail).toContain('echo hi')
    expect(tool.resultPreview).toContain('hi')
    // createdAt is NON-OPTIONAL in the iOS model — one missing key fails the
    // whole array's decode and the conversation renders empty.
    expect(all.every((m) => typeof m.createdAt === 'string' && m.createdAt.length > 0)).toBe(true)

    // Tail window: the most recent `limit`, oldest-first.
    const tail = await getMessages(convId, '?limit=2')
    expect(tail.map((m) => m.id)).toEqual(['m3', 'm4'])

    // …and one page back from that tail's first id.
    const older = await getMessages(convId, '?limit=2&before=m3')
    expect(older.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(older.map((m) => m.text)).toEqual(['first answer', 'second question'])

    // The oldest page is short, which is how the client learns there is no more.
    const oldest = await getMessages(convId, '?limit=2&before=m1')
    expect(oldest.map((m) => m.id)).toEqual(['m0'])
  }, 30_000)

  it('keeps every id pointing at the same message while the lane grows', async () => {
    const convId = await createConv()
    const sessionId = 'lane-messages-sid-growth'
    await seedLaneSession(convId, sessionId)
    // 60 turns = 120 rows: comfortably past the slim projection's 100-row tail,
    // which is exactly the cap that made ids mean a different message per build.
    const lines = turnLines(60, 'g')
    await writeJsonl(sessionId, lines, Date.UTC(2026, 5, 1))

    const build1 = await getMessages(convId, '?limit=200')
    expect(build1).toHaveLength(120)
    expect(build1[0].text).toBe('g Q0')
    expect(build1[119].text).toBe('g A59')

    // The first page the phone paints, and the cursor it will page back with.
    const page1 = await getMessages(convId, '?limit=50')
    expect(page1.map((m) => m.id)).toEqual(build1.slice(-50).map((m) => m.id))
    const cursor = page1[0].id // m70

    // The CLI answers two more turns between the two requests — the normal case.
    await writeJsonl(sessionId, [...lines, ...turnLines(2, 'h')], Date.UTC(2026, 5, 1) + 5_000)

    const build2 = await getMessages(convId, '?limit=200')
    expect(build2).toHaveLength(124)
    // ── The invariant: m0..m119 still mean the same messages ──
    expect(build2.slice(0, 120).map((m) => `${m.id}:${m.text}`))
      .toEqual(build1.map((m) => `${m.id}:${m.text}`))

    // ── loadOlder returns exactly the rows before the cursor, in both builds ──
    const older1 = await getMessages(convId, `?limit=50&before=${cursor}`)
    const older2 = await getMessages(convId, `?limit=50&before=${cursor}`)
    expect(older1.map((m) => m.id)).toEqual(older2.map((m) => m.id))
    expect(older1[older1.length - 1].id).toBe('m69')
    expect(older1).toHaveLength(50)
    expect(older1[0].id).toBe('m20')
    // …and NOTHING it returns is already on screen (the iOS client inserts the
    // reply without deduping, so an overlap is a visible duplicate).
    const shown = new Set(page1.map((m) => m.text))
    expect(older2.filter((m) => shown.has(m.text))).toEqual([])
  }, 40_000)

  it('includes an ARCHIVED lane, oldest session first', async () => {
    const convId = await createConv()
    // A `--resume` that answered "No conversation found" archives the record and
    // the next turn mints a fresh lane; the archived one holds the older turns.
    await seedLaneSession(convId, 'lane-archived-sid', {
      startedAt: '2026-02-01T00:00:00.000Z', archived: true,
    })
    await writeJsonl('lane-archived-sid', [
      userLine('before the break'),
      asstLine('answer before the break'),
    ], Date.UTC(2026, 1, 2))
    await seedLaneSession(convId, 'lane-live-sid', { startedAt: '2026-03-01T00:00:00.000Z' })
    await writeJsonl('lane-live-sid', [
      userLine('after the break'),
      asstLine('answer after the break'),
    ], Date.UTC(2026, 2, 2))

    const all = await getMessages(convId, '?limit=50')
    expect(all.map((m) => m.text)).toEqual([
      'before the break',
      'answer before the break',
      'after the break',
      'answer after the break',
    ])
    expect(all.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3'])
  }, 30_000)

  it('does not clip a long answer (the 4000-char projection clip is not for this surface)', async () => {
    const convId = await createConv()
    const sessionId = 'lane-messages-sid-long'
    const long = 'x'.repeat(9_000)
    await seedLaneSession(convId, sessionId)
    await writeJsonl(sessionId, [userLine('write a long one'), asstLine(long)], Date.UTC(2026, 6, 1))

    const all = await getMessages(convId, '?limit=50')
    expect(all[1].text).toHaveLength(9_000)
    expect(all[1].text.endsWith('…')).toBe(false)
  }, 30_000)

  it('puts pre-lane chat history first and never renders a lane-era copy twice', async () => {
    const convId = await createConv()
    const sessionId = 'lane-messages-sid-prefix'
    await writeChatHistory(convId, [
      userEntry('pre-lane question', '2026-01-05T00:00:00.000Z'),
      asstEntry('pre-lane answer', '2026-01-05T00:00:01.000Z'),
      // The copy runApiV1LaneTurn persists for a PHONE turn: it happened after the
      // lane existed, and the lane transcript already carries it.
      asstEntry('lane answer', '2026-04-05T00:00:00.000Z'),
    ])
    await seedLaneSession(convId, sessionId, { startedAt: '2026-02-01T00:00:00.000Z' })
    await writeJsonl(sessionId, [
      userLine('lane question'),
      asstLine('lane answer'),
    ], Date.UTC(2026, 3, 6))

    const all = await getMessages(convId, '?limit=50')
    expect(all.map((m) => m.text)).toEqual([
      'pre-lane question',
      'pre-lane answer',
      'lane question',
      'lane answer',
    ])
    // Exactly once, not twice.
    expect(all.filter((m) => m.text === 'lane answer')).toHaveLength(1)
  }, 30_000)

  it('renders the opening message ONCE, in the real write order', async () => {
    // PRODUCTION ORDER, and the order is the bug: the eager user persist
    // (api-v1.ts:1521 / chat.ts:894) runs BEFORE createSessionRecord stamps the
    // lane's startedAt, so that row is on the pre-lane side of the cutoff — while
    // the CLI, spawned WITH that text, writes it as its transcript's first row.
    const convId = await createConv()
    const sessionId = 'lane-messages-sid-firstturn'

    // 1. eager user persist (timestamp = now, BEFORE the record exists)
    await chatHistory.addUserMessage('plan my week', {
      displayText: 'plan my week', agentId: 'general', conversationId: convId,
    })
    // 2. the lane record is minted — startedAt = now, i.e. AFTER the row above
    await seedLaneSession(convId, sessionId)
    // 3. the CLI writes the turn, opening with the text it was spawned with
    await writeJsonl(sessionId, [
      userLine('plan my week'),
      asstLine('here is a plan'),
    ], Date.UTC(2026, 8, 1))
    // 4. the answer's compat copy lands in chat-history (after startedAt)
    await chatHistory.addAIMessages(
      [{ role: 'assistant', content: [{ type: 'text', text: 'here is a plan' }] }] as never,
      { agentId: 'general', conversationId: convId },
    )

    const all = await getMessages(convId, '?limit=50')
    expect(all.filter((m) => m.text === 'plan my week')).toHaveLength(1)
    expect(all.filter((m) => m.text === 'here is a plan')).toHaveLength(1)
    expect(all.map((m) => `${m.id}:${m.role}:${m.text}`)).toEqual([
      'm0:user:plan my week',
      'm1:assistant:here is a plan',
    ])
  }, 30_000)

  it('does not resurrect a conversation the user cleared', async () => {
    // "Clear conversation" empties chat-history and archives the lane with
    // archive_reason 'chat_cleared' — but never touches the CLI's JSONL. A reader
    // that takes every lane record hands the cleared transcript straight back.
    const convId = await createConv()
    await writeChatHistory(convId, [
      // A pre-clear compat copy that a stale git-synced store could still hold.
      userEntry('secret question', '2026-02-01T00:10:00.000Z'),
    ])
    await seedLaneSession(convId, 'lane-cleared-sid', {
      startedAt: '2026-02-01T00:00:00.000Z',
      lastActiveAt: '2026-02-01T00:20:00.000Z',
      archived: true,
      archiveReason: 'chat_cleared',
    })
    await writeJsonl('lane-cleared-sid', [
      userLine('secret question'),
      asstLine('secret answer'),
    ], Date.UTC(2026, 1, 2))
    // After the clear the user starts again: a brand-new lane.
    await seedLaneSession(convId, 'lane-after-clear-sid', { startedAt: '2026-03-01T00:00:00.000Z' })
    await writeJsonl('lane-after-clear-sid', [
      userLine('fresh question'),
      asstLine('fresh answer'),
    ], Date.UTC(2026, 2, 2))

    const all = await getMessages(convId, '?limit=50')
    expect(all.map((m) => m.text)).toEqual(['fresh question', 'fresh answer'])
  }, 30_000)

  it('serves the whole chat history while the lane has no transcript yet', async () => {
    // A lane record exists but its CLI has written nothing (the seconds after the
    // first send, or a spawn that never came up). No lane content exists, so
    // nothing can be double-rendered — cutting the history away here is what would
    // make the phone show an empty chat for a conversation it just posted to.
    const convId = await createConv()
    await writeChatHistory(convId, [
      userEntry('asked from the phone', '2026-05-01T00:00:00.000Z'),
      asstEntry('answered on the phone', '2026-05-01T00:00:01.000Z'),
    ])
    await seedLaneSession(convId, 'lane-messages-sid-no-jsonl', {
      startedAt: '2026-04-01T00:00:00.000Z', // BEFORE both rows: a pure time cut drops them
    })
    // Deliberately no writeJsonl.

    const all = await getMessages(convId, '?limit=50')
    expect(all.map((m) => m.text)).toEqual(['asked from the phone', 'answered on the phone'])
  }, 30_000)
})

describe('conversation with NO lane session', () => {
  it('serves chat history unchanged', async () => {
    const convId = await createConv()
    await chatHistory.addUserMessage('phone question', {
      displayText: 'phone question', agentId: 'general', conversationId: convId,
    })
    await chatHistory.addAIMessages(
      [{ role: 'assistant', content: [{ type: 'text', text: 'phone answer' }] }] as never,
      { agentId: 'general', conversationId: convId },
    )

    const msgs = await getMessages(convId, '?limit=50')
    // Exact entries, keys included: this is the pre-change output byte for byte.
    expect(msgs).toEqual([
      { id: 'm0', role: 'user', text: 'phone question', createdAt: expect.any(String) },
      { id: 'm1', role: 'assistant', text: 'phone answer', createdAt: expect.any(String) },
    ])
  }, 30_000)
})

describe('the primary side of the cloud relay', () => {
  it('answers server.chat.messages through the real control-relay dispatch', async () => {
    const convId = await createConv()
    const sessionId = 'lane-messages-sid-relay'
    await seedLaneSession(convId, sessionId)
    await writeJsonl(sessionId, [
      userLine('relayed question'),
      asstLine('relayed answer'),
    ], Date.UTC(2026, 7, 1))

    // The REAL dispatch a replica's bridge frame lands in — not a hand-rolled call.
    const reply = await handleSessionControlRelay('server.chat.messages', '__server__', {
      agentId: 'general', conversationId: convId, limit: 50,
    })
    expect(reply.ok).toBe(true)
    const result = (reply as { ok: true; result: Record<string, unknown> }).result
    expect(result.source).toBe('lane')
    expect(result.known).toBe(true)
    expect((result.messages as V1Message[]).map((m) => m.text))
      .toEqual(['relayed question', 'relayed answer'])
    // Same body the route serves, so the two boxes cannot drift.
    expect(result.messages).toEqual(await getMessages(convId, '?limit=50'))

    // An agentId the direct route would refuse is refused here too.
    const bad = await handleSessionControlRelay('server.chat.messages', '__server__', {
      agentId: 'NOT valid', conversationId: convId, limit: 50,
    })
    expect((bad as { ok: true; result: Record<string, unknown> }).result)
      .toEqual({ messages: [], source: 'chat-history', known: false })
  }, 30_000)
})

describe('duplicate rows in the conversation index', () => {
  it('lists one row per id (the newest) and warns once', async () => {
    const convId = await createConv()
    const indexPath = conversationIndexFile('general')
    const index = JSON.parse(await fs.readFile(indexPath, 'utf-8')) as ConversationIndex
    const row = index.conversations.find((c) => c.id === convId)!
    row.title = 'Newer title'
    row.lastMessageAt = '2026-09-01T00:00:00.000Z'
    row.messageCount = 7
    // The stale twin a whole-file LWW merge can leave behind.
    index.conversations.push({
      ...row,
      title: 'Older title',
      lastMessageAt: '2026-08-01T00:00:00.000Z',
      messageCount: 2,
    })
    await fs.writeFile(indexPath, JSON.stringify(index))

    const warn = vi.spyOn(log.agent, 'warn')
    try {
      const res = await fetch(apiUrl('/api/v1/conversations?limit=200'))
      expect(res.status).toBe(200)
      const list = await res.json() as Array<{ id: string; title?: string; messageCount: number }>
      const mine = list.filter((c) => c.id === convId)
      expect(mine).toHaveLength(1)
      expect(mine[0].title).toBe('Newer title')
      expect(mine[0].messageCount).toBe(7)

      const dupWarn = warn.mock.calls.find(([msg]) => String(msg).includes('duplicate ids'))
      expect(dupWarn).toBeDefined()
      expect((dupWarn![1] as { duplicateIds: string[] }).duplicateIds).toContain(convId)
    } finally {
      warn.mockRestore()
    }
  }, 30_000)

  it('a rename lands on the row the list shows, not on the stale twin', async () => {
    const convId = await createConv()
    const indexPath = conversationIndexFile('general')
    const index = JSON.parse(await fs.readFile(indexPath, 'utf-8')) as ConversationIndex
    const row = index.conversations.find((c) => c.id === convId)!
    row.title = 'Winner'
    row.lastMessageAt = '2026-09-02T00:00:00.000Z'
    // The OLD twin is written FIRST in file order — a plain find() picks it, which
    // is how a rename used to land on the invisible row and the title oscillated.
    index.conversations = [
      { ...row, title: 'Loser', lastMessageAt: '2026-07-02T00:00:00.000Z' },
      ...index.conversations,
    ]
    await fs.writeFile(indexPath, JSON.stringify(index))

    await renameConversation('general', convId, 'Renamed by the user')

    const res = await fetch(apiUrl('/api/v1/conversations?limit=200'))
    const list = await res.json() as Array<{ id: string; title?: string }>
    const mine = list.filter((c) => c.id === convId)
    expect(mine).toHaveLength(1)
    expect(mine[0].title).toBe('Renamed by the user')
    // The write also healed the file, so the twin cannot come back.
    const after = JSON.parse(await fs.readFile(indexPath, 'utf-8')) as ConversationIndex
    expect(after.conversations.filter((c) => c.id === convId)).toHaveLength(1)
  }, 30_000)

  it('carries isMain and pinned over from a dropped twin', async () => {
    // Both are STICKY facts about the conversation, and only the loser row happens
    // to carry them. Deleting that row would retire the agent's main conversation
    // (nothing recreates isMain) and silently un-pin the chat.
    const convId = await createConv()
    const indexPath = conversationIndexFile('general')
    const index = JSON.parse(await fs.readFile(indexPath, 'utf-8')) as ConversationIndex
    const row = index.conversations.find((c) => c.id === convId)!
    row.title = 'Winner'
    row.lastMessageAt = '2026-09-03T00:00:00.000Z'
    row.isMain = false
    row.pinned = false
    index.conversations = [
      { ...row, title: 'Loser', lastMessageAt: '2026-07-03T00:00:00.000Z', isMain: true, pinned: true },
      ...index.conversations,
    ]
    await fs.writeFile(indexPath, JSON.stringify(index))

    // The READ agrees before any write happens. Asserted through listConversations
    // rather than the HTTP list because the frozen v1 projection does not carry
    // either flag — and this is about the two paths agreeing, not about the wire.
    const shown = (await listConversations('general')).filter((c) => c.id === convId)
    expect(shown).toHaveLength(1)
    expect(shown[0].isMain).toBe(true)
    expect(shown[0].pinned).toBe(true)

    // …and the write that collapses the twins persists both flags.
    await renameConversation('general', convId, 'Still main')
    const after = JSON.parse(await fs.readFile(indexPath, 'utf-8')) as ConversationIndex
    const survivors = after.conversations.filter((c) => c.id === convId)
    expect(survivors).toHaveLength(1)
    expect(survivors[0].title).toBe('Still main')
    expect(survivors[0].isMain).toBe(true)
    expect(survivors[0].pinned).toBe(true)
  }, 30_000)
})

describe('unknown conversation', () => {
  it('still 404s with the frozen error shape', async () => {
    const res = await fetch(apiUrl('/api/v1/conversations/conv-00000000-0000-0000-0000-000000000000/messages'))
    expect(res.status).toBe(404)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('not_found')
  }, 30_000)
})
