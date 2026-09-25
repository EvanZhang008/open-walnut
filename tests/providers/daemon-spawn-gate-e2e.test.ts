/**
 * Spawn gate + host.preflight E2E against BOTH real daemon twins: the source
 * template (daemon-source.ts with host-runtime-core.ts injected as text) under
 * node, and daemon-standalone.ts run by bun when bun is installed. The source
 * twin spawns `claude` directly and used to fail with a bare "spawn failed" or
 * an exit 127 when claude, or the node an npm claude needs, was missing.
 *
 * MACHINE SAFETY: isolated WALNUT_DAEMON_DIR / WALNUT_STREAMS_DIR and a fake
 * HOME in temp dirs, never /tmp/open-walnut; PATH is pinned to system dirs and
 * SHELL=/bin/sh, so neither the real claude nor the real rc files are reached;
 * random port; the daemon is killed after each test. The only CLI ever spawned
 * is a `sleep` shim in the fake HOME, and its process group is killed after the
 * test that starts it.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { HOST_RUNTIME_MESSAGES } from '../../src/providers/host-runtime-core.js'

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
let twin: Twin = TWINS[0]
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
/** Process groups of shim CLIs a test started (spawned detached, so the daemon's death does not end them). */
const cliGroups: number[] = []

async function spawnDaemon(home: string): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    SHELL: '/bin/sh',
    PATH: '/usr/bin:/bin',
    WALNUT_DAEMON_DIR: path.join(root, 'daemon'),
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
  }
  for (const k of ['NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'ASDF_DATA_DIR', 'XDG_DATA_HOME']) delete env[k]
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
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

function fakeHome(): string {
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  return home
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-spawn-gate-src-'))
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
  for (const pgid of cliGroups.splice(0)) {
    try { process.kill(-pgid, 'SIGKILL') } catch { /* already gone */ }
  }
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.each(TWINS)('daemon spawn gate: $name', (t) => {
  beforeAll(() => { twin = t })

  it('claude absent: start answers the not-installed sentence with errorKind, and preflight agrees', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-spawn-gate-')))
    await spawnDaemon(fakeHome())
    const cwd = fs.mkdtempSync(path.join(root, 'cwd-'))
    const res = await rpc({ id: 1, cmd: 'start', sid: 'gate-missing-1', args: ['claude', '-p'], cwd, message: '' })
    expect(res).toMatchObject({ ok: false, errorKind: 'claude_missing', error: HOST_RUNTIME_MESSAGES.claudeMissing })
    expect(String(res.error)).not.toContain('internal daemon error')
    // Nothing was spawned, so no stream files exist for the sid.
    expect(fs.existsSync(path.join(root, 'streams', 'gate-missing-1.pipe'))).toBe(false)

    const pre = await rpc({ id: 2, cmd: 'host.preflight' })
    expect(pre.ok).toBe(true)
    expect(pre.claude).toEqual({ found: false, error: HOST_RUNTIME_MESSAGES.claudeMissing })
    expect(pre.dtach).toEqual({ found: false })
    expect(typeof (pre.compiler as { found: unknown }).found).toBe('boolean')
  }, 60_000)

  it('npm claude whose node cannot run: start answers the Node.js sentence, preflight reports needsNode', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-spawn-gate-')))
    const home = fakeHome()
    // The npm layout (prefix ~/.local): bin/claude -> lib/node_modules/.../cli.js.
    // Its interpreter is absolute and absent, so no node on this machine can
    // satisfy it: the gate must refuse without ever spawning.
    const pkg = path.join(home, '.local/lib/node_modules/@anthropic-ai/claude-code')
    fs.mkdirSync(pkg, { recursive: true })
    fs.writeFileSync(path.join(pkg, 'cli.js'), '#!/nonexistent-walnut-test/bin/node\nconsole.log("never runs")\n', { mode: 0o755 })
    fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true })
    fs.symlinkSync(path.join(pkg, 'cli.js'), path.join(home, '.local/bin/claude'))
    await spawnDaemon(home)
    const cwd = fs.mkdtempSync(path.join(root, 'cwd-'))

    const res = await rpc({ id: 1, cmd: 'start', sid: 'gate-npm-1', args: ['claude', '-p'], cwd, message: '' })
    expect(res).toMatchObject({ ok: false, errorKind: 'claude_needs_node', error: HOST_RUNTIME_MESSAGES.claudeNeedsNode })
    expect(String(res.error)).toMatch(/Node\.js/)
    expect(String(res.error)).toMatch(/claude\.ai\/install\.sh/)

    const pre = await rpc({ id: 2, cmd: 'host.preflight' })
    expect(pre.claude).toMatchObject({
      found: true, path: path.join(home, '.local/bin/claude'), kind: 'npm', needsNode: true, nodeFound: false,
    })
    // The daemon is still serving after both refusals.
    expect((await rpc({ id: 3, cmd: 'ping' })).ok).toBe(true)
  }, 60_000)

  it('a refused respawn leaves the live session exactly as it was (the gate runs before the teardown)', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-spawn-gate-')))
    const home = fakeHome()
    const shim = path.join(home, '.local/bin/claude')
    fs.mkdirSync(path.dirname(shim), { recursive: true })
    // A CLI that just stays alive: the gate reads it as an opaque script and lets
    // it run. It drops a marker once it is past reading its own file, so deleting
    // the file below cannot race the shell that is still loading it.
    const up = path.join(home, 'cli-up')
    fs.writeFileSync(shim, `#!/bin/sh\necho up > "${up}"\nexec sleep 120\n`, { mode: 0o755 })
    await spawnDaemon(home)
    const cwd = fs.mkdtempSync(path.join(root, 'cwd-'))
    const started = await rpc({ id: 1, cmd: 'start', sid: 'gate-live-1', args: ['claude', '-p'], cwd, message: '' })
    expect(started.ok).toBe(true)
    const pid = started.pid as number
    cliGroups.push(pid)
    await vi.waitFor(() => expect(fs.existsSync(up)).toBe(true), { timeout: 15_000, interval: 50 })
    expect(() => process.kill(pid, 0)).not.toThrow()

    // The host loses claude, then a restart (resume, no message) for the SAME sid
    // arrives. It must be refused WITHOUT touching the running process.
    fs.unlinkSync(shim)
    const refused = await rpc({ id: 2, cmd: 'start', sid: 'gate-live-1', args: ['claude', '-p'], cwd, message: '', resume: true })
    expect(refused).toMatchObject({ ok: false, errorKind: 'claude_missing' })
    await new Promise((r) => setTimeout(r, 300))
    expect(() => process.kill(pid, 0)).not.toThrow()
    const status = await rpc({ id: 3, cmd: 'status', sid: 'gate-live-1' })
    expect(status).toMatchObject({ exists: true, alive: true, pid })
  }, 60_000)

  it('hello advertises preflight-v1', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-spawn-gate-')))
    await spawnDaemon(fakeHome())
    const hello = await rpc({ id: 1, cmd: 'hello' })
    expect(hello.capabilities).toEqual(expect.arrayContaining(['preflight-v1']))
  }, 60_000)
})

/**
 * host.fix over the wire, against the same real twins. Nothing here installs or
 * compiles: only answers that run nothing are exercised (an unknown action, a
 * build-dtach whose source is incomplete, the Mac refusal). The fake HOME keeps
 * even the idempotency probe (`~/.local/bin/walnut-dtach --help`) away from the
 * real one.
 */
describe.each(TWINS)('host.fix: $name', (t) => {
  beforeAll(() => { twin = t })

  it('advertises hostfix-v1, preflight reports the platform and arch, and only named actions run', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-fix-')))
    const home = fakeHome()
    await spawnDaemon(home)
    const hello = await rpc({ id: 1, cmd: 'hello' })
    expect(hello.capabilities).toEqual(expect.arrayContaining(['preflight-v1', 'hostfix-v1']))
    const pre = await rpc({ id: 2, cmd: 'host.preflight' })
    expect(pre).toMatchObject({ ok: true, platform: process.platform, arch: process.arch })

    // The result rides under `result`: its own ok:false is an answer, not an RPC error.
    const unknown = await rpc({ id: 3, cmd: 'host.fix', action: 'sh -c id' })
    expect(unknown).toMatchObject({ ok: true, result: { action: 'sh -c id', ok: false, error: 'unknown-action' } })
    const bad = await rpc({ id: 4, cmd: 'host.fix', action: 'build-dtach', sources: { 'main.c': 'bWFpbg==' } })
    expect(bad).toMatchObject({ ok: true, result: { action: 'build-dtach', ok: false, error: 'bad-sources' } })
    expect(fs.existsSync(path.join(home, '.local/bin/walnut-dtach'))).toBe(false)
  }, 60_000)

  it.runIf(process.platform === 'darwin')('a Mac refuses install-compiler without running anything', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-fix-')))
    await spawnDaemon(fakeHome())
    const res = await rpc({ id: 1, cmd: 'host.fix', action: 'install-compiler' })
    expect(res).toMatchObject({ ok: true, result: { ok: false, error: 'darwin-needs-command-line-tools', manualCommand: 'xcode-select --install' } })
  }, 60_000)
})
