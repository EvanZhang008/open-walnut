/**
 * `GET /api/v1/sessions/:id/stream` × ACTIVITY frame payloads: the two additive
 * preview fields.
 *
 * The bug this pins: a live `tool` frame carried `{ name, toolUseId, detail? }` and a
 * live `tool-result` frame carried `{ toolUseId }` alone, so tapping a FINISHED tool
 * row mid-turn on the phone showed "No output" for a tool that had produced output.
 * The row that does carry the text only exists once the transcript has been read.
 *
 * What is asserted here is the wire:
 *   - `tool` also carries `inputPreview` (the bounded, masked `key: value` render),
 *     while `detail` stays the collapsed one-liner it always was
 *   - `tool-result` also carries `resultPreview` (bounded to 700 + `…`, masked)
 *   - neither key is emitted when there is nothing to show
 *   - a subagent's activity (`parentToolUseId`) is still dropped for both kinds
 *
 * Same fixture style as api-v1-session-talk.test.ts: one real
 * `startServer({ port: 0, dev: true })` over an isolated temp home, bus events
 * published by hand. No CLI is ever spawned.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-sstream-activity'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'

const SID = 'sstream-activity-session-0001'

let server: HttpServer
let port: number

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`
}

// ── Minimal SSE client over fetch (same shape as api-v1-session-talk.test.ts's) ──

interface SseEvt { id?: number; event: string; data: Record<string, unknown> }
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
          let id: number | undefined
          let event = ''
          let data = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue // comment / ping
            if (line.startsWith('id: ')) id = Number(line.slice(4))
            else if (line.startsWith('event: ')) event = line.slice(7)
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
          if (!event) continue
          const evt: SseEvt = { id, event, data: data ? JSON.parse(data) : {} }
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
    waitFor: (pred, timeoutMs = 10_000) => {
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

function emitToolUse(input: Record<string, unknown> | undefined, toolUseId: string, extra: Record<string, unknown> = {}): void {
  bus.emit(EventNames.SESSION_TOOL_USE, {
    sessionId: SID, toolName: 'Bash', toolUseId, ...(input ? { input } : {}), ...extra,
  }, ['main-ai'], { source: 'session-runner' })
}

function emitToolResult(result: string | undefined, toolUseId: string, extra: Record<string, unknown> = {}): void {
  bus.emit(EventNames.SESSION_TOOL_RESULT, {
    sessionId: SID, toolUseId, ...(result === undefined ? {} : { result }), ...extra,
  }, ['main-ai'], { source: 'session-runner' })
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  await createSessionRecord(SID, 'task-sstream-activity', 'test-project', '/tmp', {
    title: 'session stream activity frames',
  })
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('session stream: tool / tool-result preview fields', () => {
  it('relays the input render alongside detail, and the result excerpt verbatim', async () => {
    const sse = await connectSse(apiUrl(`/api/v1/sessions/${SID}/stream`))
    try {
      await sse.waitFor((e) => e.event === 'snapshot')

      emitToolUse({ command: 'ls docs/', description: 'List docs' }, 'tu-preview-1')
      const tool = await sse.waitFor((e) => e.event === 'tool' && e.data.toolUseId === 'tu-preview-1')
      // `detail` is unchanged (Bash prefers `description`, which is why the command
      // itself needs the second field).
      expect(tool.data.detail).toBe('List docs')
      expect(tool.data.inputPreview).toBe('command: ls docs/\ndescription: List docs')
      expect(tool.data.inputPreview as string).toContain('ls docs/')

      emitToolResult('a.md\nb.md', 'tu-preview-1')
      const result = await sse.waitFor((e) => e.event === 'tool-result' && e.data.toolUseId === 'tu-preview-1')
      expect(result.data.resultPreview).toBe('a.md\nb.md')
    } finally {
      sse.close()
    }
  }, 20_000)

  it('bounds a long result and marks the cut', async () => {
    const sse = await connectSse(apiUrl(`/api/v1/sessions/${SID}/stream`))
    try {
      await sse.waitFor((e) => e.event === 'snapshot')
      emitToolResult('x'.repeat(5_000), 'tu-preview-big')
      const result = await sse.waitFor((e) => e.event === 'tool-result' && e.data.toolUseId === 'tu-preview-big')
      const preview = result.data.resultPreview as string
      expect(typeof preview).toBe('string')
      expect(preview.length).toBeLessThanOrEqual(701)
      expect(preview.endsWith('…')).toBe(true)
    } finally {
      sse.close()
    }
  }, 20_000)

  it('masks a credential in the relayed result', async () => {
    // A tool's OUTPUT leaks as readily as its input, and this frame crosses a LAN to
    // a phone. Same masker the history row uses.
    const accessKeyId = 'AKIA' + 'ZZ4EXAMPLE7DEMO99' // split so the repo scanner never sees a key-shaped literal
    const sse = await connectSse(apiUrl(`/api/v1/sessions/${SID}/stream`))
    try {
      await sse.waitFor((e) => e.event === 'snapshot')
      emitToolResult(`key=${accessKeyId}\npassword=hunter2abcdef\n`, 'tu-preview-secret')
      const result = await sse.waitFor((e) => e.event === 'tool-result' && e.data.toolUseId === 'tu-preview-secret')
      const preview = result.data.resultPreview as string
      expect(preview).toContain('[REDACTED]')
      expect(preview).not.toContain(accessKeyId)
      expect(preview).not.toContain('hunter2abcdef')
      const blob = JSON.stringify(sse.events)
      expect(blob).not.toContain(accessKeyId)
      expect(blob).not.toContain('hunter2abcdef')
    } finally {
      sse.close()
    }
  }, 20_000)

  it('omits both keys when there is nothing to show', async () => {
    // A present-but-empty key reads as "the tool produced an empty string", which is
    // a different claim from "this frame has no excerpt".
    const sse = await connectSse(apiUrl(`/api/v1/sessions/${SID}/stream`))
    try {
      await sse.waitFor((e) => e.event === 'snapshot')
      emitToolUse(undefined, 'tu-preview-bare')
      const tool = await sse.waitFor((e) => e.event === 'tool' && e.data.toolUseId === 'tu-preview-bare')
      expect('inputPreview' in tool.data).toBe(false)
      expect('detail' in tool.data).toBe(false)

      emitToolResult('   \n\t ', 'tu-preview-bare')
      const result = await sse.waitFor((e) => e.event === 'tool-result' && e.data.toolUseId === 'tu-preview-bare')
      expect(result.data).toEqual({ toolUseId: 'tu-preview-bare' })
      expect('resultPreview' in result.data).toBe(false)
    } finally {
      sse.close()
    }
  }, 20_000)

  it("still drops a subagent's activity for both kinds", async () => {
    const sse = await connectSse(apiUrl(`/api/v1/sessions/${SID}/stream`))
    try {
      await sse.waitFor((e) => e.event === 'snapshot')
      emitToolUse({ command: 'grep SUBAGENT-ONLY .' }, 'tu-preview-sub', { parentToolUseId: 'tu-task' })
      emitToolResult('SUBAGENT-OUTPUT-ONLY', 'tu-preview-sub', { parentToolUseId: 'tu-task' })
      // A main-lane pair AFTER the subagent's, so the assertion proves filtering
      // rather than a race against an event that had not arrived yet.
      emitToolUse({ command: 'echo main' }, 'tu-preview-main')
      await sse.waitFor((e) => e.event === 'tool' && e.data.toolUseId === 'tu-preview-main')

      const blob = JSON.stringify(sse.events)
      expect(blob).not.toContain('SUBAGENT-ONLY')
      expect(blob).not.toContain('SUBAGENT-OUTPUT-ONLY')
      expect(blob).not.toContain('tu-preview-sub')
    } finally {
      sse.close()
    }
  }, 20_000)
})
