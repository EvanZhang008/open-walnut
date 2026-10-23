/**
 * GET /api/sessions/:id/cost through the real server: session record → the
 * server's daemon relay (usage.sessionCost) → the real session-cost-core over a
 * transcript on disk → the server's price book. Only the daemon process is the
 * in-test MockDaemon, and it runs the same core the real daemons bundle.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('session-cost-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getDirectDaemonConnection, setPooledConnectionForTest } from '../../src/providers/daemon-connection.js'

const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CWD = '/work/acme-cost'
let server: HttpServer
let port: number
let daemon: MockDaemon
let projects: string

function assistant(id: string, at: string, model: string, usage: Record<string, unknown>) {
  return JSON.stringify({ type: 'assistant', sessionId: SID, timestamp: at,
    message: { id, model, stop_reason: 'end_turn', usage: { speed: 'standard', inference_geo: '', service_tier: 'standard', ...usage } } })
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  projects = await fs.mkdtemp(path.join(os.tmpdir(), 'session-cost-projects-'))
  const dir = path.join(projects, CWD.replace(/[^a-zA-Z0-9]/g, '-'))
  await fs.mkdir(path.join(dir, SID, 'subagents'), { recursive: true })
  await fs.writeFile(path.join(dir, `${SID}.jsonl`), [
    assistant('m1', '2026-10-18T10:00:00.000Z', 'claude-opus-5-5', { input_tokens: 1_000, output_tokens: 2_000,
      cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 300_000,
      cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 200_000 } }),
    assistant('m2', '2026-10-20T13:00:00.000Z', 'some-unreleased-model', { input_tokens: 10, output_tokens: 10,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ].join('\n') + '\n')
  // A subagent on Haiku 5.5, once below and once above its 100K tier.
  await fs.writeFile(path.join(dir, SID, 'subagents', 'agent-one.jsonl'), [
    assistant('s1', '2026-10-18T11:00:00.000Z', 'claude-haiku-5-5', { input_tokens: 1_000, output_tokens: 1_000,
      cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 }),
    assistant('s2', '2026-10-18T11:01:00.000Z', 'claude-haiku-5-5', { input_tokens: 1_000, output_tokens: 1_000,
      cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0 }),
  ].join('\n') + '\n')
  daemon = await createMockDaemon({ claudeProjectsDir: projects })
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  // The server's host reads (DaemonFileReader) take the pooled link for the host.
  setPooledConnectionForTest('__local__', await getDirectDaemonConnection('__local__', `ws://127.0.0.1:${daemon.port}`))
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  const { createSessionRecord } = await import('../../src/core/session-tracker.js')
  await createSessionRecord(SID, 'task-cost', 'Example', CWD, { title: 'Cost check' })
}, 90_000)

afterAll(async () => {
  setPooledConnectionForTest('__local__', null)
  await stopServer()
  await daemon?.stop?.()
  await fs.rm(projects, { recursive: true, force: true })
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('session cost through the real server', () => {
  it('prices each request at its own tier and names what has no price', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${SID}/cost`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body, body.reason).toMatchObject({ sessionId: SID, engine: 'claude', source: 'claude-transcript', status: 'partial',
      responses: 4, unpricedResponses: 1, firstAt: '2026-10-18T10:00:00.000Z', lastAt: '2026-10-20T13:00:00.000Z' })
    const opus = body.models.find((m: { model: string }) => m.model === 'claude-opus-5-5')
    expect(opus.costUsd).toBeCloseTo((1_000 * 4 + 2_000 * 20 + 1_000_000 * 0.2 + 100_000 * 5 + 200_000 * 8) / 1e6, 9)
    expect(opus.priceSource).toMatchObject({ kind: 'litellm', key: 'claude-opus-5-5' })
    const haiku = body.models.find((m: { model: string }) => m.model === 'claude-haiku-5-5')
    expect(haiku.costUsd).toBeCloseTo((1_000 * 0.1 + 1_000 * 0.5 + 50_000 * 0.01) / 1e6 + (1_000 * 0.5 + 1_000 * 2.5 + 150_000 * 0.05) / 1e6, 9)
    expect(haiku.longResponses).toBe(1)
    const unknown = body.models.find((m: { model: string }) => m.model === 'some-unreleased-model')
    expect(unknown).toMatchObject({ costUsd: null, unpricedResponses: 1 })
    expect(body.totalUsd).toBeCloseTo(opus.costUsd + haiku.costUsd, 9)
  })

  it('prices the same usage on the models asked about, the session\'s own at what it cost', async () => {
    const own = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${SID}/cost`)).json()
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${SID}/cost/compare?models=${encodeURIComponent('claude-opus-5-5[1m],no-such-model')}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body, body.reason).toMatchObject({ sessionId: SID, status: 'ok', responses: 4, unknown: ['no-such-model', 'some-unreleased-model'] })
    const opus = body.rows.find((r: { key: string }) => r.key === 'claude-opus-5-5')
    expect(opus).toMatchObject({ id: 'claude-opus-5-5[1m]', group: 'walnut', current: true })
    // Each row prices the WHOLE session at one model: here Opus also takes the Haiku and
    // unpriced requests, so it costs more than Opus's own share of /cost.
    const opusOwn = own.models.find((m: { model: string }) => m.model === 'claude-opus-5-5').costUsd
    expect(opus.costUsd).toBeGreaterThan(opusOwn)
    const costs = body.rows.map((r: { costUsd: number }) => r.costUsd)
    expect(costs).toEqual([...costs].sort((a: number, b: number) => a - b))
  })

  it('answers 404 for a session it does not know', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/no-such-session/cost`)
    expect(res.status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${port}/api/sessions/no-such-session/cost/compare`)).status).toBe(404)
  })
})
