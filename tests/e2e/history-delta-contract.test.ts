/**
 * E2E for the `GET /api/sessions/:id/history?since=` delta contract.
 *
 * Real: Express server, route, session record store, session-history parsing, the
 * whale byte-ceiling degradation to a bounded sliding window. Mocked: constants
 * (temp dirs) only — no CLI needed, the JSONL is written directly.
 *
 * The two defects this pins, both measured in production:
 *
 *  1. inc-1785993576822 — a 55.8 MB transcript exceeded the byte ceiling, so every
 *     read served a 4 MiB SLIDING tail. The route treated that window's length as a
 *     monotonic cursor and sliced by count, so as the head was evicted the newest
 *     messages were silently omitted — including the user's own echo, leaving their
 *     bubble pinned at the bottom of the timeline forever.
 *  2. inc-1785965937858 — the delta claimed the synced prefix was immutable. It is
 *     not: an Agent/Task row gains `bgTaskFinished` from a task-notification the CLI
 *     appends up to a minute later. The client's frozen copy never gained the flag,
 *     so that agent's lane blocks never got absorption proof.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-delta'))
// The real '__local__' daemon expands `~/.claude` via its own process HOME, so it can't
// see fixtures written under the MOCKED CLAUDE_HOME — which is why the sibling e2e
// (session-history-enhanced.test.ts) reads empty history on HEAD too. This double
// serves __local__ from the real fs with the tilde rewritten to the mocked home, so the
// route, parser and byte-ceiling degradation are all exercised for real.
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME, CLAUDE_HOME, SESSIONS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { encodeProjectPath } from '../../src/core/session-history.js'

const CWD = '/Users/test/delta-project'
let server: HttpServer
let port: number
const prevLimit = process.env.WALNUT_MAX_FILE_READ_BYTES

interface HistoryRow {
  msgId?: string
  role?: string
  text?: string
  unsettled?: boolean
  tools?: { toolUseId?: string; bgTaskFinished?: boolean }[]
}

interface HistoryResponse {
  messages: HistoryRow[]
  revisedMessages?: HistoryRow[]
  total?: number
  cursor?: number
  delta?: boolean
}

async function history(sessionId: string, qs = ''): Promise<HistoryResponse> {
  const res = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/history${qs}`)
  expect(res.status).toBe(200)
  return res.json() as Promise<HistoryResponse>
}

async function writeJsonl(sessionId: string, lines: unknown[]) {
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

async function seedRecord(sessionId: string) {
  let existing: { version: number; sessions: unknown[] } = { version: 2, sessions: [] }
  try { existing = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf-8')) } catch { /* first write */ }
  existing.sessions.push({
    claudeSessionId: sessionId, taskId: 'delta-task', project: 'test',
    process_status: 'stopped', mode: 'default',
    startedAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-01T01:00:00Z',
    messageCount: 1, cwd: CWD,
  })
  await fs.mkdir(path.dirname(SESSIONS_FILE), { recursive: true })
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(existing))
}

let seq = 0
const user = (text: string, min = 0) => ({
  type: 'user', uuid: `u-${++seq}`,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString(),
  message: { role: 'user', content: text },
})
const asst = (text: string, min = 0) => ({
  type: 'assistant', uuid: `a-${++seq}`,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, min, 30)).toISOString(),
  message: { role: 'assistant', id: `msg_${seq}`, content: [{ type: 'text', text }] },
})
/** An assistant turn that launches a background Agent — the mutable-prefix shape. */
const asstAgent = (toolUseId: string, min: number) => ({
  type: 'assistant', uuid: `a-${++seq}`,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString(),
  message: {
    role: 'assistant', id: `msg_agent_${toolUseId}`,
    content: [
      { type: 'text', text: 'launching an agent' },
      { type: 'tool_use', id: toolUseId, name: 'Agent', input: { prompt: 'go', run_in_background: true } },
    ],
  },
})
const toolResult = (toolUseId: string, min: number) => ({
  type: 'user', uuid: `tr-${++seq}`,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'agent launched' }] },
})
/** The late completion proof the CLI appends when the agent finally stops. */
const taskNotification = (toolUseId: string, min: number) => ({
  type: 'user', uuid: `tn-${++seq}`,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString(),
  message: {
    role: 'user',
    content: `<task-notification><tool-use-id>${toolUseId}</tool-use-id><status>completed</status></task-notification>`,
  },
})

function padding(count: number): unknown[] {
  const out: unknown[] = []
  for (let i = 0; i < count; i++) {
    out.push(user(`old question ${i} ${'x'.repeat(200)}`, i))
    out.push(asst(`old answer ${i} ${'y'.repeat(200)}`, i))
  }
  return out
}

const SIDS = ['e2e-whale', 'e2e-whale-anchored', 'e2e-small', 'e2e-agent-late', 'e2e-agent-settled', 'e2e-agent-empty-delta']

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  // Records must exist BEFORE startServer — the server migrates sessions.json into
  // SQLite at boot, so a record written afterwards is invisible and /history 404s.
  for (const sid of SIDS) await seedRecord(sid)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
}, 60_000)

afterAll(async () => {
  await stopServer()
  if (prevLimit === undefined) delete process.env.WALNUT_MAX_FILE_READ_BYTES
  else process.env.WALNUT_MAX_FILE_READ_BYTES = prevLimit
})

describe('history delta contract — sliding window (inc-1785993576822)', () => {
  it('refuses an anchorless delta on a windowed read, and the full payload keeps the newest messages', async () => {
    const sid = 'e2e-whale'
    await writeJsonl(sid, [...padding(60), user('the newest question', 90), asst('the newest answer', 91)])
    process.env.WALNUT_MAX_FILE_READ_BYTES = '4096'

    const full = await history(sid)
    expect(full.delta).toBe(false)
    // The window is a strict subset of the file — that gap is what made the count lossy.
    expect(full.messages.length).toBeLessThan(122)
    // And it holds what the user is actually looking at.
    expect(full.messages.map(m => m.text)).toContain('the newest question')

    // THE BUG: this exact request used to be served as `slice(since)` on a moving
    // window, silently omitting the tail. It must now decline to a full rebuild.
    const anchorless = await history(sid, `?since=${full.cursor}`)
    expect(anchorless.delta).toBe(false)
    expect(anchorless.messages.map(m => m.text)).toContain('the newest question')
  })

  it('an anchored delta resolves by identity and reports a client-anchored cursor', async () => {
    const sid = 'e2e-whale-anchored'
    await writeJsonl(sid, [...padding(60), user('question A', 90), asst('answer A', 91)])
    process.env.WALNUT_MAX_FILE_READ_BYTES = '4096'

    const full = await history(sid)
    const counts = new Map<string, number>()
    for (const m of full.messages) if (m.msgId) counts.set(m.msgId, (counts.get(m.msgId) ?? 0) + 1)
    let anchorMsgId: string | undefined
    let anchorTail = 0
    for (let i = full.messages.length - 1; i >= 0; i--) {
      const id = full.messages[i].msgId
      if (id && counts.get(id) === 1) { anchorMsgId = id; anchorTail = full.messages.length - 1 - i; break }
    }
    expect(anchorMsgId).toBeDefined()

    const delta = await history(
      sid,
      `?since=${full.messages.length}&anchorMsgId=${encodeURIComponent(anchorMsgId!)}&anchorTail=${anchorTail}`,
    )
    expect(delta.delta).toBe(true)
    // Nothing new appended, so an empty slice — and the cursor must be what the
    // CLIENT will measure, not the server's own window length. Echoing the server
    // total is what made the client's consistency guard tautological.
    expect(delta.messages).toHaveLength(0)
    expect(delta.cursor).toBe(full.messages.length)
  })

  it('a normal (non-windowed) session still gets count-based deltas', async () => {
    const sid = 'e2e-small'
    await writeJsonl(sid, [user('hi', 0), asst('hello', 0)])
    delete process.env.WALNUT_MAX_FILE_READ_BYTES

    const full = await history(sid)
    expect(full.delta).toBe(false)
    const delta = await history(sid, `?since=${full.cursor}`)
    expect(delta.delta).toBe(true)
    expect(delta.messages).toHaveLength(0)
  })
})

describe('history delta contract — mutable prefix (inc-1785965937858)', () => {
  it('re-sends an in-flight Agent row once its late completion proof lands', async () => {
    const sid = 'e2e-agent-late'
    delete process.env.WALNUT_MAX_FILE_READ_BYTES
    const TOOL = 'toolu_late_agent'

    // Client syncs while the agent is still running: the row exists, its tool_result
    // is launch metadata, and there is NO task-notification yet.
    await writeJsonl(sid, [user('run an agent', 0), asstAgent(TOOL, 1), toolResult(TOOL, 2)])
    const synced = await history(sid)
    const agentRow = synced.messages.find(m => m.tools?.some(t => t.toolUseId === TOOL))
    if (!agentRow) {
      throw new Error(`no agent row. parsed=${JSON.stringify(synced.messages, null, 1)}`)
    }
    expect(agentRow.tools!.find(t => t.toolUseId === TOOL)!.bgTaskFinished).toBeFalsy()
    // The server must TELL us this row can still change — that flag is how the client
    // knows to re-ask. Without it the client has no way to detect a frozen prefix.
    expect(agentRow.unsettled).toBe(true)

    // The agent finishes much later; the CLI appends the notification, and the next
    // turn appends too. Under the old contract the client only ever received the new
    // turn and its frozen Agent row stayed unfinished forever.
    await writeJsonl(sid, [
      user('run an agent', 0), asstAgent(TOOL, 1), toolResult(TOOL, 2),
      taskNotification(TOOL, 3), user('next question', 4), asst('next answer', 5),
    ])

    const counts = new Map<string, number>()
    for (const m of synced.messages) if (m.msgId) counts.set(m.msgId, (counts.get(m.msgId) ?? 0) + 1)
    let anchorMsgId: string | undefined
    let anchorTail = 0
    for (let i = synced.messages.length - 1; i >= 0; i--) {
      const id = synced.messages[i].msgId
      if (id && counts.get(id) === 1) { anchorMsgId = id; anchorTail = synced.messages.length - 1 - i; break }
    }

    // The client re-asks for the ids it flagged unsettled — this is the request the
    // old contract had no way to express.
    const reviseIds = synced.messages.filter(m => m.unsettled && m.msgId).map(m => m.msgId!)
    expect(reviseIds).toContain(agentRow.msgId)

    const qs = [
      `since=${synced.messages.length}`,
      ...(anchorMsgId ? [`anchorMsgId=${encodeURIComponent(anchorMsgId)}`, `anchorTail=${anchorTail}`] : []),
      `revise=${reviseIds.map(encodeURIComponent).join(',')}`,
    ].join('&')
    const delta = await history(sid, `?${qs}`)

    if (delta.delta) {
      // THE FIX: the revised row carries the flag the client's copy is missing.
      const revisedAgent = delta.revisedMessages?.find(m => m.tools?.some(t => t.toolUseId === TOOL))
      if (!revisedAgent) {
        throw new Error(`no revised agent row. revise=${reviseIds} delta=${JSON.stringify(delta, null, 1)}`)
      }
      expect(revisedAgent.tools!.find(t => t.toolUseId === TOOL)!.bgTaskFinished).toBe(true)
      // And it must no longer be flagged, so the client stops re-asking.
      expect(revisedAgent.unsettled).toBeFalsy()
    } else {
      // A full rebuild also delivers the flag — the other acceptable outcome.
      const rebuilt = delta.messages.find(m => m.tools?.some(t => t.toolUseId === TOOL))
      expect(rebuilt!.tools!.find(t => t.toolUseId === TOOL)!.bgTaskFinished).toBe(true)
    }
  })

  it('delivers the revision even when the turn appended NOTHING new', async () => {
    // The common shape for a background agent: it finishes while the transcript gains
    // only the (hidden) task-notification, so the delta slice is EMPTY. If the client
    // only applied revisions alongside new messages, this — the most frequent case —
    // would still leave the row frozen.
    const sid = 'e2e-agent-empty-delta'
    delete process.env.WALNUT_MAX_FILE_READ_BYTES
    const TOOL = 'toolu_empty_delta_agent'

    await writeJsonl(sid, [user('run an agent', 0), asstAgent(TOOL, 1), toolResult(TOOL, 2)])
    const synced = await history(sid)
    const before = synced.messages.find(m => m.tools?.some(t => t.toolUseId === TOOL))!
    expect(before.unsettled).toBe(true)

    // Only the notification is appended — it renders as no new visible row.
    await writeJsonl(sid, [
      user('run an agent', 0), asstAgent(TOOL, 1), toolResult(TOOL, 2), taskNotification(TOOL, 3),
    ])

    const delta = await history(sid, `?since=${synced.messages.length}&revise=${encodeURIComponent(before.msgId!)}`)
    expect(delta.delta).toBe(true)
    expect(delta.messages).toHaveLength(0)
    const revised = delta.revisedMessages?.find(m => m.tools?.some(t => t.toolUseId === TOOL))
    expect(revised).toBeDefined()
    expect(revised!.tools!.find(t => t.toolUseId === TOOL)!.bgTaskFinished).toBe(true)
  })

  it('a settled prefix does NOT bloat the delta with revisions', async () => {
    const sid = 'e2e-agent-settled'
    delete process.env.WALNUT_MAX_FILE_READ_BYTES
    const TOOL = 'toolu_settled_agent'

    // Agent already proven finished before the client synced.
    await writeJsonl(sid, [
      user('run an agent', 0), asstAgent(TOOL, 1), toolResult(TOOL, 2), taskNotification(TOOL, 3),
    ])
    const synced = await history(sid)
    await writeJsonl(sid, [
      user('run an agent', 0), asstAgent(TOOL, 1), toolResult(TOOL, 2), taskNotification(TOOL, 3),
      user('next question', 4), asst('next answer', 5),
    ])

    const delta = await history(sid, `?since=${synced.messages.length}`)
    expect(delta.delta).toBe(true)
    expect(delta.revisedMessages ?? []).toHaveLength(0)
    expect(delta.messages.length).toBeGreaterThan(0)
  })
})
