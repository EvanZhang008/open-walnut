import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WebSocket } from '#ws'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('feature-upgrade-e2e', { CLOUD_MODE: true }))
import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { featureNodeStore, featureNodeHub, verifyFeatureNode, startFeatureNodes, closeFeatureNodes } from '../../src/web/ws/feature-node-runtime.js'
import { FeatureNodeStore } from '../../src/core/feature-nodes/node-store.js'
import { wsProtocolsFor } from '../../src/lib/ws-bearer-protocol.js'
import { bridgeHosts } from '../../src/web/ws/bridge-registry.js'
import { createDevice } from '../../src/core/device-auth.js'
import { updateAuth } from '../../src/core/device-store.js'
import type { ReadFrame } from '../../src/core/feature-nodes/protocol.js'
import { FeatureNodeClient } from '../../src/core/feature-nodes/feature-client.js'
import { z } from 'zod'

let port: number
const sockets = new Set<WebSocket>()
const grant = { capability: { id: 'catalog.page', version: 1 }, fingerprint: 'catalog-v1' }
beforeAll(async () => {
  const server = await startServer({ port: 0, dev: true })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Synthetic port missing')
  port = address.port
  await fs.mkdir(path.join(WALNUT_HOME, 'secrets'), { recursive: true, mode: 0o700 })
})
afterAll(async () => { for (const ws of sockets) ws.close(); await stopServer() })

function dial(token: string): Promise<{ ws: WebSocket; ready: { generation: string } }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { headers: { Authorization: `Bearer ${token}` } })
  sockets.add(ws)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('Synthetic ready deadline')) }, 5000)
    ws.once('error', () => { clearTimeout(timer); reject(new Error('Synthetic connection refused')) })
    ws.once('message', (data) => {
      clearTimeout(timer)
      const ready = JSON.parse(data.toString())
      if (ready.type !== 'ready') { reject(new Error('Synthetic ready missing')); return }
      resolve({ ws, ready })
    })
  })
}
async function refused(pathname: string, token: string): Promise<number> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, { headers: { Authorization: `Bearer ${token}` } })
  sockets.add(ws)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('Synthetic refusal deadline')) }, 5000)
    ws.once('unexpected-response', (_req, response) => { clearTimeout(timer); response.resume(); ws.close(); resolve(response.statusCode ?? 0) })
    ws.once('open', () => { clearTimeout(timer); ws.close(); resolve(101) })
    ws.once('error', () => { clearTimeout(timer); resolve(401) })
  })
}

describe('dedicated feature credential on existing bridge door', () => {
  it('reaches the real feature upgrade through authenticated primary bridge discovery and reads', async () => {
    const machine = await createDevice('bridge-local', { kind: 'machine' })
    const primary = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { headers: { Authorization: `Bearer ${machine.token}` } })
    sockets.add(primary)
    await new Promise<void>((resolve, reject) => { primary.once('open', resolve); primary.once('error', reject) })
    let sequence = 0
    const pending = new Map<string, (value: Record<string, unknown>) => void>()
    primary.on('message', (data) => {
      const frame = JSON.parse(data.toString())
      if (frame.cmd === 'feature.result') {
        primary.send(JSON.stringify({ id: frame.id, ok: true, accepted: true }))
        pending.get(frame.requestId)?.({ result: frame.result })
        pending.delete(frame.requestId)
      } else if (frame.cmd === 'ping') primary.send(JSON.stringify({ id: frame.id, ok: true, pong: true }))
    })
    primary.send(JSON.stringify({ ev: 'hello', hostAlias: '__local__', capabilities: ['feature-relay-v1'], sids: [] }))
    await expect.poll(() => bridgeHosts().map((host) => host.hostAlias)).toContain('__local__')
    const node = await featureNodeStore().provision({ nodeId: 'relay-node', accountId: 'account-a', grants: [grant] })
    const { ws } = await dial(node.token)
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString())
      if (frame.type === 'read') ws.send(JSON.stringify({ protocolVersion: 1, type: 'result', generation: frame.generation,
        correlationId: frame.correlationId, success: true, payload: { count: 205 } }))
    })
    ws.send(JSON.stringify({ protocolVersion: 1, type: 'manifest', capabilities: [grant.capability] }))
    await expect.poll(async () => (await featureNodeHub().lookup('relay-node'))?.capabilities.length).toBe(1)
    const stableConnection = { hasCapability: () => true, send: (_command: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const requestId = `fixture:${++sequence}`
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Synthetic relay deadline')) }, 5000)
      pending.set(requestId, (value) => { clearTimeout(timer); resolve(value) })
      primary.send(JSON.stringify({ ev: 'feature-request', requestId, frame: params.frame }))
    }) }
    const reader = new FeatureNodeClient(() => stableConnection)
    reader.register({ ...grant, input: z.strictObject({}), output: z.strictObject({ count: z.number().int() }) })
    try {
      expect((await reader.list()).success).toBe(true)
      for (let i = 0; i < 3; i++) expect(await reader.read({ nodeId: 'relay-node', accountId: 'account-a', capability: grant.capability, input: {} }))
        .toEqual({ success: true, payload: { count: 205 } })
      await featureNodeStore().revoke('relay-node')
      expect(await reader.read({ nodeId: 'relay-node', accountId: 'account-a', capability: grant.capability, input: {} }))
        .toEqual({ success: false, code: 'offline' })
      expect(reader.resources.calls).toBe(0)
    } finally { reader.dispose(); primary.close(); ws.close() }
  })


  it('reads an isolated node but refuses REST, browser, tunnel and execution host identity', async () => {
    const created = await featureNodeStore().provision({ nodeId: 'node-a', accountId: 'account-a', grants: [grant] })
    const { ws, ready } = await dial(created.token)
    ws.send(JSON.stringify({ protocolVersion: 1, type: 'manifest', capabilities: [grant.capability] }))
    await expect.poll(async () => (await featureNodeHub().list())[0]?.capabilities.length).toBe(1)
    expect(bridgeHosts().map((host) => host.hostAlias)).not.toContain('node-a')
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString())
      if (frame.type === 'read') ws.send(JSON.stringify({ protocolVersion: 1, type: 'result', generation: frame.generation,
        correlationId: frame.correlationId, success: true, payload: { count: 205 } }))
    })
    const frame: ReadFrame = { protocolVersion: 1, type: 'read', nodeId: 'node-a', accountId: 'account-a',
      generation: ready.generation, correlationId: 'synthetic:1', capability: grant.capability, fingerprint: grant.fingerprint,
      permissionVersion: 1, expiresAt: Date.now() + 5000, input: {} }
    expect(await featureNodeHub().read(JSON.stringify(frame))).toMatchObject({ success: true, payload: { count: 205 } })
    for (const pathname of ['/ws', '/daemon-tunnel', `/bridge?token=${created.token}`]) expect(await refused(pathname, created.token)).toBe(401)
    const rest = await fetch(`http://127.0.0.1:${port}/api/v1/tasks`, { headers: { Authorization: `Bearer ${created.token}` } })
    expect(rest.status).toBe(401)
    await featureNodeStore().revoke('node-a')
    expect(await featureNodeHub().list()).toEqual([])
    await expect.poll(() => ws.readyState).toBe(WebSocket.CLOSED)
    expect(featureNodeHub().resources.calls).toBe(0)
  })

  it('rejects machine event frames and oversized frames before dispatch', async () => {
    for (const [nodeId, send] of [
      ['node-forged', (ws: WebSocket) => ws.send(JSON.stringify({ ev: 'hello', hostAlias: '__local__' }))],
      ['node-large', (ws: WebSocket) => ws.send('x'.repeat(65537))],
    ] as const) {
      const created = await featureNodeStore().provision({ nodeId, accountId: 'account-a', grants: [grant] })
      const { ws } = await dial(created.token)
      send(ws)
      if (nodeId === 'node-forged') ws.send('x'.repeat(65537))
      await expect.poll(() => ws.readyState).toBe(WebSocket.CLOSED)
      expect(bridgeHosts().map((host) => host.hostAlias)).not.toContain(nodeId)
    }
  })

  it('never echoes a bearer subprotocol and cannot reopen after a shutdown during verification', async () => {
    const created = await featureNodeStore().provision({ nodeId: 'node-protocol', accountId: 'account-a', grants: [grant] })
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, wsProtocolsFor(created.token).reverse())
    sockets.add(ws)
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    expect(ws.protocol).toBe('walnut.v1')
    expect(ws.protocol).not.toContain(created.token)
    ws.close()
    let release!: (value: typeof created.authority) => void
    const held = new Promise<typeof created.authority>((resolve) => { release = resolve })
    const spy = vi.spyOn(FeatureNodeStore.prototype, 'verify').mockReturnValueOnce(held)
    const verification = verifyFeatureNode(created.token)
    closeFeatureNodes()
    release(created.authority)
    expect(await verification).toBeUndefined()
    spy.mockRestore()
    startFeatureNodes()
  })

  it('limits distinct credential failures without counting infrastructure errors', async () => {
    const { _resetAuthRateLimitForTesting, isAuthRateLimited } = await import('../../src/web/middleware/auth-rate-limit.js')
    _resetAuthRateLimitForTesting()
    const rejected = (token: string) => new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': '192.0.2.21' } })
      sockets.add(ws)
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('Synthetic auth deadline')) }, 5000)
      ws.once('unexpected-response', (_request, response) => { clearTimeout(timer); response.resume(); ws.close(); resolve(response.statusCode ?? 0) })
      ws.on('error', () => {})
    })
    const spy = vi.spyOn(FeatureNodeStore.prototype, 'verify').mockRejectedValueOnce(new Error('Synthetic store unavailable'))
    expect(await rejected(`fn.${'0'.repeat(64)}`)).toBe(503)
    expect(isAuthRateLimited('192.0.2.21')).toBe(false)
    spy.mockRestore()
    for (let i = 0; i < 10; i++) expect(await rejected(`fn.${i.toString(16).padStart(64, '0')}`)).toBe(401)
    expect(await rejected(`fn.${'f'.repeat(64)}`)).toBe(429)
    _resetAuthRateLimitForTesting()
  })

  it('preserves persisted status-only machine denial rather than converting it into a feature node', async () => {
    const machine = await createDevice('bridge-status-peer', { kind: 'machine' })
    await updateAuth((auth) => {
      auth.devices.find((device) => device.name === 'bridge-status-peer')!.bridgeScope = 'status-only'
      return { persist: true, result: undefined }
    })
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { headers: { Authorization: `Bearer ${machine.token}` } })
    sockets.add(ws)
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.send(JSON.stringify({ protocolVersion: 1, type: 'manifest', capabilities: [grant.capability] }))
    expect(await featureNodeHub().list()).toEqual([])
    ws.close()
  })

  it('replaces an existing live connection at 32 nodes but refuses a different 33rd node', async () => {
    closeFeatureNodes()
    startFeatureNodes()
    const identity = (token: unknown) => {
      const index = Number.parseInt(String(token).slice(3), 16)
      return Number.isInteger(index) && index >= 0 && index <= 32
        ? { nodeId: `capacity-${index}`, accountId: 'account-a', permissionVersion: 1, grants: [grant] } : undefined
    }
    const spy = vi.spyOn(FeatureNodeStore.prototype, 'verify').mockImplementation(async (token) => identity(token))
    const peers: WebSocket[] = []
    try {
      for (let i = 0; i < 32; i++) peers.push((await dial(`fn.${i.toString(16).padStart(64, '0')}`)).ws)
      expect(featureNodeHub().size).toBe(32)
      const replacement = await dial(`fn.${'0'.repeat(64)}`)
      peers.push(replacement.ws)
      await expect.poll(() => peers[0].readyState).toBe(WebSocket.CLOSED)
      expect(featureNodeHub().size).toBe(32)
      await expect(dial(`fn.${(32).toString(16).padStart(64, '0')}`)).rejects.toThrow('refused')
      expect(featureNodeHub().size).toBe(32)
    } finally {
      for (const ws of peers) ws.terminate()
      closeFeatureNodes()
      spy.mockRestore()
      startFeatureNodes()
    }
  })
})
