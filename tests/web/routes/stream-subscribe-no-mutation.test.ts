/**
 * Regression test for the "UI stuck at 'Walnut is working...'" bug where
 * the session:stream-subscribe RPC (frontend re-subscribe on every
 * status-changed event) mutated sessionStreamBuffer as a "defensive cleanup"
 * based on a stale DB record — clobbering a just-fired markStreaming from a
 * fresh resume within ~20ms.
 *
 * Root cause log (session 8953f3e8 on clouddev, 2026-04-29T05:54:28):
 *   .643  markStreaming
 *   .644  RPC session:stream-subscribe  (frontend resubscribed)
 *   .662  markDone wasStreaming=true blocksRetained=0  ← BUG
 *
 * Fix invariant: the RPC is READ-ONLY. Read-time correction returns
 * isStreaming=false to the caller when the DB record is terminal, but the
 * shared buffer state is never mutated by the RPC.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { sessionStreamBuffer } from '../../../src/web/session-stream-buffer.js'
import WebSocket from 'ws'

let server: HttpServer
let port: number

async function seedTask(taskId: string): Promise<void> {
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  const tasksFile = path.join(tasksDir, 'tasks.json')
  let store = { version: 1, tasks: [] as unknown[] }
  try {
    store = JSON.parse(await fs.readFile(tasksFile, 'utf-8'))
  } catch { /* first run */ }
  if (!store.tasks.find((t: { id?: string }) => t.id === taskId)) {
    store.tasks.push({
      id: taskId,
      title: `Stream subscribe test ${taskId}`,
      status: 'todo',
      phase: 'IN_PROGRESS',
      priority: 'immediate',
      project: 'StreamSubscribe',
      session_ids: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      description: '',
    })
    await fs.writeFile(tasksFile, JSON.stringify(store, null, 2))
  }
}

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
      } catch { /* ignore non-JSON or unrelated frames */ }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

async function openWs(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return ws
}

describe('session:stream-subscribe RPC — read-only invariant', () => {
  beforeAll(async () => {
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    server = await startServer({ port: 0, dev: true })
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
  }, 30_000)

  afterAll(async () => {
    await stopServer()
  })

  beforeEach(() => {
    // Reset buffer state between tests. We tap into the private `streaming`
    // Set and `buffers` Map directly because the public API (markDone/clear)
    // is designed to be called from lifecycle events only; a test-only
    // reset helper doesn't exist.
    const anyBuffer = sessionStreamBuffer as unknown as { streaming: Set<string>; buffers: Map<string, unknown> }
    anyBuffer.streaming.clear()
    anyBuffer.buffers.clear()
  })

  it('does NOT mutate buffer isStreaming when DB record is stale-terminal', async () => {
    const sid = 'sid-stale-terminal-1'
    const taskId = 'task-stale-1'
    await seedTask(taskId)

    // Seed session record with stale terminal status (mimics resume race:
    // last turn's stopped record hasn't been overwritten yet when the fresh
    // markStreaming fires for the new turn).
    await createSessionRecord(sid, taskId, 'StreamSubscribe', undefined, { mode: 'bypass' })
    await updateSessionRecord(sid, { process_status: 'stopped' })

    // Fresh resume has just marked the buffer streaming.
    sessionStreamBuffer.markStreaming(sid)
    expect((sessionStreamBuffer as unknown as { streaming: Set<string> }).streaming.has(sid)).toBe(true)

    // Frontend re-subscribes (what happens on every status-changed).
    const ws = await openWs()
    try {
      const resp = await rpcCall(ws, 'session:stream-subscribe', { sessionId: sid })
      const snapshot = resp as { blocks: unknown[]; isStreaming: boolean }

      // Read-time correction: RPC returns isStreaming=false because DB is terminal.
      expect(snapshot.isStreaming).toBe(false)

      // CRITICAL: the shared buffer state is UNCHANGED.
      // A subsequent JSONL event must still see isStreaming=true so downstream
      // broadcasts append correctly and the fresh turn keeps streaming.
      //
      // We inspect the private `streaming` Set instead of calling getSnapshot()
      // because getSnapshot() applies the same read-time correction the RPC
      // returns — using it here would defeat the test. The only way to prove
      // the shared state is untouched is to look at the raw Set directly.
      expect((sessionStreamBuffer as unknown as { streaming: Set<string> }).streaming.has(sid)).toBe(true)
    } finally {
      ws.close()
    }
  })

  it('returns isStreaming=false for idle between turns without mutating the buffer', async () => {
    const sid = 'sid-idle-between-turns-1'
    const taskId = 'task-idle-between-turns-1'
    await seedTask(taskId)

    await createSessionRecord(sid, taskId, 'StreamSubscribe', undefined, {
      mode: 'bypass',
      initialProcessStatus: 'idle',
    })
    sessionStreamBuffer.markStreaming(sid)

    const ws = await openWs()
    try {
      const resp = await rpcCall(ws, 'session:stream-subscribe', { sessionId: sid })
      const snapshot = resp as { blocks: unknown[]; isStreaming: boolean }

      expect(snapshot.isStreaming).toBe(false)
      expect((sessionStreamBuffer as unknown as { streaming: Set<string> }).streaming.has(sid)).toBe(true)
    } finally {
      ws.close()
    }
  })

  it('does NOT mutate buffer isStreaming when stale-running (>5min since last change)', async () => {
    const sid = 'sid-stale-running-1'
    const taskId = 'task-stale-run-1'
    await seedTask(taskId)

    await createSessionRecord(sid, taskId, 'StreamSubscribe', undefined, { mode: 'bypass' })
    // Ancient last_status_change — simulates orphaned running session.
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    await updateSessionRecord(sid, { process_status: 'running', last_status_change: tenMinAgo })

    sessionStreamBuffer.markStreaming(sid)
    expect((sessionStreamBuffer as unknown as { streaming: Set<string> }).streaming.has(sid)).toBe(true)

    const ws = await openWs()
    try {
      const resp = await rpcCall(ws, 'session:stream-subscribe', { sessionId: sid })
      const snapshot = resp as { blocks: unknown[]; isStreaming: boolean }

      // Read-time correction applied.
      expect(snapshot.isStreaming).toBe(false)

      // Buffer untouched.
      expect((sessionStreamBuffer as unknown as { streaming: Set<string> }).streaming.has(sid)).toBe(true)
    } finally {
      ws.close()
    }
  })

  it('returns isStreaming=true when DB record is running and fresh', async () => {
    const sid = 'sid-fresh-running-1'
    const taskId = 'task-fresh-run-1'
    await seedTask(taskId)

    await createSessionRecord(sid, taskId, 'StreamSubscribe', undefined, { mode: 'bypass' })
    await updateSessionRecord(sid, {
      process_status: 'running',
      last_status_change: new Date().toISOString(),
    })

    sessionStreamBuffer.markStreaming(sid)

    const ws = await openWs()
    try {
      const resp = await rpcCall(ws, 'session:stream-subscribe', { sessionId: sid })
      const snapshot = resp as { blocks: unknown[]; isStreaming: boolean }
      expect(snapshot.isStreaming).toBe(true)
      expect((sessionStreamBuffer as unknown as { streaming: Set<string> }).streaming.has(sid)).toBe(true)
    } finally {
      ws.close()
    }
  })

  it('returns isStreaming=false when buffer was never marked streaming', async () => {
    const sid = 'sid-cold-1'
    const taskId = 'task-cold-1'
    await seedTask(taskId)

    await createSessionRecord(sid, taskId, 'StreamSubscribe', undefined, { mode: 'bypass' })

    const ws = await openWs()
    try {
      const resp = await rpcCall(ws, 'session:stream-subscribe', { sessionId: sid })
      const snapshot = resp as { blocks: unknown[]; isStreaming: boolean }
      expect(snapshot.isStreaming).toBe(false)
      expect(snapshot.blocks).toEqual([])
    } finally {
      ws.close()
    }
  })
})
