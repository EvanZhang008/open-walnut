/**
 * Every client face sends an op call's id and, when the answer is lost, says what is known:
 * the call id, how to read it (op_result) and how to run it again safely (src/lib/op-call-id.ts).
 *
 * 2026-11-04: task_send came back `walnut: hub_timeout: primary server timed out` while the
 * message had been delivered and answered; nothing told the caller whether it went or how to
 * check, so it could resend (two copies) or take a delivered message for lost. The faces: the
 * in-session CLI (wn-cli.ts), the template CLI in the daemon's source twin (daemon-source.ts),
 * the MCP server on a host (walnut-mcp-stdio.ts) and the Mac's own CLI (src/commands/tools.ts).
 * The server half (one run per id, op_result) is tests/mcp/op-call-dedup.test.ts.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { runWalnutCli } from '../../../src/providers/wn-cli.js'
import { createWalnutMcpHandler } from '../../../src/providers/walnut-mcp-stdio.js'
import { runTools } from '../../../src/commands/tools.js'
import { getDaemonSource } from '../../../src/providers/daemon-source.js'
import { CALL_ID_RE, writeOpId } from '../../../src/lib/op-call-id.js'
import { SOURCE_TWIN } from '../../helpers/source-twin.js'

const HUB_TIMEOUT = { ok: false, error: { code: 'hub_timeout', message: 'primary server timed out' } }
const SENT = { ok: true, result: { delivery: 'queued', messageId: 'qm-1' } }
type GwReq = { args: { name: string; args: Record<string, unknown>; callId?: string } }

async function gateway(dir: string, answer: (req: GwReq, n: number) => unknown) {
  const sock = path.join(dir, 'gw.sock')
  fs.rmSync(sock, { force: true })
  const requests: GwReq[] = []
  const server = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d.toString('utf-8')
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const req = JSON.parse(buf.slice(0, nl)) as GwReq
      requests.push(req)
      c.end(JSON.stringify(answer(req, requests.length)) + '\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(sock, () => resolve()))
  fs.chmodSync(sock, 0o600)
  return { sock, requests, close: () => server.close() }
}

let dir = ''
const savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocid-'))
  for (const k of ['WALNUT_AGENT_SOCKET', 'WALNUT_SESSION_ID', 'OPEN_WALNUT_API_URL']) savedEnv[k] = process.env[k]
})
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  process.exitCode = 0
  fs.rmSync(dir, { recursive: true, force: true })
})

const SEND = { to: 'mt0v0wao-fc03', title: 'Draft ready', text: 'The draft is in the folder.' }

describe('the in-session CLI (wn-cli.ts)', () => {
  async function run(argv: string[]): Promise<{ code: number; err: string; out: string }> {
    let err = ''
    let out = ''
    const e = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { err += String(c); return true })
    const o = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out += String(c); return true })
    try {
      return { code: await runWalnutCli(argv), err, out }
    } finally {
      e.mockRestore()
      o.mockRestore()
    }
  }

  it('sends a call id beside the op; a lost answer names it, the read, and the safe re-run, on stderr and stdout', async () => {
    const gw = await gateway(dir, () => HUB_TIMEOUT)
    process.env.WALNUT_AGENT_SOCKET = gw.sock
    process.env.WALNUT_SESSION_ID = 'probe-sid'
    const r = await run(['tools', 'call', 'task_send', JSON.stringify(SEND)])
    gw.close()
    expect(r.code).toBe(5)
    const callId = gw.requests[0].args.callId!
    expect(callId).toMatch(CALL_ID_RE)
    expect(gw.requests[0].args.args).toEqual(SEND)
    expect(r.err).toContain('walnut: hub_timeout: primary server timed out')
    expect(r.err).toContain(`no answer came back for task_send (call ${callId})`)
    expect(r.err).toContain(`walnut tools call op_result '{"call_id":"${callId}"}'`)
    expect(r.err).toContain(`walnut tools call task_send '${JSON.stringify({ ...SEND, _call_id: callId })}'`)
    // A caller reading only stdout is not left with nothing.
    expect(JSON.parse(r.out)).toMatchObject({ call_id: callId, state: 'unknown' })
  })

  it('a re-run with "_call_id" sends that id and takes the key out of the op\'s arguments', async () => {
    const gw = await gateway(dir, () => SENT)
    process.env.WALNUT_AGENT_SOCKET = gw.sock
    process.env.WALNUT_SESSION_ID = 'probe-sid'
    const r = await run(['tools', 'call', 'task_send', JSON.stringify({ ...SEND, _call_id: 'oc-0123456789abcdef' })])
    gw.close()
    expect(r.code).toBe(0)
    expect(gw.requests[0].args).toMatchObject({ name: 'task_send', callId: 'oc-0123456789abcdef', args: SEND })
    const bad = await run(['tools', 'call', 'task_send', JSON.stringify({ ...SEND, _call_id: 'not-one' })])
    expect(bad.code).toBe(2)
    expect(bad.err).toMatch(/_call_id must be/)
  })
})

describe('arguments too large to inline (a file the server pulls)', () => {
  it('a "_call_id" in the file names the call: the CLI sends and prints that id, not a new one', async () => {
    const file = path.join(dir, 'big.json')
    fs.writeFileSync(file, JSON.stringify({ ...SEND, text: 'x'.repeat(1_200_000), _call_id: 'oc-fromthefile0001' }))
    const gw = await gateway(dir, () => HUB_TIMEOUT)
    process.env.WALNUT_AGENT_SOCKET = gw.sock
    process.env.WALNUT_SESSION_ID = 'probe-sid'
    let err = ''
    const e = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { err += String(c); return true })
    const o = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      expect(await runWalnutCli(['tools', 'call', 'task_send', `@${file}`])).toBe(5)
    } finally { e.mockRestore(); o.mockRestore() }
    gw.close()
    expect(gw.requests[0].args).toMatchObject({ name: 'task_send', argsFile: file, callId: 'oc-fromthefile0001' })
    expect(err).toContain('(call oc-fromthefile0001)')
  })
})

describe('the template CLI (daemon-source.ts)', () => {
  function run(sock: string, payload: string): Promise<{ code: number | null; err: string; out: string }> {
    const twin = path.join(dir, 'daemon.cjs')
    if (!fs.existsSync(twin)) fs.writeFileSync(twin, getDaemonSource())
    return new Promise((resolve) => {
      const child = spawn(SOURCE_TWIN.file, [twin, 'wn', 'tools', 'call', 'task_send', payload], {
        env: { ...process.env, WALNUT_DAEMON_DIR: dir, WALNUT_AGENT_SOCKET: sock, WALNUT_SESSION_ID: 'probe-sid' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let err = ''
      let out = ''
      child.stderr.on('data', (d) => { err += d })
      child.stdout.on('data', (d) => { out += d })
      child.on('close', (code) => resolve({ code, err, out }))
    })
  }

  it('sends a call id, names it when no answer comes, and keeps a caller-given one', async () => {
    const lost = await gateway(dir, () => HUB_TIMEOUT)
    const r = await run(lost.sock, JSON.stringify(SEND))
    lost.close()
    expect(r.code).toBe(5)
    const callId = lost.requests[0].args.callId!
    expect(callId).toMatch(CALL_ID_RE)
    expect(r.err).toContain(`no answer came back for task_send (call ${callId})`)
    expect(r.err).toContain(`walnut tools call op_result '{"call_id":"${callId}"}'`)

    const again = await gateway(dir, () => SENT)
    const r2 = await run(again.sock, JSON.stringify({ ...SEND, _call_id: callId }))
    again.close()
    expect(r2.code).toBe(0)
    expect(again.requests[0].args).toMatchObject({ callId, args: SEND })
  }, 60_000)
})

describe('the MCP server on a host (walnut-mcp-stdio.ts)', () => {
  const formatError = (e: { code: string; message: string }) => [`walnut: ${e.code}: ${e.message}`]
  it('sends a call id and names it when no answer comes; "_call_id" re-runs that call', async () => {
    const seen: Array<Record<string, unknown>> = []
    const handle = createWalnutMcpHandler({ formatError, request: async (_op, a) => { seen.push(a as Record<string, unknown>); return HUB_TIMEOUT as never } })
    const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_send', arguments: SEND } })
    const text = (reply?.result as { content: Array<{ text: string }> }).content[0].text
    const callId = seen[0].callId as string
    expect(callId).toMatch(CALL_ID_RE)
    expect(text).toContain(`(call ${callId})`)
    expect(text).toContain('op_result')
    await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'task_send', arguments: { ...SEND, _call_id: callId } } })
    expect(seen[1]).toMatchObject({ callId, args: SEND })
  })
})

describe('the Mac\'s own CLI (src/commands/tools.ts)', () => {
  it('each write carries an op id derived from the call id; a lost answer names the call', async () => {
    const seen: Array<{ opId?: string; body: Record<string, unknown> }> = []
    const server = http.createServer((req, res) => {
      let buf = ''
      req.on('data', (c) => { buf += c })
      req.on('end', () => {
        seen.push({ opId: req.headers['x-walnut-op-id'] as string | undefined, body: buf ? JSON.parse(buf) : {} })
        // Applied, but the answer never reaches the caller.
        if (seen.length === 1) { req.socket.destroy(); return }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(SENT.result))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
    delete process.env.WALNUT_AGENT_SOCKET
    delete process.env.WALNUT_SESSION_ID
    let out = ''
    let err = ''
    const log = vi.spyOn(console, 'log').mockImplementation((s) => { out += String(s) + '\n' })
    const error = vi.spyOn(console, 'error').mockImplementation((s) => { err += String(s) + '\n' })
    try {
      await runTools(['call', 'task_send', JSON.stringify(SEND)], {})
      expect(process.exitCode).toBe(1)
      const callId = /\(call (oc-[A-Za-z0-9_-]+)\)/.exec(err)?.[1]
      expect(callId).toMatch(CALL_ID_RE)
      expect(seen[0].opId).toBe(writeOpId(callId!, 'POST', '/messages', 0))
      expect(JSON.parse(out)).toMatchObject({ call_id: callId, state: 'unknown' })
      process.exitCode = 0
      await runTools(['call', 'task_send', JSON.stringify({ ...SEND, _call_id: callId })], {})
      expect(seen[1].opId).toBe(seen[0].opId)
      expect(seen[1].body).not.toHaveProperty('_call_id')
    } finally {
      log.mockRestore()
      error.mockRestore()
      server.close()
    }
  })
})
