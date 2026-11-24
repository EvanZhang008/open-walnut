/**
 * A session the daemon starts gets the user's shell environment, on the real daemon
 * (daemon-standalone.ts under bun) started the way a launcher starts the service: SHELL=/bin/sh.
 *
 * Before: the preamble sourced ~/.bashrc or ~/.zshrc by $SHELL, so under /bin/sh it sourced
 * neither, and the host's shell_setup ran only in host.preflight, never at a start: the
 * preflight found claude while the session said "Not logged in" (2026-11-24).
 *
 * Pinned (session-shell.ts, 'start-shell-setup-v1'):
 *  - the session runs in the user's login shell from passwd (bash or zsh), its SHELL is that
 *    shell, and its rc file ran;
 *  - a start carrying `shellSetup` runs it after the rc file, with no stdin (the first message
 *    still reaches the CLI) and no stdout in the session's stream; one that fails to parse or
 *    calls `exit` never breaks the start, and the shell's argv names its file, never its text;
 *  - the daemon keeps the last setup per Walnut (0600) for a start that carries none (one the
 *    host decides itself), and '' clears it;
 *  - an older leader (no field) on a host that never got one: no setup runs, as before.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths; the "CLI" is /bin/sh
 * writing its env to a file; every process is killed after.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { accountInfo } from '../../src/lib/account.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-session-shell-twins-')))
afterAll(() => { if (root.includes('walnut-session-shell-twins-')) fs.rmSync(root, { recursive: true, force: true }) })
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
// The login shell the daemon finds in passwd (never $SHELL: bun's os.userInfo() answers that);
// the test needs one whose rc file the preamble sources.
const LOGIN_SHELL = (() => { try { return accountInfo().shell } catch { return '' } })()
const RC_LOGIN = /\/(bash|zsh)$/.test(LOGIN_SHELL) && fs.existsSync(LOGIN_SHELL)
const HOME_OF_WALNUT = path.join(root, 'walnut-data')

let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1
const started: number[] = []
afterEach(async () => {
  for (const pid of started.splice(0)) { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
  try { ws?.close() } catch { /* closed */ }
  ws = null
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((r) => { const t = setTimeout(r, 10_000); proc!.once('exit', () => { clearTimeout(t); r() }) })
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
})

async function boot(dir: string): Promise<void> {
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  // The user's rc files: whichever one the login shell reads exports RC_VAR.
  for (const rc of ['.bashrc', '.zshrc']) fs.writeFileSync(path.join(home, rc), 'export RC_VAR=from-rc\necho rc-noise\n')
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, WALNUT_HOME_OVERRIDE: home,
    WALNUT_DAEMON_DIR: path.join(dir, 'daemon'), WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TASK_DIR_ROOT: path.join(dir, 'state', 'tasks'),
    WALNUT_SECRETS_DIR_ROOT: path.join(dir, 'state', 'secrets'),
  }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'RC_VAR', 'SETUP_VAR', 'ZDOTDIR', 'BASH_ENV', 'ENV']) delete env[k]
  proc = spawn(BUN!, [STANDALONE, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    onDaemonEarlyExit(proc!, { daemonDir: env.WALNUT_DAEMON_DIR }, (err) => { clearTimeout(timer); reject(err) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
}

function rpc(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  const sock = ws!
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); sock.off('message', onMessage); resolve(msg) }
    }
    sock.on('message', onMessage)
    sock.send(JSON.stringify({ id, ...cmd }))
  })
}

async function waitFile(file: string, ms = 20_000): Promise<string> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (fs.existsSync(file)) { const t = fs.readFileSync(file, 'utf8'); if (t.endsWith('|END')) return t }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('no file ' + file)
}

/**
 * Start a stand-in CLI that writes RC_VAR|SETUP_VAR|SHELL|STOLEN|<first stdin line has the message>|END
 * (the message arrives as a stream-json user line).
 */
async function startSession(dir: string, sid: string, extra: Record<string, unknown>): Promise<string> {
  const seen = path.join(dir, `${sid}.txt`)
  const script = `read -r first; case "$first" in *first-message*) got=first-message ;; *) got="none:$first" ;; esac; `
    + `printf '%s|%s|%s|%s|%s|END' "\${RC_VAR-unset}" "\${SETUP_VAR-unset}" "\${SHELL-unset}" "\${STOLEN-unset}" "$got" > '${seen}'; exec /bin/sleep 60`
  const reply = await rpc({ cmd: 'start', sid, args: ['/bin/sh', '-c', script], cwd: dir, message: 'first-message', origin: { home: HOME_OF_WALNUT }, ...extra })
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  const pid = Number((reply as { pid?: unknown }).pid ?? (reply as { result?: { pid?: unknown } }).result?.pid)
  if (pid > 1) started.push(pid)
  return waitFile(seen)
}

// A setup that exports, prints, and tries to read the session's stdin.
const SETUP = 'export SETUP_VAR=from-setup; echo setup-noise; read -r stolen && export STOLEN="$stolen"'

describe.skipIf(!BUN || !RC_LOGIN)('standalone daemon (bun) started with SHELL=/bin/sh', () => {
  it('a start runs the rc file and the shell_setup the leader sent, in the login shell, and the host keeps the setup', async () => {
    const dir = path.join(root, 'with-setup')
    await boot(dir)
    const hello = await rpc({ cmd: 'hello' })
    expect(JSON.stringify(hello)).toContain('start-shell-setup-v1')

    // Both variables, the login shell as SHELL, nothing read from stdin, the first message intact.
    expect(await startSession(dir, 'shell-setup-session-1', { shellSetup: SETUP })).toBe(`from-rc|from-setup|${LOGIN_SHELL}|unset|first-message|END`)
    // Neither the rc file nor the setup printed into the session's stream.
    const stream = fs.readFileSync(path.join(dir, 'streams', 'shell-setup-session-1.jsonl'), 'utf8')
    expect(stream).not.toContain('setup-noise')
    expect(stream).not.toContain('rc-noise')

    // Kept for this Walnut, private to this user.
    const kept = fs.readdirSync(path.join(dir, 'daemon', 'shell-setup'))
    expect(kept).toHaveLength(1)
    const file = path.join(dir, 'daemon', 'shell-setup', kept[0]!)
    expect(fs.readFileSync(file, 'utf8')).toBe(SETUP)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(dir, 'daemon', 'shell-setup')).mode & 0o777).toBe(0o700)

    // A start that carries none (one the host decides itself) runs the kept one.
    expect(await startSession(dir, 'shell-setup-session-2', {})).toBe(`from-rc|from-setup|${LOGIN_SHELL}|unset|first-message|END`)

    // A setup that does not parse fails alone: the session still starts, with its rc file.
    expect(await startSession(dir, 'shell-setup-session-3', { shellSetup: 'if then (' })).toBe(`from-rc|unset|${LOGIN_SHELL}|unset|first-message|END`)

    // An `exit` in a setup ends the setup alone: what it exported before stays, and the CLI starts.
    expect(await startSession(dir, 'shell-setup-session-exit', { shellSetup: 'export SETUP_VAR=before-exit; exit 4; export SETUP_VAR=after-exit' }))
      .toBe(`from-rc|before-exit|${LOGIN_SHELL}|unset|first-message|END`)

    // The session shell's argv names the kept file, never the setup text (it may hold tokens,
    // and argv shows in ps): the setup counts its own marker in the shell's /proc cmdline.
    if (fs.existsSync('/proc/self/cmdline')) {
      const counting = 'export SETUP_VAR="argv-hits-$(tr \'\\0\' \'\\n\' < /proc/$$/cmdline | grep -c argv-marker-7f3)"'
      expect(await startSession(dir, 'shell-setup-session-argv', { shellSetup: counting }))
        .toBe(`from-rc|argv-hits-0|${LOGIN_SHELL}|unset|first-message|END`)
    }

    // '' (the person removed it) clears it, for later starts too.
    expect(await startSession(dir, 'shell-setup-session-4', { shellSetup: '' })).toBe(`from-rc|unset|${LOGIN_SHELL}|unset|first-message|END`)
    expect(fs.readdirSync(path.join(dir, 'daemon', 'shell-setup'))).toEqual([])
    expect(await startSession(dir, 'shell-setup-session-5', {})).toBe(`from-rc|unset|${LOGIN_SHELL}|unset|first-message|END`)
  }, 120_000)

  it('an older leader sends no shell_setup: none runs, the rc file still does', async () => {
    const dir = path.join(root, 'older-leader')
    await boot(dir)
    expect(await startSession(dir, 'shell-setup-older-1', {})).toBe(`from-rc|unset|${LOGIN_SHELL}|unset|first-message|END`)
    expect(fs.existsSync(path.join(dir, 'daemon', 'shell-setup'))).toBe(false)
  }, 120_000)
})
