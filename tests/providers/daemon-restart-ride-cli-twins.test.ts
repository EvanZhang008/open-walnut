/**
 * Both twins' own `walnut` CLIs against a scripted gateway socket: the answers a
 * stopping daemon gives, a long `walnut wait`, an env-less lookup, and a mark no
 * call may trust (daemon-restart-mark.ts).
 *
 * The real-daemon half (a daemon stops, the next one answers) is
 * daemon-restart-ride-twins-e2e.test.ts; this file pins what a CLI does with each
 * answer, which a real daemon gives only in a window too short to aim at.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the socket are temp paths; the only
 * processes are the CLIs this file starts, each ended when its test ends.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { guardedPath } from '../setup/exec-guard.js'

let scriptPath = ''
let root = ''
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; full: boolean; command: (...args: string[]) => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, full: false, command: (...args) => [SOURCE_TWIN.file, [scriptPath, ...args]] },
  ...(BUN ? [{ name: 'standalone twin (bun)', full: true, command: (...args: string[]): [string, string[]] => [BUN, [STANDALONE, ...args]] }] : []),
]
const WAIT_LINE = 'walnut: the Walnut daemon on this host is restarting; waiting for the next one (up to 45s)'
const STOPPING = { ok: false, error: { code: 'hub_unreachable', message: 'daemon is shutting down; retry after reconnecting', detail: { stopping: true } } }
const procs: ChildProcess[] = []
const servers: net.Server[] = []

const daemonDir = () => path.join(root, 'daemon')
const sockPath = () => path.join(daemonDir(), 'agent-gateway.sock')
const markPath = () => path.join(daemonDir(), 'restarting')
const freshMark = () => fs.writeFileSync(markPath(), String(Math.floor(Date.now() / 1000)))

/** A gateway that answers the n-th request with answers[n] (the last one from then on), keeping every request. */
async function gateway(answers: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const seen: Array<Record<string, unknown>> = []
  const server = net.createServer((sock) => {
    let buf = ''
    sock.on('data', (c) => {
      buf += c.toString('utf-8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      seen.push(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>)
      sock.end(JSON.stringify(answers[Math.min(seen.length - 1, answers.length - 1)]) + '\n')
    })
    sock.on('error', () => { /* the CLI went */ })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(sockPath(), resolve))
  fs.chmodSync(sockPath(), 0o600)
  return seen
}

function cli(twin: Twin, args: string[], extra: Record<string, string> = {}, injected = true): Promise<{ out: string; err: string; code: number | null; ms: number }> {
  const t0 = Date.now()
  const [cmd, argv] = twin.command('walnut', ...args)
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: path.join(root, 'home'),
    WALNUT_DAEMON_DIR: daemonDir(),
    WALNUT_CLI_WAIT_MS: '30000',
    WALNUT_AGENT_SOCKET: undefined,
    WALNUT_SESSION_ID: undefined,
    ...(injected ? { WALNUT_AGENT_SOCKET: sockPath(), WALNUT_SESSION_ID: 'external' } : {}),
    ...extra,
  }
  const child = spawn(cmd, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  procs.push(child)
  let out = ''
  let err = ''
  child.stdout?.on('data', (c) => { out += c })
  child.stderr?.on('data', (c) => { err += c })
  return new Promise((resolve) => child.on('close', (code) => resolve({ out, err, code, ms: Date.now() - t0 })))
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ride-cli-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  for (const p of procs.splice(0)) { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL') }
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()))
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

function newRoot(): void {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.platform() === 'win32' ? os.tmpdir() : '/tmp', 'wrc-')))
  for (const d of [path.join(root, 'home'), daemonDir()]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
}

const CALL = ['tools', 'call', 'task_send', '{}']

for (const twin of TWINS) {
  describe(`a walnut CLI and a daemon restarting, ${twin.name}`, () => {
    it('the stopping daemon\'s answers, then the next one\'s: it waits and prints that answer', async () => {
      newRoot()
      freshMark()
      const seen = await gateway([STOPPING, STOPPING, { ok: true, result: { sent: true } }])
      const r = await cli(twin, CALL)
      expect(r.code).toBe(0)
      expect(JSON.parse(r.out)).toEqual({ sent: true })
      expect(seen).toHaveLength(3)
      expect(r.err.split('\n').filter((l) => l === WAIT_LINE)).toHaveLength(1)
    }, 60_000)

    it('a stopping answer with no mark is the answer, at once, and its detail is not printed as a result', async () => {
      newRoot()
      const seen = await gateway([STOPPING, { ok: true, result: { sent: true } }])
      const r = await cli(twin, CALL)
      expect(r.code).toBe(5)
      expect(seen).toHaveLength(1)
      expect(r.out).not.toContain('stopping')
      expect(r.err).toContain('hub_unreachable')
      expect(r.err).not.toContain('restarting; waiting')
    }, 60_000)

    it('a mark that is a FIFO, a link or too big holds no call: no socket fails at once', async () => {
      for (const plant of ['fifo', 'link', 'big'] as const) {
        newRoot()
        if (plant === 'fifo') { const mk = spawn('mkfifo', [markPath()]); await new Promise((r) => mk.on('close', r)) }
        if (plant === 'link') { const real = path.join(root, 'real-mark'); fs.writeFileSync(real, String(Math.floor(Date.now() / 1000))); fs.symlinkSync(real, markPath()) }
        if (plant === 'big') fs.writeFileSync(markPath(), String(Math.floor(Date.now() / 1000)) + ' '.repeat(64))
        const r = await cli(twin, CALL)
        expect(r.code, plant).toBe(6)
        expect(r.err, plant).not.toContain('restarting; waiting')
        expect(r.ms, plant).toBeLessThan(10_000)
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 90_000)

    it('`walnut wait` polls on through a stopping daemon and a server away, and ends on the answer', async () => {
      newRoot()
      const task = { ok: true, result: { task: { id: 't-1', title: 'x', phase: 'NEED_ACTION' } } }
      const seen = await gateway([STOPPING, { ok: false, error: { code: 'hub_unreachable', message: 'no server' } }, task])
      const r = await cli(twin, ['wait', 't-1', '--timeout', '40'])
      expect(r.code).toBe(0)
      expect(JSON.parse(r.out)).toMatchObject({ done: true, phase: 'NEED_ACTION' })
      expect(seen).toHaveLength(3)
    }, 90_000)

    if (twin.full) {
      it('env-less, with no socket yet: it waits for the next daemon\'s socket, still checked owner-only', async () => {
        newRoot()
        freshMark()
        const run = cli(twin, CALL, {}, false)
        await new Promise((r) => setTimeout(r, 1_500))
        const seen = await gateway([{ ok: true, result: { sent: true } }])
        const r = await run
        expect(r.code).toBe(0)
        expect(JSON.parse(r.out)).toEqual({ sent: true })
        expect(seen[0]).toMatchObject({ sid: 'external' })
        expect(r.err.split('\n').filter((l) => l === WAIT_LINE)).toHaveLength(1)
        expect(r.ms).toBeGreaterThanOrEqual(1_400)
      }, 60_000)
    }
  })
}
