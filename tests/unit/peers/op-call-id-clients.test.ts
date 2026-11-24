/**
 * Every client face sends an op call's id and, when the answer is lost, says what is known:
 * the call id, how to read it (op_result) and how to run it again safely (src/lib/op-call-id.ts).
 *
 * 2026-11-04: task_send came back `walnut: hub_timeout: primary server timed out` while the
 * message had been delivered and answered; nothing told the caller whether it went or how to
 * check, so it could resend (two copies) or take a delivered message for lost. The faces: the
 * in-session CLI (wn-cli.ts), the MCP server on a host (walnut-mcp-stdio.ts) and the Mac's own CLI (src/commands/tools.ts).
 * The server half (one run per id, op_result) is tests/mcp/op-call-dedup.test.ts.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { runWalnutCli } from '../../../src/providers/wn-cli.js'
import { createWalnutMcpHandler } from '../../../src/providers/walnut-mcp-stdio.js'
import { runTools } from '../../../src/commands/tools.js'
import { CALL_ID_RE, writeOpId } from '../../../src/lib/op-call-id.js'

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
    // One JSON error on stderr (a second document would not parse), nothing on stdout: the call's state is the error's detail.
    const failure = JSON.parse(r.err) as { ok: boolean; error: { code: string; message: string; detail?: unknown } }
    expect(failure).toMatchObject({ ok: false, error: { code: 'hub_timeout' } })
    expect(failure.error.message).toContain('primary server timed out')
    expect(failure.error.message).toContain(`no answer came back for task_send (call ${callId})`)
    expect(failure.error.message).toContain(`walnut tools call op_result '{"call_id":"${callId}"}'`)
    expect(failure.error.message).toContain(`walnut tools call task_send '${JSON.stringify({ ...SEND, _call_id: callId })}'`)
    expect(failure.error.detail).toMatchObject({ call_id: callId, state: 'unknown' })
    expect(r.out).toBe('')
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
    const badFailure = JSON.parse(bad.err) as { error: { code: string; message: string } }
    expect(badFailure.error.code).toBe('invalid_call_id')
    expect(badFailure.error.message).toMatch(/_call_id must be/)
  })

  it('with --json a lost call is ONE document on stdout: the call id and the safe re-run in the message, the lost state as its detail', async () => {
    const gw = await gateway(dir, () => HUB_TIMEOUT)
    process.env.WALNUT_AGENT_SOCKET = gw.sock
    process.env.WALNUT_SESSION_ID = 'probe-sid'
    const r = await run(['tools', 'call', 'task_send', JSON.stringify(SEND), '--json'])
    gw.close()
    expect(r.code).toBe(5)
    expect(r.err).toBe('')
    const callId = gw.requests[0].args.callId!
    const doc = JSON.parse(r.out) as { ok: boolean; error: { code: string; message: string; detail: unknown } }
    expect(doc.ok).toBe(false)
    expect(doc.error.code).toBe('hub_timeout')
    expect(doc.error.message).toContain(`(call ${callId})`)
    expect(doc.error.message).toContain(`walnut tools call op_result '{"call_id":"${callId}"}'`)
    expect(doc.error.detail).toMatchObject({ call_id: callId, state: 'unknown' })
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

describe('the MCP server on a host (walnut-mcp-stdio.ts)', () => {
  const formatError = (e: { code: string; message: string }) => [`walnut: ${e.code}: ${e.message}`]
  it('sends a call id and names it when no answer comes; "_call_id" re-runs that call', async () => {
    const seen: Array<Record<string, unknown>> = []
    // op_result is asked too (it times out as well here): only the call's own requests are checked.
    let opResultReads = 0
    const handle = createWalnutMcpHandler({ formatError, lostFollowMs: 0, request: async (_op, a) => { if ((a as { name?: string }).name === 'op_result') opResultReads += 1; else seen.push(a as Record<string, unknown>); return HUB_TIMEOUT as never } })
    const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_send', arguments: SEND } })
    const text = (reply?.result as { content: Array<{ text: string }> }).content[0].text
    const callId = seen[0].callId as string
    expect(callId).toMatch(CALL_ID_RE)
    expect(text).toContain(`(call ${callId})`)
    expect(text).toContain('op_result')
    await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'task_send', arguments: { ...SEND, _call_id: callId } } })
    expect(seen[1]).toMatchObject({ callId, args: SEND })
    // A re-run is not followed with op_result: that may still hold the earlier run's answer.
    expect(opResultReads).toBe(1)
  })

  // 2026-11-20: brief_write went through on a busy Mac, but its answer came after the gateway's
  // 10 s and the call read as a failure (oc-ca23bb21d76f42c68cf71edab2c73aad).
  it('a lost answer is read with op_result: a call that went through answers as it did', async () => {
    const reads: string[] = []
    let state = 'running'
    const handle = createWalnutMcpHandler({
      formatError,
      request: async (_op, a) => {
        const req = a as { name?: string; args?: { call_id?: string } }
        if (req.name !== 'op_result') return HUB_TIMEOUT as never
        reads.push(req.args!.call_id!)
        // Still running at the first read, done at the next.
        const answer = state === 'running'
          ? { call_id: req.args!.call_id, state: 'running' }
          : { call_id: req.args!.call_id, state: 'done', ok: true, result: { brief: { text: 'written' } } }
        state = 'done'
        return { ok: true, result: answer } as never
      },
    })
    const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brief_write', arguments: { content: 'x' } } })
    const result = reply?.result as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0].text)).toEqual({ brief: { text: 'written' } })
    expect(reads.length).toBe(2)
    expect(new Set(reads).size).toBe(1)
  })

  it('a lost answer whose call failed says why; one the server never saw stays lost', async () => {
    const answer = (state: Record<string, unknown>) => createWalnutMcpHandler({
      formatError,
      request: async (_op, a) => ((a as { name?: string }).name === 'op_result' ? { ok: true, result: state } : HUB_TIMEOUT) as never,
    })
    const failed = await answer({ state: 'done', ok: false, message: 'brief_too_long: over the limit' })({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brief_write', arguments: { content: 'x' } } })
    expect(failed?.result).toMatchObject({ isError: true, content: [{ text: 'brief_too_long: over the limit' }] })
    // Another session's call: where it stands only, never taken as this call's answer.
    const withheld = await answer({ state: 'done', ok: true, answer_withheld: 'the answer goes only to the session that made the call' })({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'brief_write', arguments: { content: 'x' } } })
    expect((withheld?.result as { isError?: boolean }).isError).toBe(true)
    const unknown = await answer({ state: 'unknown' })({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brief_write', arguments: { content: 'x' } } })
    const text = (unknown?.result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain('walnut: hub_timeout')
    expect(text).toContain('op_result')
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
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out += String(c); return true })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { err += String(c); return true })
    try {
      await runTools(['call', 'task_send', JSON.stringify(SEND)], {})
      expect(process.exitCode).toBe(1)
      const callId = /\(call (oc-[A-Za-z0-9_-]+)\)/.exec(err)?.[1]
      expect(callId).toMatch(CALL_ID_RE)
      const failure = JSON.parse(err) as { ok: boolean; error: { message: string; detail?: unknown } }
      expect(failure.ok).toBe(false)
      expect(failure.error.message).toContain(`walnut tools call op_result '{"call_id":"${callId}"}'`)
      expect(failure.error.detail).toMatchObject({ call_id: callId, state: 'unknown' })
      expect(out).toBe('')
      expect(seen[0].opId).toBe(writeOpId(callId!, 'POST', '/messages', 0))
      process.exitCode = 0
      await runTools(['call', 'task_send', JSON.stringify({ ...SEND, _call_id: callId })], {})
      expect(seen[1].opId).toBe(seen[0].opId)
      expect(seen[1].body).not.toHaveProperty('_call_id')
    } finally {
      log.mockRestore()
      stdout.mockRestore()
      stderr.mockRestore()
      server.close()
    }
  })
})
