/**
 * The feature-node connection journal end to end: a real server (companion mode, so the
 * /bridge door is open), a node on the real WebSocket upgrade, its close codes, the read
 * route behind the real auth middleware, the op through the real executor, and the stop
 * path a deploy takes (a planned-restart marker, then stopServer as the SIGTERM handler
 * calls it): the node gets 1012, and the journal says "deploy".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WebSocket } from '#ws'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('feature-journal-e2e', { CLOUD_MODE: true }))
import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { featureNodeStore, featureNodeJournal } from '../../src/web/ws/feature-node-runtime.js'
import { createDevice } from '../../src/core/device-auth.js'
import { plannedRestartFile, writePlannedRestart } from '../../src/core/planned-restart.js'
import { executeOp } from '../../src/ops/index.js'
import { getSelfApiRoot } from '../../src/lib/self-api-root.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'

let port: number
let stopped = false
let phone = ''
const sockets = new Set<WebSocket>()
const grant = { capability: { id: 'catalog.page', version: 1 }, fingerprint: 'catalog-v1' }

beforeAll(async () => {
  const server = await startServer({ port: 0, dev: true })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Synthetic port missing')
  port = address.port
  await fs.mkdir(path.join(WALNUT_HOME, 'secrets'), { recursive: true, mode: 0o700 })
  phone = (await createDevice('journal-reader')).token
}, 60_000)
afterAll(async () => { for (const ws of sockets) ws.terminate(); if (!stopped) await stopServer() })

function dial(token: string): Promise<{ ws: WebSocket; generation: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { headers: { Authorization: `Bearer ${token}` } })
  sockets.add(ws)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('Synthetic ready deadline')) }, 5000)
    ws.once('error', () => { clearTimeout(timer); reject(new Error('Synthetic connection refused')) })
    ws.once('message', (data) => {
      clearTimeout(timer)
      const ready = JSON.parse(data.toString())
      if (ready.type !== 'ready') { reject(new Error('Synthetic ready missing')); return }
      resolve({ ws, generation: ready.generation })
    })
  })
}

async function journalFor(nodeId: string, headers: Record<string, string> = { Authorization: `Bearer ${phone}` }, query = '') {
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/feature-nodes/connections?node=${nodeId}${query}`, { headers })
  return { status: r.status, body: await r.json().catch(() => null) as any }
}

describe('feature node connection journal, end to end', () => {
  it('records a node\'s connect and its own close with code and reason, readable through the route', async () => {
    const node = await featureNodeStore().provision({ nodeId: 'journal-node', accountId: 'account-a', grants: [grant] })
    const { ws, generation } = await dial(node.token)
    await expect.poll(async () => (await journalFor('journal-node')).body?.current?.generation).toBe(generation)
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    ws.close(4001, 'node going away')
    await closed
    await expect.poll(async () => (await journalFor('journal-node')).body?.events?.at(-1)?.type).toBe('disconnected')
    const { status, body } = await journalFor('journal-node')
    expect(status).toBe(200)
    expect(body.current).toBeNull()
    const mine = body.events.filter((e: any) => e.type !== 'server_started')
    expect(mine).toEqual([
      { at: expect.any(String), type: 'connected', nodeId: 'journal-node', generation },
      { at: expect.any(String), type: 'disconnected', nodeId: 'journal-node', generation, cause: 'closed_by_node',
        closeCode: 4001, closeReason: 'node going away', connectedForMs: expect.any(Number) },
    ])
    expect(body.events[0]).toMatchObject({ type: 'server_started', build: expect.any(String) })
    expect(JSON.stringify(body)).not.toContain('account-a')
    expect(JSON.stringify(body)).not.toContain(node.token)
  })

  it('filters by since and limit, refuses bad input, and refuses a caller without a device token (a node\'s own included)', async () => {
    const all = (await journalFor('journal-node')).body.events
    const last = all.at(-1).at
    const since = await journalFor('journal-node', undefined, `&since=${encodeURIComponent(last)}`)
    expect(since.body.events.map((e: any) => e.type)).toEqual(['disconnected'])
    const limited = await journalFor('journal-node', undefined, '&limit=1')
    expect(limited.body).toMatchObject({ truncated: true, events: [{ type: 'disconnected' }] })
    expect((await journalFor('journal-node', undefined, '&since=yesterday')).status).toBe(400)
    expect((await journalFor('journal-node', undefined, '&limit=0')).status).toBe(400)
    expect((await journalFor('bad%20id')).status).toBe(400)
    const nodeToken = (await featureNodeStore().provision({ nodeId: 'journal-snoop', accountId: 'account-a', grants: [grant] })).token
    for (const headers of [{}, { Authorization: `Bearer ${nodeToken}` }, { Authorization: 'Bearer not-a-token' }]) {
      expect((await journalFor('journal-node', headers)).status).toBe(401)
    }
  })

  it('the op reads the same journal through the executor', async () => {
    // A call to this server's own root carries its self-call credential (no loopback waiver in companion mode).
    const out = await executeOp('feature_node_connections', { node: 'journal-node', limit: 5 }, { apiBase: getSelfApiRoot()!, origin: LOCAL_ORIGIN })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    const result = (out as { result: any }).result
    expect(result.events.at(-1)).toMatchObject({ type: 'disconnected', cause: 'closed_by_node', closeCode: 4001 })
    expect(result.outcome).toMatch(/journal events/)
    expect(await executeOp('feature_node_connections', { limit: 0 }, { apiBase: getSelfApiRoot()!, origin: LOCAL_ORIGIN })).toMatchObject({ ok: false })
  })

  it('a binary frame on the real socket is a protocol error: closed 1008, journaled as such', async () => {
    const node = await featureNodeStore().provision({ nodeId: 'binary-node', accountId: 'account-a', grants: [grant] })
    const { ws, generation } = await dial(node.token)
    const seen = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    ws.send(Buffer.from(JSON.stringify({ protocolVersion: 1, type: 'manifest', capabilities: [grant.capability] })), { binary: true })
    expect(await seen).toBe(1008)
    await expect.poll(async () => (await journalFor('binary-node')).body?.events?.at(-1)).toMatchObject({
      type: 'disconnected', generation, cause: 'protocol_error', closeCode: 1008,
    })
  })

  it('a deploy\'s stop: the marker names it, the node gets 1012 before the server is gone, the journal says deploy', async () => {
    const node = await featureNodeStore().provision({ nodeId: 'restart-node', accountId: 'account-a', grants: [grant] })
    const { ws, generation } = await dial(node.token)
    const seen = new Promise<{ code: number; reason: string }>((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
    await writePlannedRestart(WALNUT_HOME, { reason: 'deploy', build: 'a1b2c3d4e' })
    stopped = true
    await stopServer({ reason: 'SIGTERM' })
    expect(await seen).toEqual({ code: 1012, reason: 'server stopping: deploy' })
    await expect(fs.access(plannedRestartFile(WALNUT_HOME))).rejects.toThrow()
    const { events } = await featureNodeJournal().read({ nodeId: 'restart-node' })
    const tail = events.slice(-2)
    expect(tail[0]).toMatchObject({ type: 'server_stopping', reason: 'deploy', signal: 'SIGTERM', nextBuild: 'a1b2c3d4e' })
    expect(tail[1]).toMatchObject({ type: 'disconnected', nodeId: 'restart-node', generation, cause: 'server_stopping', closeCode: 1012 })
    expect(events.filter((e) => e.type === 'connected').at(-1)).toMatchObject({ generation })
  })

  it('a restart without a marker says its own reason; a marker the previous server left is removed at start', async () => {
    // As if an older server had been stopped without taking it.
    await writePlannedRestart(WALNUT_HOME, { reason: 'deploy', build: 'feedface1' })
    const server = await startServer({ port: 0, dev: true })
    stopped = false
    port = (server.address() as { port: number }).port
    await expect.poll(async () => fs.access(plannedRestartFile(WALNUT_HOME)).then(() => 'there', () => 'gone')).toBe('gone')
    const node = await featureNodeStore().provision({ nodeId: 'update-node', accountId: 'account-a', grants: [grant] })
    const { ws } = await dial(node.token)
    const seen = new Promise<string>((resolve) => ws.once('close', (_code, reason) => resolve(reason.toString())))
    stopped = true
    await stopServer({ reason: 'self-update' })
    expect(await seen).toBe('server stopping: self-update')
    const stop = (await featureNodeJournal().read({ nodeId: 'update-node' })).events.filter((e) => e.type === 'server_stopping').at(-1)
    expect(stop).toMatchObject({ reason: 'self-update' })
    expect(stop).not.toHaveProperty('signal')
    expect(stop).not.toHaveProperty('nextBuild')
  })
})
