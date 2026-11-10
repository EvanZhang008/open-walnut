/**
 * `walnut mcp-server`: Walnut's ops as an MCP stdio server over the host daemon's
 * gateway socket (src/providers/walnut-mcp-stdio.ts).
 *
 * The handler tests pin the protocol answers; the e2e test runs the real CLI
 * entry (`runWalnutCli(['mcp-server'])`) as a child process against a fake
 * gateway socket, driven by the real MCP SDK client, so framing, the caller sid
 * and the large-payload spill are exercised end to end.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createWalnutMcpHandler, mcpToolOf, negotiateProtocol, MCP_PROTOCOL_VERSIONS } from '../../src/providers/walnut-mcp-stdio.js'
import { GATEWAY_INLINE_ARGS_MAX_BYTES } from '../../src/providers/tool-args-source.js'
import type { GatewayResponse } from '../../src/providers/gateway-core.js'

const ROOT = path.resolve(__dirname, '../..')
const formatError = (e: { code: string; message: string }) => [`walnut: ${e.code}: ${e.message}`]

describe('walnut mcp-server handler', () => {
  it('answers initialize with the client version it speaks, else its newest', () => {
    expect(negotiateProtocol('2025-06-18')).toBe('2025-06-18')
    expect(negotiateProtocol('1999-01-01')).toBe(MCP_PROTOCOL_VERSIONS[0])
    expect(negotiateProtocol(undefined)).toBe(MCP_PROTOCOL_VERSIONS[0])
  })

  it('a hub row with no schema (an older hub) still becomes a callable tool', () => {
    const t = mcpToolOf({ name: 'task_get', description: 'Get one task', signature: 'id', readonly: true })
    expect(t.inputSchema).toEqual({ type: 'object', additionalProperties: true })
    expect(t.description).toBe('Get one task\n\nArguments: id')
    expect(t.annotations).toEqual({ readOnlyHint: true })
    const s = mcpToolOf({ name: 'task_delete', description: 'd', inputSchema: { type: 'object' }, destructive: true })
    expect(s.description).toBe('d')
    expect(s.annotations).toEqual({ destructiveHint: true })
  })

  it('notifications get no answer; unknown methods get method-not-found', async () => {
    const handle = createWalnutMcpHandler({ request: async () => ({ ok: true, result: {} }), formatError })
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await handle({ jsonrpc: '2.0', id: 9, method: 'nope' })).toMatchObject({ id: 9, error: { code: -32601 } })
    expect(await handle({ jsonrpc: '2.0', id: 10, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 10, result: {} })
  })

  it('a gateway error is a tool error carrying the op detail and the CLI lines', async () => {
    const handle = createWalnutMcpHandler({
      request: async () => ({ ok: false, error: { code: 'internal', message: 'boom', detail: { outcome: 'Refused' } } }),
      formatError,
    })
    const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_get', arguments: { id: 'x' } } })
    const result = reply?.result as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('"outcome":"Refused"')
    expect(result.content[0].text).toContain('walnut: internal: boom')
  })

  it('a daemon that does not answer is a tool error, never a hung call', async () => {
    const handle = createWalnutMcpHandler({ request: async () => { throw new Error('socket closed') }, formatError })
    const reply = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'task_get', arguments: {} } })
    expect((reply?.result as { isError?: boolean }).isError).toBe(true)
    const list = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect(list).toMatchObject({ id: 3, error: { code: -32603 } })
  })

  it('a short list (the Mac away, an older hub) is answered, completed later, and the client told', async () => {
    let calls = 0
    const notified: string[] = []
    const full = { ok: true as const, result: { ops: [{ name: 'task_get', inputSchema: { type: 'object' } }, { name: 'task_list', inputSchema: { type: 'object' } }] } }
    const handle = createWalnutMcpHandler({
      formatError,
      listRetryMs: 5,
      notify: (m) => notified.push(m),
      request: async () => {
        calls++
        if (calls === 1) return { ok: false, error: { code: 'hub_unreachable', message: 'no primary' } }
        if (calls === 2) return { ok: true, result: { ops: [{ name: 'task_get', signature: 'id' }] } }
        return full
      },
    })
    const init = await handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} })
    expect((init?.result as { capabilities: { tools: { listChanged: boolean } } }).capabilities.tools.listChanged).toBe(true)
    const first = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(first).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
    const deadline = Date.now() + 2000
    while (notified.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
    expect(notified).toEqual(['notifications/tools/list_changed'])
    expect(calls).toBe(3)
    const second = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect((second?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(['task_get', 'task_list'])
    await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect(calls).toBe(3)
  })

  it('a line that is not a JSON-RPC object is ignored, never a crash', async () => {
    const handle = createWalnutMcpHandler({ request: async () => ({ ok: true, result: {} }), formatError })
    expect(await handle(null as never)).toBeNull()
    expect(await handle([1] as never)).toBeNull()
  })

  it('arguments too big for the gateway line travel as a file the hub pulls, removed after', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-mcp-spill-'))
    let sent: Record<string, unknown> = {}
    let seenOnDisk = ''
    const handle = createWalnutMcpHandler({
      tmpDir,
      formatError,
      request: async (_op, args) => {
        sent = args
        seenOnDisk = fs.readFileSync(String(args.argsFile), 'utf-8')
        return { ok: true, result: { ok: 1 } }
      },
    })
    const big = 'x'.repeat(GATEWAY_INLINE_ARGS_MAX_BYTES + 10)
    await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'human_inbox_send', arguments: { html: big } } })
    expect(sent.args).toBeUndefined()
    expect(JSON.parse(seenOnDisk)).toEqual({ html: big })
    expect(fs.readdirSync(tmpDir)).toEqual([])
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('walnut mcp-server e2e: real MCP client, real CLI entry, fake gateway socket', () => {
  let server: net.Server | undefined
  let dir: string | undefined
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('lists the hub catalog and runs a call with shell-hostile text unchanged, as the session', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-mcp-e2e-'))
    const sock = path.join(dir, 'agent-gateway.sock')
    const seen: Array<{ op: string; sid: string; args: Record<string, unknown> }> = []
    server = net.createServer((c) => {
      let buf = ''
      c.on('data', (d) => {
        buf += d.toString()
        const nl = buf.indexOf('\n')
        if (nl === -1) return
        const req = JSON.parse(buf.slice(0, nl)) as { op: string; sid: string; args: Record<string, unknown> }
        seen.push(req)
        let resp: GatewayResponse
        if (req.op === 'tools.list') {
          resp = { ok: true, result: { ops: [{ name: 'task_update', title: 'Update', description: 'Update a task', readonly: false,
            inputSchema: { type: 'object', properties: { id: { type: 'string' }, description: { type: 'string' } }, required: ['id'] } }] } }
        } else {
          resp = { ok: true, result: { echoed: req.args.args } }
        }
        c.end(JSON.stringify(resp) + '\n')
      })
    })
    await new Promise<void>((r) => server!.listen(sock, () => r()))
    fs.chmodSync(sock, 0o600)

    const entry = path.join(dir, 'entry.ts')
    fs.writeFileSync(entry, `import { runWalnutCli } from ${JSON.stringify(path.join(ROOT, 'src/providers/wn-cli.ts'))}\nprocess.exit(await runWalnutCli(['mcp-server']))\n`)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...process.env as Record<string, string>, WALNUT_AGENT_SOCKET: sock, WALNUT_SESSION_ID: 'sess-1234' },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(transport)
    try {
      expect(client.getInstructions()).toContain('Walnut is the user')
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(['task_update'])
      expect(tools[0].inputSchema.required).toEqual(['id'])
      const hostile = "run `walnut tools call` then $(date +%s); it's \"quoted\", $5, 100%, C:\\tmp, \\n, \u2705"
      const r = await client.callTool({ name: 'task_update', arguments: { id: 't1', description: hostile } })
      const body = JSON.parse((r.content as Array<{ text: string }>)[0].text) as { echoed: { description: string } }
      expect(body.echoed.description).toBe(hostile)
      expect(seen.map((s) => s.op)).toEqual(['tools.list', 'tools.call'])
      expect(seen[0].args).toEqual({ schemas: true })
      for (const s of seen) expect(s.sid).toBe('sess-1234')
    } finally {
      await client.close()
    }
  }, 30_000)
})
