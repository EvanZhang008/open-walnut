/**
 * A daemon forwards any `session.control` a client of its WebSocket sends. The
 * only legitimate sender is the cloud replica, whose relays always arrive through
 * the Mac's own daemon ('__local__'). A remote exec host's daemon gets a
 * `forbidden` control-result for EVERY action (box-level `server.*` and
 * session-level alike) and the action never runs. A session on that host still
 * reaches Walnut through the gateway (`walnut tools call`), which is untouched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-control-host-policy'))

const relayMock = vi.fn(async (action: string) => ({ ok: true as const, result: { status: 200, body: { action } } }))
vi.mock('../../src/core/sessions/session-controls.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/sessions/session-controls.js')>()
  return { ...actual, handleSessionControlRelay: relayMock }
})

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { controlRefusedForHost } from '../../src/core/sessions/control-host-policy.js'
import { REMOTE_HTTP_ORIGIN, hostOrigin } from '../../src/lib/caller-origin.js'

interface SentFrame { cmd: string; params: Record<string, unknown> }

function makeConn(hostKey: string): { conn: DaemonConnection; sent: SentFrame[] } {
  const conn = new DaemonConnection(hostKey, null)
  const sent: SentFrame[] = []
  ;(conn as unknown as { send: (cmd: string, params: Record<string, unknown>) => Promise<unknown> }).send =
    async (cmd: string, params: Record<string, unknown>) => { sent.push({ cmd, params }); return { ok: true } }
  return { conn, sent }
}

async function control(conn: DaemonConnection, action: string, relayId = 7): Promise<void> {
  await (conn as unknown as { handleControlRequest: (e: Record<string, unknown>) => Promise<void> })
    .handleControlRequest({ relayId, action, sessionId: '__server__', params: { body: {} } })
}

beforeEach(() => { relayMock.mockClear() })

describe('session.control relays by host', () => {
  it('a remote host\'s daemon cannot reach Apple Health: forbidden, and the action never runs', async () => {
    for (const action of ['server.health.status', 'server.health.sync', 'server.health.settings', 'server.health.delete']) {
      const { conn, sent } = makeConn('remote-dev')
      await control(conn, action)
      expect(relayMock).not.toHaveBeenCalled()
      expect(sent).toHaveLength(1)
      expect(sent[0].cmd).toBe('control-result')
      expect(sent[0].params).toMatchObject({ relayId: 7, errorKind: 'forbidden' })
      expect(sent[0].params.error).toMatch(/only through this Mac's own daemon/)
      expect(sent[0].params.error).not.toMatch(/[\u2013\u2014]/)
      expect(sent[0].params).not.toHaveProperty('result')
    }
  })

  it('the Mac\'s own daemon (and so the replica bridge) still reaches Apple Health', async () => {
    const { conn, sent } = makeConn('__local__')
    await control(conn, 'server.health.status', 9)
    // A relay on the Mac's own daemon comes from the cloud replica's bridge: it runs
    // for a paired client off this Mac, never as this Mac.
    expect(relayMock).toHaveBeenCalledWith('server.health.status', '__server__', { body: {} }, REMOTE_HTTP_ORIGIN)
    expect(sent).toEqual([{ cmd: 'control-result', params: { relayId: 9, result: { status: 200, body: { action: 'server.health.status' } } } }])
  })

  it('a remote host\'s daemon cannot relay any other action either: box-level or session-level', async () => {
    const actions = [
      'server.routines.run', 'server.routines.check-test', 'server.routines.create', 'server.chat.turn', 'server.tasks.apply',
      'server.human-inbox.send', 'server.files.list', 'server.search', 'server.plugin-op', 'server.push.register',
      'model', 'patch', 'terminate', 'permission', 'fork', 'history',
    ]
    for (const action of actions) {
      for (const host of ['remote-dev', 'cloud', '__local__x', '']) {
        const { conn, sent } = makeConn(host)
        await control(conn, action, 11)
        expect(relayMock, `${action} via ${host}`).not.toHaveBeenCalled()
        expect(sent, `${action} via ${host}`).toEqual([{ cmd: 'control-result', params: { relayId: 11, error: expect.stringContaining(`${action} was refused`), errorKind: 'forbidden' } }])
      }
    }
  })

  it('the Mac\'s own daemon still relays every action (the replica\'s bridge path)', async () => {
    for (const action of ['server.routines.run', 'server.chat.turn', 'server.tasks.apply', 'model', 'patch']) {
      relayMock.mockClear()
      const { conn, sent } = makeConn('__local__')
      await control(conn, action, 12)
      expect(relayMock).toHaveBeenCalledWith(action, '__server__', { body: {} }, REMOTE_HTTP_ORIGIN)
      expect(sent[0].params).toMatchObject({ relayId: 12, result: { status: 200 } })
    }
  })

  it('a session on the remote host still reaches Walnut through the gateway on the same connection', async () => {
    const { conn, sent } = makeConn('remote-dev')
    // tools.call reaches the real op executor; fetch is stubbed so no request leaves the test.
    const prevUrl = process.env.OPEN_WALNUT_API_URL
    process.env.OPEN_WALNUT_API_URL = 'http://127.0.0.1:1'
    const seen: Array<{ url: string; origin: string | undefined }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), origin: (init.headers as Record<string, string>)['x-walnut-origin'] })
      return new Response(JSON.stringify({ task: { id: 'abc123', title: 'probe', phase: 'TODO' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    try {
      await (conn as unknown as { handleGatewayRequest: (e: Record<string, unknown>) => Promise<void> })
        .handleGatewayRequest({ relayId: 21, capability: 'tools.call', callerSid: 'a1b2c3d4-1111-2222-3333-444455556666', payload: { name: 'task_get', args: { id: 'abc123' } } })
    } finally {
      vi.unstubAllGlobals()
      if (prevUrl === undefined) delete process.env.OPEN_WALNUT_API_URL
      else process.env.OPEN_WALNUT_API_URL = prevUrl
    }
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ cmd: 'gateway-result', params: { relayId: 21, result: { task: { id: 'abc123' } } } })
    expect(seen).toEqual([{ url: 'http://127.0.0.1:1/api/tasks/abc123', origin: hostOrigin('remote-dev') }])
    expect(relayMock).not.toHaveBeenCalled()
  })
})

describe('controlRefusedForHost', () => {
  it('accepts every action from the Mac\'s own daemon and none from any other', () => {
    expect(controlRefusedForHost('server.health.sync', '__local__')).toBeNull()
    expect(controlRefusedForHost('model', '__local__')).toBeNull()
    expect(controlRefusedForHost('server.health.sync', 'remote-dev')).toMatch(/remote-dev/)
    expect(controlRefusedForHost('server.healthy', 'remote-dev')).not.toBeNull()
    expect(controlRefusedForHost('model', 'remote-dev')).toBe(
      "model was refused: session controls are accepted only through this Mac's own daemon, not the daemon on host remote-dev")
    expect(controlRefusedForHost('model', '')).toMatch(/an unnamed host$/)
    // A look-alike host key is not the Mac.
    expect(controlRefusedForHost('server.health.status', '__local__x')).not.toBeNull()
    expect(controlRefusedForHost('server.health.status', '')).not.toBeNull()
  })
})
