/**
 * session:stream-subscribe reads the stream buffer just before it answers, after its own
 * awaits. A delta the server sent while the handler waited on the session lookup reached the
 * client before the answer, and the client takes the snapshot as holding everything it received
 * before it (web/src/stream/stream-reducer.ts accumulatorAfterSnapshot): a snapshot read before
 * the await left that delta out, and the column dropped it (2026-11-10 review).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

/** Runs inside the route's session lookup, before it returns. */
const duringLookup: { fn: ((sid: string) => void) | null } = { fn: null }
vi.mock('../../../src/core/session-tracker.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/session-tracker.js')>()
  return {
    ...orig,
    getSessionByClaudeId: async (sid: string) => {
      const record = await orig.getSessionByClaudeId(sid)
      duringLookup.fn?.(sid)
      return record
    },
  }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { sessionStreamBuffer } from '../../../src/web/session-stream-buffer.js'
import WebSocket from 'ws'

let server: HttpServer
let port: number

function rpcCall(ws: WebSocket, method: string, payload: unknown): Promise<unknown> {
  const id = `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 5_000)
    const handler = (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string; ok?: boolean; payload?: unknown; error?: string }
        if (msg.type === 'res' && msg.id === id) {
          ws.off('message', handler)
          clearTimeout(timeout)
          if (msg.ok) resolve(msg.payload)
          else reject(new Error(msg.error ?? 'RPC error'))
        }
      } catch { /* not this answer */ }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

describe('session:stream-subscribe reads the buffer after its lookup', () => {
  beforeAll(async () => {
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    server = await startServer({ port: 0, dev: true })
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
  }, 30_000)

  afterAll(async () => {
    duringLookup.fn = null
    await stopServer()
  })

  it('a delta appended while the lookup ran is in the answer', async () => {
    const sid = 'sid-subscribe-late-read-1'
    sessionStreamBuffer.markStreaming(sid)
    sessionStreamBuffer.appendTextDelta(sid, '## Findings ', 'msg_late_1')
    duringLookup.fn = (s) => { if (s === sid) sessionStreamBuffer.appendTextDelta(s, 'and more', 'msg_late_1') }
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
    try {
      const snapshot = await rpcCall(ws, 'session:stream-subscribe', { sessionId: sid }) as { blocks: Array<{ type: string; content?: string }> }
      const text = snapshot.blocks.filter((b) => b.type === 'text').map((b) => b.content).join('')
      expect(text).toBe('## Findings and more')
    } finally {
      duringLookup.fn = null
      ws.close()
    }
  })
})
