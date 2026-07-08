/**
 * REGRESSION: daemon-reconnect 'running' must NOT mark the stream buffer
 * streaming (inc-1783406628291 — fake "Streaming" badge with hours-old blocks
 * during an SSH-down window).
 *
 * recoverDisconnectedSessions() emits session:status-changed ps='running'
 * with source 'daemon-reconnect' for every alive-but-non-idle session on every
 * reconnect. That means "the CLI process exists", not "a turn is producing
 * output" — but the server's status-changed handler treated any 'running' as
 * markStreaming. During connection flapping (reconnect ~every 30-60s) the
 * buffer's streaming flag was re-armed forever: snapshots returned
 * isStreaming=true with stale blocks, and no turn-end ever cleared it because
 * no turn was running.
 *
 * Invariant: only a genuine turn signal (source 'session-runner') turns the
 * streaming flag on; 'daemon-reconnect' running is reconciliation metadata.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { sessionStreamBuffer } from '../../../src/web/session-stream-buffer.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'

let server: HttpServer

const streamingSet = (): Set<string> =>
  (sessionStreamBuffer as unknown as { streaming: Set<string> }).streaming

/** Emit and give the async bus handler a tick to run. */
async function emitStatus(sid: string, ps: string, source: string): Promise<void> {
  bus.emit(EventNames.SESSION_STATUS_CHANGED, {
    sessionId: sid,
    taskId: `task-${sid}`,
    process_status: ps,
  }, ['*'], { source: source as never, urgency: 'urgent' })
  await new Promise(r => setTimeout(r, 50))
}

describe('session:status-changed running — source gating', () => {
  beforeAll(async () => {
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    server = await startServer({ port: 0, dev: true })
    void server
  }, 30_000)

  afterAll(async () => {
    await stopServer()
  })

  beforeEach(() => {
    streamingSet().clear()
    const anyBuffer = sessionStreamBuffer as unknown as { buffers: Map<string, unknown> }
    anyBuffer.buffers.clear()
  })

  it("daemon-reconnect 'running' does NOT set the streaming flag (the incident)", async () => {
    const sid = 'sid-reconnect-noop'
    await createSessionRecord(sid, `task-${sid}`, 'proj')

    await emitStatus(sid, 'running', 'daemon-reconnect')
    expect(streamingSet().has(sid)).toBe(false)
    expect(sessionStreamBuffer.getSnapshot(sid).isStreaming).toBe(false)
  })

  it("session-runner 'running' DOES set the streaming flag (real turn)", async () => {
    const sid = 'sid-runner-real'
    await createSessionRecord(sid, `task-${sid}`, 'proj')

    await emitStatus(sid, 'running', 'session-runner')
    expect(streamingSet().has(sid)).toBe(true)
  })

  it('reconnect flap after a real turn ended stays not-streaming', async () => {
    const sid = 'sid-flap'
    await createSessionRecord(sid, `task-${sid}`, 'proj')

    // Real turn ran and ended. The idle markDone is DEFERRED inside
    // MARK_DONE_DEDUP_MS (500ms) of the last markStreaming (intentional
    // stopped→running flicker protection) — wait it out before asserting.
    await emitStatus(sid, 'running', 'session-runner')
    await new Promise(r => setTimeout(r, 600))
    await emitStatus(sid, 'idle', 'session-runner')
    expect(streamingSet().has(sid)).toBe(false)

    // SSH flapping: reconnect reconciliation fires 'running' repeatedly.
    await emitStatus(sid, 'running', 'daemon-reconnect')
    await emitStatus(sid, 'running', 'daemon-reconnect')
    expect(streamingSet().has(sid)).toBe(false)
    expect(sessionStreamBuffer.getSnapshot(sid).isStreaming).toBe(false)
  })
})
