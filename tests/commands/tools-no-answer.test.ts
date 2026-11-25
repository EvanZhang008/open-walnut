/**
 * Every Walnut tool-call client of a session counts a call no Walnut answered (lib/no-answer-report.ts).
 *
 * 2026-11-25 daily audit: of 11 such failures in session transcripts, 4 reached `usage_watch errors`.
 *   - The Mac's `walnut tools call` (src/commands/tools.ts) reaches its server over HTTP. While a deploy
 *     restarts the server and the daemon inside it, its call fails "Walnut server not running", and it
 *     kept none: 5 of 5 missed.
 *   - The other 2 were MCP servers started before the client counted anything (the sessions' processes
 *     dated from 11-22 and 11-24 14:45Z): nothing in code reaches a process that old.
 * Pinned:
 *   - the Mac CLI keeps such a call in the session's spool and tells it with its next call over HTTP,
 *     under the code it printed (the session hook reads the same one, so the two count once); a
 *     server's refusal keeps nothing, nor does a trigger check's call;
 *   - the `open-walnut mcp` mount (Main, an ask, a console agent) keeps its own the same way
 *     (2026-11-25 review: it was a client the first fix missed), and its report never holds the
 *     answer of that long-lived server;
 *   - `walnut guide` and `walnut mcp` keep theirs too;
 *   - a report this host's daemon answered itself while its Walnut was away (`offline: true`) was taken
 *     by no hub: it is kept for the next call, by the CLI and the MCP server alike;
 *   - the MCP server keeps its own in the same spool, so a later process of the session (or its CLI)
 *     tells what an earlier one could not;
 *   - piped into another command (the shell's status is the reader's, so the session hook sees no
 *     failure), the Mac CLI keeps it all the same.
 * Every agent tool-call client in the source keeps them: tests/core/usage-watch/no-answer-clients-guard.test.ts.
 *
 * Real pieces: runTools, the op executor's HTTP calls (a port nothing listens on, then a small HTTP
 * server), the daemon CLI client over a real unix socket (a small NDJSON server recording what it was
 * asked), and the MCP handler. No Walnut server, no daemon process. The piped case runs the CLI as its
 * own process behind a real shell pipe.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { runTools } from '../../src/commands/tools.js'
import { createWalnutMcpServer } from '../../src/mcp/server.js'
import { NO_ANSWER_MAX_AGE_MS, noAnswerSpoolFile, spoolNoAnswer, takeSpooledNoAnswers } from '../../src/lib/no-answer-report.js'
import { createWalnutMcpHandler } from '../../src/providers/walnut-mcp-stdio.js'
import type { GatewayResponse } from '../../src/providers/gateway-core.js'

const SID = '5b2e8c1a-7d3f-4a90-b6e1-2c4f8a9d0e13'
const ROOT = path.resolve(__dirname, '../..')
let dir: string
let sock: string
let spool: string
let gateway: net.Server | null = null
let api: http.Server | null = null
let apiPort = 0
let deadPort = 0
let asked: Array<Record<string, unknown>> = []
let listAnswer: Record<string, unknown> = { ok: true, result: { recorded: true, no_answer: 1 } }
/** How the Walnut server answers every request: a status and a body. */
let apiAnswer: { status: number; body: unknown } = { status: 200, body: { mode: 'ONLINE' } }
const saved: Record<string, string | undefined> = {}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

/** This host's daemon, back: it records each line and answers a report as the hub would. */
async function daemonUp(): Promise<void> {
  gateway = net.createServer((c) => {
    let buf = ''
    c.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>
      asked.push(req)
      c.end(JSON.stringify(req.op === 'tools.list' ? listAnswer : { ok: true, result: {} }) + '\n')
    })
  })
  await new Promise<void>((resolve) => gateway!.listen(sock, resolve))
}

/** The Walnut server, back: every GET answers a small status. */
async function serverUp(): Promise<void> {
  api = http.createServer((_req, res) => {
    res.statusCode = apiAnswer.status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(apiAnswer.body))
  })
  await new Promise<void>((resolve) => api!.listen(0, '127.0.0.1', resolve))
  apiPort = (api.address() as net.AddressInfo).port
  process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${apiPort}`
}

const reports = () => asked.filter((r) => r.op === 'tools.list').map((r) => (r.args as { report?: { no_answer?: unknown[] } }).report?.no_answer)

beforeAll(async () => { deadPort = await freePort() })

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-no-answer-'))
  fs.chmodSync(dir, 0o700)
  sock = path.join(dir, 'agent-gateway.sock')
  spool = noAnswerSpoolFile(sock, SID)!
  asked = []
  listAnswer = { ok: true, result: { recorded: true, no_answer: 1 } }
  apiAnswer = { status: 200, body: { mode: 'ONLINE' } }
  for (const k of ['OPEN_WALNUT_API_URL', 'WALNUT_AGENT_SOCKET', 'WALNUT_SESSION_ID', 'WALNUT_CHECK_TOKEN']) saved[k] = process.env[k]
  delete process.env.WALNUT_CHECK_TOKEN
  process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${deadPort}`
  process.env.WALNUT_AGENT_SOCKET = sock
  process.env.WALNUT_SESSION_ID = SID
  process.exitCode = 0
  vi.spyOn(process.stdout, 'write').mockImplementation(((_c: unknown, ...rest: unknown[]) => {
    const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined
    cb?.()
    return true
  }) as typeof process.stdout.write)
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (gateway) await new Promise<void>((resolve) => gateway!.close(() => resolve()))
  if (api) await new Promise<void>((resolve) => api!.close(() => resolve()))
  gateway = null
  api = null
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  process.exitCode = 0
  fs.rmSync(dir, { recursive: true, force: true })
})

afterAll(() => { process.exitCode = 0 })

describe('the Mac\'s walnut tools call', () => {
  it('keeps a call no Walnut answered (server and daemon restarting) and tells it with its next call over HTTP', async () => {
    await runTools(['call', 'walnut_status', '{}'], {})
    expect(process.exitCode).toBe(1)
    const kept = takeSpooledNoAnswers(spool)
    expect(kept.report).toEqual([{ op: 'walnut_status', code: 'hub_unreachable', client: 'cli', ms: expect.any(Number), id: expect.any(String) }])

    await serverUp()
    await daemonUp()
    process.exitCode = 0
    await runTools(['call', 'walnut_status', '{}'], {})
    expect(process.exitCode ?? 0).toBe(0)
    expect(reports()).toEqual([[{ op: 'walnut_status', code: 'hub_unreachable', client: 'cli', ms: expect.any(Number), id: expect.any(String) }]])
    expect(asked[0]).toMatchObject({ op: 'tools.list', sid: SID })
    expect(takeSpooledNoAnswers(spool).report).toEqual([])

    // Told once: the next call that works finds nothing kept and asks the daemon nothing.
    await runTools(['call', 'walnut_status', '{}'], {})
    expect(reports()).toHaveLength(1)
  })

  it('a report this host\'s daemon answered itself while its Walnut was away is kept for the next call', async () => {
    spoolNoAnswer(spool, 'task_get', 'hub_unreachable', 'cli')
    await serverUp()
    await daemonUp()
    listAnswer = { ok: true, result: { ops: [], offline: true } }
    await runTools(['call', 'walnut_status', '{}'], {})
    expect(reports()).toHaveLength(1)
    const kept = takeSpooledNoAnswers(spool)
    expect(kept.report.map((n) => `${n.op}:${n.code}`)).toEqual(['task_get:hub_unreachable'])
    listAnswer = { ok: true, result: { recorded: true, no_answer: 1 } }
    await runTools(['call', 'walnut_status', '{}'], {})
    expect(reports()).toHaveLength(2)
    expect(takeSpooledNoAnswers(spool).report).toEqual([])
  })

  it('outside a session nothing is kept, nor in a trigger check', async () => {
    delete process.env.WALNUT_SESSION_ID
    await runTools(['call', 'walnut_status', '{}'], {})
    expect(fs.existsSync(spool)).toBe(false)
    process.env.WALNUT_SESSION_ID = SID
    process.env.WALNUT_CHECK_TOKEN = 'chk-0001'
    await runTools(['call', 'walnut_status', '{}'], {})
    expect(fs.existsSync(spool)).toBe(false)
  })

  it('a server\'s refusal is an answer: nothing is kept', async () => {
    await serverUp()
    apiAnswer = { status: 409, body: { error: { code: 'conflict', message: 'changed meanwhile' } } }
    await runTools(['call', 'walnut_status', '{}'], {})
    expect(process.exitCode).toBe(1)
    expect(fs.existsSync(spool)).toBe(false)
  })

  it('an answer broken off is kept under the code the CLI printed, as the session hook reads it', async () => {
    // A server whose answer breaks off after it began: "Walnut request failed reading its answer".
    api = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' })
      res.write('{"mode":')
      setTimeout(() => req.socket.destroy(), 20)
    })
    await new Promise<void>((resolve) => api!.listen(0, '127.0.0.1', resolve))
    process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${(api.address() as net.AddressInfo).port}`
    let printed = ''
    vi.mocked(process.stderr.write).mockImplementation(((c: unknown) => { printed += String(c); return true }) as typeof process.stderr.write)
    vi.mocked(console.error).mockImplementation((...a: unknown[]) => { printed += a.map(String).join(' ') })
    await runTools(['call', 'walnut_status', '{}'], {})
    const code = /"code"\s*:\s*"([a-z_]+)"/.exec(printed)?.[1]
    expect(code).toBe('request_failed')
    expect(takeSpooledNoAnswers(spool).report.map((n) => `${n.op}:${n.code}`)).toEqual([`walnut_status:${code}`])
  })
  it('piped into another command (the shell says 0): kept all the same', async () => {
    const runner = path.join(dir, 'runner.ts')
    fs.writeFileSync(runner, `import { runTools } from ${JSON.stringify(path.join(ROOT, 'src/commands/tools.ts'))}\n`
      + 'await runTools(process.argv.slice(2), {})\nprocess.exit(process.exitCode ?? 0)\n')
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
    const line = `${quote(process.execPath)} ${quote(runner)} call walnut_status '{}' 2>&1 | cat > /dev/null`
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn('/bin/sh', ['-c', line], { env: { ...process.env, HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.resume()
      child.stderr.resume()
      child.on('close', (c) => resolve(c))
    })
    expect(code).toBe(0)
    expect(takeSpooledNoAnswers(spool).report).toEqual([{ op: 'walnut_status', code: 'hub_unreachable', client: 'cli', ms: expect.any(Number), id: expect.any(String) }])
  }, 60_000)

  it('walnut guide and walnut mcp keep theirs too, and tell what the spool holds once they get through', async () => {
    const { runGuide } = await import('../../src/commands/guide.js')
    const { runMcpClient } = await import('../../src/commands/mcp-client.js')
    await runGuide({})
    await runMcpClient(['list'])
    expect(takeSpooledNoAnswers(spool).report.map((k) => `${k.op}:${k.code}`)).toEqual(['skill_read:hub_unreachable', 'mcp_servers:hub_unreachable'])
    await serverUp()
    await daemonUp()
    await runMcpClient(['list'])
    expect(reports().map((r) => (r as Array<{ op: string }>).map((n) => n.op))).toEqual([['skill_read', 'mcp_servers']])
    expect(takeSpooledNoAnswers(spool).report).toEqual([])
  }, 60_000)
})

describe('the open-walnut mcp mount of Main, an ask and a console agent', () => {
  async function callTool(name: string): Promise<{ isError?: boolean }> {
    const mcp = createWalnutMcpServer({ apiBase: process.env.OPEN_WALNUT_API_URL })
    const client = new Client({ name: 'no-answer', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([mcp.connect(b), client.connect(a)])
    try {
      return await client.callTool({ name, arguments: {} }) as { isError?: boolean }
    } finally {
      await client.close().catch(() => {})
      await mcp.close().catch(() => {})
    }
  }

  it('keeps a call no Walnut answered and tells it with its next answered call', async () => {
    expect((await callTool('walnut_status')).isError).toBe(true)
    const kept = takeSpooledNoAnswers(spool)
    expect(kept.report).toEqual([{ op: 'walnut_status', code: 'hub_unreachable', client: 'mcp', ms: expect.any(Number), id: expect.any(String) }])
    await serverUp()
    await daemonUp()
    expect((await callTool('walnut_status')).isError).toBeFalsy()
    // Told without holding the answer (a long-lived server): it arrives after the call returned.
    await vi.waitFor(() => expect(reports()).toEqual([[{ op: 'walnut_status', code: 'hub_unreachable', client: 'mcp', ms: expect.any(Number), id: expect.any(String) }]]))
  })

  it('outside a session nothing is kept', async () => {
    delete process.env.WALNUT_SESSION_ID
    expect((await callTool('walnut_status')).isError).toBe(true)
    expect(fs.existsSync(path.dirname(spool))).toBe(false)
  })
})

describe('what is kept again', () => {
  it('only what is still told: a failure past its age is never told, and leaves the file once a report was taken', () => {
    const now = Date.now()
    spoolNoAnswer(spool, 'task_get', 'hub_unreachable', 'cli', now - NO_ANSWER_MAX_AGE_MS - 60_000)
    spoolNoAnswer(spool, 'task_list', 'hub_unreachable', 'cli', now - 1_000)
    const taken = takeSpooledNoAnswers(spool, now)
    expect(taken.report.map((n) => n.op)).toEqual(['task_list'])
    // Not yet taken by a server: both lines are still in the file.
    expect(fs.readFileSync(spool, 'utf-8').trim().split('\n')).toHaveLength(2)
    taken.told()
    expect(fs.existsSync(spool)).toBe(false)
  })
})

describe('the MCP server keeps its own in the session\'s spool', () => {
  const formatError = (e: { code: string; message: string }) => [`walnut: ${e.code}: ${e.message}`]
  const call = (handle: ReturnType<typeof createWalnutMcpHandler>, id: number, name: string) =>
    handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })

  it('a later process of the session tells what an earlier one could not, and the CLI\'s too', async () => {
    const first = createWalnutMcpHandler({
      formatError, noAnswerSpool: spool,
      request: async () => { throw Object.assign(new Error('connect ENOENT agent-gateway.sock'), { code: 'ENOENT' }) },
    })
    await call(first, 1, 'task_get')
    // That process ends here (a restart) before any call of it gets through.
    spoolNoAnswer(spool, 'task_list', 'hub_unreachable', 'cli')
    const told: unknown[] = []
    let answer: GatewayResponse = { ok: true, result: { ops: [], offline: true } }
    const next = createWalnutMcpHandler({
      formatError, noAnswerSpool: spool,
      request: async (op, args) => {
        if (op === 'tools.list') { told.push((args.report as { no_answer: unknown }).no_answer); return answer }
        return { ok: true, result: { id: 'x' } }
      },
    })
    await call(next, 1, 'task_get')
    await vi.waitFor(() => expect(told).toHaveLength(1))
    // A call this host's daemon answered from its copy while its Walnut is away is no sign the hub is
    // back: it tells nothing.
    const offline = createWalnutMcpHandler({
      formatError, noAnswerSpool: spool,
      request: async (op, args) => {
        if (op === 'tools.list') { told.push((args.report as { no_answer: unknown }).no_answer); return answer }
        return { ok: true, result: { id: 'x', offline: true } }
      },
    })
    await call(offline, 1, 'task_get')
    await new Promise((r) => setTimeout(r, 50))
    expect(told).toHaveLength(1)
    // Answered by this host's daemon while its Walnut was away: no hub took it, so it is kept.
    answer = { ok: true, result: { recorded: true, no_answer: 2 } }
    await call(next, 2, 'task_get')
    await vi.waitFor(() => expect(told).toHaveLength(2))
    const names = (r: unknown) => (r as Array<{ op: string; code: string; client: string }>).map((n) => `${n.client}:${n.op}:${n.code}`).sort()
    expect(told.map(names)).toEqual([
      ['cli:task_list:hub_unreachable', 'mcp:task_get:no_daemon'],
      ['cli:task_list:hub_unreachable', 'mcp:task_get:no_daemon'],
    ])
    expect(takeSpooledNoAnswers(spool).report).toEqual([])
  })
})
