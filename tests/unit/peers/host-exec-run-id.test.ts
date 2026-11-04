/**
 * A host_exec run's id is chosen by the CALLER (src/providers/host-exec-run-id.ts), so a
 * run whose answer never comes back can still be read.
 *
 * 2026-11-03: a session on another host called host_exec on the Mac, the Mac was slow, and
 * the call came back `hub_timeout: primary server timed out` after 20 s with no job id,
 * although the command had started there; its output was lost. Now every client face picks
 * `hx-<uuid>` before the call leaves and sends it as `job_id`: the in-session CLI
 * (wn-cli.ts), the template CLI in the daemon's source twin (daemon-source.ts), and the MCP
 * server on a host (walnut-mcp-stdio.ts). When no answer comes, each prints that id and the
 * exact host_exec_read to run. A server older than the field refuses it before anything runs,
 * and each face then calls once more without it. `hub_unreachable` means the call never
 * reached the server: nothing ran, and the faces say so instead.
 *
 * The other half (the server runs the job under that id, and host_exec_read reads it after the
 * answer was lost) is in tests/e2e/host-exec-e2e.test.ts.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { awayLines, callerRunId, dropRunId, lostRunLines, neverSent, refusedRunId } from '../../../src/providers/host-exec-run-id.js'
import { runWalnutCli } from '../../../src/providers/wn-cli.js'
import { createWalnutMcpHandler } from '../../../src/providers/walnut-mcp-stdio.js'
import { runTools } from '../../../src/commands/tools.js'
import { getDaemonSource } from '../../../src/providers/daemon-source.js'
import { parseOpArgs } from '../../../src/ops/executor.js'
import { SOURCE_TWIN } from '../../helpers/source-twin.js'
import type { WalnutOp } from '../../../src/ops/registry.js'

const HUB_TIMEOUT = { ok: false, error: { code: 'hub_timeout', message: 'primary server timed out' } }
const HUB_AWAY = { ok: false, error: { code: 'hub_unreachable', message: '"host_exec" needs the Walnut server, which is not answering this host right now.' } }
const DONE = { ok: true, result: { jobId: 'hx-from-the-server', running: false, exitCode: 0 } }

/** What a Walnut server older than the field answers: its strict schema has no job_id (the real parser's words). */
function olderServerRefusal(args: Record<string, unknown>, name = 'host_exec'): { ok: false; error: { code: string; message: string } } {
  const input = name === 'host_copy'
    ? { from_host: z.string(), from: z.string(), to_host: z.string(), to: z.string() }
    : { host: z.string(), command: z.string().optional() }
  const old = { name, input } as unknown as WalnutOp
  const parsed = parseOpArgs(old, args)
  if (parsed.ok) throw new Error('expected the older schema to refuse job_id')
  return { ok: false, error: { code: 'internal', message: parsed.message } }
}

/** A stand-in for the daemon's agent gateway: records each request, answers each from `answer`. */
async function gateway(dir: string, answer: (req: { args: { name: string; args: Record<string, unknown> } }, n: number) => unknown) {
  const sock = path.join(dir, 'gw.sock')
  const requests: Array<{ args: { name: string; args: Record<string, unknown> } }> = []
  const server = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d.toString('utf-8')
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const req = JSON.parse(buf.slice(0, nl))
      requests.push(req)
      c.end(JSON.stringify(answer(req, requests.length)) + '\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(sock, () => resolve()))
  fs.chmodSync(sock, 0o600)
  return { sock, requests, close: () => server.close() }
}

/**
 * A socket file nothing listens on (a daemon that died without removing it): a connect is
 * refused before a byte is written. The listener is a child killed with SIGKILL, so the file stays.
 */
function staleSocket(dir: string): string {
  const sock = path.join(dir, 'dead.sock')
  spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)}, () => process.kill(process.pid, 'SIGKILL'))`])
  if (!fs.statSync(sock).isSocket()) throw new Error('expected a stale socket file')
  fs.chmodSync(sock, 0o600)
  return sock
}

let dir = ''
const savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxid-'))
  for (const k of ['WALNUT_AGENT_SOCKET', 'WALNUT_SESSION_ID']) savedEnv[k] = process.env[k]
})
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  process.exitCode = 0
  fs.rmSync(dir, { recursive: true, force: true })
})

const CALL = '{"host":"studio-mac","command":"swiftc probe.swift && ./probe"}'

describe('the rule', () => {
  it('picks hx-<uuid> for host_exec only, and keeps one the caller gave', () => {
    const args: Record<string, unknown> = { host: 'studio-mac', command: 'true' }
    expect(callerRunId('host_exec', args, () => 'abcd-1234')).toBe('hx-abcd-1234')
    expect(args.job_id).toBe('hx-abcd-1234')
    expect(callerRunId('host_exec', { host: 'h', job_id: 'hx-mine-0001' })).toBe('hx-mine-0001')
    // A run under one named grant is a host_exec run too.
    expect(callerRunId('host_exec_pinned', { host: 'h', grant_id: 'xg-0000', command: 'true' }, () => 'abcd-1234')).toBe('hx-abcd-1234')
    const read: Record<string, unknown> = { host: 'h', job_id: 'hx-x' }
    expect(callerRunId('host_exec_read', read)).toBeNull()
    expect(callerRunId('task_get', {})).toBeNull()
    expect(callerRunId('toString', {})).toBeNull()
    expect(callerRunId('host_exec', {})).toMatch(/^hx-[0-9a-f-]{36}$/)
  })

  it('a lost answer names the job and the exact read, quoted for the shell', () => {
    const lines = lostRunLines('host_exec', { host: "o'brien-mac" }, 'hx-1234')
    expect(lines[0]).toBe("walnut: host_exec may have started on o'brien-mac as job hx-1234: do not run it again. Read it first:")
    expect(lines[1]).toBe(`  walnut tools call host_exec_read '{"host":"o'\\''brien-mac","job_id":"hx-1234","wait_ms":10000}'`)
    expect(lines[2]).toContain('host_exec_list')
    expect(lostRunLines('task_get', {}, 'x')).toEqual([])
  })

  it('knows an older server\'s refusal of the field, and nothing else', () => {
    const refusal = olderServerRefusal({ host: 'h', command: 'true', job_id: 'hx-abcd' })
    expect(refusedRunId('host_exec', refusal.error.message)).toBe(true)
    expect(refusedRunId('host_exec', olderServerRefusal({ host: 'h', job_id: 'hx-abcd', bogus: 1 }).error.message)).toBe(true)
    expect(refusedRunId('host_exec', olderServerRefusal({ host: 'h', bogus: 1 }).error.message)).toBe(false)
    expect(refusedRunId('host_exec_read', refusal.error.message)).toBe(false)
    expect(refusedRunId('host_exec', 'job_id must be hx- and 4 to 64 letters')).toBe(false)
  })

  it('a server out of reach ran nothing; a job started before still runs', () => {
    expect(awayLines('host_exec', { host: 'studio-mac' })).toEqual(['walnut: host_exec did not reach the Walnut server, so nothing ran on studio-mac; call it again once the server answers.'])
    expect(awayLines('host_exec_read', { host: 'studio-mac', job_id: 'hx-1' })[0]).toContain('keeps running meanwhile, and its log stays in your task\'s directory there (host-exec/hx-1.log)')
    expect(awayLines('task_get', {})).toEqual([])
    expect(awayLines('host_exec', { host: 'studio-mac' }, "this host's Walnut daemon")).toEqual(["walnut: host_exec did not reach this host's Walnut daemon, so nothing ran on studio-mac; call it again once this host's daemon answers."])
  })

  it('only a socket refused before the write is a call that never left', () => {
    for (const code of ['ENOENT', 'ECONNREFUSED', 'EACCES', 'ENOTSOCK']) expect(neverSent(Object.assign(new Error('x'), { code }))).toBe(true)
    for (const err of [Object.assign(new Error('x'), { code: 'EPIPE' }), Object.assign(new Error('x'), { code: 'ECONNRESET' }), new Error('agent socket closed without a response'), null, 'ENOENT']) {
      expect(neverSent(err)).toBe(false)
    }
    const args: Record<string, unknown> = { host: 'h', command: 'true', job_id: 'hx-abcd' }
    dropRunId('host_exec', args)
    expect(args).toEqual({ host: 'h', command: 'true' })
    const other: Record<string, unknown> = { job_id: 'hx-abcd' }
    dropRunId('host_exec_read', other)
    expect(other).toEqual({ job_id: 'hx-abcd' })
  })
})

describe('the in-session CLI (wn-cli.ts)', () => {
  async function run(argv: string[]): Promise<{ code: number; err: string }> {
    let err = ''
    const e = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { err += String(c); return true })
    const o = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      return { code: await runWalnutCli(argv), err }
    } finally {
      e.mockRestore()
      o.mockRestore()
    }
  }

  it('sends its own job id; when no answer comes it names it and the read to run', async () => {
    const gw = await gateway(dir, () => HUB_TIMEOUT)
    process.env.WALNUT_AGENT_SOCKET = gw.sock
    process.env.WALNUT_SESSION_ID = 'probe-sid'
    const r = await run(['tools', 'call', 'host_exec', CALL])
    gw.close()
    expect(r.code).toBe(5)
    const sent = gw.requests[0].args.args.job_id as string
    expect(sent).toMatch(/^hx-[0-9a-f-]{36}$/)
    expect(r.err).toContain(`host_exec may have started on studio-mac as job ${sent}: do not run it again`)
    expect(r.err).toContain(`walnut tools call host_exec_read '{"host":"studio-mac","job_id":"${sent}","wait_ms":10000}'`)
  })

  it('an older server refuses the field: the same call once more without it', async () => {
    const gw = await gateway(dir, (req, n) => (n === 1 ? olderServerRefusal(req.args.args) : DONE))
    process.env.WALNUT_AGENT_SOCKET = gw.sock
    process.env.WALNUT_SESSION_ID = 'probe-sid'
    const r = await run(['tools', 'call', 'host_exec', CALL])
    gw.close()
    expect(r.code).toBe(0)
    expect(gw.requests).toHaveLength(2)
    expect(gw.requests[0].args.args.job_id).toMatch(/^hx-/)
    expect(gw.requests[1].args.args).toEqual({ host: 'studio-mac', command: 'swiftc probe.swift && ./probe' })
  })

  it('a server out of reach: nothing ran, and it says so', async () => {
    const gw = await gateway(dir, () => HUB_AWAY)
    process.env.WALNUT_AGENT_SOCKET = gw.sock
    process.env.WALNUT_SESSION_ID = 'probe-sid'
    const r = await run(['tools', 'call', 'host_exec', CALL])
    gw.close()
    expect(r.code).toBe(5)
    expect(r.err).toContain('so nothing ran on studio-mac')
    expect(r.err).not.toContain('may have started')
  })

  it('a daemon socket that refuses the connection: the call never left, so nothing ran', async () => {
    process.env.WALNUT_AGENT_SOCKET = staleSocket(dir)
    process.env.WALNUT_SESSION_ID = 'probe-sid'
    const r = await run(['tools', 'call', 'host_exec', CALL])
    expect(r.code).toBe(6)
    expect(r.err).toContain("host_exec did not reach this host's Walnut daemon, so nothing ran on studio-mac")
    expect(r.err).not.toContain('may have started')
  })
})

describe('the template CLI (daemon-source.ts)', () => {
  async function run(sock: string, flags: string[] = [], op = 'host_exec', payload = CALL): Promise<{ code: number | null; err: string; out: string }> {
    const twin = path.join(dir, 'daemon.cjs')
    if (!fs.existsSync(twin)) fs.writeFileSync(twin, getDaemonSource())
    return new Promise((resolve) => {
      const child = spawn(SOURCE_TWIN.file, [twin, 'wn', 'tools', 'call', ...flags, op, payload], {
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

  it('sends its own job id, names it when no answer comes, and drops it for an older server', async () => {
    const lost = await gateway(dir, () => HUB_TIMEOUT)
    const r = await run(lost.sock)
    lost.close()
    expect(r.code).toBe(5)
    const sent = lost.requests[0].args.args.job_id as string
    expect(sent).toMatch(/^hx-[0-9a-f-]{36}$/)
    expect(r.err).toContain(`host_exec may have started on studio-mac as job ${sent}: do not run it again`)
    expect(r.err).toContain(`walnut tools call host_exec_read '{"host":"studio-mac","job_id":"${sent}","wait_ms":10000}'`)

    fs.rmSync(path.join(dir, 'gw.sock'), { force: true })
    const old = await gateway(dir, (req, n) => (n === 1 ? olderServerRefusal(req.args.args) : DONE))
    const r2 = await run(old.sock)
    old.close()
    expect(r2.code).toBe(0)
    expect(old.requests.map((q) => q.args.args.job_id === undefined)).toEqual([false, true])

    fs.rmSync(path.join(dir, 'gw.sock'), { force: true })
    const away = await gateway(dir, () => HUB_AWAY)
    const r3 = await run(away.sock)
    away.close()
    expect(r3.err).toContain('so nothing ran on studio-mac')
    expect(r3.err).not.toContain('may have started')

    // --json: stdout stays the one reply, and the run's id still reaches stderr.
    fs.rmSync(path.join(dir, 'gw.sock'), { force: true })
    const lostJson = await gateway(dir, () => HUB_TIMEOUT)
    const r4 = await run(lostJson.sock, ['--json'])
    lostJson.close()
    expect(JSON.parse(r4.out)).toEqual(HUB_TIMEOUT)
    expect(r4.err).toContain(`as job ${lostJson.requests[0].args.args.job_id as string}: do not run it again`)

    // A socket that refuses the connection: the call never left.
    const r5 = await run(staleSocket(dir))
    expect(r5.code).toBe(6)
    expect(r5.err).toContain("host_exec did not reach this host's Walnut daemon, so nothing ran on studio-mac")
    expect(r5.err).not.toContain('may have started')
  }, 60_000)

  it('picks a copy_id for host_copy the same way, and says the same as the other clients', async () => {
    const copy = { from_host: 'devbox', from: '~/out/app.tgz', to_host: 'studio-mac', to: '~/in/app.tgz' }
    const lost = await gateway(dir, () => HUB_TIMEOUT)
    const r = await run(lost.sock, [], 'host_copy', JSON.stringify(copy))
    lost.close()
    expect(r.code).toBe(5)
    const sent = lost.requests[0].args.args.copy_id as string
    expect(sent).toMatch(/^hc-[0-9a-f-]{36}$/)
    expect(lost.requests[0].args.args.job_id).toBeUndefined()
    for (const line of lostRunLines('host_copy', copy, sent)) expect(r.err).toContain(line)

    fs.rmSync(path.join(dir, 'gw.sock'), { force: true })
    const old = await gateway(dir, (req, n) => (n === 1 ? olderServerRefusal(req.args.args, 'host_copy') : DONE))
    const r2 = await run(old.sock, [], 'host_copy', JSON.stringify(copy))
    old.close()
    expect(r2.code).toBe(0)
    expect(old.requests.map((q) => q.args.args.copy_id === undefined)).toEqual([false, true])

    fs.rmSync(path.join(dir, 'gw.sock'), { force: true })
    const away = await gateway(dir, () => HUB_AWAY)
    const r3 = await run(away.sock, [], 'host_copy', JSON.stringify(copy))
    away.close()
    expect(r3.err).toContain(awayLines('host_copy', copy)[0])
    expect(r3.err).not.toContain('may have started')
  }, 60_000)
})

describe('the Mac\'s own CLI (src/commands/tools.ts)', () => {
  it('an older server refuses the field: the same call once more without it', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const server = http.createServer((req, res) => {
      let buf = ''
      req.on('data', (c) => { buf += c })
      req.on('end', () => {
        const body = buf ? JSON.parse(buf) as Record<string, unknown> : {}
        bodies.push(body)
        res.setHeader('Content-Type', 'application/json')
        if (bodies.length === 1) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: olderServerRefusal({ host: 'studio-mac', ...body }).error.message }))
          return
        }
        res.end(JSON.stringify(DONE.result))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const saved = process.env.OPEN_WALNUT_API_URL
    process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
    delete process.env.WALNUT_AGENT_SOCKET
    delete process.env.WALNUT_SESSION_ID
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await runTools(['call', 'host_exec', CALL], {})
      expect(bodies).toHaveLength(2)
      expect(bodies[0].job_id).toMatch(/^hx-/)
      expect(bodies[1].job_id).toBeUndefined()
      expect(process.exitCode ?? 0).toBe(0)
    } finally {
      log.mockRestore()
      error.mockRestore()
      if (saved === undefined) delete process.env.OPEN_WALNUT_API_URL; else process.env.OPEN_WALNUT_API_URL = saved
      server.close()
    }
  })
})

describe('the MCP server on a host (walnut-mcp-stdio.ts)', () => {
  const formatError = (e: { code: string; message: string }) => [`walnut: ${e.code}: ${e.message}`]
  const call = { jsonrpc: '2.0' as const, id: 1, method: 'tools/call', params: { name: 'host_exec', arguments: { host: 'studio-mac', command: 'true' } } }

  it('sends its own job id and names it when no answer comes', async () => {
    const seen: Array<Record<string, unknown>> = []
    const handle = createWalnutMcpHandler({ formatError, request: async (_op, a) => { seen.push((a as { args: Record<string, unknown> }).args); return HUB_TIMEOUT as never } })
    const reply = await handle(call)
    const text = (reply?.result as { content: Array<{ text: string }> }).content[0].text
    const sent = seen[0].job_id as string
    expect(sent).toMatch(/^hx-/)
    expect(text).toContain(`as job ${sent}: do not run it again`)
    // The client's own arguments are left as they were.
    expect(call.params.arguments).toEqual({ host: 'studio-mac', command: 'true' })
  })

  it('drops the field for an older server, and says nothing ran when the server is out of reach', async () => {
    const seen: Array<Record<string, unknown>> = []
    const handle = createWalnutMcpHandler({
      formatError,
      request: async (_op, a) => {
        const args = { ...(a as { args: Record<string, unknown> }).args }
        seen.push(args)
        return (seen.length === 1 ? olderServerRefusal(args) : DONE) as never
      },
    })
    expect((await handle(call))?.result).toMatchObject({ content: [{ text: expect.stringContaining('hx-from-the-server') }] })
    expect(seen.map((s) => s.job_id === undefined)).toEqual([false, true])
    const away = createWalnutMcpHandler({ formatError, request: async () => HUB_AWAY as never })
    const text = ((await away(call))?.result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain('so nothing ran on studio-mac')
  })

  it('a daemon socket that refused the connection ran nothing; one that broke after the write may have', async () => {
    const refused = createWalnutMcpHandler({ formatError, request: async () => { throw Object.assign(new Error('connect ECONNREFUSED /run/walnut.sock'), { code: 'ECONNREFUSED' }) } })
    const a = ((await refused(call))?.result as { content: Array<{ text: string }> }).content[0].text
    expect(a).toContain("host_exec did not reach this host's Walnut daemon, so nothing ran on studio-mac")
    expect(a).not.toContain('may have started')
    const broke = createWalnutMcpHandler({ formatError, request: async () => { throw new Error('agent socket closed without a response') } })
    const b = ((await broke(call))?.result as { content: Array<{ text: string }> }).content[0].text
    expect(b).toContain('do not run it again')
  })
})
