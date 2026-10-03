/**
 * /api/mcp and the registry behind it, over a real socket and a real stdio MCP server process
 * (tests/fixtures/mcp/fake-stdio-server.mjs): who may call what (read-only tools for outside
 * callers, writes only on a server opened to sessions and only from this Mac), the failure codes a
 * CLI turns into sentences, the answer shape, restart, ownership of a name, and the status events
 * Settings listens to.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo, Server } from 'node:net'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-mcp-routes'))

const { createMcpServersRouter } = await import('../../src/web/routes/mcp-servers.js')
const { registerMcpServer, listMcpServers, getMcpConnection, closeAllMcpServers } = await import('../../src/core/mcp-servers/registry.js')
const { bus } = await import('../../src/core/event-bus.js')
const { MCP_STATUS_EVENT } = await import('../../src/core/mcp-servers/types.js')

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/mcp/fake-stdio-server.mjs')

let server: Server
let base: string
let dir: string
const registrations: Array<{ dispose(): Promise<void> }> = []
/** Each registration logs to its own file: tests reuse names, and one test's calls are not another's. */
const logs = new Map<string, string>()
let logSeq = 0

function register(name: string, sessions: 'read-only' | 'all' | 'none', owner = 'test-plugin', extra: Record<string, unknown> = {}) {
  const log = path.join(dir, `${name}-${++logSeq}.jsonl`)
  logs.set(name, log)
  const registration = registerMcpServer(owner, {
    name, command: process.execPath, args: [FIXTURE], sessions,
    env: { FAKE_MCP_LOG: log }, ...extra,
  })
  registrations.push(registration)
  return registration
}

async function post(route: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, any> }
}

async function get(route: string) {
  const res = await fetch(`${base}${route}`)
  return { status: res.status, body: await res.json() as Record<string, any> }
}

const callsTo = (name: string) => {
  const file = logs.get(name)
  if (!file || !fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((one) => one.kind === 'call')
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-mcp-routes-'))
  const app = express()
  app.use(express.json())
  app.use('/api/mcp', createMcpServersRouter())
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await Promise.all(registrations.splice(0).map((one) => one.dispose()))
})

afterAll(async () => {
  await closeAllMcpServers()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/mcp/servers', () => {
  it('lists every registration sorted, without starting any', async () => {
    register('zeta', 'read-only')
    register('alpha', 'all', 'other-plugin')
    const { status, body } = await get('/api/mcp/servers')
    expect(status).toBe(200)
    expect(body.servers.map((one: { name: string }) => one.name)).toEqual(['alpha', 'zeta'])
    expect(body.servers[0]).toMatchObject({ owner: 'other-plugin', state: 'idle', sessions: 'all' })
    expect(callsTo('zeta')).toHaveLength(0)
    // The fake writes a start line the moment it runs: no file means no process.
    expect(fs.existsSync(logs.get('zeta')!)).toBe(false)
  })
})

describe('reads', () => {
  it('a read-only tool answers with its JSON already parsed', async () => {
    register('reader', 'read-only')
    const { status, body } = await post('/api/mcp/servers/reader/read', { tool: 'echo', arguments: { q: 'hi' } })
    expect(status).toBe(200)
    expect(body).toEqual({ isError: false, data: { echoed: { q: 'hi' } } })
  })

  it('an isError answer is still a 200 answer, flagged', async () => {
    register('reader', 'read-only')
    const { status, body } = await post('/api/mcp/servers/reader/read', { tool: 'fail' })
    expect(status).toBe(200)
    expect(body.isError).toBe(true)
    expect(body.data).toEqual({ error: 'channel_not_found', message: 'No such channel' })
  })

  it('a tool that may change something is refused on read, and never reaches the server', async () => {
    register('reader', 'read-only')
    for (const tool of ['note_write', 'wipe']) {
      const { status, body } = await post('/api/mcp/servers/reader/read', { tool })
      expect(status).toBe(403)
      expect(body.error.code).toBe('mcp_tool_not_read_only')
      expect(body.error.message).toMatch(/read-only tools only/)
    }
    expect(callsTo('reader').filter((one) => one.tool !== 'echo')).toHaveLength(0)
  })

  it('an unknown tool is a 404 that names the problem; an unknown server lists what exists', async () => {
    register('reader', 'read-only')
    const tool = await post('/api/mcp/servers/reader/read', { tool: 'nope' })
    expect(tool.status).toBe(404)
    expect(tool.body.error.code).toBe('mcp_tool_not_found')
    const missing = await post('/api/mcp/servers/ghost/read', { tool: 'echo' })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('mcp_server_not_found')
    expect(missing.body.error.message).toMatch(/Registered: reader/)
  })

  it('a server kept for its plugin answers no outside caller', async () => {
    register('private', 'none')
    const read = await post('/api/mcp/servers/private/read', { tool: 'echo' })
    expect(read.status).toBe(403)
    expect(read.body.error.code).toBe('mcp_not_exposed')
    const call = await post('/api/mcp/servers/private/call', { tool: 'echo' })
    expect(call.status).toBe(403)
    expect(callsTo('private')).toHaveLength(0)
  })

  it('a deadline that passes is a 504 with the stage, so a caller knows it may have run', async () => {
    register('reader', 'read-only')
    const { status, body } = await post('/api/mcp/servers/reader/read', { tool: 'slow', arguments: { ms: 5000 }, timeout_ms: 200 })
    expect(status).toBe(504)
    expect(body.error).toMatchObject({ code: 'mcp_timeout', stage: 'after-call' })
  })

  it('a bad body is a 400', async () => {
    register('reader', 'read-only')
    expect((await post('/api/mcp/servers/reader/read', {})).status).toBe(400)
    expect((await post('/api/mcp/servers/reader/read', { tool: 'echo', arguments: [1] })).status).toBe(400)
  })
})

describe('calls that may change something', () => {
  it('only on a server opened to sessions', async () => {
    register('reader', 'read-only')
    const { status, body } = await post('/api/mcp/servers/reader/call', { tool: 'note_write' })
    expect(status).toBe(403)
    expect(body.error.code).toBe('mcp_not_exposed')
    expect(callsTo('reader')).toHaveLength(0)
  })

  it('from this Mac they run', async () => {
    register('open', 'all')
    const { status, body } = await post('/api/mcp/servers/open/call', { tool: 'note_write', arguments: { text: 'x' } })
    expect(status).toBe(200)
    expect(body.data).toEqual({ written: true })
  })

  it('for a caller off this Mac they are refused, even on an open server', async () => {
    register('open', 'all')
    const { status, body } = await post('/api/mcp/servers/open/call', { tool: 'note_write' }, { 'x-walnut-origin': 'build-box' })
    expect(status).toBe(403)
    expect(body.error.code).toBe('mcp_local_only')
    expect(callsTo('open')).toHaveLength(0)
    // Reads still answer that caller.
    const read = await post('/api/mcp/servers/open/read', { tool: 'echo' }, { 'x-walnut-origin': 'build-box' })
    expect(read.status).toBe(200)
  })

  it('a write tool asked through read on an open server points at call', async () => {
    register('open', 'all')
    const { status, body } = await post('/api/mcp/servers/open/read', { tool: 'note_write' })
    expect(status).toBe(403)
    expect(body.error.message).toMatch(/call it with mcp_call/)
  })
})

describe('tools and restart', () => {
  it('tools lists annotations and the status after the start', async () => {
    register('reader', 'read-only')
    const { status, body } = await get('/api/mcp/servers/reader/tools')
    expect(status).toBe(200)
    expect(body.server).toMatchObject({ name: 'reader', state: 'ready', toolCount: body.tools.length })
    expect(body.tools.find((tool: { name: string }) => tool.name === 'echo')).toMatchObject({ readOnly: true })
  })

  it('a server that cannot start answers 503 with the reason, and the list shows it failed', async () => {
    register('broken', 'read-only', 'test-plugin', { command: path.join(dir, 'missing-binary') })
    const { status, body } = await get('/api/mcp/servers/broken/tools')
    expect(status).toBe(503)
    expect(body.error).toMatchObject({ code: 'mcp_unavailable', stage: 'before-call' })
    const list = await get('/api/mcp/servers')
    expect(list.body.servers[0]).toMatchObject({ name: 'broken', state: 'failed' })
    expect(list.body.servers[0].lastError).toMatch(/command was not found/)
  })

  it('restart gives a new process; refused for a caller off this Mac', async () => {
    register('reader', 'read-only')
    await post('/api/mcp/servers/reader/read', { tool: 'echo' })
    const pid = getMcpConnection('reader')!.pid()
    const remote = await post('/api/mcp/servers/reader/restart', {}, { 'x-walnut-origin': 'build-box' })
    expect(remote.status).toBe(403)
    expect(getMcpConnection('reader')!.pid()).toBe(pid)
    const { status, body } = await post('/api/mcp/servers/reader/restart', {})
    expect(status).toBe(200)
    expect(body.server.state).toBe('ready')
    expect(getMcpConnection('reader')!.pid()).not.toBe(pid)
  })
})

describe('registry', () => {
  it('one owner per name; the same owner replaces its own registration', async () => {
    register('shared', 'read-only', 'plugin-a')
    expect(() => register('shared', 'read-only', 'plugin-b')).toThrow(/already registered by plugin-a/)
    await post('/api/mcp/servers/shared/read', { tool: 'echo' })
    const before = getMcpConnection('shared')!
    const pid = before.pid()
    register('shared', 'all', 'plugin-a')
    expect(getMcpConnection('shared')).not.toBe(before)
    expect(getMcpConnection('shared')!.status()).toMatchObject({ sessions: 'all', state: 'idle' })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try { process.kill(pid!, 0) } catch { break }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(() => process.kill(pid!, 0)).toThrow()
  })

  it('a replaced registration\'s dispose leaves the new one in place', async () => {
    const first = register('shared', 'read-only', 'plugin-a')
    register('shared', 'all', 'plugin-a')
    await first.dispose()
    expect(listMcpServers().map((one) => one.name)).toEqual(['shared'])
    expect(getMcpConnection('shared')!.status().sessions).toBe('all')
  })

  it('rejects names and definitions it cannot run', () => {
    for (const name of ['', 'Upper', 'has space', '../x', 'x'.repeat(65)]) {
      expect(() => registerMcpServer('p', { name, command: 'x' })).toThrow(/must be lowercase/)
    }
    expect(() => registerMcpServer('p', { name: 'ok', command: ' ' })).toThrow(/needs a command/)
    expect(() => registerMcpServer('p', { name: 'ok', command: 'x', args: [1 as unknown as string] })).toThrow(/args must be strings/)
    expect(() => registerMcpServer('p', { name: 'ok', command: 'x', sessions: 'some' as 'all' })).toThrow(/sessions is/)
    expect(listMcpServers()).toEqual([])
  })

  it('announces registration, state changes and removal on the bus for Settings', async () => {
    const seen: Array<{ name: string; state: string | null }> = []
    bus.subscribe('test-mcp-status', (event) => {
      const data = event.data as { name: string; status: { state: string } | null }
      seen.push({ name: data.name, state: data.status?.state ?? null })
    }, { global: true, interest: [MCP_STATUS_EVENT] })
    try {
      const registration = register('watched', 'read-only')
      await post('/api/mcp/servers/watched/read', { tool: 'echo' })
      await registration.dispose()
      expect(seen.map((one) => one.state)).toEqual(expect.arrayContaining(['idle', 'starting', 'ready', null]))
      expect(seen[seen.length - 1]).toEqual({ name: 'watched', state: null })
    } finally {
      bus.unsubscribe('test-mcp-status')
    }
  })
})
