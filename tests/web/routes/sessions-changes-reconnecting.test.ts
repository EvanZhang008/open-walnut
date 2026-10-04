/**
 * GET /api/sessions/:id/changes while the session's host is still connecting
 * (core/hosts/remote-read-bound.ts answers HostReconnectingError at once):
 *   - `?swr=1` on the session's own edits paints the list this server already
 *     had (peekSessionChanges, stale:true), so the Changed tab keeps its rows;
 *   - anything else, or no list yet: 503 host_reconnecting, never a hang.
 *
 * Real sessions router and session record; the host read and the cache peek
 * are the seams (a real reconnecting host is tests/e2e/host-read-deadline-e2e.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

const peeked = vi.hoisted(() => ({ result: null as unknown, calls: [] as Array<[string, string | undefined]> }))
vi.mock('../../../src/core/session-changes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/session-changes.js')>()),
  peekSessionChanges: async (sessionId: string, host?: string) => {
    peeked.calls.push([sessionId, host])
    return peeked.result
  },
}))
vi.mock('../../../src/core/hosts/remote-read-bound.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/hosts/remote-read-bound.js')>()
  return {
    ...actual,
    // The host is mid-dial: every remote read answers at once, degraded.
    boundHostRead: async <T,>(host: string | null | undefined, read: () => Promise<T>) => {
      if (actual.isRemoteHost(host)) throw new actual.HostReconnectingError(host, 'Dev box')
      return read()
    },
  }
})

import express from 'express'
import request from 'supertest'
import { sessionsRouter } from '../../../src/web/routes/sessions.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const SID = 'changes-reconnecting-sid'
const CACHED = { groups: [{ kind: 'cwd', files: [{ relPath: 'app.ts', status: 'modified' }] }], fileCount: 1, stale: true, light: true }

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/sessions', sessionsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  peeked.result = null
  peeked.calls = []
  await createSessionRecord(SID, 'task-1', 'proj', '/home/dev/projects/beta', { host: 'devbox' })
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('GET /api/sessions/:id/changes while the host reconnects', () => {
  it('?swr=1 serves the list this server already had, marked stale', async () => {
    peeked.result = CACHED
    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ light: '1', swr: '1' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(CACHED)
    expect(peeked.calls).toEqual([[SID, 'devbox']])
  })

  it('?swr=1 with base=session is the same list', async () => {
    peeked.result = CACHED
    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ swr: '1', base: 'session' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(CACHED)
  })

  it('no list yet: 503 host_reconnecting, in the host\'s own name', async () => {
    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ swr: '1' })
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'Reconnecting to Dev box', code: 'host_reconnecting' })
  })

  it('without swr, or for a git baseline, the cache is not consulted', async () => {
    peeked.result = CACHED
    for (const query of [{}, { swr: '1', base: 'uncommitted' }]) {
      const res = await request(createApp()).get(`/api/sessions/${SID}/changes`).query(query)
      expect(res.status, JSON.stringify(query)).toBe(503)
      expect(res.body.code).toBe('host_reconnecting')
    }
    expect(peeked.calls).toEqual([])
  })
})
