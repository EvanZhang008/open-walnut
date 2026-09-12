/**
 * The main chat's REASONING and TOOL rows must SURVIVE the turn that produced them.
 *
 * The report: on the phone's main chat (the Personal AI conversation, not a coding
 * session) a reasoning row and a tool row show up while the turn runs, and both
 * disappear the moment it ends. The live rows ride the conversation's SSE channel
 * (`thinking`, `tool`, `tool-result` frames — api-v1-lane-activity.test.ts pins the
 * wire); the rows the phone keeps come from a REFETCH of
 * GET /api/v1/conversations/:id/messages right after `message-end`. So "it vanishes
 * at turn end" is one question about TWO surfaces, and no test spanned them: the
 * activity test never reads the history back, and api-v1-lane-messages.test.ts hand-
 * writes a JSONL without ever running a turn.
 *
 * That gap is exactly where the defect can hide: the turn's own write path is what
 * runs between the two reads (runApiV1LaneTurn persists a TEXT-ONLY compat copy of
 * the answer into chat-history), and the assembly then has to prefer the CLI's
 * transcript, drop the duplicated copies, and keep the kind rows.
 *
 * What each case pins:
 *  - a turn that reasoned and called a tool leaves `kind:'thinking'` and
 *    `kind:'tool'` rows in the persisted read, on the DEFAULT read — no query flag
 *    (this endpoint has no `rich=1`, deliberately; see the api-v1 doc). Gating them
 *    later would reproduce the report on every client that didn't add the flag.
 *  - the answer and the user's own text appear EXACTLY ONCE each: the compat copy
 *    and the eager user row must not double a turn that the transcript already has.
 *  - ONE vocabulary for both surfaces: the same JSONL read as a CHAT conversation
 *    and as a CODING SESSION transcript (`/sessions/:id/transcript?fresh=1&rich=1`)
 *    yields the same kind rows with the same field values. The user's requirement is
 *    "use the same set of things", so a second shape for the chat surface is a bug
 *    even when both render.
 *  - paging still holds with kind rows present: two pages neither overlap nor skip,
 *    and an id keeps meaning the same row while the lane grows. Kind rows change how
 *    many rows a turn contributes (4 here, not 2), which is where an off-by-one in
 *    the positional cursor space would surface.
 *
 * Real: Express server (startServer), the api-v1 router + its SSE channel, the
 * conversation registry, chat-history, the session record store, the lane mint
 * (a real record with a real lane key), and the whole transcript read pipeline
 * (buildSessionTranscript → readSessionHistoryTail → DaemonFileReader →
 * parseSessionMessages) against JSONL on disk. Mocked: constants (temp dirs), the
 * '__local__' daemon file reader (in production it expands `~/.claude` via its own
 * process HOME and so cannot see fixtures under the mocked CLAUDE_HOME), and the
 * session runner — a fake that answers the turn from a script and writes the JSONL
 * a real `claude` CLI would write, so no CLI is ever spawned.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-lane-history-activity'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME, CLAUDE_HOME, CONFIG_FILE } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import { markProcessing, removeProcessed } from '../../../src/core/session-message-queue.js'
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../../src/core/session-history.js'
import type { SessionStartEvent, SessionSendEvent } from '../../../src/core/event-types.js'

let server: HttpServer
let port: number

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

/** The mobile message shape (api-v1.ts ApiV1Message), as the wire carries it. */
interface V1Message {
  id: string
  role: string
  text: string
  createdAt?: string
  kind?: string
  detail?: string
  inputPreview?: string
  resultPreview?: string
  thinkingText?: string
  /** Opaque handle for the on-demand full-text read; present only when the row's
   *  excerpt had to cut something. */
  detailRef?: string
  agent?: string
}

/** The session-transcript shape (session-projection.ts ProjectedTranscriptMessage). */
interface V1TranscriptRow {
  role: string
  text: string
  timestamp: string
  kind?: string
  detail?: string
  inputPreview?: string
  resultPreview?: string
  thinkingText?: string
  /** Opaque handle for the on-demand full-text read; present only when the row's
   *  excerpt had to cut something. */
  detailRef?: string
  agent?: string
}

// ── JSONL fixtures: the lines a real CLI writes for one reasoning + tool turn ──

let seq = 0
const THINKING = 'The lockfile is the suspect.\nI should read it before answering.'
const TOOL_INPUT = { command: 'echo hi', description: 'Say hi' }
/** Past the reasoning excerpt's cap, so the row has text left to fetch on demand. */
const LONG_THINKING = 'The dependency graph churns on every install. '.repeat(60)
/** Past the result preview's cap, for the same reason on the tool side. */
const LONG_RESULT = 'warn: rebuilding a package that did not change\n'.repeat(40)

function userLine(text: string): unknown {
  return { type: 'user', uuid: `u-${++seq}`, timestamp: new Date().toISOString(), message: { role: 'user', content: text } }
}
function thinkingAndToolLine(toolUseId: string): unknown {
  return {
    type: 'assistant', uuid: `a-${++seq}`, timestamp: new Date().toISOString(),
    message: {
      role: 'assistant', id: `msg-${seq}`,
      content: [
        { type: 'thinking', thinking: THINKING },
        { type: 'tool_use', id: toolUseId, name: 'Bash', input: TOOL_INPUT },
      ],
    },
  }
}
function toolResultLine(toolUseId: string, content = 'hi'): unknown {
  return {
    type: 'user', uuid: `tr-${++seq}`, timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  }
}
/** A message whose reasoning AND whose tool output both exceed their excerpt caps,
 *  so both rows carry the on-demand full-text handle (`detailRef`). */
function clippedActivityLine(toolUseId: string): unknown {
  return {
    type: 'assistant', uuid: `a-${++seq}`, timestamp: new Date().toISOString(),
    message: {
      role: 'assistant', id: `msg-${seq}`,
      content: [
        { type: 'thinking', thinking: LONG_THINKING },
        { type: 'tool_use', id: toolUseId, name: 'Grep', input: { pattern: 'rebuild', path: 'packages/' } },
      ],
    },
  }
}
function asstLine(text: string): unknown {
  return {
    type: 'assistant', uuid: `t-${++seq}`, timestamp: new Date().toISOString(),
    message: { role: 'assistant', id: `msg-${seq}`, content: [{ type: 'text', text }] },
  }
}

/** `~/.claude/projects/<encoded cwd>/<sid>.jsonl` — what the reader resolves. */
function jsonlPath(sessionId: string, cwd: string): string {
  return path.join(CLAUDE_HOME, 'projects', encodeProjectPath(cwd), `${sessionId}.jsonl`)
}

/** `mtimeMs` is explicit where a file is rewritten: the reader caches parses by
 *  mtime, so two writes inside one millisecond would serve the first parse twice. */
async function writeJsonl(sessionId: string, cwd: string, lines: unknown[], mtimeMs?: number): Promise<void> {
  const file = jsonlPath(sessionId, cwd)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  if (mtimeMs !== undefined) await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs))
}

// ── Fake session runner: answers the turn AND writes the transcript ──

const ANSWER_DELAY_MS = 60
const LANE_REPLY = 'the lane answered'
const inFlightDrains = new Set<Promise<void>>()
/** Session ids the fake runner was asked to start, in order. */
let startedSessionIds: string[] = []

function drainQueue(sessionId: string): void {
  const p = (async () => {
    try {
      const batch = await markProcessing(sessionId)
      if (batch.length > 0) await removeProcessed(sessionId, batch.map((m) => m.id))
    } catch { /* the store may be torn down between tests */ }
  })()
  inFlightDrains.add(p)
  void p.finally(() => inFlightDrains.delete(p))
}

/**
 * Stands in for the CLI: writes the JSONL, marks the record SPAWNED, puts the
 * turn's activity on the bus, then answers.
 *
 * The pid/outputFile stamp is not decoration. A freshly minted lane record carries
 * `status_reason:'awaiting_spawn'` with no pid and no outputFile, and both reads
 * short-circuit on that (isPreSpawnSession) because a CLI that never came up has
 * nothing to read. A real spawn persists pid + outputFile; skipping it here would
 * make this test pass or fail for a reason production never sees.
 */
function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    let sid: string | undefined
    let cwd = WALNUT_HOME
    if (event.name === EventNames.SESSION_START) {
      const d = event.data as SessionStartEvent
      sid = d.preassignedSessionId
      cwd = d.cwd || WALNUT_HOME
    } else if (event.name === EventNames.SESSION_SEND) {
      sid = (event.data as SessionSendEvent).sessionId
    }
    if (!sid) return
    const sessionId = sid
    startedSessionIds.push(sessionId)
    drainQueue(sessionId)
    setTimeout(() => {
      void (async () => {
        const toolUseId = `toolu_${startedSessionIds.length}`
        // The CLI is spawned WITH the user's text, so it writes that turn whole.
        await writeJsonl(sessionId, cwd, [
          userLine('why is the build slow?'),
          thinkingAndToolLine(toolUseId),
          toolResultLine(toolUseId),
          clippedActivityLine(`${toolUseId}-long`),
          toolResultLine(`${toolUseId}-long`, LONG_RESULT),
          asstLine(LANE_REPLY),
        ])
        await updateSessionRecord(sessionId, {
          pid: process.pid,
          outputFile: jsonlPath(sessionId, cwd),
        })
        const targets = ['main-ai']
        bus.emit(EventNames.SESSION_THINKING_DELTA, { sessionId, delta: THINKING, msgId: 'msg_t' },
          targets, { source: 'session-runner', urgency: 'urgent' })
        bus.emit(EventNames.SESSION_TOOL_USE, { sessionId, toolName: 'Bash', toolUseId, input: TOOL_INPUT },
          targets, { source: 'session-runner' })
        bus.emit(EventNames.SESSION_TOOL_RESULT, { sessionId, toolUseId, result: 'hi' },
          targets, { source: 'session-runner' })
        bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId, delta: LANE_REPLY },
          targets, { source: 'session-runner', urgency: 'urgent' })
        bus.emit(EventNames.SESSION_RESULT, { sessionId, result: LANE_REPLY, isError: false },
          ['main-ai', 'session-runner'], { source: 'session-runner' })
      })()
    }, ANSWER_DELAY_MS)
  })
}

// ── Minimal SSE client (same shape as api-v1-lane-activity.test.ts's) ──

interface SseEvt { event: string; data: Record<string, unknown> }
interface SseConn {
  events: SseEvt[]
  waitFor: (pred: (e: SseEvt) => boolean, timeoutMs?: number) => Promise<SseEvt>
  close: () => void
}

async function connectSse(url: string): Promise<SseConn> {
  const controller = new AbortController()
  const res = await fetch(url, { signal: controller.signal })
  if (res.status !== 200 || !res.body) {
    controller.abort()
    throw new Error(`SSE connect failed: ${res.status}`)
  }
  const events: SseEvt[] = []
  const waiters: Array<{ pred: (e: SseEvt) => boolean; resolve: (e: SseEvt) => void }> = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          let event = ''
          let data = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue // comment / ping
            if (line.startsWith('event: ')) event = line.slice(7)
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
          if (!event) continue
          const evt: SseEvt = { event, data: data ? JSON.parse(data) as Record<string, unknown> : {} }
          events.push(evt)
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].pred(evt)) {
              waiters[i].resolve(evt)
              waiters.splice(i, 1)
            }
          }
        }
      }
    } catch { /* aborted */ }
  })()
  return {
    events,
    waitFor: (pred, timeoutMs = 15_000) => {
      const existing = events.find(pred)
      if (existing) return Promise.resolve(existing)
      return new Promise<SseEvt>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SSE waitFor timed out')), timeoutMs)
        waiters.push({ pred, resolve: (e) => { clearTimeout(timer); resolve(e) } })
      })
    },
    close: () => controller.abort(),
  }
}

// ── HTTP helpers ──

async function createConv(): Promise<string> {
  const res = await fetch(apiUrl('/api/v1/conversations'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })
  expect(res.status).toBe(201)
  return (await res.json() as { id: string }).id
}

async function getMessages(convId: string, qs = ''): Promise<V1Message[]> {
  const res = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages${qs}`))
  expect(res.status).toBe(200)
  return await res.json() as V1Message[]
}

async function getSessionTranscript(sessionId: string): Promise<V1TranscriptRow[]> {
  const res = await fetch(apiUrl(`/api/v1/sessions/${sessionId}/transcript?fresh=1&rich=1`))
  expect(res.status).toBe(200)
  return (await res.json() as { messages: V1TranscriptRow[] }).messages
}

/** Bind a record to a conversation's lane WITHOUT the pre-spawn latch — these
 *  fixtures have transcripts, so they must read like a session whose CLI came up. */
async function seedLaneSession(convId: string, sessionId: string, cwd: string): Promise<void> {
  await createSessionRecord(sessionId, '', '', cwd, {
    title: 'Lane session',
    lane: `chat:general:${convId}`,
    initialProcessStatus: 'idle',
  })
  await updateSessionRecord(sessionId, { pid: process.pid, outputFile: jsonlPath(sessionId, cwd) })
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'Ada' },
    defaults: { priority: 'none', platform: 'local' },
    provider: { type: 'claude-code' },
    agent: { provider: 'claude-code' },
  }), 'utf-8')
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  installFakeRunner() // displaces the real runner by name
}, 60_000)

afterAll(async () => {
  await Promise.all([...inFlightDrains]).catch(() => {})
  await stopServer()
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a finished turn keeps its reasoning and tool rows', () => {
  it('shows them live on the SSE channel AND in the persisted read afterwards', async () => {
    startedSessionIds = []
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const posted = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'why is the build slow?' }),
      })
      expect(posted.status).toBe(202)
      await sse.waitFor((e) => e.event === 'message-end')

      // ── While the turn ran: the live frames the phone draws its activity from ──
      expect(sse.events.some((e) => e.event === 'thinking' && typeof e.data.delta === 'string')).toBe(true)
      expect(sse.events.some((e) => e.event === 'tool' && e.data.name === 'Bash')).toBe(true)
      expect(sse.events.some((e) => e.event === 'tool-result')).toBe(true)

      // ── After it ended: the SAME two rows, on the DEFAULT read (no flag) ──
      const rows = await getMessages(convId, '?limit=50')
      const kinds = rows.map((m) => `${m.role}:${m.kind ?? 'text'}`)
      expect(kinds).toContain('assistant:thinking')
      expect(kinds).toContain('assistant:tool')

      // Pinned by TEXT, not by position: the fixture has a second reasoning row
      // and a second tool row (the clipped pair the next case needs), and an
      // index here would silently start asserting about the wrong one.
      const thinking = rows.find((m) => m.kind === 'thinking'
        && m.text.startsWith('The lockfile is the suspect'))!
      // Collapsed one-liner in `text`, the fuller excerpt behind it — the two
      // fields a client needs to render a row that expands on tap.
      expect(thinking.text).toBe('The lockfile is the suspect. I should read it before answering.')
      expect(thinking.thinkingText).toBe(THINKING)

      const tool = rows.find((m) => m.kind === 'tool' && m.text === 'Bash')!
      expect(tool.text).toBe('Bash')
      expect(tool.detail).toContain('Say hi')      // `detail` prefers the description…
      expect(tool.inputPreview).toContain('echo hi') // …so the command lives here.
      expect(tool.resultPreview).toContain('hi')

      // ── And the turn's own writes did not double anything ──
      // runApiV1LaneTurn persists a text-only compat copy of the answer, and the
      // route eagerly persists the user's text before the lane exists. Both are
      // already in the CLI's transcript, so each must render exactly once.
      expect(rows.filter((m) => m.text === LANE_REPLY)).toHaveLength(1)
      expect(rows.filter((m) => m.role === 'user' && m.text === 'why is the build slow?')).toHaveLength(1)

      // createdAt is NON-OPTIONAL in the iOS model: one missing key fails the
      // whole array's decode and the conversation renders EMPTY.
      expect(rows.every((m) => typeof m.createdAt === 'string' && m.createdAt.length > 0)).toBe(true)
    } finally {
      sse.close()
    }
  }, 60_000)

  it('describes the rows with the same vocabulary a coding session uses', async () => {
    // Same JSONL, both surfaces: the chat read (this conversation) and the session
    // transcript read the phone already renders for a coding session. A second
    // shape for the chat surface would force a second renderer on the client.
    const sessionId = startedSessionIds[0]
    expect(sessionId).toBeTruthy()
    const convId = (await (await fetch(apiUrl('/api/v1/conversations?limit=50'))).json() as Array<{ id: string }>)[0].id

    const chatRows = (await getMessages(convId, '?limit=50')).filter((m) => m.kind === 'tool' || m.kind === 'thinking')
    const sessionRows = (await getSessionTranscript(sessionId)).filter((m) => m.kind === 'tool' || m.kind === 'thinking')

    const shape = (m: V1Message | V1TranscriptRow) => ({
      role: m.role,
      kind: m.kind,
      text: m.text,
      detail: m.detail,
      inputPreview: m.inputPreview,
      resultPreview: m.resultPreview,
      thinkingText: m.thinkingText,
      agent: m.agent,
      // Included on purpose: the on-demand full-text handle is anchored on the
      // MESSAGE id plus the tool's index inside that message, never on the row's
      // position in the tail — so the same row read through either surface must
      // hand the client the same token. Anchoring it on a sliding position would
      // make the phone's drawer open a different tool's text depending on which
      // read it came from, and only a cross-surface comparison can see that.
      detailRef: m.detailRef,
    })
    expect(chatRows.length).toBeGreaterThan(0)
    expect(chatRows.map(shape)).toEqual(sessionRows.map(shape))

    // …and the comparison is not vacuous: the fixture's clipped pair really does
    // carry a ref (present = "there is more to fetch"), while the short rows,
    // whose excerpt is the whole text, carry none.
    const clipped = chatRows.filter((m) => typeof m.detailRef === 'string' && m.detailRef.length > 0)
    expect(clipped.map((m) => m.kind).sort()).toEqual(['thinking', 'tool'])
    expect(clipped.find((m) => m.kind === 'tool')!.text).toBe('Grep')
    expect(clipped.find((m) => m.kind === 'thinking')!.text)
      .toContain('The dependency graph churns on every install.')
    // The short rows: excerpt == whole text, so there is nothing to offer.
    expect(chatRows.find((m) => m.text === 'Bash')!.detailRef).toBeUndefined()
    expect(chatRows.find((m) => m.text.startsWith('The lockfile is the suspect'))!.detailRef)
      .toBeUndefined()
  }, 60_000)
})

describe('paging with reasoning and tool rows present', () => {
  /** One turn = 4 rows (user, thinking, tool, answer) — not 2, which is the point. */
  function turnLines(turns: number, tag: string): unknown[] {
    const out: unknown[] = []
    for (let i = 0; i < turns; i++) {
      out.push(userLine(`${tag} Q${i}`))
      out.push(thinkingAndToolLine(`${tag}-tu-${i}`))
      out.push(toolResultLine(`${tag}-tu-${i}`))
      out.push(asstLine(`${tag} A${i}`))
    }
    return out
  }

  it('never overlaps or skips a row across two pages, and keeps ids stable as the lane grows', async () => {
    const convId = await createConv()
    const sessionId = 'lane-history-paging-sid'
    const cwd = path.join(WALNUT_HOME, 'paging-lane')
    await seedLaneSession(convId, sessionId, cwd)
    const lines = turnLines(20, 'p') // 20 turns → 80 rows
    await writeJsonl(sessionId, cwd, lines, Date.UTC(2026, 5, 1))

    const all = await getMessages(convId, '?limit=200')
    expect(all).toHaveLength(80)
    expect(all.filter((m) => m.kind === 'thinking')).toHaveLength(20)
    expect(all.filter((m) => m.kind === 'tool')).toHaveLength(20)

    // The first page the phone paints, then one page back from its oldest id.
    const page1 = await getMessages(convId, '?limit=50')
    expect(page1.map((m) => m.id)).toEqual(all.slice(-50).map((m) => m.id))
    const cursor = page1[0].id
    const page2 = await getMessages(convId, `?limit=50&before=${cursor}`)

    // No overlap (the iOS client inserts a page without deduping, so an overlap is
    // a visible duplicate) and no gap: the two pages are one contiguous slice.
    const shown = new Set(page1.map((m) => m.id))
    expect(page2.filter((m) => shown.has(m.id))).toEqual([])
    expect([...page2, ...page1].map((m) => m.id)).toEqual(all.map((m) => m.id))

    // Two more turns arrive; every id the phone is holding still means its row.
    await writeJsonl(sessionId, cwd, [...lines, ...turnLines(2, 'q')], Date.UTC(2026, 5, 1) + 5_000)
    const grown = await getMessages(convId, '?limit=200')
    expect(grown).toHaveLength(88)
    expect(grown.slice(0, 80).map((m) => `${m.id}:${m.kind ?? 'text'}:${m.text}`))
      .toEqual(all.map((m) => `${m.id}:${m.kind ?? 'text'}:${m.text}`))
    const olderAgain = await getMessages(convId, `?limit=50&before=${cursor}`)
    expect(olderAgain.map((m) => m.id)).toEqual(page2.map((m) => m.id))
  }, 60_000)
})
