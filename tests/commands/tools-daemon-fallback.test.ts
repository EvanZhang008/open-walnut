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
      received.push(JSON.parse(buf.slice(0, nl)))
      c.end(JSON.stringify(answer) + '\n')
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
