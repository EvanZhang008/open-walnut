/**
 * PUT /api/v1/sessions/:id/uploads/:uploadId on the cloud COMPANION: a chunk for
 * a session on another machine goes over the bridge to THAT host as the narrow
 * `upload.part` (base64, the task id from the synced projection), and a daemon
 * too old for it, or no bridge, answers the codes the phone acts on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-session-upload-cloud', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.fn()
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError,
  bridgeForHost: () => ({ connected: true }),
  bridgePhoneState: () => 'connected',
  noteStreamWithoutBridge: () => {},
  bridgeHosts: () => [],
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
  setMobileEventHandler: () => {},
}))

const SID = 'cloud-upload-sid'
const UP = 'up-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
vi.mock('../../../src/core/session-projection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/session-projection.js')>()),
  readSessionProjection: async () => ({
    version: 1 as const, exportedAt: new Date().toISOString(),
    sessions: [{ id: SID, host: 'devbox', cwd: '/w', task_id: 'task-xyz', title: 't', status: 'idle' }],
  }),
}))

import express from 'express'
import request from 'supertest'
import { sessionStreamV1Router } from '../../../src/web/routes/session-stream-v1.js'

function put(query: Record<string, string>, body: Buffer) {
  const a = express()
  a.use(express.json({ limit: '15mb' }))
  a.use('/api/v1', sessionStreamV1Router)
  return request(a).put(`/api/v1/sessions/${SID}/uploads/${UP}`).query(query)
    .set('Content-Type', 'application/octet-stream').send(body)
}

beforeEach(() => { bridgeRequestMock.mockReset() })

describe('PUT /api/v1/sessions/:id/uploads/:uploadId (companion)', () => {
  it('relays the chunk to the session host over the bridge, naming the session, never a task or a home', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, staged: 10, done: true, path: '/home/u/.local/state/open-walnut/tasks/task-xyz/uploads/x/r.pdf' })
    const res = await put({ offset: '0', size: '10', name: 'r.pdf', sha256: 'b'.repeat(64) }, Buffer.from('%PDF-1.4 x'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: 10, size: 10, done: true, path: '/home/u/.local/state/open-walnut/tasks/task-xyz/uploads/x/r.pdf' })
    const [host, cmd, params] = bridgeRequestMock.mock.calls[0]
    expect(host).toBe('devbox')
    expect(cmd).toBe('upload.part')
    expect(params).toMatchObject({ uploadId: UP, name: 'r.pdf', size: 10, offset: 0, sessionId: SID, sha256: 'b'.repeat(64) })
    // The host files it under the task it started the session for, not one the companion names.
    expect(params).not.toHaveProperty('taskId')
    expect(Buffer.from(params.data, 'base64').toString()).toBe('%PDF-1.4 x')
    // The companion never names a data home for the host's task dir marker.
    expect(params).not.toHaveProperty('home')
  })

  it('an older daemon (no command, or not on its bridge allowlist) is files_need_daemon_upgrade', async () => {
    for (const error of ['unknown command: upload.part', 'command not permitted over bridge: upload.part']) {
      bridgeRequestMock.mockResolvedValueOnce({ ok: false, error })
      const res = await put({ offset: '0', size: '5', name: 'a.txt' }, Buffer.from('hello'))
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('files_need_daemon_upgrade')
    }
  })

  it('a gap answers where to resume; no bridge is 503 bridge_offline', async () => {
    bridgeRequestMock.mockResolvedValueOnce({ ok: false, error: 'upload.part failed: staged 2 bytes', code: 'gap', have: 2 })
    const gap = await put({ offset: '4', size: '9', name: 'a.txt' }, Buffer.from('hello'))
    expect(gap.status).toBe(409)
    expect(gap.body.error).toMatchObject({ code: 'upload_offset_mismatch', received: 2 })
    bridgeRequestMock.mockRejectedValueOnce(new BridgeOfflineError('devbox'))
    const off = await put({ offset: '0', size: '5', name: 'a.txt' }, Buffer.from('hello'))
    expect(off.status).toBe(503)
    expect(off.body.error.code).toBe('bridge_offline')
    // A slow link that timed out is retryable too, never a 500.
    bridgeRequestMock.mockRejectedValueOnce(new Error('bridge request timed out: upload.part'))
    const slow = await put({ offset: '0', size: '5', name: 'a.txt' }, Buffer.from('hello'))
    expect(slow.status).toBe(503)
    expect(slow.body.error.code).toBe('bridge_offline')
  })
})
