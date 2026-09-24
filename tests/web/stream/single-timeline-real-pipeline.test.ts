/**
 * REAL-PIPELINE evidence-contract tests for the single-timeline model.
 *
 * The unit suites (stream-reducer / render-filter / promote-blocks) hand-craft
 * BOTH sides of the absorption match. These tests close that gap: a REAL
 * server (startServer + MockDaemon + mock Claude CLI) produces the WS stream
 * events AND the persisted history (real JSONL parser), and the REAL frontend
 * pure modules (stream-reducer, render-filter) consume them — proving the
 * parser's msgId/toolUseId shapes match the filter's evidence keys.
 * Dialect note: history is parsed from the STREAM-CAPTURE JSONL
 * (SESSION_STREAMS_DIR fallback — same parser, same code path); the canonical
 * ~/.claude/projects dialect is byte-identical for assistant lines per the
 * plan's verified findings, but is not separately exercised here.
 *
 * Revert detector: the old destructive model deleted blocks at session:result
 * before history caught up. Instant 2 below (post-result, pre-history-fetch)
 * pins that the union still shows the streamed content exactly once.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-stl-real'))

import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../../helpers/mock-daemon.js'
import { SESSION_STREAMS_DIR } from '../../../src/constants.js'
import fsp from 'node:fs/promises'

// The REAL frontend modules under test (same imports the components use).
import {
  applyMainTextDelta,
  appendMainThinking,
  appendToolCall,
  backfillToolResult,
  flushMainTextBuffer,
  appendLaneText,
  appendSystemBlock,
  type StreamingBlock,
} from '@/stream/stream-reducer'
import { computeRenderFilter, buildHistoryEvidence } from '@/stream/render-filter'
import type { SessionHistoryMessage } from '@/types/session'

const MOCK_CLI = path.resolve(import.meta.dirname, '../../providers/mock-claude.mjs')

let server: HttpServer
let port = 0
let daemon: MockDaemon

interface WsFrame {
  type: string
  id?: string
  name?: string
  data?: Record<string, unknown>
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 10_000)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsFrame
      if (frame.type === 'res' && frame.id === id) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

/** Collect every event frame; resolve once a session:result arrives. */
function collectUntilResult(ws: WebSocket, timeoutMs = 20_000): Promise<WsFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: WsFrame[] = []
    const timer = setTimeout(() => reject(new Error('timed out waiting for session:result')), timeoutMs)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsFrame
      if (frame.type !== 'event') return
      frames.push(frame)
      if (frame.name === 'session:result') {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frames)
      }
    }
    ws.on('message', handler)
  })
}

/**
 * Mirror useSessionStream's event handling through the REAL reducer functions.
 * Returns append-only blocks plus the completedLen stamped at result — exactly
 * the state the render filter sees in the component.
 *
 * NOTE: this is a test-local MIRROR of the hook's dispatch (the pure reducer +
 * filter modules are the real imports; the hook's React wiring is not executed
 * here). Hook-layer regressions are covered by the Playwright real-pipeline
 * specs (tests/e2e/browser/single-timeline-real-pipeline.spec.ts).
 */
function reduceEvents(frames: WsFrame[], sessionId: string): { blocks: StreamingBlock[]; completedLen: number } {
  let blocks: StreamingBlock[] = []
  let textBuffer = ''
  let completedLen = 0
  for (const f of frames) {
    const d = f.data ?? {}
    if (d.sessionId !== sessionId) continue
    switch (f.name) {
      case 'session:text-delta': {
        if (d.parentToolUseId) {
          blocks = appendLaneText(blocks, {
            delta: String(d.delta ?? ''),
            msgId: d.msgId as string | undefined,
            parentToolUseId: String(d.parentToolUseId),
          })
        } else {
          const r = applyMainTextDelta(blocks, textBuffer, String(d.delta ?? ''), d.msgId as string | undefined, completedLen)
          blocks = r.blocks
          textBuffer = r.textBuffer
        }
        break
      }
      case 'session:thinking-delta': {
        blocks = flushMainTextBuffer(blocks, textBuffer, completedLen)
        textBuffer = ''
        blocks = appendMainThinking(blocks, String(d.delta ?? ''), d.msgId as string | undefined, completedLen)
        break
      }
      case 'session:tool-use': {
        blocks = flushMainTextBuffer(blocks, textBuffer, completedLen)
        textBuffer = ''
        blocks = appendToolCall(blocks, {
          toolUseId: String(d.toolUseId),
          toolName: String(d.toolName ?? 'Tool'),
          input: d.input as Record<string, unknown> | undefined,
        })
        break
      }
      case 'session:tool-result': {
        blocks = backfillToolResult(blocks, String(d.toolUseId), String(d.result ?? ''), Boolean(d.isError))
        break
      }
      case 'session:system-event': {
        blocks = flushMainTextBuffer(blocks, textBuffer, completedLen)
        textBuffer = ''
        blocks = appendSystemBlock(blocks, {
          variant: d.variant as 'compact' | 'error' | 'info',
          message: String(d.message ?? ''),
          detail: d.detail as string | undefined,
          progress: d.progress as boolean | undefined,
          uuid: d.uuid as string | undefined,
        })
        break
      }
      case 'session:result': {
        blocks = flushMainTextBuffer(blocks, textBuffer, completedLen)
        textBuffer = ''
        completedLen = blocks.length
        break
      }
    }
  }
  return { blocks, completedLen }
}

/**
 * Publish the MockDaemon's captured CLI output to SESSION_STREAMS_DIR — the
 * exact directory the production daemon writes its stream capture to and the
 * history route's local fallback reads from. The BYTES are the real mock-CLI
 * stdout; only the directory differs (MockDaemon keeps its own tmpDir), so
 * this is transport plumbing, not fixture authorship: the REAL parser still
 * parses REAL CLI output.
 *
 * MUST be called before fetchHistory: without it the history route finds no
 * JSONL and returns [] forever — the absorption assertions then time out
 * looking exactly like a render-filter bug when it's a missing-plumbing bug.
 */
async function publishStreamsFile(sid: string): Promise<void> {
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
  const content = await fsp.readFile(daemon.streamFilePath(sid), 'utf-8')
  await fsp.writeFile(path.join(SESSION_STREAMS_DIR, `${sid}.jsonl`), content)
}

async function fetchHistory(sessionId: string): Promise<SessionHistoryMessage[]> {
  const res = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/history`)
  expect(res.status).toBe(200)
  const body = await res.json() as { messages: SessionHistoryMessage[] }
  return body.messages ?? []
}

/** Occurrences of `marker` across the visible union (history + unhidden blocks). */
function countInUnion(
  marker: string,
  messages: SessionHistoryMessage[],
  blocks: StreamingBlock[],
  hidden: Set<number>,
): number {
  let n = 0
  for (const m of messages) {
    if (typeof m.text === 'string') n += m.text.split(marker).length - 1
  }
  blocks.forEach((b, i) => {
    if (hidden.has(i)) return
    if ((b.type === 'text' || b.type === 'thinking') && b.content.includes(marker)) n++
  })
  return n
}

/** Same, for system notices (history text + visible system blocks). */
function countSystemInUnion(
  marker: string,
  messages: SessionHistoryMessage[],
  blocks: StreamingBlock[],
  hidden: Set<number>,
): number {
  let n = 0
  for (const m of messages) {
    if (m.role === 'system' && typeof m.text === 'string') n += m.text.split(marker).length - 1
  }
  blocks.forEach((b, i) => {
    if (hidden.has(i)) return
    if (b.type === 'system' && b.message.includes(marker)) n++
  })
  return n
}

beforeAll(async () => {
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  await new Promise((r) => setTimeout(r, 1500))
}, 30_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
})

describe('single-timeline real pipeline — evidence contract', () => {
  it('B1: streamed text is visible exactly once at all three instants; real-parser msgId twin hides the block', async () => {
    const MARKER = 'Hello, world!'
    const ws = await connectWs()
    const collected = collectUntilResult(ws)
    const rpc = await sendWsRpc(ws, 'session:start', {
      taskId: 'stl-task-b1', message: 'stream-partial-thinking-then-text', project: 'Walnut',
    })
    expect((rpc as Record<string, unknown>).ok).toBe(true)

    const frames = await collected
    ws.close()
    const resultFrame = frames.find((f) => f.name === 'session:result')!
    const sid = String(resultFrame.data!.sessionId)
    expect(sid).toBeTruthy()

    // ── Instant 1: mid-deltas (replay a prefix of the frames; history empty) ──
    const resultIdx = frames.indexOf(resultFrame)
    const midFrames = frames.slice(0, resultIdx) // everything before result
    const mid = reduceEvents(midFrames, sid)
    {
      // While streaming: live tail is protected; nothing hidden; one copy max.
      const { hidden } = computeRenderFilter({
        blocks: mid.blocks, messages: [], watermark: 0, isStreaming: true,
      })
      expect(hidden.size).toBe(0)
      expect(countInUnion(MARKER, [], mid.blocks, hidden)).toBe(1)
    }

    // ── Instant 2: post-result, PRE-history — the revert detector. The old
    // model had already DELETED the blocks here (count 0 until history landed). ──
    const full = reduceEvents(frames, sid)
    expect(full.blocks.length).toBeGreaterThanOrEqual(mid.blocks.length) // append-only
    {
      const { hidden } = computeRenderFilter({
        blocks: full.blocks, messages: [], watermark: 0, isStreaming: false,
      })
      expect(hidden.size).toBe(0) // no evidence yet → nothing hidden
      expect(countInUnion(MARKER, [], full.blocks, hidden)).toBe(1)
    }

    // ── Instant 3: real history fetched — msgId twin absorbs the text block. ──
    // Poll: the archive flush is async after result.
    await publishStreamsFile(sid)
    let messages: SessionHistoryMessage[] = []
    let hidden = new Set<number>()
    for (let i = 0; i < 30; i++) {
      messages = await fetchHistory(sid)
      const r = computeRenderFilter({
        blocks: full.blocks, messages, watermark: 0, isStreaming: false,
        historyEvidence: buildHistoryEvidence(messages),
      })
      hidden = r.hidden
      const textIdx = full.blocks.findIndex((b) => b.type === 'text' && b.content.includes(MARKER))
      if (textIdx >= 0 && hidden.has(textIdx)) break
      await new Promise((r2) => setTimeout(r2, 300))
    }
    const textIdx = full.blocks.findIndex((b) => b.type === 'text' && b.content.includes(MARKER))
    expect(textIdx).toBeGreaterThanOrEqual(0)
    // THE contract: the real parser's msgId matches the streamed msgId.
    expect(hidden.has(textIdx)).toBe(true)
    // Union still exactly one copy (now the persisted one).
    expect(countInUnion(MARKER, messages, full.blocks, hidden)).toBe(1)
    // The streamed text block carried a real msg_… id (id evidence, not content fallback).
    const textBlock = full.blocks[textIdx] as { msgId?: string }
    expect(textBlock.msgId).toMatch(/^msg_/)
  }, 40_000)

  it('B2: tool_call block absorbed via the real parser toolUseId twin; result backfilled', async () => {
    const ws = await connectWs()
    const collected = collectUntilResult(ws)
    const rpc = await sendWsRpc(ws, 'session:start', {
      taskId: 'stl-task-b2', message: 'tool-test', project: 'Walnut',
    })
    expect((rpc as Record<string, unknown>).ok).toBe(true)

    const frames = await collected
    ws.close()
    const resultFrame = frames.find((f) => f.name === 'session:result')!
    const sid = String(resultFrame.data!.sessionId)

    const { blocks } = reduceEvents(frames, sid)
    const toolIdx = blocks.findIndex((b) => b.type === 'tool_call' && b.toolUseId === 'toolu_mock_001')
    expect(toolIdx).toBeGreaterThanOrEqual(0)
    const tool = blocks[toolIdx] as { status: string; result?: string }
    expect(tool.status).toBe('done')
    expect(tool.result).toContain('File contents here')

    // Pre-history: kept visible.
    {
      const { hidden } = computeRenderFilter({ blocks, messages: [], watermark: 0, isStreaming: false })
      expect(hidden.has(toolIdx)).toBe(false)
    }

    // Post-history: hidden via toolUseId evidence from the REAL parser.
    await publishStreamsFile(sid)
    let absorbed = false
    for (let i = 0; i < 30; i++) {
      const messages = await fetchHistory(sid)
      const { hidden } = computeRenderFilter({
        blocks, messages, watermark: 0, isStreaming: false,
        historyEvidence: buildHistoryEvidence(messages),
      })
      if (hidden.has(toolIdx)) { absorbed = true; break }
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(absorbed).toBe(true)
  }, 40_000)

  it('B3: the compaction notice is absorbed by the real parser\'s system row — one "Context compacted", even after compaction wiped the surrounding evidence', async () => {
    // 2026-09-21, reported with a screenshot of the same compaction twice:
    //   Context compacted (493K → 44K tokens) · auto   ← the persisted row
    //   Continuation summary ›
    //   Context compacted  493K → 44K tokens · auto    ← the streamed notice
    // A notice has no msgId/toolUseId, so it could only be swept as a "pure-UI"
    // block, which needs every matchable block in the window to have matched.
    // Compaction is the one event that makes that permanently impossible: it
    // rewrites the transcript, so the blocks streamed before the boundary lose
    // the messages they would have matched. The notice now carries the CLI
    // boundary line's own uuid, which is exactly what the parser writes as the
    // system row's msgId — this test proves those two really are the same key.
    const ws = await connectWs()
    const collected = collectUntilResult(ws)
    const rpc = await sendWsRpc(ws, 'session:start', {
      taskId: 'stl-task-b3', message: 'compaction-test:3', project: 'Walnut',
    })
    expect((rpc as Record<string, unknown>).ok).toBe(true)

    const frames = await collected
    ws.close()
    const sid = String(frames.find((f) => f.name === 'session:result')!.data!.sessionId)

    const { blocks } = reduceEvents(frames, sid)
    // Three keep-alives plus the boundary collapsed to ONE row already (the
    // placeholder became the outcome in place).
    const notices = blocks.filter((b) => b.type === 'system' && b.variant === 'compact')
    expect(notices).toHaveLength(1)
    const noticeIdx = blocks.findIndex((b) => b.type === 'system' && b.variant === 'compact')
    const notice = blocks[noticeIdx] as { message: string; detail?: string; uuid?: string }
    expect(notice.message).toBe('Context compacted')
    expect(notice.detail).toBe('444K → 49K tokens · auto')
    // The id that makes absorption possible, straight off the CLI's line.
    expect(notice.uuid).toBe('mock-boundary-1')

    // Pre-history: the notice is the ONLY thing telling the user why the session
    // went quiet, so it must stay visible.
    {
      const { hidden } = computeRenderFilter({ blocks, messages: [], watermark: 0, isStreaming: false })
      expect(hidden.has(noticeIdx)).toBe(false)
    }

    await publishStreamsFile(sid)
    let messages: SessionHistoryMessage[] = []
    let hidden = new Set<number>()
    for (let i = 0; i < 30; i++) {
      messages = await fetchHistory(sid)
      const r = computeRenderFilter({
        blocks, messages, watermark: 0, isStreaming: false,
        historyEvidence: buildHistoryEvidence(messages),
      })
      hidden = r.hidden
      if (hidden.has(noticeIdx)) break
      await new Promise((r2) => setTimeout(r2, 300))
    }

    // The parser's row: same uuid as the streamed notice, and the SAME two
    // display pieces, so the surviving row reads identically to the live one.
    const sysRows = messages.filter((m) => m.role === 'system' && m.systemVariant === 'compact')
    expect(sysRows).toHaveLength(1)
    expect(sysRows[0].msgId).toBe('mock-boundary-1')
    expect(sysRows[0].text).toBe('Context compacted')
    expect(sysRows[0].systemDetail).toBe('444K → 49K tokens · auto')

    // THE contract: the streamed notice is hidden, so the event appears once.
    expect(hidden.has(noticeIdx)).toBe(true)
    expect(countSystemInUnion('Context compacted', messages, blocks, hidden)).toBe(1)

    // THE REPORTED STATE. A real post-compaction transcript keeps the boundary
    // and drops what came before it, so the pure-UI sweep can never fire again.
    // Absorption must not depend on it: id evidence alone has to carry the row.
    const compactedHistory = messages.filter((m) => m.role === 'system')
    const afterCompaction = computeRenderFilter({
      blocks, messages: compactedHistory, watermark: 0, isStreaming: false,
      historyEvidence: buildHistoryEvidence(compactedHistory),
    })
    expect(afterCompaction.hidden.has(noticeIdx)).toBe(true)
    expect(countSystemInUnion('Context compacted', compactedHistory, blocks, afterCompaction.hidden)).toBe(1)
    // …and the orphaned model text is still KEPT, never silently dropped.
    const textIdx = blocks.findIndex((b) => b.type === 'text' && b.content.includes('Context is nearly full'))
    expect(textIdx).toBeGreaterThanOrEqual(0)
    expect(afterCompaction.hidden.has(textIdx)).toBe(false)
  }, 40_000)
})
