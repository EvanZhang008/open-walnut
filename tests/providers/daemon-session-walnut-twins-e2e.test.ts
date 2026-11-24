/**
 * Which `walnut` a session runs, on the real session daemon (daemon-standalone.ts under bun).
 *
 * A session reaches its Walnut over HTTP only when that Walnut gave it OPEN_WALNUT_API_URL
 * (self-api-root.ts: local sessions of a server). Every other session reaches it through its
 * host daemon's gateway shim. The shim used to be APPENDED to every session's PATH, so on a
 * machine that joined with a Walnut of its own, that Walnut's `walnut` came first and sent the
 * joined Walnut's session calls (task_update, task_create) to the other Walnut's server.
 *
 * Pinned: with another `walnut` on the daemon's PATH, a session with no OPEN_WALNUT_API_URL
 * resolves `walnut` to this daemon's shim, and one with it still resolves the installed CLI
 * first (the Mac hub, unchanged). A session its host assembles itself names the host server's
 * root and still runs the shim (tests/integration/host-call-entry-twins.test.ts, which has a
 * follower). And a ratchet: every place the daemon puts the shim dir on a session PATH goes
 * through the one rule, given the start's Walnut.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths, PATH is built with
 * guardedPath; the only processes signalled are the daemons and stand-in CLIs this file started.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { guardedPath } from '../setup/exec-guard.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { readTwinText } from '../helpers/standalone-twin-text.js'
import { daemonRuntimeText } from '../helpers/daemon-runtime-text.js'

let cliPath = ''
let root = ''
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const command = (): [string, string[]] => [BUN!, [STANDALONE, '--start']]

// Records its PATH and what `walnut` resolves to in it, then idles until told to exit.
const FAKE_CLI = `
const fs = require('fs')
const { spawnSync } = require('child_process')
const out = process.argv[2]
const walnut = spawnSync('/bin/sh', ['-c', 'command -v walnut'], { env: process.env, encoding: 'utf8' }).stdout.trim()
fs.appendFileSync(out, JSON.stringify({ pid: process.pid, path: process.env.PATH, walnut, apiUrl: process.env.OPEN_WALNUT_API_URL ?? null }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
setTimeout(() => process.exit(0), 60000).unref()
process.on('SIGTERM', () => process.exit(0))
process.stdin.on('data', () => {})
setInterval(() => {}, 1000)
`

interface Daemon { proc: ChildProcess; ws: WebSocket; dir: string }
const DAEMON_OWN_URL = 'http://127.0.0.1:9'
const daemons: Daemon[] = []
const spawnedPids = new Set<number>()
let rpcId = 1

async function boot(otherBin: string): Promise<Daemon> {
  const daemonDir = path.join(root, 'daemon')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    // Another Walnut's CLI, ahead of everything the daemon adds.
    PATH: guardedPath([otherBin], '/usr/bin:/bin'),
    HOME: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: undefined,
    // The daemon's own address (whatever server started it): never one a session may see.
    OPEN_WALNUT_API_URL: DAEMON_OWN_URL,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'home', '.open-walnut', 'local', 'spawn-journal.jsonl'),
  }
  const [cmd, args] = command()
  const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 60_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  const d: Daemon = { proc, ws, dir: daemonDir }
  daemons.push(d)
  return d
}

function rpc(d: Daemon, cmd: Record<string, unknown>, timeoutMs = 40_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); d.ws.off('message', onMessage); resolve(msg) }
    }
    d.ws.on('message', onMessage)
    d.ws.send(JSON.stringify({ id, ...cmd }))
  })
}

async function waitFor(check: () => boolean, ms = 15_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

const recorded = (out: string): Array<{ pid: number; path: string; walnut: string; apiUrl: string | null }> =>
  fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-session-walnut-cli-'))
  cliPath = path.join(dir, 'fake-claude.cjs')
  fs.writeFileSync(cliPath, FAKE_CLI)
})

afterEach(async () => {
  for (const d of daemons.splice(0)) {
    try { d.ws.close() } catch { /* closed */ }
    if (d.proc.exitCode === null) {
      d.proc.kill('SIGKILL')
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, 3000); d.proc.once('exit', () => { clearTimeout(t); resolve() }) })
    }
  }
  for (const pid of spawnedPids) { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
  spawnedPids.clear()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.skipIf(!BUN)('session walnut, standalone daemon (bun)', () => {
  it('a session its Walnut reaches only through the daemon runs the shim, not another Walnut on PATH', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-session-walnut-')))
    fs.mkdirSync(path.join(root, 'home'), { recursive: true })
    const otherBin = path.join(root, 'other-walnut', 'bin')
    fs.mkdirSync(otherBin, { recursive: true })
    fs.writeFileSync(path.join(otherBin, 'walnut'), '#!/bin/sh\necho other\n', { mode: 0o755 })
    const d = await boot(otherBin)
    const shim = path.join(d.dir, 'bin', 'walnut')
    expect(await waitFor(() => fs.existsSync(shim))).toBe(true)

    const start = async (sid: string, settings: Record<string, unknown>) => {
      const out = path.join(root, `${sid.slice(0, 8)}.jsonl`)
      const sh = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} ${JSON.stringify(out)} "$@"`
      const args = ['/bin/sh', '-c', sh, 'sh', '--output-format', 'stream-json', '--settings', JSON.stringify(settings),
        '--input-format', 'stream-json', '--session-id', sid]
      const reply = await rpc(d, { cmd: 'start', sid, cwd: root, message: '', mode: 'default', args })
      expect(reply).toMatchObject({ ok: true })
      spawnedPids.add(reply.pid as number)
      expect(await waitFor(() => recorded(out).length === 1)).toBe(true)
      return recorded(out)[0]
    }

    // A remote Walnut's session (no API URL; a joined machine): this daemon's shim.
    const remote = await start('aaaaaaaa-0000-4000-8000-00000000000a', { env: { WALNUT_X: '1' }, hooks: {} })
    expect(remote.walnut).toBe(shim)
    expect(remote.path.split(':')[0]).toBe(path.dirname(shim))
    // Its process env names no Walnut either: not the daemon's own, which is another server's.
    expect(remote.apiUrl).toBeNull()

    // A local server's session (its API URL): the installed CLI first, as on the Mac.
    const local = await start('bbbbbbbb-0000-4000-8000-00000000000b', { env: { OPEN_WALNUT_API_URL: 'http://127.0.0.1:1' } })
    expect(local.walnut).toBe(path.join(otherBin, 'walnut'))
    expect(local.path.split(':').at(-1)).toBe(path.dirname(shim))
    // Its process env names the same Walnut its settings do (a mock CLI, a hook, a child that
    // reads the process env sees what Claude Code applies from the settings).
    expect(local.apiUrl).toBe('http://127.0.0.1:1')
  }, 180_000)
})

describe('every use of the shim dir in the daemon is a known one', () => {
  // A new spawn path that puts the shim dir on a PATH by itself brings the cross-Walnut misroute
  // back, however it joins the strings. So every line naming GATEWAY_SHIM_DIR must be one of
  // these; a new use fails here until someone decides which rule it follows.
  const KNOWN: Array<[RegExp, string]> = [
    [/^(const|var) GATEWAY_SHIM_DIR = path\.join\(path\.dirname\(GATEWAY_SOCK_PATH\), 'bin'\);?$/, 'definition'],
    [/path\.join\(GATEWAY_SHIM_DIR, /, 'a file in it'],
    [/fs\.(readdirSync|mkdirSync)\(GATEWAY_SHIM_DIR[,)]/, 'its own upkeep'],
    [/templateShimDir: GATEWAY_SHIM_DIR,$/, 'trigger checks (trigger-check-core.ts puts it first)'],
    // Handed to the trigger modules, whose checks use it as above (daemon-trigger-runs.ts, daemon-trigger-commands.ts).
    [/^const trigger(Runs|Commands) = createDaemonTrigger(Runs|Commands)\(\{[^}]*\bGATEWAY_SHIM_DIR\b/, 'handed to the trigger checks'],
    // Handed to the session shell (daemon-session-shell.ts), which holds the rule and the preamble below.
    [/^const sessionShellHelpers = createDaemonSessionShell\(\{[^}]*\bGATEWAY_SHIM_DIR\b/, 'handed to the session shell'],
    [/^GATEWAY_SHIM_DIR: string$/, 'an area module\'s deps'],
    [/^const \{[^}]*\bGATEWAY_SHIM_DIR\b[^}]*\} = deps$/, 'an area module\'s deps'],
    [/touchDirs: \[\{ dir: GATEWAY_SHIM_DIR, /, 'kept alive in a swept /tmp'],
    // The one rule (sessionPathWithShim) and the preamble that applies it in the shell
    // (session-shell.ts buildSessionPreamble, checked below).
    [/^return throughGateway \? GATEWAY_SHIM_DIR \+ path\.delimiter \+ base : base \+ path\.delimiter \+ GATEWAY_SHIM_DIR;?$/, 'rule'],
    [/^return buildSessionPreamble\(\{ shimDir: GATEWAY_SHIM_DIR, installHomeBin: INSTALL_HOME_BIN, fallbackPathStep: spawnFallbackPath\(\), \.\.\.o \}\);?$/, 'preamble'],
    [/^\+ GATEWAY_SHIM_DIR \+ '"'$/, 'the fallback dirs, then the shim dir (spawnFallbackPath)'],
    // A plugin job is no session: it carries no OPEN_WALNUT_API_URL to judge by.
    [/^env\.PATH = \(process\.env\.PATH \|\| ''\) \+ path\.delimiter \+ GATEWAY_SHIM_DIR;?$/, 'plugin job'],
  ]
  // The whole runtime: daemon-standalone.ts and its area modules (the trigger checks are daemon-trigger-*.ts).
  const STANDALONE_TEXT = readTwinText(path.resolve(__dirname, '../../src/providers/daemon-standalone.ts'))
  it('src/providers/daemon-standalone.ts', () => {
    const lines = STANDALONE_TEXT.split('\n')
      .map((l) => l.trim())
      .filter((l) => /\bGATEWAY_SHIM_DIR\b/.test(l) && !l.startsWith('//') && !l.startsWith('*'))
    const kinds = lines.map((l) => KNOWN.find(([re]) => re.test(l))?.[1] ?? `unknown: ${l}`)
    expect(kinds.filter((k) => k.startsWith('unknown'))).toEqual([])
    expect(kinds.filter((k) => k === 'rule')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'preamble')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'plugin job')).toHaveLength(1)
  })
  it('src/providers/session-shell.ts: the preamble takes the daemon\'s fallback step, or puts the shim dir first', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../src/providers/session-shell.ts'), 'utf8')
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => /\bo\.shimDir\b/.test(l) && !l.startsWith('//') && !l.startsWith('*'))
    // Appended by the daemon's own fallback step (spawnFallbackPath, checked above); put first here.
    // A regex, not the line's text: the exec-guard ratchet would read the quoted assignment as a child's literal PATH.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\.\.\.\(o\.gatewayFirst \? \['export PATH\=' \+ shellQuote\(o\.shimDir\) \+ ':"\$PATH"'\] : \[\]\),$/)
    expect(text).toMatch(/^\s+o\.fallbackPathStep,$/m)
  })
  it('both spawn paths of the daemon ask the rule, with the home the start is for, in one form', () => {
    const text = STANDALONE_TEXT
    expect(text).toMatch(/buildSpawnPreamble\(\{ nodeDir: launch\.nodeDir, gatewayFirst: walnutThroughGateway\(settingsEnvOf\(launch\.args\), startHome\), shellSetupFile \}\)/)
    expect(text).toMatch(/const startHome = spawnInfo\.home \?\? resumeRec\?\.home\n/)
    expect(text).toMatch(/const startHome = \(cmd as \{ home\?: unknown \}\)\.home\n\s+const throughGateway = walnutThroughGateway\(params\.env, startHome\)/)
    expect(text).toMatch(/PATH: sessionPathWithShim\(process\.env\.PATH \|\| '', throughGateway\),/)
  })
  it('the rule asks whether a follower of the start\'s Walnut is here: linked, or its server kept by this daemon', () => {
    const shell = fs.readFileSync(path.resolve(__dirname, '../../src/providers/daemon-session-shell.ts'), 'utf8')
    expect(shell).toMatch(/if \(sessionWalnutApiUrl\(env\) === undefined\) return true\n\s+return typeof home === 'string' && home !== '' && followsHere\(home\)/)
    expect(STANDALONE_TEXT).toMatch(/followsHere: \(home\) => followerHere\(home\)\.here,/)
    // The kept spec counts, so a start replayed after a handover, before the follower's hello, runs the shim.
    expect(STANDALONE_TEXT).toMatch(/here: linked !== undefined \|\| spec !== undefined,/)
    expect(STANDALONE_TEXT).toMatch(/const spec = !home \? undefined : hostServers\.keeps\(home\) \? home : hostServers\.keeps\(walnutOfHome\(home\)\) \? walnutOfHome\(home\) : undefined/)
  })
  it('every writer of WALNUT_AGENT_SOCKET in src/ is a known spawn, and each session spawn places the shim by the rule', () => {
    // A process given the gateway socket runs a `walnut`; which one is decided where it is spawned. So
    // any way of handing the socket (a key, a computed key, an assignment, whatever its value) counts,
    // and a new one fails here until someone decides which rule it follows: a spawn that placed the
    // shim by the address alone ran an older `walnut` of the box in a session its host assembled
    // (2026-11-24, 401 not_paired from the replica's own root).
    const SRC = path.resolve(__dirname, '../../src')
    const WRITER = /(?<![.\w])\[?['"`]?WALNUT_AGENT_SOCKET['"`]?\]?\s*:(?!:)|\bWALNUT_AGENT_SOCKET['"`]?\]?\s*=(?!=)|['"`]WALNUT_AGENT_SOCKET['"`]\s*,\s*[^)\]]/
    const KNOWN: Record<string, string> = {
      'providers/daemon-session-start.ts': 'session',
      'providers/daemon-acp-sessions.ts': 'session',
      'providers/plugin-jobs-core.ts': 'a plugin job: no session, its program is the daemon\'s own (the shim dir appended: pluginJobBaseEnv)',
      'commands/demo-home.ts': 'the Demo\'s own server env: the Demo starts no session daemon with it',
    }
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full, out)
        else if (/\.(ts|mjs|cjs|js)$/.test(e.name)) out.push(full)
      }
      return out
    }
    const code = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    const writers: Record<string, number> = {}
    for (const file of walk(SRC)) {
      const n = code(file).filter((l) => WRITER.test(l)).length
      if (n) writers[path.relative(SRC, file)] = n
    }
    expect(Object.keys(writers).filter((rel) => !KNOWN[rel]), 'a new writer of WALNUT_AGENT_SOCKET: decide which `walnut` it runs').toEqual([])
    for (const rel of Object.keys(KNOWN)) expect(writers[rel], rel).toBe(1)
    // A session spawn asks the rule once, with two arguments (its env and its home), and places the
    // shim only by what the rule said: no `true`, no other value.
    for (const rel of Object.keys(KNOWN).filter((r) => KNOWN[r] === 'session')) {
      const lines = code(path.join(SRC, rel))
      const asks = lines.filter((l) => /\bwalnutThroughGateway\(/.test(l) && !/^\s*walnutThroughGateway: /.test(l))
      expect(asks, rel).toHaveLength(1)
      expect(asks[0], rel).toMatch(/walnutThroughGateway\((settingsEnvOf\(launch\.args\)|params\.env), startHome\)/)
      const places = lines.filter((l) => /\bsessionPathWithShim\(|\bgatewayFirst:/.test(l) && !/^\s*(sessionPathWithShim|buildSpawnPreamble): /.test(l))
      expect(places, rel).toHaveLength(1)
      expect(places[0], rel).toMatch(/gatewayFirst: walnutThroughGateway\(|sessionPathWithShim\([^,]+, throughGateway\)/)
    }
  })
  it('every session spawn of the daemon takes its OPEN_WALNUT_API_URL from what its Walnut named', () => {
    // The native spawn reads it from the CLI's settings, an ACP worker from its env; a spawn that
    // left it out would hand the session the daemon's own address (or none) again.
    // The whole runtime: the ACP start is daemon-acp-sessions.ts, the native one daemon-session-start.ts.
    const text = daemonRuntimeText()
    const sets = text.split('\n').map((l) => l.trim()).filter((l) => /^OPEN_WALNUT_API_URL:/.test(l))
    expect(sets).toEqual([
      expect.stringMatching(/^OPEN_WALNUT_API_URL: sessionWalnutApiUrl\(params\.env\) (\?\?|\|\|) '',$/),
      expect.stringMatching(/^OPEN_WALNUT_API_URL: sessionWalnutApiUrl\(settingsEnvOf\(launch\.args\)\),$/),
    ])
  })
})
