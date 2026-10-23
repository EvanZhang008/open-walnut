/**
 * The in-app terminal through a real server and a real pty: no stub between the
 * `/ws` RPC and the shell. Runs on both runtimes, so it proves src/lib/pty.ts on
 * each (node-pty on Node, the built-in terminal on bun, where node-pty's output
 * never arrives).
 *
 *   ws terminal:open -> register -> dtach check (local: dtach if it can be had,
 *   else a plain shell) -> terminal-manager -> spawn -> loadPty().spawn
 *   -> the shell's output back as terminal:data:<id> events
 *
 * What it pins: the shell runs and answers input, a UTF-8 character survives the
 * trip whole, a resize reaches the shell, Ctrl-C interrupts the foreground job,
 * a reattach replays what was printed, and the shell's own exit reaches the
 * client as terminal:exit:<id>.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-terminal-pty'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'

let server: HttpServer
let port = 0
let savedShell: string | undefined

interface Frame { type: string; id?: string; ok?: boolean; payload?: Record<string, unknown>; error?: string; name?: string; data?: Record<string, unknown> }

/** One client: its RPCs and the terminal output it has been sent. */
class Client {
  output = ''
  exits: Array<Record<string, unknown>> = []
  constructor(readonly ws: WebSocket, private terminalId = '') {
    ws.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as Frame
      if (frame.type !== 'event' || !this.terminalId) return
      if (frame.name === `terminal:data:${this.terminalId}`) this.output += String(frame.data?.data ?? '')
      if (frame.name === `terminal:exit:${this.terminalId}`) this.exits.push(frame.data ?? {})
    })
  }

  static async connect(): Promise<Client> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://localhost:${port}/ws`)
      s.on('open', () => resolve(s))
      s.on('error', reject)
    })
    return new Client(ws)
  }

  rpc(method: string, payload: unknown): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const id = `t-${Math.random().toString(36).slice(2)}`
      const timer = setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 30_000)
      const onMessage = (raw: Buffer) => {
        const frame = JSON.parse(raw.toString()) as Frame
        if (frame.type !== 'res' || frame.id !== id) return
        clearTimeout(timer)
        this.ws.off('message', onMessage)
        resolve(frame)
      }
      this.ws.on('message', onMessage)
      this.ws.send(JSON.stringify({ type: 'req', id, method, payload }))
    })
  }

  async open(sessionId: string, cols = 100, rows = 30): Promise<Record<string, unknown>> {
    // The terminal's id is its session's (one terminal per session), and a
    // reattach replays the scrollback BEFORE the open answers.
    this.terminalId = sessionId
    const res = await this.rpc('terminal:open', { sessionId, cols, rows })
    expect(res.ok, res.error).toBe(true)
    const payload = res.payload ?? {}
    expect(payload.ok).toBe(true)
    expect(payload.terminalId).toBe(sessionId)
    return payload
  }

  async input(data: string): Promise<void> {
    const res = await this.rpc('terminal:input', { terminalId: this.terminalId, data })
    expect(res.ok, res.error).toBe(true)
  }

  /** Wait until the output matches; the error names what did arrive. */
  async waitFor(pattern: RegExp, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!pattern.test(this.output)) {
      if (Date.now() > deadline) throw new Error(`no ${pattern} in terminal output: ${JSON.stringify(this.output.slice(-600))}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  get id(): string { return this.terminalId }
}

beforeAll(async () => {
  // A plain POSIX shell: a login zsh in the test's empty HOME would stop at its
  // first-run menu instead of a prompt.
  savedShell = process.env.SHELL
  process.env.SHELL = '/bin/sh'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 60_000)

afterAll(async () => {
  await stopServer()
  if (savedShell === undefined) delete process.env.SHELL
  else process.env.SHELL = savedShell
}, 30_000)

describe('the in-app terminal over a real pty', () => {
  it('runs a shell that answers input, keeps UTF-8 whole, resizes, and takes Ctrl-C', async () => {
    const sessionId = 'term-pty-e2e-1'
    const cwd = path.join(WALNUT_HOME, 'work')
    await fs.mkdir(cwd, { recursive: true })
    await createSessionRecord(sessionId, `task-${sessionId}`, '', cwd)

    const client = await Client.connect()
    const opened = await client.open(sessionId, 100, 30)
    expect(typeof opened.persistent).toBe('boolean')

    await client.input('echo walnut-$((6*7)) "$PWD"\r')
    await client.waitFor(new RegExp(`walnut-42 ${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

    // A three-byte character printed as single bytes arrives as one character.
    await client.input("printf 'u-\\344\\275\\240-\\n'\r")
    await client.waitFor(/u-你-/)

    const resized = await client.rpc('terminal:resize', { terminalId: client.id, cols: 132, rows: 40 })
    expect(resized.ok, resized.error).toBe(true)
    await client.input('echo size-$(stty size | tr " " x)\r')
    await client.waitFor(/size-40x132/)

    await client.input('sleep 30 && echo slept-$((1+1))\r')
    await new Promise((r) => setTimeout(r, 500))
    await client.input('\x03')
    await client.input('echo after-$((2+2))\r')
    await client.waitFor(/after-4/)
    expect(client.output).not.toMatch(/slept-2/)

    // A second client reattaches the live terminal and gets the scrollback.
    client.ws.close()
    const again = await Client.connect()
    const reopened = await again.open(sessionId, 132, 40)
    expect(reopened.terminalId).toBe(opened.terminalId)
    await again.waitFor(/walnut-42/)

    // The shell's own exit reaches the client.
    await again.input('exit\r')
    const deadline = Date.now() + 20_000
    while (again.exits.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    expect(again.exits.length, `no terminal:exit; output ${JSON.stringify(again.output.slice(-300))}`).toBe(1)
    await again.rpc('terminal:kill', { terminalId: again.id })
    again.ws.close()
  }, 90_000)
})
