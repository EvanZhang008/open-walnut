/**
 * host_mcp_* and host_http through a REAL server (core/hosts/host-mcp.ts, host-http.ts,
 * routes/host-exec-v1.ts, ops/host-reach.ts): a task's session on one host calls an MCP
 * server configured on another, and makes a web request from it, under the SAME grant as
 * host_exec, asked for by one letter when the caller's host is not one the user registered
 * (strangerbox; a task on a registered host, devbox, needs none). Listing server names needs no grant; tools, calls
 * and requests do; a call past the caller's gateway budget comes back running and is read
 * with host_mcp_result; credential-looking text is hidden; a daemon too old is named; a
 * revoked grant stops it all.
 *
 * Real: the server, the inbox and its answer route, the grants file, the op executor, and
 * the host side (host-mcp-core.ts starting a real stdio MCP server through /bin/sh, and
 * host-http-core.ts making a real request). Fake: only the transport to the target host,
 * which runs the host cores in-process.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-reach-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import * as daemonConnections from '../../src/providers/daemon-connection.js'
import { createHostMcp, type HostMcp } from '../../src/providers/host-mcp-core.js'
import { createHostHttp } from '../../src/providers/host-http-core.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { resetHostMcpForTest } from '../../src/core/hosts/host-mcp.js'
import { resetHostHttpForTest } from '../../src/core/hosts/host-http.js'
import { __setTransferConnectionResolverForTesting } from '../../src/core/transfer/daemon-transfer-client.js'

let server: HttpServer
let service: HttpServer
let servicePort = 0
let port: number
let hostRoot: string
let mcp: HostMcp
const SID = 'host-reach-e2e-session'
const OWN_SID = 'host-reach-e2e-own'
let taskId = ''
const sent: Array<{ cmd: string; params: Record<string, unknown> }> = []
const FAKE = path.resolve(__dirname, '../fixtures/mcp/host-mcp-fake.cjs')
// Random bytes made up at each run, shaped like a GitHub token so the redaction scanner sees one: never a credential.
const FAKE_TOKEN = 'ghp_' + randomBytes(27).toString('base64url').replace(/[-_]/g, 'x').slice(0, 36)

/** A session's call comes through its host's gateway, which sets its deadline (20 s from when the server got it). */
async function api(method: string, p: string, body?: unknown, sid?: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid, 'x-walnut-answer-by': String(Date.now() + 20_000) } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}

async function until(fn: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const call = (server: string, body: Record<string, unknown>) => api('POST', `/api/v1/hosts/macbox/mcp/${encodeURIComponent(server)}/call`, body, SID)

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  hostRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-host-reach-e2e-')))
  const home = path.join(hostRoot, 'home')
  await fs.mkdir(home, { recursive: true })
  // The target host's own Claude Code config: its MCP server and a value that stays there.
  await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {
    fake: { command: process.execPath, args: [FAKE], env: { FAKE_TOKEN: 'only-on-macbox' } },
  } }))
  mcp = createHostMcp({
    spawn: (await import('node:child_process')).spawn,
    killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
    shell: '/bin/sh', home, env: { PATH: process.env.PATH, HOME: home },
  })
  const httpCore = createHostHttp()
  const macbox = {
    connected: true, hostKey: 'macbox', connect: async () => {},
    hasCapability: (c: string) => c === 'host-mcp-v1' || c === 'host-http-v1',
    send: async (cmd: string, params: Record<string, unknown> = {}) => {
      sent.push({ cmd, params })
      if (cmd === 'http.request') return httpCore.request(params)
      const op = cmd.slice('mcp.'.length) as 'list' | 'tools' | 'call' | 'result'
      return (mcp[op] as (p: unknown) => Promise<Record<string, unknown>>)(params)
    },
  }
  const oldbox = { connected: true, hostKey: 'oldbox', connect: async () => {}, hasCapability: () => false, send: async () => ({ ok: false, error: 'unknown command' }) }
  const devbox = { connected: true, hostKey: 'devbox', connect: async () => {}, hasCapability: () => false, send: async () => ({ ok: false, error: 'unknown command' }) }
  const real = daemonConnections.getDaemonConnection
  vi.spyOn(daemonConnections, 'getDaemonConnection').mockImplementation(async (key, target) =>
    key === 'macbox' ? macbox as unknown as daemonConnections.DaemonConnection
      : key === 'oldbox' ? oldbox as unknown as daemonConnections.DaemonConnection
        : key === 'devbox' || key === 'strangerbox' ? devbox as unknown as daemonConnections.DaemonConnection : real(key, target))
  // A web service only "macbox" runs (here: on this machine's loopback).
  service = http.createServer((req, res) => {
    if (req.url === '/leak') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`ok\ntoken=${FAKE_TOKEN}\nend\n`); return }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=abc' })
    res.end(JSON.stringify({ path: req.url, method: req.method }))
  })
  await new Promise<void>((r) => service.listen(0, '127.0.0.1', () => r()))
  servicePort = (service.address() as { port: number }).port
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  await updateConfig({ hosts: { devbox: { hostname: 'devbox.example' }, macbox: { hostname: 'macbox.example', label: 'Mac box' }, oldbox: { hostname: 'oldbox.example' } } })
  const created = await api('POST', '/api/v1/tasks', { title: 'Search the docs' })
  taskId = created.body.task?.id ?? created.body.id
  await createSessionRecord(SID, taskId, '', '/home/me/repo', { host: 'strangerbox', title: 'docs', initialProcessStatus: 'stopped' } as never)
  const own = await api('POST', '/api/v1/tasks', { title: 'Read the dashboard' })
  await createSessionRecord(OWN_SID, own.body.task?.id ?? own.body.id, '', '/home/me/dash', { host: 'devbox', title: 'dash', initialProcessStatus: 'stopped' } as never)
}, 120_000)

afterAll(async () => {
  mcp?.closeAll()
  await stopServer()
  service?.close()
  vi.restoreAllMocks()
  __setTransferConnectionResolverForTesting(null)
  resetHostMcpForTest()
  resetHostHttpForTest()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(hostRoot, { recursive: true, force: true }).catch(() => {})
})

describe('host_mcp and host_http', () => {
  it('lists names without a grant, and refuses a non-session, its own host, an unknown host, an old daemon', async () => {
    expect(await api('GET', '/api/v1/hosts/macbox/mcp')).toMatchObject({ status: 403, body: { code: 'session_only' } })
    expect(await api('GET', '/api/v1/hosts/strangerbox/mcp', undefined, SID)).toMatchObject({ status: 400, body: { code: 'same_host', error: expect.stringContaining('your own tools') } })
    expect(await api('GET', '/api/v1/hosts/nosuch/mcp', undefined, SID)).toMatchObject({ status: 404, body: { code: 'unknown_host' } })
    expect(await api('GET', '/api/v1/hosts/oldbox/mcp', undefined, SID)).toMatchObject({ status: 409, body: { code: 'daemon_upgrade', error: expect.stringContaining('call its MCP servers') } })
    expect(await api('POST', '/api/v1/hosts/oldbox/http', { url: 'http://localhost/' }, SID)).toMatchObject({ status: 403, body: { code: 'exec_grant_required' } })
    const listed = await executeOp('host_mcp_list', { host: 'macbox' }, { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: SID }) as { ok: boolean; result: Record<string, unknown> }
    expect(listed).toMatchObject({ ok: true, result: { host: 'macbox', servers: [{ name: 'fake', scope: 'user', type: 'stdio' }] } })
    expect(sent.map((m) => m.cmd)).toEqual(['mcp.list'])
  })

  it('one letter covers MCP calls and web requests; after Allow both work, with credentials hidden', async () => {
    const first = await call('fake', { tool: 'echo', arguments: { text: 'hi' } })
    expect(first).toMatchObject({ status: 403, body: { code: 'exec_grant_required' } })
    const letterId = first.body.letterId as string
    // A web request while the user has not answered: the same letter, no second one.
    expect(await api('POST', '/api/v1/hosts/macbox/http', { url: `http://127.0.0.1:${servicePort}/x` }, SID)).toMatchObject({ status: 403, body: { letterId } })
    const inbox = (await api('GET', '/api/v1/human-inbox?limit=50')).body
    const asks = ((inbox.letters ?? inbox.items) as Array<{ id: string; subject: string; markdown?: string }>).filter((l) => l.subject.endsWith('use Mac box?'))
    expect(asks.map((l) => l.id)).toEqual([letterId])
    expect(asks[0].subject).toBe('Let "Search the docs" use Mac box?')
    expect(sent.filter((m) => m.cmd !== 'mcp.list')).toEqual([])

    expect((await api('POST', `/api/v1/human-inbox/${letterId}/answer`, { actionId: 'allow' })).status).toBeLessThan(300)
    await until(async () => ((await api('GET', '/api/v1/host-exec/grants')).body.grants ?? []).length === 1, 'the grant')

    const tools = await executeOp('host_mcp_tools', { host: 'macbox', server: 'fake' }, { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: SID }) as { ok: boolean; result: Record<string, unknown> }
    expect(tools.ok).toBe(true)
    expect((tools.result.tools as Array<{ name: string }>).map((t) => t.name)).toContain('echo')
    expect(String(tools.result.outcome)).toMatch(/^9 tool\(s\) on fake on macbox/)

    const viaOp = await executeOp('host_mcp_call', { host: 'macbox', server: 'fake', tool: 'env', arguments: { name: 'FAKE_TOKEN' } },
      { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: SID }) as { ok: boolean; result: Record<string, unknown> }
    // The value lives in that host's config and is used there; only the tool's answer comes back.
    expect(viaOp).toMatchObject({ ok: true, result: { host: 'macbox', server: 'fake', tool: 'env', isError: false, running: false, text: 'only-on-macbox' } })
    expect(sent.find((m) => m.cmd === 'mcp.call')!.params).toMatchObject({ taskId, server: 'fake', tool: 'env' })
    expect(JSON.stringify(sent.map((m) => m.params))).not.toContain('only-on-macbox')

    // An image the tool returns becomes a file in the calling session's task directory on ITS
    // host (strangerbox), written there through its daemon; no base64 reaches the agent.
    const devboxTasks = path.join(hostRoot, 'devbox-tasks')
    const writes: Array<Record<string, unknown>> = []
    const realConnected = daemonConnections.getConnectedDaemonConnection
    const connectedSpy = vi.spyOn(daemonConnections, 'getConnectedDaemonConnection').mockImplementation((key: string) =>
      key === 'strangerbox' ? { taskDirRoot: devboxTasks } as unknown as daemonConnections.DaemonConnection : realConnected(key))
    __setTransferConnectionResolverForTesting(async (h) => h !== 'strangerbox' ? [] : [{
      hasCapability: (c: string) => c === 'fs-write-part-v1',
      send: async (cmd: string, p: Record<string, unknown>) => {
        writes.push({ cmd, path: p.path, final: p.final })
        await fs.mkdir(path.dirname(String(p.path)), { recursive: true })
        await fs.writeFile(String(p.path), Buffer.from(String(p.data), 'base64'))
        return { ok: true, staged: p.size, done: true }
      },
    }])
    const pic = await executeOp('host_mcp_call', { host: 'macbox', server: 'fake', tool: 'image' },
      { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: SID }) as { ok: boolean; result: Record<string, unknown> }
    const images = pic.result.images as Array<{ mimeType: string; bytes: number; path?: string; data?: string }>
    expect(images).toEqual([{ mimeType: 'image/png', bytes: 300, path: expect.stringMatching(new RegExp(`^${devboxTasks}/${taskId}/host-mcp/mc-[\\w-]+-1\\.png$`)) }])
    expect(writes).toEqual([{ cmd: 'fs.writePart', path: images[0].path, final: true }])
    expect(await fs.readFile(images[0].path!)).toEqual(Buffer.alloc(300, 1))
    expect(String(pic.result.outcome)).toContain(`Image(s) saved: ${images[0].path}`)
    // A kept answer read again writes it again, into the same file.
    const again = await api('GET', `/api/v1/hosts/macbox/mcp-calls/${String(pic.result.callId)}`, undefined, SID)
    expect(again.body.images).toEqual(images)
    connectedSpy.mockRestore()
    __setTransferConnectionResolverForTesting(null)

    const secret = await call('fake', { tool: 'secret' })
    expect(secret.status).toBe(200)
    expect(secret.body.text).toMatch(/^before\n\[Walnut hid this line: it looks like a credential \([^)]+\)\]\nafter$/)
    expect(secret.body.text).not.toContain('ghp_')
    expect(secret.body).toMatchObject({ redactedLines: 1, structured: { ok: true } })
    expect(await call('fake', { tool: 'fails' })).toMatchObject({ status: 200, body: { isError: true, text: 'it went wrong' } })
    expect(await call('fake', { tool: 'nope' })).toMatchObject({ status: 502, body: { code: 'server_failed' } })
    // A server that dies quoting a credential on stderr: its words come back, the credential does not.
    const died = await call('fake', { tool: 'crashleak' })
    expect(died).toMatchObject({ status: 502, body: { code: 'server_failed' } })
    expect(died.body.error).toContain('exit 9')
    expect(died.body.error).not.toContain('ghp_')
    expect(await call('missing', { tool: 'echo' })).toMatchObject({ status: 404, body: { code: 'unknown_server' } })

    const web = await executeOp('host_http', { host: 'macbox', url: `http://127.0.0.1:${servicePort}/api/health?q=1`, method: 'post', body: '{}' },
      { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: SID }) as { ok: boolean; result: Record<string, unknown> }
    expect(web).toMatchObject({ ok: true, result: { host: 'macbox', status: 200, contentType: 'application/json' } })
    expect(JSON.parse(String(web.result.body))).toEqual({ path: '/api/health?q=1', method: 'POST' })
    expect((web.result.headers as Record<string, string>)['set-cookie']).toBe('[hidden by Walnut]')
    expect(String(web.result.outcome)).toMatch(/^HTTP 200 from /)
    const leak = await api('POST', '/api/v1/hosts/macbox/http', { url: `http://127.0.0.1:${servicePort}/leak` }, SID)
    expect(leak.body.body).not.toContain('ghp_')
    expect(leak.body).toMatchObject({ redactedLines: 1 })
    expect(await api('POST', '/api/v1/hosts/macbox/http', { url: 'file:///etc/passwd' }, SID)).toMatchObject({ status: 400, body: { code: 'bad_request' } })

    await until(async () => ((await api('GET', '/api/v1/host-exec/grants')).body.grants[0].runs ?? 0) >= 7, 'the use count')
    const [g] = (await api('GET', '/api/v1/host-exec/grants')).body.grants
    expect(g.lastCommand).toMatch(/^(GET|POST) http:\/\/127\.0\.0\.1:/)
  }, 60_000)

  it('a call past the caller\'s gateway budget comes back running and is read with host_mcp_result', async () => {
    const t0 = Date.now()
    const slow = await call('fake', { tool: 'slow', arguments: { ms: 15_000 }, timeout_ms: 60_000 })
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(slow).toMatchObject({ status: 200, body: { running: true, callId: expect.stringMatching(/^mc-/) } })
    const done = await api('GET', `/api/v1/hosts/macbox/mcp-calls/${slow.body.callId}?wait_ms=10000`, undefined, SID)
    expect(done).toMatchObject({ status: 200, body: { running: false, text: 'slept 15000' } })
  }, 60_000)

  it('a revoked grant stops calls and requests; listing names still works', async () => {
    const [g] = (await api('GET', '/api/v1/host-exec/grants')).body.grants
    expect((await api('DELETE', `/api/v1/host-exec/grants/${g.id}`)).status).toBe(200)
    expect(await call('fake', { tool: 'echo' })).toMatchObject({ status: 403, body: { code: 'exec_grant_required' } })
    // A read after a revoke reads as revoked (2026-11-05: one code for one state).
    expect((await api('GET', `/api/v1/hosts/macbox/mcp-calls/mc-anything-1234`, undefined, SID))).toMatchObject({ status: 403, body: { code: 'exec_grant_revoked' } })
    expect((await api('GET', '/api/v1/hosts/macbox/mcp', undefined, SID)).status).toBe(200)
  }, 30_000)

  it('a task on a registered host calls MCP servers and web services there with no letter', async () => {
    const inboxBefore = (await api('GET', '/api/v1/human-inbox?limit=50')).body
    const before = ((inboxBefore.letters ?? inboxBefore.items) as unknown[]).length
    const web = await api('POST', '/api/v1/hosts/macbox/http', { url: `http://127.0.0.1:${servicePort}/own` }, OWN_SID)
    expect(web).toMatchObject({ status: 200, body: { status: 200 } })
    const tools = await api('GET', '/api/v1/hosts/macbox/mcp/fake/tools', undefined, OWN_SID)
    expect(tools.status).toBe(200)
    const inbox = (await api('GET', '/api/v1/human-inbox?limit=50')).body
    expect(((inbox.letters ?? inbox.items) as unknown[]).length).toBe(before)
  }, 30_000)
})
