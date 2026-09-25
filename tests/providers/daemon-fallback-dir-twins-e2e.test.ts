/**
 * The two daemon twins, booted for real, on the two things this change gave
 * them: a daemon dir moved to ~/.cache/open-walnut (because /tmp could not take
 * it) keeps PRODUCTION semantics (streams under ~/.open-walnut/tmp/streams, the
 * user's `walnut` shim installed), and fs.ls answers through the shared budgeted
 * lister (the source twin gets it injected as text, the standalone imports it).
 *
 * MACHINE SAFETY: HOME is a temp dir, so "~/.cache/open-walnut" and every path
 * the production branch writes (streams, ~/.local/bin) live inside it; the
 * legacy /tmp streams dir is pointed at an empty temp path so nothing real is
 * migrated; PATH is pinned to system dirs and SHELL=/bin/sh; random port; the
 * daemon is SIGKILLed after each test (no session is ever started, so there is
 * no process group to reap).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

let scriptPath = ''
let root = ''
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: 'source twin (node)', command: () => [process.execPath, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]
let proc: ChildProcess | null = null
let ws: WebSocket | null = null

async function boot(twin: Twin, env: Record<string, string>): Promise<void> {
  const full: Record<string, string | undefined> = { ...process.env, SHELL: '/bin/sh', PATH: '/usr/bin:/bin', ...env }
  for (const k of ['NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'ASDF_DATA_DIR', 'XDG_DATA_HOME', 'WALNUT_STREAMS_DIR']) {
    if (!(k in env)) delete full[k]
  }
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env: full, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc!.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
}

function rpc(frame: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout')), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === frame.id) { clearTimeout(timer); ws!.off('message', onMessage); resolve(msg) }
    }
    ws!.on('message', onMessage)
    ws!.send(JSON.stringify(frame))
  })
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return check()
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fallback-dir-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  try { ws?.close() } catch { /* already closed */ }
  ws = null
  if (proc && proc.exitCode === null) {
    proc.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.each(TWINS)('daemon twin: $name', (twin) => {
  it('a daemon in ~/.cache/open-walnut is a production daemon: home streams dir, user shim installed', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fallback-dir-')))
    const home = path.join(root, 'home')
    const daemonDir = path.join(home, '.cache', 'open-walnut')
    fs.mkdirSync(daemonDir, { recursive: true })
    await boot(twin, { HOME: home, WALNUT_DAEMON_DIR: daemonDir, WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams') })

    expect(fs.existsSync(path.join(home, '.open-walnut', 'tmp', 'streams'))).toBe(true)
    expect(fs.existsSync(`${daemonDir}-streams`)).toBe(false)
    const shim = path.join(home, '.local', 'bin', 'walnut')
    expect(await waitFor(() => fs.existsSync(shim))).toBe(true)
    const text = fs.readFileSync(shim, 'utf-8')
    expect(text).toContain('walnut-user-shim v1')
    // With no WALNUT_DAEMON_DIR the shim looks in both production dirs and
    // exports the one it picks (the dir choice itself: walnut-user-shim.test.ts).
    expect(text).toContain('"$HOME/.cache/open-walnut"')
    expect(text).toContain('export WALNUT_DAEMON_DIR')
  }, 60_000)

  it('any other dir stays a sandbox: no home streams, no shim', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fallback-dir-')))
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    await boot(twin, { HOME: home, WALNUT_DAEMON_DIR: path.join(root, 'daemon'), WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams') })
    const r = await rpc({ id: 1, cmd: 'fs.ls', path: root })
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(root, 'daemon-streams'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.open-walnut', 'tmp', 'streams'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.local', 'bin', 'walnut'))).toBe(false)
  }, 60_000)

  it('a /tmp-dir (or sandbox) daemon refuses to delete a live daemon dir in ~/.cache/open-walnut', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fallback-dir-')))
    const home = path.join(root, 'home')
    const other = path.join(home, '.cache', 'open-walnut')
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, 'daemon.pid'), '1')
    await boot(twin, { HOME: home, WALNUT_DAEMON_DIR: path.join(root, 'daemon'), WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams') })
    const r = await rpc({ id: 5, cmd: 'fs.rm', path: path.join(other, 'daemon.pid') })
    expect(r.ok).toBe(false)
    expect(String(r.error)).toMatch(/EDENIED/)
    expect(fs.existsSync(path.join(other, 'daemon.pid'))).toBe(true)
    const hello = await rpc({ id: 6, cmd: 'hello' })
    expect(hello.runtime).toBe(twin.name.includes('bun') ? 'bun' : 'node')
  }, 60_000)

  it('fs.ls answers through the shared lister: types, links, dangling links, detail, no partial flag when all answered', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fallback-dir-')))
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const tree = path.join(root, 'tree')
    fs.mkdirSync(path.join(tree, 'src'), { recursive: true })
    fs.writeFileSync(path.join(tree, 'a.txt'), 'hello')
    fs.symlinkSync(path.join(tree, 'src'), path.join(tree, 'linked'))
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(tree, 'dangling'))
    await boot(twin, { HOME: home, WALNUT_DAEMON_DIR: path.join(root, 'daemon'), WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams') })

    const r = await rpc({ id: 2, cmd: 'fs.ls', path: tree })
    expect(r.ok).toBe(true)
    expect(r).not.toHaveProperty('partial')
    const byName = Object.fromEntries((r.entries as Array<{ name: string }>).map((e) => [e.name, e]))
    expect(byName.src).toEqual({ name: 'src', type: 'dir' })
    expect(byName['a.txt']).toEqual({ name: 'a.txt', type: 'file' })
    expect(byName.linked).toEqual({ name: 'linked', type: 'dir', symlink: true })
    expect(byName.dangling).toEqual({ name: 'dangling', type: 'other', symlink: true })

    const d = await rpc({ id: 3, cmd: 'fs.ls', path: tree, detail: true })
    const file = (d.entries as Array<{ name: string; size?: number }>).find((e) => e.name === 'a.txt')
    expect(file?.size).toBe(5)

    const missing = await rpc({ id: 4, cmd: 'fs.ls', path: path.join(root, 'absent') })
    expect(missing.ok).toBe(false)
    expect(String(missing.error)).toMatch(/fs\.ls failed: .*ENOENT/)
  }, 60_000)
})
