/**
 * An agent's call through `walnut mcp-server` waits for a server that is restarting, as a
 * `walnut tools call` does, and its client can tell it is waiting (src/providers/walnut-mcp-stdio.ts,
 * the line from src/providers/gateway-request.ts).
 *
 * 2026-11-23: a task_create through the MCP server failed with hub_unreachable 13 s after a deploy
 * restarted the server; the MCP server named no wait, so the daemon answered at once.
 *
 * The notice rule is the CLI's (a person's terminal only): here it goes out of band, as an MCP
 * progress notification to a client that asked for progress, never into the tool's answer.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createWalnutMcpHandler } from '../../src/providers/walnut-mcp-stdio.js'
import { GATEWAY_ANSWER_SLACK_MS, GATEWAY_WAIT_NOTICE_MS, MCP_CALL_WAIT_MS, type GatewayLine } from '../../src/providers/gateway-request.js'
import { mcpGatewayRequest } from '../../src/providers/wn-cli.js'
import type { GatewayResponse } from '../../src/providers/gateway-core.js'

const ROOT = path.resolve(__dirname, '../..')
const formatError = (e: { code: string; message: string }) => [`walnut: ${e.code}: ${e.message}`]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const later = (ms: number, resp: GatewayResponse) => () => sleep(ms).then(() => resp)

describe('a waiting MCP call tells its client, out of band', () => {
  it('a client that gave a progressToken hears once that the call waits; the answer carries no notice', async () => {
    const progress: Array<Record<string, unknown>> = []
    const handle = createWalnutMcpHandler({
      request: later(300, { ok: true, result: { task: { id: 't1' } } }), formatError,
      progress: (p) => { progress.push(p) }, waitNoticeMs: 50, callWaitMs: 60_000,
    })
    const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_create', arguments: { title: 'x' }, _meta: { progressToken: 42 } } })
    expect(progress).toEqual([{ progressToken: 42, progress: 0, message: 'Walnut: no answer yet; this call waits up to 60s' }])
    const text = (reply?.result as { content: Array<{ text: string }> }).content[0]!.text
    expect(JSON.parse(text)).toEqual({ task: { id: 't1' } })
    expect(text).not.toMatch(/waits up to/)
  })

  it('no token, or an answer before the notice: nothing is sent', async () => {
    const progress: unknown[] = []
    const slow = createWalnutMcpHandler({ request: later(200, { ok: true, result: {} }), formatError, progress: (p) => { progress.push(p) }, waitNoticeMs: 20 })
    await slow({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_get', arguments: {} } })
    const quick = createWalnutMcpHandler({ request: later(5, { ok: true, result: {} }), formatError, progress: (p) => { progress.push(p) }, waitNoticeMs: 200 })
    await quick({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'task_get', arguments: {}, _meta: { progressToken: 'a' } } })
    await sleep(300)
    expect(progress).toEqual([])
  })

  it('a failed call clears its notice too', async () => {
    const progress: unknown[] = []
    const handle = createWalnutMcpHandler({
      request: later(5, { ok: false, error: { code: 'hub_unreachable', message: 'no primary server connected' } }), formatError,
      progress: (p) => { progress.push(p) }, waitNoticeMs: 100,
    })
    const reply = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'task_create', arguments: {}, _meta: { progressToken: 'b' } } })
    expect((reply?.result as { isError?: boolean }).isError).toBe(true)
    await sleep(250)
    expect(progress).toEqual([])
  })

  it("a lost call's follow reads end within the follow's time, on the line that is sent", async () => {
    const sent: GatewayLine[] = []
    const handle = createWalnutMcpHandler({
      // The MCP server's real line builder, its socket replaced.
      request: mcpGatewayRequest('/tmp/none/agent-gateway.sock', 'sess-f', async (_p, line) => {
        sent.push(line)
        if (line.req.args.name === 'op_result') return { ok: true, result: { state: 'done', ok: true, result: { saved: true } } }
        return { ok: false, error: { code: 'hub_timeout', message: 'primary server timed out' } }
      }, {}),
      formatError, lostFollowMs: 5_000,
    })
    const reply = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'brief_write', arguments: { text: 'x' } } })
    expect(JSON.parse((reply?.result as { content: Array<{ text: string }> }).content[0]!.text)).toEqual({ saved: true })
    // The call itself: the MCP wait; the follow read: no longer than what is left of the follow
    // (under a relay's least time, so it waits for no server and its socket ends with what is left).
    expect(sent[0]!.req).toMatchObject({ waitMs: MCP_CALL_WAIT_MS, args: { name: 'brief_write' } })
    expect(sent[1]!.req).toMatchObject({ waitMs: 0, args: { name: 'op_result' } })
    expect(sent[1]!.timeoutMs).toBeGreaterThan(0)
    expect(sent[1]!.timeoutMs).toBeLessThanOrEqual(5_000)
  })
})

describe('the real `walnut mcp-server` process', () => {
  let dir = ''
  let server: net.Server | null = null
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()))
    server = null
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('names the MCP wait on each call and none on its list, and its progress reaches the SDK client', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-mcp-wait-'))
    const sock = path.join(dir, 'agent-gateway.sock')
    const seen: Array<Record<string, unknown>> = []
    server = net.createServer((c) => {
      let buf = ''
      c.on('data', (d) => {
        buf += d.toString()
        const nl = buf.indexOf('\n')
        if (nl === -1) return
        const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown> & { op: string; args: Record<string, unknown> }
        seen.push(req)
        if (req.op === 'tools.list') {
          c.end(JSON.stringify({ ok: true, result: { ops: [{ name: 'task_create', description: 'Create', inputSchema: { type: 'object' } }] } }) + '\n')
          return
        }
        // The daemon holds the call past the notice (a server restarting), then answers.
        setTimeout(() => c.end(JSON.stringify({ ok: true, result: { task: { id: 't9' } } }) + '\n'), GATEWAY_WAIT_NOTICE_MS + 1_000)
      })
      c.on('error', () => { /* the client went */ })
    })
    await new Promise<void>((r) => server!.listen(sock, () => r()))
    fs.chmodSync(sock, 0o600)

    const entry = path.join(dir, 'entry.ts')
    fs.writeFileSync(entry, `import { runWalnutCli } from ${JSON.stringify(path.join(ROOT, 'src/providers/wn-cli.ts'))}\nprocess.exit(await runWalnutCli(['mcp-server']))\n`)
    const env: Record<string, string> = { ...process.env as Record<string, string>, WALNUT_AGENT_SOCKET: sock, WALNUT_SESSION_ID: 'sess-wait' }
    // Never this run's own Walnut session's entry or test run.
    for (const k of ['WALNUT_CALL_SOCKET', 'WALNUT_CALL_TOKEN', 'WALNUT_TEST_RUN', 'WALNUT_MCP_WAIT_MS']) delete env[k]
    const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: 'pipe' })
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(transport)
    try {
      await client.listTools()
      const progress: Array<{ progress: number; message?: string }> = []
      const r = await client.callTool({ name: 'task_create', arguments: { title: 'x' } }, undefined, {
        onprogress: (p) => { progress.push(p as { progress: number; message?: string }) },
        timeout: 60_000,
      })
      expect(JSON.parse((r.content as Array<{ text: string }>)[0]!.text)).toEqual({ task: { id: 't9' } })
      expect(progress).toHaveLength(1)
      expect(progress[0]!.message).toBe(`Walnut: no answer yet; this call waits up to ${MCP_CALL_WAIT_MS / 1000}s`)
      const list = seen.find((s) => s.op === 'tools.list')!
      const call = seen.find((s) => s.op === 'tools.call')!
      expect('waitMs' in list).toBe(false)
      expect(call.waitMs).toBe(MCP_CALL_WAIT_MS)
      expect(call.sid).toBe('sess-wait')
      expect(MCP_CALL_WAIT_MS + GATEWAY_ANSWER_SLACK_MS).toBeGreaterThan(GATEWAY_WAIT_NOTICE_MS + 1_000)
    } finally {
      await client.close()
    }
  }, 60_000)
})

// Review 2026-11-23: a call cancelled while the daemon held it for a restarting server was sent
// once the server came back, and a model that retried it with a new call id sent it twice.
describe('a call the client cancels is never sent late', () => {
  it('notifications/cancelled aborts the running call\'s request, and the cancelled call gets no answer', async () => {
    let seen: AbortSignal | undefined
    const handle = createWalnutMcpHandler({
      formatError,
      request: (_op, _args, _ms, signal) => new Promise<GatewayResponse>((_resolve, reject) => {
        seen = signal
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('the call was cancelled'), { code: 'cancelled' })))
      }),
    })
    const pending = handle({ jsonrpc: '2.0', id: 'c-1', method: 'tools/call', params: { name: 'task_send', arguments: { to: 't1', text: 'hi' } } })
    await vi.waitFor(() => expect(seen).toBeDefined())
    expect(seen?.aborted).toBe(false)
    // Another request's cancel touches nothing.
    await handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'c-2' } })
    expect(seen?.aborted).toBe(false)
    await handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'c-1', reason: 'user' } })
    expect(seen?.aborted).toBe(true)
    expect(await pending).toBeNull()
  })

  it('the request\'s socket closes at the cancel, so a daemon holding it drops it unsent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cancel-'))
    const sock = path.join(dir, 'gw.sock')
    let lines = 0
    let closed = false
    const server = net.createServer((c) => {
      c.on('data', () => { lines++ })
      c.on('close', () => { closed = true })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    try {
      const ctl = new AbortController()
      const req = mcpGatewayRequest(sock, 'sid-1')('tools.call', { name: 'task_send', args: {}, callId: 'c1' }, undefined, ctl.signal)
      await vi.waitFor(() => expect(lines).toBe(1))
      ctl.abort()
      await expect(req).rejects.toMatchObject({ code: 'cancelled' })
      await vi.waitFor(() => expect(closed).toBe(true))
      // Cancelled before it started: nothing is opened.
      await expect(mcpGatewayRequest(sock, 'sid-1')('tools.call', { name: 'x', args: {} }, undefined, ctl.signal)).rejects.toMatchObject({ code: 'cancelled' })
      expect(lines).toBe(1)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
