/**
 * Cloud REPLICA host resolution for the v1 session talk endpoints — the
 * 2026-09-11 defect: a coding session started 2026-08-09 and stopped for more
 * than STOPPED_RETENTION_DAYS (14) is NOT in the git-synced projection, so the
 * replica answered its own local `404 Session not found` (6ms, no bridge hop)
 * on the first send, seconds after relaying `detail` and `model-options` for
 * that same session successfully.
 *
 * The projection is a bounded LIST projection ("what to show") and was being
 * used as an EXISTENCE oracle ("does it exist"). Existence is the PRIMARY's to
 * answer, over the `detail` control relay that already exists
 * (core/sessions/cloud-session-host.ts).
 *
 * Contract under test:
 *   (a) absent from the projection + primary answers `detail` → the send relays
 *       `session.message` to the primary and answers 202.
 *   (b) primary answers not_found → 404 not_found (the only 404 left).
 *   (c) primary unreachable → 503 `bridge_offline`, naming the PRIMARY.
 *   (d) primary's record has a REMOTE host → images AND the send go to THAT
 *       host (the CLI reads the files from disk on its own host).
 *   (e) present in the projection → resolved locally, ZERO `detail` relays.
 *   (f) the SSE stream and the fresh transcript read also resolve via the
 *       primary; an unreachable primary is 503 bridge_offline on the stream,
 *       never a 404.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-host-resolve', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.fn()
const bridgeAttachSessionMock = vi.fn(async () => {})
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError,
  bridgeForHost: () => ({ connected: true }),
  bridgeHosts: () => [],
  bridgeAttachSession: bridgeAttachSessionMock,
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
  setMobileEventHandler: () => {},
}))

/** The reported session: stopped 2026-08-09, outside the projection window. */
const SID = 'cloud-resolve-sid-1'
/** Rows the synced projection carries — empty for every case but (e). */
let projectionRows: Array<Record<string, unknown>> = []
vi.mock('../../../src/core/session-projection.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/session-projection.js')>()
  return {
    ...mod,
    readSessionProjection: async () => ({
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      sessions: projectionRows,
    }),
  }
})

import express from 'express'
import request from 'supertest'
import { sessionStreamV1Router, buildTranscriptViaBridge } from '../../../src/web/routes/session-stream-v1.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function createApp() {
  const app = express()
  app.use(express.json({ limit: '80mb' }))
  app.use('/api/v1', sessionStreamV1Router)
  return app
}

/** The primary's `detail` reply: getSessionDetail's { session, … } envelope. */
function detailReply(host: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    result: {
      session: {
        claudeSessionId: SID, host, process_status: 'stopped',
        cwd: '/home/user/repo', model: 'opus', ...extra,
      },
      pendingPermissions: [],
    },
  }
}

function calls(): Array<[string, string, Record<string, unknown>]> {
  return bridgeRequestMock.mock.calls as Array<[string, string, Record<string, unknown>]>
}

function cmds(): string[] {
  return calls().map((c) => c[1])
}

/** Which control-relay actions the bridge was asked for (should be [] in (e)). */
function relayedActions(): string[] {
  return calls().filter((c) => c[1] === 'session.control').map((c) => String(c[2].action))
}

/**
 * Read up to the first SSE EVENT frame (the attach `: connected` comment comes
 * first), or the whole error body. Supertest waits for the response to END,
 * which an SSE stream never does.
 */
async function readFirstEvent(path: string): Promise<{ status: number; body: string }> {
  const app = createApp()
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const port = address.port
  try {
    return await new Promise<{ status: number; body: string }>((resolve, reject) => {
      let settled = false
      const finish = (value: { status: number; body: string }) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const req = http.get({ port, path }, (res) => {
        let buffer = ''
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          if (buffer.includes('event: ')) {
            finish({ status: res.statusCode ?? 0, body: buffer })
            req.destroy()
          }
        })
        res.on('end', () => finish({ status: res.statusCode ?? 0, body: buffer }))
      })
      req.on('error', (err) => { if (!settled) reject(err) })
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  bridgeAttachSessionMock.mockClear()
  projectionRows = []
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('send: a session outside the projection window', () => {
  it('(a) asks the primary and relays the send to it (the reported 404)', async () => {
    bridgeRequestMock.mockImplementation(async (_host: string, cmd: string) => {
      if (cmd === 'session.control') return detailReply('')
      if (cmd === 'session.message') return { ok: true }
      throw new Error('unexpected command: ' + cmd)
    })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/messages`)
      .send({ text: 'and the photos?' })
    expect(res.status).toBe(202)
    expect(res.body.messageId).toMatch(/^qm-mobile-/)
    expect(cmds()).toEqual(['session.control', 'session.message'])
    // The existence question goes to the PRIMARY's own daemon…
    const [detailHost, , detailParams] = calls()[0]
    expect(detailHost).toBe('__local__')
    expect(detailParams.action).toBe('detail')
    expect(detailParams.sessionId).toBe(SID)
    // …and host '' in the primary's record maps to that same alias.
    const [sendHost, , sendParams] = calls()[1]
    expect(sendHost).toBe('__local__')
    expect(sendParams.message).toBe('and the photos?')
  })

  it('(b) the primary answering not_found is the only 404 left', async () => {
    bridgeRequestMock.mockImplementation(async (_host: string, cmd: string) => {
      if (cmd === 'session.control') return { ok: false, errorKind: 'not_found', error: 'session not found' }
      throw new Error('unexpected command: ' + cmd)
    })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/messages`)
      .send({ text: 'hi' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    expect(cmds()).toEqual(['session.control'])
  })

  it('(c) an unreachable primary is 503 bridge_offline, and the message names the primary', async () => {
    // bridge_offline is the code this route already uses for every unreachable
    // hop, and the phone's silent retry ladder keys on it
    // (SendRetryPolicy.isRetryable) — a fresh code would turn this into the one
    // bridge outage the user has to retry by hand.
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/messages`)
      .send({ text: 'hi' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
    // Never "session not found": the session's existence was never in doubt.
    expect(res.body.error.message).toMatch(/primary/i)
    expect(res.body.error.message).not.toContain(SID)
    expect(res.body.error.message).not.toMatch(/not found/i)
  })

  it('(d) a REMOTE host from the primary receives both the image save and the send', async () => {
    bridgeRequestMock.mockImplementation(async (_host: string, cmd: string) => {
      if (cmd === 'session.control') return detailReply('devbox')
      if (cmd === 'image.save') return { ok: true, path: '/tmp/open-walnut/images/x.png' }
      if (cmd === 'session.message') return { ok: true }
      throw new Error('unexpected command: ' + cmd)
    })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/messages`)
      .send({ text: 'look at this', images: [{ data: TINY_PNG, mediaType: 'image/png' }] })
    expect(res.status).toBe(202)
    expect(cmds()).toEqual(['session.control', 'image.save', 'session.message'])
    const save = calls()[1]
    const send = calls()[2]
    // The CLI reads the file from disk on ITS host, so both hops must agree.
    expect(save[0]).toBe('devbox')
    expect(send[0]).toBe('devbox')
    expect(String(send[2].message)).toContain('/tmp/open-walnut/images/x.png')
  })

  it('(e) a session PRESENT in the projection never asks the primary', async () => {
    projectionRows = [{
      id: SID, host: 'devbox', process_status: 'running',
      started_at: new Date().toISOString(), last_active_at: new Date().toISOString(),
      message_count: 1, cwd: '/home/user/repo',
    }]
    bridgeRequestMock.mockImplementation(async (_host: string, cmd: string) => {
      if (cmd === 'session.message') return { ok: true }
      throw new Error('unexpected command: ' + cmd)
    })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/messages`)
      .send({ text: 'hi' })
    expect(res.status).toBe(202)
    expect(cmds()).toEqual(['session.message'])
    expect(relayedActions()).toEqual([])
  })
})

describe('(f) stream + transcript for a session outside the projection window', () => {
  it('the SSE stream attaches on the host the primary reported', async () => {
    bridgeRequestMock.mockImplementation(async (_host: string, cmd: string) => {
      if (cmd === 'session.control') return detailReply('')
      throw new Error('unexpected command: ' + cmd)
    })
    const res = await readFirstEvent(`/api/v1/sessions/${SID}/stream`)
    expect(res.status).toBe(200)
    expect(res.body).toContain('event: bridge-online')
    expect(bridgeAttachSessionMock).toHaveBeenCalledWith('__local__', SID)
  })

  it('the SSE stream answers 503 bridge_offline (never 404) when the primary is unreachable', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await readFirstEvent(`/api/v1/sessions/${SID}/stream`)
    expect(res.status).toBe(503)
    expect(JSON.parse(res.body).error.code).toBe('bridge_offline')
    expect(bridgeAttachSessionMock).not.toHaveBeenCalled()
  })

  it('the fresh transcript read reaches read-history on the primary-reported host', async () => {
    const jsonl = [
      { type: 'user', message: { content: 'and the photos?' }, timestamp: '2026-08-09T04:00:00Z' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'on it' }] }, timestamp: '2026-08-09T04:00:01Z' },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n'
    bridgeRequestMock.mockImplementation(async (_host: string, cmd: string) => {
      if (cmd === 'session.control') return detailReply('devbox')
      if (cmd === 'read-history') return { ok: true, main: jsonl }
      throw new Error('unexpected command: ' + cmd)
    })
    const transcript = await buildTranscriptViaBridge(SID)
    expect(transcript).not.toBeNull()
    expect((transcript as { messages: Array<{ text: string }> }).messages.map((m) => m.text))
      .toEqual(['and the photos?', 'on it'])
    expect(calls().find((c) => c[1] === 'read-history')?.[0]).toBe('devbox')
  })

  it('the transcript read degrades to null (synced file) when the primary is unreachable', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    expect(await buildTranscriptViaBridge(SID)).toBeNull()
  })
})
