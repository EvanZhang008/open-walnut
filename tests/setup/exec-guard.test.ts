/**
 * The test exec guard (tests/setup/exec-guard.ts), caught in the act: each escape
 * a gate run found (2026-10-03) is replayed here and must land on the guard's
 * refusing script, never the real tool. Each test consumes its own hits with
 * takeExecGuardHits(), so the guard's afterEach sees none; anywhere else a hit
 * fails the test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EXEC_GUARD_BIN, failOnExecGuardHits, guardedPath, takeExecGuardHits, type ExecGuardHit } from './exec-guard.js'
import {
  EXEC_GUARD_HOME_PREFIX, EXEC_GUARD_LOG, EXEC_GUARD_OFFSET_FILE, EXEC_GUARD_RUN_FILE, EXEC_GUARD_TOOLS, parseHit,
  unattributedHitsSince, unreadHitsOfRun,
} from './exec-guard-core.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { assertNotProductionPath } from '../../src/constants.js'

const THIS_FILE = 'tests/setup/exec-guard.test.ts'

function accountHome(): string | null {
  try { return os.userInfo().homedir } catch { return null }
}

async function waitForHits(pred: (h: ExecGuardHit) => boolean, ms = 20_000): Promise<ExecGuardHit[]> {
  const seen: ExecGuardHit[] = []
  const until = Date.now() + ms
  while (Date.now() < until) {
    seen.push(...takeExecGuardHits())
    if (seen.some(pred)) return seen
    await new Promise((r) => setTimeout(r, 100))
  }
  return seen
}

describe('the worker env', () => {
  it('runs under a fake HOME with no real hosts, rc or agent', () => {
    const home = os.homedir()
    expect(path.basename(home)).toBe(`${EXEC_GUARD_HOME_PREFIX}${process.pid}`)
    expect(home.startsWith(fs.realpathSync(os.tmpdir())) || home.startsWith(os.tmpdir())).toBe(true)
    if (accountHome()) expect(home).not.toBe(accountHome())
    expect(fs.readFileSync(path.join(home, '.ssh', 'config'), 'utf8')).not.toMatch(/^\s*Host\s/m)
    expect(fs.existsSync(path.join(home, '.zshrc'))).toBe(false)
    for (const k of ['ZDOTDIR', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'CLAUDE_CONFIG_DIR', 'SSH_AUTH_SOCK']) {
      expect(process.env[k], k).toBeUndefined()
    }
    // A neutral identity, so a test's git commit never borrows the developer's.
    expect(execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8' }).trim()).toBe('walnut-test@example.invalid')
  })

  it('resolves every guarded tool to the refusing script, first on PATH', () => {
    expect(process.env.PATH!.split(path.delimiter)[0]).toBe(EXEC_GUARD_BIN)
    expect(process.env.WALNUT_TEST_EXEC_GUARD).toBe(EXEC_GUARD_BIN)
    for (const tool of EXEC_GUARD_TOOLS) {
      const found = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()
      expect(found, tool).toBe(path.join(EXEC_GUARD_BIN, tool))
    }
  })

  it('keeps the account home out of the data-dir guard even though HOME is fake', () => {
    const real = accountHome()
    if (!real) return
    expect(() => assertNotProductionPath(path.join(real, '.open-walnut', 'tasks.json'))).toThrow(/production path/)
  })
})

describe('escapes found by the 2026-10-03 gate land on the guard', () => {
  it('a bare `claude` spawned from PATH (api-v1-session-talk) is refused and names this test', () => {
    const r = spawnSync('claude', ['-p', 'hello'], { encoding: 'utf8' })
    expect(r.status).toBe(127)
    expect(r.stderr).toContain('refused to run the real claude')
    expect(r.stderr).toContain(THIS_FILE)
    const hits = takeExecGuardHits()
    expect(hits.map((h) => h.tool)).toEqual(['claude'])
    expect(hits[0].startedBy).toContain(THIS_FILE)
    expect(hits[0].args).toBe('-p hello')
  })

  it('`ssh -fN alice@devbox.example.com` (host-connect-now-cloud-remint) never dials', () => {
    const r = spawnSync('ssh', ['-fN', 'alice@devbox.example.com'], { encoding: 'utf8' })
    expect(r.status).toBe(255)
    const hits = takeExecGuardHits()
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ tool: 'ssh', args: '-fN alice@devbox.example.com' })
  })

  it('scp and sftp are refused the same way', () => {
    for (const tool of ['scp', 'sftp']) {
      expect(spawnSync(tool, ['devbox:/x', '/tmp/y']).status, tool).toBe(255)
    }
    expect(takeExecGuardHits().map((h) => h.tool)).toEqual(['scp', 'sftp'])
  })

  it('host discovery reads the fake ~/.ssh/config (trigger-host-policy, api-v1 read the real one)', async () => {
    const cfg = path.join(os.homedir(), '.ssh', 'config')
    expect(fs.readFileSync(cfg, 'utf8')).not.toMatch(/^\s*(Host|Match|Include)\s/m)
    // The server's own discovery (the hosts a test server would dial) finds none,
    // though the same scanner finds a host in a config that has one.
    const { scanSshConfig } = await import('../../src/core/ssh-config-scanner.js')
    expect((await scanSshConfig()).size).toBe(0)
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-exec-guard-sshcfg-'))
    try {
      fs.writeFileSync(path.join(other, 'config'), 'Host devbox\n  HostName devbox.example.com\n  User alice\n')
      expect([...(await scanSshConfig(path.join(other, 'config'))).keys()]).toContain('devbox')
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
    // `ssh -G host` (how the server reads a host's ssh options) lands on the guard too.
    expect(spawnSync('ssh', ['-G', 'devbox']).status).toBe(255)
    expect(takeExecGuardHits().map((h) => h.args)).toEqual(['-G devbox'])
  })

  it('a hit the code under test swallowed still fails the test, naming it and the command', () => {
    spawnSync('/bin/sh', ['-c', 'ssh devbox true >/dev/null 2>&1 || true'])
    let message = ''
    try { failOnExecGuardHits('during this test') } catch (err) { message = (err as Error).message }
    expect(message).toContain('[exec-guard] 1 call(s)')
    expect(message).toContain('ssh devbox true')
    expect(message).toContain(`${THIS_FILE} > escapes found by the 2026-10-03 gate land on the guard > a hit the code`)
  })

  it('a test that wants a fake ssh puts it in front of the guard', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-exec-guard-fake-'))
    try {
      fs.writeFileSync(path.join(dir, 'ssh'), '#!/bin/sh\necho fake-ssh\n', { mode: 0o755 })
      const r = spawnSync('ssh', ['devbox'], { encoding: 'utf8', env: { ...process.env, PATH: guardedPath([dir]) } })
      expect(r.stdout.trim()).toBe('fake-ssh')
      expect(takeExecGuardHits()).toEqual([])
      expect(guardedPath([dir], `/usr/bin:${EXEC_GUARD_BIN}:/bin`)).toBe([dir, EXEC_GUARD_BIN, '/usr/bin', '/bin'].join(path.delimiter))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a process that lost the test env still never runs the tool, and its hit reaches the teardown check', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-exec-guard-lost-'))
    try {
      const since = Date.now()
      const r = spawnSync(path.join(EXEC_GUARD_BIN, 'ssh'), ['devbox'], { env: { PATH: '/usr/bin:/bin', TMPDIR: tmp } })
      expect(r.status).toBe(255)
      const hits = unattributedHitsSince(since, tmp).filter((h) => h.pid === r.pid)
      expect(hits).toHaveLength(1)
      expect(hits[0].startedBy).toBe('a process that lost the test env')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
    expect(parseHit('torn line')).toBeNull()
  })

  it('a hit after the last check (a dial that outlived its test) is left for the runner', () => {
    takeExecGuardHits()
    const r = spawnSync('ssh', ['-fN', 'alice@devbox.example.com'])
    // What the worker has read so far is on disk, and the new line is past it.
    const home = os.homedir()
    const offset = Number(fs.readFileSync(path.join(home, EXEC_GUARD_OFFSET_FILE), 'utf8'))
    expect(fs.statSync(path.join(home, EXEC_GUARD_LOG)).size).toBeGreaterThan(offset)
    expect(fs.readFileSync(path.join(home, EXEC_GUARD_RUN_FILE), 'utf8')).toBe(String(process.ppid))
    // The runner's teardown read, against a copy of this home and one of another run.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-exec-guard-runner-'))
    try {
      for (const [name, run] of [[`${EXEC_GUARD_HOME_PREFIX}101`, '7001'], [`${EXEC_GUARD_HOME_PREFIX}102`, '7002']]) {
        fs.mkdirSync(path.join(tmp, name))
        for (const f of [EXEC_GUARD_LOG, EXEC_GUARD_OFFSET_FILE]) fs.copyFileSync(path.join(home, f), path.join(tmp, name, f))
        fs.writeFileSync(path.join(tmp, name, EXEC_GUARD_RUN_FILE), run)
      }
      const unread = unreadHitsOfRun(7001, tmp)
      expect(unread).toHaveLength(1)
      expect(unread[0]).toMatchObject({ tool: 'ssh', args: '-fN alice@devbox.example.com' })
      expect(unread[0].startedBy).toContain(`${THIS_FILE} > escapes found by the 2026-10-03 gate land on the guard > a hit after`)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
    expect(unreadHitsOfRun(process.ppid).filter((h) => h.pid === r.pid)).toHaveLength(1)
    expect(takeExecGuardHits()).toHaveLength(1)
    expect(unreadHitsOfRun(process.ppid).filter((h) => h.pid === r.pid)).toEqual([])
  })
})

// The daemon half (the PATH rule itself: host-runtime-core.test.ts), for real:
// a booted twin whose session spawn names a bare
// `claude` (cmdBridgeResume after a lost record, or createSessionManager with a
// test daemon URL, which keeps `claude`) lands on the guard.
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(import.meta.dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: (script: string) => [string, string[]] }
const TWINS: Twin[] = [
  { name: 'source twin (node)', command: (script) => [process.execPath, [script, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

let script = ''
let root = ''
let proc: ChildProcess | null = null
let ws: WebSocket | null = null

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-exec-guard-src-'))
  script = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  try { ws?.close() } catch { /* closed */ }
  ws = null
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { proc!.kill('SIGKILL') } catch { /* gone */ } resolve() }, 10_000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
    proc.kill('SIGTERM')
    await exited
  }
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

async function boot(twin: Twin): Promise<{ runDir: string; cwd: string }> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-exec-guard-twin-')))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'work')
  const runDir = path.join(root, 'run')
  for (const d of [home, cwd, runDir]) fs.mkdirSync(d, { recursive: true })
  // A claude on the user's LOGIN PATH, where a real install sits (the login
  // shell's rc adds ~/.local/bin, Homebrew, ...): a daemon puts that PATH ahead of
  // the one it inherited, so without the guard rule this one would run.
  const systemBin = path.join(root, 'login-path-bin')
  fs.mkdirSync(systemBin, { recursive: true })
  fs.writeFileSync(path.join(systemBin, 'claude'), `#!/bin/sh\ntouch ${JSON.stringify(path.join(root, 'REAL_CLAUDE_RAN'))}\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(home, '.profile'), `PATH=${JSON.stringify(systemBin)}:"$PATH"; export PATH\n`)
  const env: Record<string, string | undefined> = {
    ...process.env, HOME: home, SHELL: '/bin/sh', WALNUT_DAEMON_DIR: runDir,
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'), WALNUT_DAEMON_PARENT_PID: String(process.pid),
  }
  for (const k of ['NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'ASDF_DATA_DIR', 'XDG_DATA_HOME', 'WALNUT_STREAMS_DIR']) delete env[k]
  const [cmd, args] = twin.command(script)
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'ignore'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  return { runDir, cwd }
}

function rpc(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout')), 20_000)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === frame.id) { clearTimeout(timer); ws!.off('message', onMessage); resolve(msg) }
    }
    ws!.on('message', onMessage)
    ws!.send(JSON.stringify(frame))
  })
}

describe.each(TWINS)('daemon twin: $name', (twin) => {
  it('bridgeResume with a lost record respawns a bare `claude`, which lands on the guard', async () => {
    const { runDir, cwd } = await boot(twin)
    const sid = 'guard-resume-0001'
    fs.mkdirSync(`${runDir}-streams`, { recursive: true })
    fs.writeFileSync(path.join(`${runDir}-streams`, `${sid}.jsonl`), '')
    await rpc({ id: 1, cmd: 'bridgeResume', sid, message: 'hello', cwd })
    const hits = await waitForHits((h) => h.tool === 'claude' && h.args.includes(`--resume ${sid}`))
    const hit = hits.find((h) => h.tool === 'claude' && h.args.includes(`--resume ${sid}`))
    expect(hit, JSON.stringify(hits)).toBeDefined()
    expect(hit!.startedBy).toContain(THIS_FILE)
    expect(fs.existsSync(path.join(root, 'REAL_CLAUDE_RAN'))).toBe(false)
  }, 60_000)

  it('a start whose argv names `claude` (a test daemon URL keeps it) lands on the guard', async () => {
    const { cwd } = await boot(twin)
    const sid = 'guard-start-0001'
    await rpc({ id: 2, cmd: 'start', sid, cwd, args: ['claude', '-p', '--output-format', 'stream-json', '--input-format', 'stream-json'] })
    const hits = await waitForHits((h) => h.tool === 'claude')
    expect(hits.some((h) => h.tool === 'claude' && h.args.startsWith('-p')), JSON.stringify(hits)).toBe(true)
    expect(fs.existsSync(path.join(root, 'REAL_CLAUDE_RAN'))).toBe(false)
  }, 60_000)
})
