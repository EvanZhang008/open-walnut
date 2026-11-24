/**
 * The session daemon (daemon-standalone.ts), booted for real under bun, says this machine's stable id in its hello
 * (`machineId`, machine-id-core.ts): the id in `~/.local/state/open-walnut/machine-id`, made
 * once, seeded from the data dir's older id (the same rule as the server's), the same for every daemon of the account whatever
 * its dir, and never under XDG_STATE_HOME.
 *
 * MACHINE SAFETY: HOME is a temp dir per test, every daemon dir is under it, and every daemon is
 * SIGKILLed after its test.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { testBun } from '../helpers/bun-runtime.js'
import { guardedPath } from '../setup/exec-guard.js'

const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const procs: ChildProcess[] = []
const sockets: WebSocket[] = []
const cleanup: string[] = []

afterEach(async () => {
  for (const s of sockets.splice(0)) { try { s.close() } catch { /* already closed */ } }
  await Promise.all(procs.splice(0).map((p) => new Promise<void>((resolve) => {
    if (p.exitCode !== null || p.signalCode !== null) return resolve()
    const t = setTimeout(resolve, 2000)
    p.once('exit', () => { clearTimeout(t); resolve() })
    p.kill('SIGKILL')
  })))
  for (const d of cleanup.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tempHome(): string {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-machine-id-twins-home-')))
  cleanup.push(home)
  return home
}

/** A daemon under `home`, in its own dir there; resolves with its port. */
function start(home: string, dirName: string, env: Record<string, string> = {}): Promise<number> {
  const dir = path.join(home, dirName)
  const p = spawn(BUN!, [STANDALONE, '--start'], {
    env: {
      ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), WALNUT_LEGACY_STREAMS_DIR: '/nonexistent-walnut-legacy-streams',
      HOME: home, WALNUT_HOME_OVERRIDE: '', OPEN_WALNUT_HOME: '', WALNUT_DAEMON_DIR: dir, WALNUT_STREAMS_DIR: `${dir}-streams`, ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  procs.push(p)
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
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  sockets.push(ws)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hello timeout')), 20_000)
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      if (msg.id === 1) { clearTimeout(timer); resolve(msg) }
    })
    ws.send(JSON.stringify({ id: 1, cmd: 'hello', run: 'machine-id-twins-test' }))
  })
}

const idFile = (home: string) => path.join(home, '.local', 'state', 'open-walnut', 'machine-id')

describe.skipIf(!BUN)('machine id in hello: standalone daemon (bun)', () => {
  it('is the id kept under the account\'s home, the same for a second daemon in another dir, never under XDG_STATE_HOME', async () => {
    const home = tempHome()
    const first = await hello(await start(home, 'a', { XDG_STATE_HOME: path.join(home, 'xdg') }))
    expect(first.ok).toBe(true)
    expect(first.machineId).toMatch(/^[0-9a-f]{32}$/)
    expect(fs.readFileSync(idFile(home), 'utf8')).toBe(`${first.machineId}\n`)
    expect(fs.statSync(idFile(home)).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(path.join(home, 'xdg', 'open-walnut', 'machine-id'))).toBe(false)
    const second = await hello(await start(home, 'b'))
    expect(second.machineId).toBe(first.machineId)
  })

  it('a missing id is seeded from the data dir\'s older one', async () => {
    const home = tempHome()
    const legacy = path.join(home, '.open-walnut', 'local', 'machine-id')
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.writeFileSync(legacy, `${'f'.repeat(32)}\n`)
    const res = await hello(await start(home, 'a'))
    expect(res.machineId).toBe('f'.repeat(32))
    expect(fs.readFileSync(idFile(home), 'utf8').trim()).toBe('f'.repeat(32))
  })

  it('a missing id is seeded from the custom data dir it is told (OPEN_WALNUT_HOME) first, as the server is', async () => {
    const home = tempHome()
    const custom = path.join(home, 'walnut-data')
    for (const [dir, id] of [[custom, '1'.repeat(32)], [path.join(home, '.open-walnut'), '2'.repeat(32)]]) {
      fs.mkdirSync(path.join(dir, 'local'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'local', 'machine-id'), `${id}\n`)
    }
    const res = await hello(await start(home, 'a', { OPEN_WALNUT_HOME: custom }))
    expect(res.machineId).toBe('1'.repeat(32))
    expect(fs.readFileSync(idFile(home), 'utf8').trim()).toBe('1'.repeat(32))
  })
})
