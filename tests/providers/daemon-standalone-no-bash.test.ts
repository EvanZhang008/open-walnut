/**
 * The standalone daemon twin (daemon-standalone.ts, run by bun) starts every
 * session as `<shell> -c "<preamble>; exec claude …"`. Regression (961e2f222):
 * the shell was `$SHELL || /bin/bash`, so a host with no bash and no $SHELL
 * (Alpine, a container), or a $SHELL naming a shell that is gone, failed every
 * spawn with "no PID (likely bad cwd or missing shell)". The fix (sessionShell)
 * takes $SHELL only when it names a runnable file, else /bin/bash, else /bin/sh.
 *
 * Three layers:
 *  - the real twin over its WebSocket: with $SHELL pointing at a shell that is
 *    gone, and with $SHELL unset, a start still gets a PID and the CLI runs;
 *  - sessionShell itself, compiled from the daemon's source text and run against a
 *    fake filesystem with no bash at all (the one case this machine cannot stage,
 *    since /bin/bash exists here);
 *  - no spawn site falls back to `process.env.SHELL ||` again.
 *
 * MACHINE SAFETY: isolated WALNUT_DAEMON_DIR / WALNUT_STREAMS_DIR and a fake HOME
 * in a temp dir, PATH pinned to system dirs, random port, the daemon is killed
 * after each test. The only CLI spawned is a `sleep` shim in the fake HOME, and
 * its process group is killed after the test.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { transformSync } from 'esbuild'
import { testBun } from '../helpers/bun-runtime.js'

const BUN = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')

let root = ''
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
const cliGroups: number[] = []

async function spawnDaemon(home: string, shell: string | undefined): Promise<void> {
  const env: Record<string, string | undefined> = { ...process.env }
  // Nothing inherited may point the child at a real Walnut, daemon, journal or ~/.claude:
  // every WALNUT_* / OPEN_WALNUT_* knob goes (WALNUT_SPAWN_JOURNAL, WALNUT_HOME_OVERRIDE,
  // WALNUT_DAEMON_PARENT_PID, WALNUT_JOURNAL_DIR, ...), and so do the config and state roots.
  for (const k of Object.keys(env)) {
    if (/^(OPEN_)?WALNUT_/.test(k)) delete env[k]
  }
  for (const k of ['CLAUDE_CONFIG_DIR', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'ASDF_DATA_DIR']) delete env[k]
  Object.assign(env, {
    HOME: home,
    PATH: '/usr/bin:/bin',
    XDG_STATE_HOME: path.join(root, 'state'),
    WALNUT_DAEMON_DIR: path.join(root, 'daemon'),
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
  })
  if (shell === undefined) delete env.SHELL
  else env.SHELL = shell
  proc = spawn(BUN!, [STANDALONE, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 60_000)
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

function rpc(frame: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
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

/** A fake HOME whose ~/.local/bin/claude is a shim that drops a marker and stays alive. */
function homeWithShim(): { home: string; up: string } {
  const home = path.join(root, 'home')
  const shim = path.join(home, '.local/bin/claude')
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  const up = path.join(home, 'cli-up')
  fs.writeFileSync(shim, `#!/bin/sh\necho up > "${up}"\nexec sleep 120\n`, { mode: 0o755 })
  return { home, up }
}

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

describe.runIf(!!BUN && process.platform !== 'win32')('standalone daemon: a session starts without the shell $SHELL names', () => {
  const cases: Array<{ name: string; shell: (root: string) => string | undefined }> = [
    // The shell the user's account names was uninstalled (or the image never had it).
    { name: '$SHELL names a shell that is gone', shell: (r) => path.join(r, 'gone', 'zsh') },
    // A container that sets no $SHELL at all. Where /bin/bash exists (this Mac, the CI image)
    // this passed before the fix too; the no-bash half is pinned by the sessionShell tests below.
    { name: '$SHELL is unset', shell: () => undefined },
  ]
  for (const c of cases) {
    it(`${c.name}: start gets a PID and the CLI runs`, async () => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-no-bash-')))
      const { home, up } = homeWithShim()
      await spawnDaemon(home, c.shell(root))
      const cwd = fs.mkdtempSync(path.join(root, 'cwd-'))
      const started = await rpc({ id: 1, cmd: 'start', sid: 'no-bash-1', args: ['claude', '-p'], cwd, message: '' })
      if (typeof started.pid === 'number') cliGroups.push(started.pid)
      expect(started, JSON.stringify(started)).toMatchObject({ ok: true })
      expect(typeof started.pid).toBe('number')
      await vi.waitFor(() => expect(fs.existsSync(up)).toBe(true), { timeout: 20_000, interval: 50 })
      expect(await rpc({ id: 2, cmd: 'status', sid: 'no-bash-1' })).toMatchObject({ exists: true, alive: true, pid: started.pid })
    }, 120_000)
  }
})

/** sessionShell compiled from the daemon's source text, run against injected fs and env. */
function loadSessionShell(): (fsImpl: unknown, env: Record<string, string | undefined>) => string {
  const src = fs.readFileSync(STANDALONE, 'utf8')
  const start = src.search(/\bfunction sessionShell\s*\(/)
  expect(start, 'daemon-standalone.ts declares sessionShell()').toBeGreaterThanOrEqual(0)
  let depth = 0
  let end = -1
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break }
  }
  const js = transformSync(src.slice(start, end), { loader: 'ts' }).code
  const factory = new Function('fs', 'path', 'process', `${js}\nreturn sessionShell`)
  return (fsImpl, env) => factory(fsImpl, path, { env })()
}

function fakeFs(runnable: string[], dirs: string[] = []) {
  const exec = new Set([...runnable, ...dirs])
  return {
    constants: { X_OK: fs.constants.X_OK },
    accessSync(file: string) { if (!exec.has(file)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' }) },
    statSync(file: string) {
      if (!exec.has(file)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })
      return { isFile: () => !dirs.includes(file) }
    },
  }
}

describe('sessionShell: the shell a session starts under', () => {
  it('a host with no bash and no $SHELL (Alpine, a container) gets /bin/sh', () => {
    const sessionShell = loadSessionShell()
    expect(sessionShell(fakeFs(['/bin/sh']), {})).toBe('/bin/sh')
    expect(sessionShell(fakeFs(['/bin/sh']), { SHELL: '' })).toBe('/bin/sh')
  })

  it('a $SHELL that is gone, relative, or not a file falls back to bash, else sh', () => {
    const sessionShell = loadSessionShell()
    expect(sessionShell(fakeFs(['/bin/sh']), { SHELL: '/bin/bash' })).toBe('/bin/sh')
    expect(sessionShell(fakeFs(['/bin/bash', '/bin/sh']), { SHELL: '/usr/local/bin/zsh' })).toBe('/bin/bash')
    expect(sessionShell(fakeFs(['/bin/bash', '/bin/sh', 'zsh']), { SHELL: 'zsh' })).toBe('/bin/bash')
    expect(sessionShell(fakeFs(['/bin/sh'], ['/opt/shells']), { SHELL: '/opt/shells' })).toBe('/bin/sh')
  })

  it('a runnable $SHELL is kept, so the user\'s rc files run in their own shell', () => {
    const sessionShell = loadSessionShell()
    expect(sessionShell(fakeFs(['/usr/bin/zsh', '/bin/bash', '/bin/sh']), { SHELL: '/usr/bin/zsh' })).toBe('/usr/bin/zsh')
  })

  it('no spawn path falls back to `$SHELL || …` again', () => {
    const src = fs.readFileSync(STANDALONE, 'utf8')
    expect(src.match(/process\.env\.SHELL\s*\|\|/g) ?? []).toEqual([])
  })
})
