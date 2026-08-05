/**
 * E2E tests for the sessions list `?q=` filter (GET /api/sessions and
 * GET /api/sessions/recent).
 *
 * What's real: Express server (startServer), session-tracker (SQLite),
 * task-manager, REST API. What's mocked: constants.js (temp dir). No CLI is
 * spawned — records are seeded directly via createSessionRecord with
 * process_status left non-alive so enrichWithLiveStatus never probes PIDs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { addTask } from '../../src/core/task-manager.js'
import { updateConfig } from '../../src/core/config-manager.js'

let server: HttpServer
let port: number

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

async function getSessions(path: string): Promise<{ claudeSessionId: string }[]> {
  const res = await fetch(apiUrl(path))
  expect(res.status).toBe(200)
  const body = await res.json() as { sessions: { claudeSessionId: string }[] }
  return body.sessions
}

const SID_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const SID_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const SID_C = 'cccccccc-0000-4000-8000-000000000003'

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0

  // Host alias→hostname mapping — hostname search must resolve through config
  // because session records persist only the alias.
  await updateConfig({ hosts: { clouddev: { hostname: 'clouddev.internal.example.net' } } })

  const { task } = await addTask({ title: 'Payment gateway rewrite', project: 'Quick Start' })

  await createSessionRecord(SID_A, task.id, 'Quick Start', '/home/user/payments', {
    title: 'Fix checkout flow',
    host: 'clouddev',
  })
  await createSessionRecord(SID_B, '', '', '/Users/me/walnut-web', {
    title: 'Session finder UI',
  })
  await createSessionRecord(SID_C, '', '', '/tmp/scratch', {
    title: 'Scratch experiment',
    host: 'devbox',
  })
  // Make all seeded rows non-alive so GET's liveness probe can't rewrite them.
  for (const sid of [SID_A, SID_B, SID_C]) {
    await updateSessionRecord(sid, { process_status: 'stopped' })
  }
}, 30000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('GET /api/sessions?q=', () => {
  it('without q returns all seeded sessions', async () => {
    const sessions = await getSessions('/api/sessions')
    const ids = sessions.map(s => s.claudeSessionId)
    expect(ids).toEqual(expect.arrayContaining([SID_A, SID_B, SID_C]))
  })

  it('filters by session title, case-insensitive', async () => {
    const sessions = await getSessions('/api/sessions?q=CHECKOUT')
    expect(sessions.map(s => s.claudeSessionId)).toEqual([SID_A])
  })

  it('filters by owning-task title', async () => {
    const sessions = await getSessions('/api/sessions?q=payment%20gateway')
    expect(sessions.map(s => s.claudeSessionId)).toEqual([SID_A])
  })

  it('filters by cwd substring', async () => {
    const sessions = await getSessions('/api/sessions?q=walnut-web')
    expect(sessions.map(s => s.claudeSessionId)).toEqual([SID_B])
  })

  it('filters by host', async () => {
    const sessions = await getSessions('/api/sessions?q=devbox')
    expect(sessions.map(s => s.claudeSessionId)).toEqual([SID_C])
  })

  it('filters by full hostname resolved from config.hosts (records only carry the alias)', async () => {
    const sessions = await getSessions('/api/sessions?q=clouddev.internal.example.net')
    expect(sessions.map(s => s.claudeSessionId)).toEqual([SID_A])
  })

  it('AND-combines multiple terms', async () => {
    const both = await getSessions('/api/sessions?q=checkout%20clouddev')
    expect(both.map(s => s.claudeSessionId)).toEqual([SID_A])
    const none = await getSessions('/api/sessions?q=checkout%20devbox')
    expect(none).toEqual([])
  })

  it('returns empty list (not error) for a no-match query', async () => {
    const sessions = await getSessions('/api/sessions?q=zzz-no-such-thing')
    expect(sessions).toEqual([])
  })
})

describe('GET /api/sessions/recent?q=', () => {
  it('without q returns the recent list', async () => {
    const sessions = await getSessions('/api/sessions/recent?limit=10')
    expect(sessions.length).toBeGreaterThanOrEqual(3)
  })

  it('searches the WHOLE list then caps at limit', async () => {
    const sessions = await getSessions('/api/sessions/recent?q=scratch&limit=1')
    expect(sessions.map(s => s.claudeSessionId)).toEqual([SID_C])
  })

  it('respects limit with a broad query', async () => {
    // All three cwds contain a "/" — broad match; limit must cap the result.
    const sessions = await getSessions('/api/sessions/recent?q=%2F&limit=2')
    expect(sessions.length).toBe(2)
  })
})
