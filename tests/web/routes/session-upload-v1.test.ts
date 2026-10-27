/**
 * PUT /api/v1/sessions/:id/uploads/:uploadId on the PRIMARY box: one raw chunk
 * of a phone's file, relayed to the session host's daemon (`upload.part` through
 * daemon-transfer-client.uploadPart), and every host answer mapped to the
 * contract's status and code. The daemon side is pinned by
 * tests/providers/upload-part.test.ts; this file pins the relay.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-session-upload', { CLOUD_MODE: false }))

const { records, uploadPartMock } = vi.hoisted(() => ({
  records: new Map<string, Record<string, unknown>>(),
  uploadPartMock: vi.fn(),
}))
vi.mock('../../../src/core/session-tracker.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/session-tracker.js')>()),
  getSessionByClaudeId: async (sid: string) => records.get(sid) ?? null,
}))

vi.mock('../../../src/core/transfer/daemon-transfer-client.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/transfer/daemon-transfer-client.js')>()),
  uploadPart: uploadPartMock,
}))

import express from 'express'
import request from 'supertest'
import { sessionStreamV1Router } from '../../../src/web/routes/session-stream-v1.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { TransferCommandError, TransferHostOfflineError } from '../../../src/core/transfer/daemon-transfer-client.js'
import { DaemonNeedsUpgradeError } from '../../../src/core/daemon-file-reader.js'
import { UPLOAD_CHUNK_BYTES } from '../../../src/core/sessions/session-uploads.js'

const SID = 'sess-upload-1'
const UP = 'up-11111111-2222-3333-4444-555555555555'

function app() {
  const a = express()
  // The server's own global JSON parser sits in front, as in server.ts.
  a.use(express.json({ limit: '15mb' }))
  a.use('/api/v1', sessionStreamV1Router)
  return a
}

function put(query: Record<string, string>, body: Buffer, sid = SID, up = UP) {
  return request(app())
    .put(`/api/v1/sessions/${sid}/uploads/${up}`)
    .query(query)
    .set('Content-Type', 'application/octet-stream')
    .send(body)
}

beforeEach(() => {
  records.clear()
  records.set(SID, { claudeSessionId: SID, host: 'devbox', taskId: 'task-abc' })
  uploadPartMock.mockReset()
})

describe('PUT /api/v1/sessions/:id/uploads/:uploadId (primary)', () => {
  it('relays the raw bytes to the session host with its task, and answers what the host staged', async () => {
    uploadPartMock.mockResolvedValue({ staged: 5 })
    const res = await put({ offset: '0', size: '10', name: 'clip.mov' }, Buffer.from('hello'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: 5, size: 10, done: false })
    expect(uploadPartMock).toHaveBeenCalledTimes(1)
    const [host, opts] = uploadPartMock.mock.calls[0]
    expect(host).toBe('devbox')
    expect(opts).toMatchObject({ uploadId: UP, name: 'clip.mov', size: 10, offset: 0, taskId: 'task-abc', home: WALNUT_HOME, sessionId: SID })
    expect(Buffer.isBuffer(opts.data) && opts.data.toString()).toBe('hello')
  })

  it('a session on this machine goes to the local daemon; the last chunk answers the path', async () => {
    records.set(SID, { claudeSessionId: SID, host: '', taskId: 'task-abc' })
    const sha = 'a'.repeat(64)
    uploadPartMock.mockResolvedValue({ staged: 10, done: true, sha256: sha, path: '/h/tasks/task-abc/uploads/x/clip.mov' })
    const res = await put({ offset: '5', size: '10', name: 'clip.mov', sha256: sha.toUpperCase() }, Buffer.from('world'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: 10, size: 10, done: true, path: '/h/tasks/task-abc/uploads/x/clip.mov' })
    expect(uploadPartMock.mock.calls[0][0]).toBe('__local__')
    expect(uploadPartMock.mock.calls[0][1]).toMatchObject({ offset: 5, sha256: sha })
  })

  it('an empty file is one empty chunk', async () => {
    uploadPartMock.mockResolvedValue({ staged: 0, done: true, path: '/h/u/empty.txt' })
    const res = await put({ offset: '0', size: '0', name: 'empty.txt' }, Buffer.alloc(0))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ done: true, path: '/h/u/empty.txt' })
  })

  it('maps every host answer to the contract', async () => {
    const cases: Array<[unknown, number, string, Record<string, unknown>?]> = [
      [new TransferCommandError('staged 4 bytes', 'devbox', 'upload.part', 'gap', { have: 4 }), 409, 'upload_offset_mismatch', { received: 4 }],
      [new TransferCommandError('sha differs', 'devbox', 'upload.part', 'checksum_mismatch'), 422, 'upload_checksum_mismatch'],
      [new TransferCommandError('full', 'devbox', 'upload.part', 'no_space', { free: 1 }), 507, 'host_disk_full'],
      [new TransferCommandError('bad name', 'devbox', 'upload.part', 'bad_request'), 400, 'bad_request'],
      [new TransferCommandError('EIO', 'devbox', 'upload.part', 'failed'), 502, 'upload_failed'],
      [new TransferHostOfflineError('devbox'), 503, 'bridge_offline'],
      [new Error('daemon command timeout'), 503, 'bridge_offline'],
      [new DaemonNeedsUpgradeError('devbox', 'upload-part-v1'), 400, 'files_need_daemon_upgrade'],
    ]
    for (const [err, status, code, extra] of cases) {
      uploadPartMock.mockReset()
      uploadPartMock.mockRejectedValue(err)
      const res = await put({ offset: '8', size: '20', name: 'a.pdf' }, Buffer.from('12345678'))
      expect(res.status, code).toBe(status)
      expect(res.body.error, code).toMatchObject({ code, ...(extra ?? {}) })
    }
  })

  it('refuses bad input before anything reaches the host', async () => {
    const bad: Array<[Record<string, string>, Buffer, number, string?, string?]> = [
      [{ offset: '0', size: '5', name: '../x' }, Buffer.from('hello'), 400],
      [{ offset: '0', size: '5', name: '.env' }, Buffer.from('hello'), 400],
      [{ offset: '0', size: '5' }, Buffer.from('hello'), 400],
      [{ offset: '-1', size: '5', name: 'a' }, Buffer.from('hello'), 400],
      [{ offset: '0', size: 'x', name: 'a' }, Buffer.from('hello'), 400],
      [{ offset: '0', size: '5', name: 'a', sha256: 'nothex' }, Buffer.from('hello'), 400],
      [{ offset: '3', size: '5', name: 'a' }, Buffer.from('hello'), 400],
      [{ offset: '0', size: String(5 * 1024 ** 3), name: 'a' }, Buffer.from('hello'), 413],
      [{ offset: '0', size: '5', name: 'a' }, Buffer.from('hello'), 400, 'bad id!', UP],
      [{ offset: '0', size: '5', name: 'a' }, Buffer.from('hello'), 400, SID, 'up-x'],
    ]
    for (const [q, body, status, sid, up] of bad) {
      const res = await put(q, body, sid ?? SID, up ?? UP)
      expect(res.status, JSON.stringify(q)).toBe(status)
    }
    expect(uploadPartMock).not.toHaveBeenCalled()
  })

  it('a chunk over the chunk size is 413 in the contract shape', async () => {
    const res = await put({ offset: '0', size: String(UPLOAD_CHUNK_BYTES * 2), name: 'big.bin' }, Buffer.alloc(UPLOAD_CHUNK_BYTES + 2048))
    expect(res.status).toBe(413)
    expect(res.body.error).toMatchObject({ code: 'too_large' })
    expect(uploadPartMock).not.toHaveBeenCalled()
  })

  it('a full-size chunk passes, whatever the content type says', async () => {
    uploadPartMock.mockResolvedValue({ staged: UPLOAD_CHUNK_BYTES })
    const res = await request(app())
      .put(`/api/v1/sessions/${SID}/uploads/${UP}`)
      .query({ offset: '0', size: String(UPLOAD_CHUNK_BYTES * 2), name: 'v.mov' })
      .set('Content-Type', 'video/quicktime')
      .send(Buffer.alloc(UPLOAD_CHUNK_BYTES, 7))
    expect(res.status).toBe(200)
    expect(uploadPartMock.mock.calls[0][1].data.length).toBe(UPLOAD_CHUNK_BYTES)
  })

  it('an unknown session is 404', async () => {
    const res = await put({ offset: '0', size: '5', name: 'a.txt' }, Buffer.from('hello'), 'nobody')
    expect(res.status).toBe(404)
    expect(uploadPartMock).not.toHaveBeenCalled()
  })
})
