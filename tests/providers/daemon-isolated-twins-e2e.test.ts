/**
 * A test server's isolated daemon on a remote host (src/providers/remote-isolation.ts),
 * both daemon twins booted for real:
 *   - its hello says which Walnut it is: its dir, and the test server's key;
 *   - a daemon named for a test server refuses to start in a production daemon dir;
 *   - with no server socket for its lease it ends itself and removes its own root
 *     (`/tmp/open-walnut-test-<key>`), and only that root.
 *
 * MACHINE SAFETY: HOME is a temp dir, the "production dir" case is that temp HOME's
 * ~/.cache/open-walnut (never the real /tmp/open-walnut), every isolated root uses a
 * key made for this run, and every daemon is SIGKILLed after its test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { isolatedDaemonEnv, isolatedLayout, ISOLATED_TMP_PREFIX } from '../../src/providers/remote-isolation.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { guardedPath } from '../setup/exec-guard.js'

let scriptPath = ''
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
const cleanup: string[] = []

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-isolated-twins-src-'))
  cleanup.push(dir)
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  try { ws?.close() } catch { /* already closed */ }
  ws = null
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    proc.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  proc = null
  for (const d of cleanup.splice(1)) fs.rmSync(d, { recursive: true, force: true })
})

function tempHome(): string {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-isolated-twins-home-')))
  cleanup.push(home)
  return home
}

/** A key of this run's own: the root it names is ours alone. */
function freshKey(): string {
  return crypto.randomBytes(8).toString('hex')
}

function launch(twin: Twin, env: Record<string, string>): ChildProcess {
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, {
    env: { ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), WALNUT_LEGACY_STREAMS_DIR: '/nonexistent-walnut-legacy-streams', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return proc
}

async function portOf(p: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    let err = ''
    p.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    p.stderr?.on('data', (chunk) => { err += chunk.toString() })
    p.on('exit', (code) => { clearTimeout(timer); reject(new Error(`daemon exited ${code}: ${err.slice(-500)}`)) })
  })
}

async function hello(port: number): Promise<Record<string, unknown>> {
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hello timeout')), 20_000)
    ws!.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      if (msg.id === 1) { clearTimeout(timer); resolve(msg) }
    })
    ws!.send(JSON.stringify({ id: 1, cmd: 'hello', run: 'isolated-twins-test' }))
  })
}

function exitOf(p: ChildProcess, ms: number): Promise<number | null | 'running'> {
  return new Promise((resolve) => {
    if (p.exitCode !== null || p.signalCode !== null) return resolve(p.exitCode)
    const t = setTimeout(() => resolve('running'), ms)
    p.once('exit', (code) => { clearTimeout(t); resolve(code) })
  })
}

describe.each(TWINS)('isolated daemon: $name', (twin) => {
  it('says its dir and the test server it serves in its hello; a plain daemon names no test server', async () => {
    const home = tempHome()
    const key = freshKey()
    const root = path.join(home, 'iso-root')
    const env = isolatedDaemonEnv(root, key)
    const port = await portOf(launch(twin, { HOME: home, ...env, WALNUT_DAEMON_ORPHAN_EXIT_MS: '' }))
    const res = await hello(port)
    expect(res).toMatchObject({ ok: true, dir: isolatedLayout(root).daemonDir, isolatedFor: key })
    // The source twin learns its task dir root from the task-dir sidecar a deploy uploads; this test ships none.
    if (twin.name.startsWith('standalone') || res.taskDirRoot !== undefined) expect(res.taskDirRoot).toBe(isolatedLayout(root).taskDirRoot)
    ws?.close(); proc?.kill('SIGKILL'); await exitOf(proc!, 3000)

    // The same daemon without the key: its hello names no test server.
    const plainDir = path.join(home, 'plain', 'daemon')
    const port2 = await portOf(launch(twin, { HOME: home, WALNUT_DAEMON_DIR: plainDir, WALNUT_STREAMS_DIR: plainDir + '-streams' }))
    const res2 = await hello(port2)
    expect(res2).toMatchObject({ ok: true, dir: plainDir })
    expect(res2).not.toHaveProperty('isolatedFor')
  })

  it('refuses to start in a production daemon dir', async () => {
    const home = tempHome()
    // $HOME/.cache/open-walnut is a production dir to both twins (the remote home fallback).
    const prod = path.join(home, '.cache', 'open-walnut')
    const p = launch(twin, { HOME: home, WALNUT_DAEMON_DIR: prod, WALNUT_STREAMS_DIR: path.join(home, 'streams'), WALNUT_DAEMON_ISOLATED_FOR: freshKey() })
    let err = ''
    p.stderr?.on('data', (c) => { err += c.toString() })
    const code = await exitOf(p, 20_000)
    expect(code).not.toBe(0)
    expect(code).not.toBe('running')
    expect(err).toMatch(/isolated daemon: refusing to start it in the production daemon dir/)
    expect(fs.existsSync(path.join(prod, 'daemon.pid'))).toBe(false)
  })

  it('with no server for its lease it ends itself and removes its own root, nothing else', async () => {
    const home = tempHome()
    const key = freshKey()
    const root = `${ISOLATED_TMP_PREFIX}${key}`
    cleanup.push(root)
    const neighbour = path.join(home, 'neighbour')
    fs.mkdirSync(neighbour)
    fs.writeFileSync(path.join(neighbour, 'keep.txt'), 'x')
    const env = { ...isolatedDaemonEnv(root, key), WALNUT_DAEMON_ORPHAN_EXIT_MS: '1500', WALNUT_DAEMON_HEARTBEAT_MS: '300' }
    const p = launch(twin, { HOME: home, ...env })
    await portOf(p)
    expect(fs.existsSync(isolatedLayout(root).daemonDir)).toBe(true)
    // No socket connects: the lease runs out.
    const code = await exitOf(p, 20_000)
    expect(code).toBe(0)
    expect(fs.existsSync(root)).toBe(false)
    expect(fs.readFileSync(path.join(neighbour, 'keep.txt'), 'utf8')).toBe('x')
  })

  it('keeps its root while a server stays connected', async () => {
    const home = tempHome()
    const key = freshKey()
    const root = `${ISOLATED_TMP_PREFIX}${key}`
    cleanup.push(root)
    const env = { ...isolatedDaemonEnv(root, key), WALNUT_DAEMON_ORPHAN_EXIT_MS: '1500', WALNUT_DAEMON_HEARTBEAT_MS: '300' }
    const p = launch(twin, { HOME: home, ...env })
    await hello(await portOf(p))
    expect(await exitOf(p, 3500)).toBe('running')
    expect(fs.existsSync(isolatedLayout(root).daemonDir)).toBe(true)
  })
})
