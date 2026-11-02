/**
 * Which `walnut` a session runs, on the real daemon twins.
 *
 * A session reaches its Walnut over HTTP only when that Walnut gave it OPEN_WALNUT_API_URL
 * (self-api-root.ts: local sessions of a server). Every other session reaches it through its
 * host daemon's gateway shim. The shim used to be APPENDED to every session's PATH, so on a
 * machine that joined with a Walnut of its own, that Walnut's `walnut` came first and sent the
 * joined Walnut's session calls (task_update, task_create) to the other Walnut's server.
 *
 * Pinned: with another `walnut` on the daemon's PATH, a session with no OPEN_WALNUT_API_URL
 * resolves `walnut` to this daemon's shim, and one with it still resolves the installed CLI
 * first (the Mac hub, unchanged). And a ratchet: every place either twin puts the shim dir on
 * a session PATH goes through the one rule.
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
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

let scriptPath = ''
let cliPath = ''
let root = ''
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

// Records its PATH and what `walnut` resolves to in it, then idles until told to exit.
const FAKE_CLI = `
const fs = require('fs')
const { spawnSync } = require('child_process')
const out = process.argv[2]
const walnut = spawnSync('/bin/sh', ['-c', 'command -v walnut'], { env: process.env, encoding: 'utf8' }).stdout.trim()
fs.appendFileSync(out, JSON.stringify({ pid: process.pid, path: process.env.PATH, walnut }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
setTimeout(() => process.exit(0), 60000).unref()
process.on('SIGTERM', () => process.exit(0))
process.stdin.on('data', () => {})
setInterval(() => {}, 1000)
`

interface Daemon { proc: ChildProcess; ws: WebSocket; dir: string }
const daemons: Daemon[] = []
const spawnedPids = new Set<number>()
let rpcId = 1

async function boot(twin: Twin, otherBin: string): Promise<Daemon> {
  const daemonDir = path.join(root, 'daemon')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    // Another Walnut's CLI, ahead of everything the daemon adds.
    PATH: guardedPath([otherBin], '/usr/bin:/bin'),
    HOME: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: undefined,
    OPEN_WALNUT_API_URL: undefined,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'home', '.open-walnut', 'local', 'spawn-journal.jsonl'),
  }
  const [cmd, args] = twin.command()
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

const recorded = (out: string): Array<{ pid: number; path: string; walnut: string }> =>
  fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-session-walnut-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
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

describe.each(TWINS)('session walnut: $name', (twin) => {
  it('a session its Walnut reaches only through the daemon runs the shim, not another Walnut on PATH', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-session-walnut-')))
    fs.mkdirSync(path.join(root, 'home'), { recursive: true })
    const otherBin = path.join(root, 'other-walnut', 'bin')
    fs.mkdirSync(otherBin, { recursive: true })
    fs.writeFileSync(path.join(otherBin, 'walnut'), '#!/bin/sh\necho other\n', { mode: 0o755 })
    const d = await boot(twin, otherBin)
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

    // A local server's session (its API URL): the installed CLI first, as on the Mac.
    const local = await start('bbbbbbbb-0000-4000-8000-00000000000b', { env: { OPEN_WALNUT_API_URL: 'http://127.0.0.1:1' } })
    expect(local.walnut).toBe(path.join(otherBin, 'walnut'))
    expect(local.path.split(':').at(-1)).toBe(path.dirname(shim))
  }, 180_000)
})

describe('every use of the shim dir in a twin is a known one', () => {
  // A new spawn path that puts the shim dir on a PATH by itself brings the cross-Walnut misroute
  // back, however it joins the strings. So every line naming GATEWAY_SHIM_DIR must be one of
  // these; a new use fails here until someone decides which rule it follows.
  const KNOWN: Array<[RegExp, string]> = [
    [/^(const|var) GATEWAY_SHIM_DIR = path\.join\(DAEMON_DIR, 'bin'\);?$/, 'definition'],
    [/path\.join\(GATEWAY_SHIM_DIR, /, 'a file in it'],
    [/fs\.(readdirSync|mkdirSync)\(GATEWAY_SHIM_DIR[,)]/, 'its own upkeep'],
    [/templateShimDir: GATEWAY_SHIM_DIR,$/, 'trigger checks (trigger-check-core.ts puts it first)'],
    [/touchDirs: \[\{ dir: GATEWAY_SHIM_DIR, /, 'kept alive in a swept /tmp'],
    // The one rule (sessionPathWithShim) and the preamble that applies it in the shell.
    [/^return throughGateway \? GATEWAY_SHIM_DIR \+ path\.delimiter \+ base : base \+ path\.delimiter \+ GATEWAY_SHIM_DIR;?$/, 'rule'],
    [/^\+ GATEWAY_SHIM_DIR \+ '"',$/, 'preamble'],
    [/^\.\.\.\(gatewayFirst \? \['export PATH\=' \+ shellQuote\(GATEWAY_SHIM_DIR\) \+ ':"\$PATH"'\] : \[\]\),$/, 'preamble'],
    // A plugin job is no session: it carries no OPEN_WALNUT_API_URL to judge by.
    [/^env\.PATH = \(process\.env\.PATH \|\| ''\) \+ path\.delimiter \+ GATEWAY_SHIM_DIR;?$/, 'plugin job'],
  ]
  const twins = [
    { rel: 'src/providers/daemon-standalone.ts', rule: 1, preamble: 2 },
    { rel: 'src/providers/daemon-source.ts', rule: 1, preamble: 0 },
  ]
  it.each(twins)('$rel', ({ rel, rule, preamble }) => {
    const lines = fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8').split('\n')
      .map((l) => l.trim())
      .filter((l) => /\bGATEWAY_SHIM_DIR\b/.test(l) && !l.startsWith('//') && !l.startsWith('*'))
    const kinds = lines.map((l) => KNOWN.find(([re]) => re.test(l))?.[1] ?? `unknown: ${l}`)
    expect(kinds.filter((k) => k.startsWith('unknown'))).toEqual([])
    expect(kinds.filter((k) => k === 'rule')).toHaveLength(rule)
    expect(kinds.filter((k) => k === 'preamble')).toHaveLength(preamble)
    expect(kinds.filter((k) => k === 'plugin job')).toHaveLength(1)
  })
  it('both spawn paths of the standalone twin ask the rule', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../src/providers/daemon-standalone.ts'), 'utf8')
    expect(text).toMatch(/buildSpawnPreamble\(launch\.nodeDir, walnutThroughGateway\(settingsEnvOf\(launch\.args\)\)\)/)
    expect(text).toMatch(/PATH: sessionPathWithShim\(process\.env\.PATH \|\| '', throughGateway\),/)
  })
  it('both spawn paths of the source twin ask the rule', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../src/providers/daemon-source.ts'), 'utf8')
    expect(text).toMatch(/sessionPathWithShim\(\(launch\.nodeDir \? .*walnutThroughGateway\(settingsEnvOf\(launch\.args\)\)\),/)
    expect(text).toMatch(/sessionPathWithShim\(process\.env\.PATH \|\| '', walnutThroughGateway\(params\.env\)\),/)
  })
})
