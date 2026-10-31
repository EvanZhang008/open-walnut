/**
 * host.vitals ('host-vitals-v1') on both daemon twins booted for real: the
 * capability is advertised, the daemon starts its minute ledger at boot inside
 * its isolated daemon dir (never under the real HOME), a Walnut socket counts as
 * linked, and the reply carries real readings and the folded ledger.
 *
 * MACHINE SAFETY: HOME, the daemon dir, the streams dir and the ledger are temp
 * paths; the daemon is SIGKILLed after each test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'

let scriptPath = ''
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]
let proc: ChildProcess | null = null
let port = 0
const sockets: WebSocket[] = []
let rpcId = 1
let root = ''

async function boot(twin: Twin): Promise<{ home: string; daemon: string }> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-vitals-e2e-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const daemon = path.join(root, 'daemon')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh', PATH: '/usr/bin:/bin', HOME: home,
    WALNUT_DAEMON_DIR: daemon,
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
    WALNUT_HOST_VITALS_DIR: undefined,
  }
  delete env.WALNUT_HOST_VITALS_DIR
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc!.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  return { home, daemon }
}

async function connect(): Promise<WebSocket> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  sockets.push(ws)
  return ws
}

function rpc(ws: WebSocket, cmd: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); ws.off('message', onMessage); resolve(msg) }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, ...cmd }))
  })
}

async function waitFor(check: () => boolean, ms = 20_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return check()
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-vitals-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  for (const s of sockets.splice(0)) { try { s.close() } catch { /* closed */ } }
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((resolve) => { const t = setTimeout(resolve, 10_000); proc!.once('exit', () => { clearTimeout(t); resolve() }) })
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
  if (root.includes('walnut-vitals-e2e-')) fs.rmSync(root, { recursive: true, force: true })
})

describe.each(TWINS)('host.vitals on the $name', (twin) => {
  it('advertises the capability, writes its ledger beside the daemon dir, and answers with real readings', async () => {
    const { home, daemon } = await boot(twin)
    const ws = await connect()
    const hello = await rpc(ws, { cmd: 'hello' })
    expect(hello.capabilities as string[]).toContain('host-vitals-v1')
    const ledgerDir = path.join(daemon, 'host-vitals')
    const lines = () => {
      try { return fs.readdirSync(ledgerDir).flatMap((f) => fs.readFileSync(path.join(ledgerDir, f), 'utf8').trim().split('\n').filter(Boolean)) } catch { return [] }
    }
    expect(await waitFor(() => lines().length > 0)).toBe(true)
    const first = JSON.parse(lines()[0]) as Record<string, number>
    expect(first.m).toBe(Math.floor(first.m))
    expect(first.d).toBeGreaterThan(0)
    // Nothing under the (temp) HOME: an isolated daemon never writes the real ledger place.
    expect(fs.existsSync(path.join(home, '.open-walnut', 'tmp', 'host-vitals'))).toBe(false)
    const res = await rpc(ws, { cmd: 'host.vitals', days: 1 })
    expect(res.ok).toBe(true)
    const stats = res.stats as Record<string, unknown>
    expect(stats.cpus as number).toBeGreaterThan(0)
    expect(stats.memTotalBytes as number).toBeGreaterThan(0)
    expect(stats.memAvailBytes as number).toBeGreaterThan(0)
    expect(stats.linked).toBe(true) // this socket is a Walnut server's link
    expect(typeof stats.uptimeSec).toBe('number')
    const history = res.history as Record<string, unknown>
    expect(history.coverageFrom).toBe(first.m * 60_000)
    expect(history.bucketMinutes).toBe(60)
    expect((history.buckets as unknown[]).length).toBe(24)
    expect((res.ledger as Record<string, unknown>).writeErrors).toBe(0)
  }, 60_000)
})
