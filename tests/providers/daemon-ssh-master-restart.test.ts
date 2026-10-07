/**
 * A server restart keeps the host's SSH ControlMaster, so it needs no new login.
 *
 * 2026-10-07: the user's SSH certificate expired at 04:45; the master the server
 * had authenticated at 04:38 kept the host working. A deploy at 05:09 restarted
 * the server: the old process sent `-O exit`, the new one built a socket path from
 * its own pid, had to log in again and could not. Every session on that host
 * stopped answering ("Couldn't start a session", "Message couldn't be delivered")
 * until the user logged in again.
 *
 * MACHINE SAFETY: no real ssh. `ssh` on PATH is tests/providers/fixtures/
 * fake-ssh-master.mjs (in front of the exec guard), whose master is a real
 * detached process on a real unix socket; every one is killed in afterEach.
 * The real OpenSSH behaviour this relies on is pinned by
 * tests/providers/ssh-control-master.live.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DaemonConnection, disconnectAllDaemons, setPooledConnectionForTest } from '../../src/providers/daemon-connection.js'
import type { SshTarget } from '../../src/providers/session-io.js'
import { guardedPath } from '../setup/exec-guard.js'

const TARGET: SshTarget = { hostname: 'devbox.example.com', user: 'tester' }
const FAKE = path.resolve(__dirname, 'fixtures/fake-ssh-master.mjs')

type Priv = Record<string, (...args: unknown[]) => Promise<unknown>> & Record<string, unknown>
const priv = (conn: DaemonConnection) => conn as unknown as Priv

let state = ''
let savedPath: string | undefined
let savedState: string | undefined
let sockets: string[] = []

const calls = (): string[][] => {
  try {
    return fs.readFileSync(path.join(state, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
const kind = (argv: string[]): string => {
  if (argv.includes('-O')) return argv[argv.indexOf('-O') + 1]
  if (argv.includes('-fN')) return 'start'
  if (argv[argv.length - 1] === 'true') return 'verify'
  return 'other'
}
const kinds = () => calls().map(kind)
const resetCalls = () => fs.rmSync(path.join(state, 'calls.jsonl'), { force: true })
const flag = (name: string, on = true) => on ? fs.writeFileSync(path.join(state, name), '') : fs.rmSync(path.join(state, name), { force: true })

/** A fresh server process: a new DaemonConnection with nothing in memory. */
async function connectMaster(): Promise<DaemonConnection> {
  const conn = new DaemonConnection('devbox', TARGET)
  await priv(conn).ensureControlMaster()
  const p = priv(conn)._controlPath as string | null
  if (p) sockets.push(p)
  return conn
}

async function waitFor(what: string, probe: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeEach(() => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fake-ssh-'))
  const bin = path.join(state, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o755 })
  savedPath = process.env.PATH
  savedState = process.env.FAKE_SSH_STATE
  process.env.PATH = guardedPath([bin])
  process.env.FAKE_SSH_STATE = state
  sockets = []
})

afterEach(() => {
  setPooledConnectionForTest('devbox', null)
  for (const sock of new Set(sockets)) {
    try { process.kill(Number(fs.readFileSync(`${sock}.pid`, 'utf8')), 'SIGKILL') } catch { /* already gone */ }
    for (const f of [sock, `${sock}.pid`, `${sock}.forwards`]) fs.rmSync(f, { force: true })
  }
  process.env.PATH = savedPath
  if (savedState === undefined) delete process.env.FAKE_SSH_STATE
  else process.env.FAKE_SSH_STATE = savedState
  fs.rmSync(state, { recursive: true, force: true })
})

describe('the SSH ControlMaster across a server restart', () => {
  it('the next process reuses the master the last one left, with no login, also once the credential has expired', async () => {
    const first = await connectMaster()
    expect(kinds()).toEqual(['start'])
    const socket = priv(first)._controlPath as string

    // Server shutdown: every connection goes, the master stays.
    setPooledConnectionForTest('devbox', first)
    disconnectAllDaemons()
    await new Promise((r) => setTimeout(r, 200))
    expect(kinds()).not.toContain('exit')
    expect(fs.existsSync(socket)).toBe(true)

    // The certificate expires: a new login would now fail.
    flag('credential-expired')
    resetCalls()
    const next = await connectMaster()
    expect(priv(next)._controlPath).toBe(socket)
    expect(kinds()).toEqual(['check', 'verify'])
    expect(kinds()).not.toContain('start')
  })

  it('a forward the last process opened through the master is cancelled by the next one', async () => {
    const first = await connectMaster()
    const socket = priv(first)._controlPath as string
    fs.appendFileSync(`${socket}.forwards`, '51234:127.0.0.1:39829\n')
    setPooledConnectionForTest('devbox', first)
    disconnectAllDaemons()
    resetCalls()

    await connectMaster()
    const cancels = calls().filter((c) => kind(c) === 'cancel')
    expect(cancels).toHaveLength(1)
    expect(cancels[0]).toEqual(expect.arrayContaining(['-L', '51234:127.0.0.1:39829']))
    expect(fs.existsSync(`${socket}.forwards`)).toBe(false)
  })

  it('a master whose link carries nothing is ended and replaced, not reused', async () => {
    const first = await connectMaster()
    const socket = priv(first)._controlPath as string
    flag('link-dead')
    resetCalls()

    priv(first)._controlPath = null // what reconnect() does before ensureControlMaster
    await priv(first).ensureControlMaster()
    expect(kinds()).toEqual(['check', 'verify', 'exit', 'start'])
    expect(priv(first)._controlPath).toBe(socket)
  })

  it('a dead master leaves a socket nothing answers on: removed, and a new one started', async () => {
    const first = await connectMaster()
    const socket = priv(first)._controlPath as string
    process.kill(Number(fs.readFileSync(`${socket}.pid`, 'utf8')), 'SIGKILL')
    await waitFor('the master to die', () => { try { process.kill(Number(fs.readFileSync(`${socket}.pid`, 'utf8')), 0); return false } catch { return true } })
    resetCalls()

    await connectMaster()
    expect(kinds()).toEqual(['check', 'exit', 'start'])
  })

  it('an explicit disconnect (not a shutdown) still ends the master', async () => {
    const conn = await connectMaster()
    const socket = priv(conn)._controlPath as string
    resetCalls()
    conn.disconnect()
    await waitFor('the exit request', () => kinds().includes('exit'))
    expect(fs.existsSync(socket)).toBe(false)
  })

  it('a reconnect in the same process keeps a master that still works', async () => {
    const conn = await connectMaster()
    flag('credential-expired')
    resetCalls()
    priv(conn)._controlPath = null // what reconnect() does before ensureControlMaster
    await priv(conn).ensureControlMaster()
    expect(kinds()).toEqual(['check', 'verify'])
    expect(priv(conn)._controlPath).not.toBeNull()
  })
})
