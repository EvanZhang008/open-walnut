/**
 * `walnut tools call` from a Mac session while the Walnut server is down: the
 * installed CLI hands the call to the session's host daemon over the agent
 * socket (docs/plan/daemon-first-hosts.md), exactly as the daemon's own shim
 * would send it.
 *
 * Real pieces: runTools (the command), the op executor's HTTP attempt against a
 * port nothing listens on, and the daemon CLI client over a real unix socket.
 * The daemon itself is a small NDJSON server in a temp dir that records what it
 * was asked; no Walnut server, no daemon process, no claude CLI.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { runTools } from '../../src/commands/tools.js'

let dir: string
let sock: string
let gateway: net.Server
let received: Array<Record<string, unknown>> = []
let answer: Record<string, unknown> = { ok: true, result: {} }
/** When set, answers per request (the catalog and the call need different replies). */
let answerFor: ((req: Record<string, unknown>) => Record<string, unknown>) | null = null
let deadPort = 0
const saved: Record<string, string | undefined> = {}
let out = ''
let err = ''

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-tools-fallback-'))
  sock = path.join(dir, 'agent-gateway.sock')
  gateway = net.createServer((c) => {
    let buf = ''
    c.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>
      received.push(req)
      c.end(JSON.stringify(answerFor ? answerFor(req) : answer) + '\n')
    })
  })
  await new Promise<void>((resolve) => gateway.listen(sock, resolve))
  // A port that was just free: connection refused, like a stopped server.
  deadPort = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => gateway.close(() => resolve()))
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  for (const k of ['OPEN_WALNUT_API_URL', 'WALNUT_AGENT_SOCKET', 'WALNUT_SESSION_ID']) saved[k] = process.env[k]
  process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${deadPort}`
  received = []
  answer = { ok: true, result: {} }
  answerFor = null
  out = ''
  err = ''
  process.exitCode = undefined
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
    out += String(chunk)
    const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined
    cb?.()
    return true
  }) as typeof process.stdout.write)
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { err += String(chunk); return true }) as typeof process.stderr.write)
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out += a.map(String).join(' ') + '\n' })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err += a.map(String).join(' ') + '\n' })
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  process.exitCode = undefined
})

describe('walnut tools call with the server down', () => {
  it('inside a session: the host daemon answers the same call', async () => {
    process.env.WALNUT_AGENT_SOCKET = sock
    process.env.WALNUT_SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
    answer = { ok: true, result: { offline: true, task: { id: 'mtask-1', title: 'Parent work' } } }
    await runTools(['call', 'task_get', '{"id":"mtask-1"}'], {})
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      v: 1, op: 'tools.call', sid: 'aaaaaaaa-1111-4111-8111-111111111111',
      args: { name: 'task_get', args: { id: 'mtask-1' } },
    })
    expect(JSON.parse(out)).toEqual(answer.result)
    expect(err).toContain("asking this host's daemon")
    expect(err).not.toContain('server not running')
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('a daemon refusal is printed and fails the command', async () => {
    process.env.WALNUT_AGENT_SOCKET = sock
    process.env.WALNUT_SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
    answer = { ok: false, error: { code: 'hub_unreachable', message: 'note_search needs the Walnut server, which is not connected to this host.' } }
    await runTools(['call', 'note_search', '{"q":"x"}'], {})
    expect(received).toHaveLength(1)
    expect(err).toContain('needs the Walnut server')
    expect(process.exitCode).not.toBe(0)
  })

  it('outside a session: the usual "server not running" error, no daemon asked', async () => {
    delete process.env.WALNUT_AGENT_SOCKET
    delete process.env.WALNUT_SESSION_ID
    await runTools(['call', 'task_get', '{"id":"mtask-1"}'], {})
    expect(received).toEqual([])
    expect(err).toContain('Walnut server not running')
    expect(process.exitCode).toBe(1)
  })

  it('a session whose daemon socket is gone: the usual error', async () => {
    process.env.WALNUT_AGENT_SOCKET = path.join(dir, 'missing.sock')
    process.env.WALNUT_SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
    await runTools(['call', 'task_get', '{"id":"mtask-1"}'], {})
    expect(received).toEqual([])
    expect(err).toContain('Walnut server not running')
    expect(process.exitCode).toBe(1)
  })
})

/**
 * A plugin declares its ops inside the server process, so the installed CLI never
 * sees them. Inside a session the host daemon is the way there (2026-10-06: an
 * Inbox Triage run got "Unknown op: mail_list" and could not mark mail read).
 */
describe('walnut tools reaches a plugin op through the host daemon', () => {
  const SID = 'bbbbbbbb-2222-4222-8222-222222222222'
  const HUB_OPS = [
    { name: 'task_list', title: 'List tasks', readonly: true, remote: 'allow', signature: 'q?' },
    { name: 'mail_list', title: 'List mail', readonly: true, remote: 'allow', signature: 'account?, limit?' },
    { name: 'mail_mark_read', title: 'Mark mail read or unread', readonly: false, remote: 'deny', signature: 'account?, messages, read?' },
  ]
  const hub = (req: Record<string, unknown>): Record<string, unknown> => {
    if (req.op === 'tools.list') {
      const name = (req.args as { name?: string } | undefined)?.name
      if (!name) return { ok: true, result: { ops: HUB_OPS } }
      const row = HUB_OPS.find((o) => o.name === name)
      return { ok: true, result: { ops: row ? [{ ...row, description: 'Set the read flag.', params: [{ name: 'messages', type: 'string[]', required: true }] }] : [] } }
    }
    return { ok: true, result: { marked: 2, account: 'work' } }
  }

  beforeEach(() => {
    process.env.WALNUT_AGENT_SOCKET = sock
    process.env.WALNUT_SESSION_ID = SID
    answerFor = hub
  })

  it('call: an op unknown here goes to the daemon with its arguments untouched', async () => {
    await runTools(['call', 'mail_mark_read', '{"messages":["m1","m2"]}'], {})
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      v: 1, op: 'tools.call', sid: SID,
      args: { name: 'mail_mark_read', args: { messages: ['m1', 'm2'] } },
    })
    expect(JSON.parse(out)).toEqual({ marked: 2, account: 'work' })
    // Not the outage path: no "server not reachable" notice.
    expect(err).not.toContain('not reachable')
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('call: a core op still runs here, the daemon is not asked first', async () => {
    await runTools(['call', 'task_get', '{"id":"mtask-1"}'], {})
    // The server is down in this file, so the ONE daemon call is the outage fallback.
    expect(received).toHaveLength(1)
    expect(err).toContain("asking this host's daemon")
  })

  it('call: outside a session an unknown op is the usual error and no daemon is asked', async () => {
    delete process.env.WALNUT_AGENT_SOCKET
    delete process.env.WALNUT_SESSION_ID
    await runTools(['call', 'mail_mark_read', '{"messages":["m1"]}'], {})
    expect(received).toEqual([])
    expect(err).toContain('Unknown op: mail_mark_read')
    expect(process.exitCode).toBe(1)
  })

  it('call: the flag form for an unknown op says to pass JSON', async () => {
    await runTools(['call', 'mail_mark_read', '--messages', 'm1'], {})
    expect(received).toEqual([])
    expect(err).toContain("walnut tools call mail_mark_read '{...}'")
    expect(process.exitCode).toBe(1)
  })

  it('list: plugin ops join the core catalog once, and --readonly drops the writes', async () => {
    await runTools(['list'], {})
    expect(out).toContain('mail_mark_read')
    expect(out).toContain('mail_list')
    expect(out.match(/^\s*task_list\b/gm)).toHaveLength(1)
    expect(received.map((r) => r.op)).toEqual(['tools.list'])

    out = ''
    await runTools(['list', '--readonly'], {})
    expect(out).toContain('mail_list')
    expect(out).not.toContain('mail_mark_read')
  })

  it('list: no daemon answer still prints the core catalog', async () => {
    answerFor = () => ({ ok: false, error: { code: 'hub_unreachable', message: 'down' } })
    await runTools(['list'], {})
    expect(out).toContain('task_list')
    expect(out).not.toContain('mail_list')
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('help: a plugin op shows the parameters the server reports', async () => {
    await runTools(['help', 'mail_mark_read'], {})
    expect(received[0]).toMatchObject({ op: 'tools.list', args: { name: 'mail_mark_read' } })
    expect(out).toContain('mail_mark_read')
    expect(out).toContain('messages')
    expect(process.exitCode ?? 0).toBe(0)
  })
})
