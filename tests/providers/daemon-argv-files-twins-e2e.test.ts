/**
 * The CLI's content arguments ride files on the real daemon twins
 * (src/providers/cli-argv-files-core.ts).
 *
 * 2026-10-31: `pkill -f "clone.*playwright"` SIGTERMed every Claude Code CLI on
 * the Mac, because each carried its `--settings` hook scripts (which name git
 * clone and playwright-report) and its session prompt in its command line. A
 * session start and a one-shot run go through each twin here with the real
 * session settings; the stand-in CLI records the argv it was given, and the
 * test reads the live process's command line from the process table, as
 * pgrep does.
 *
 * Pinned: the argv names files, never the content; each file holds exactly the
 * inline value the server sent, mode 0600 in a 0700 dir; a resume of the same
 * session reuses the same files; the daemon's registry still answers the inline
 * args (a fork reads the live prompt there); a path the server already gave is
 * left alone.
 *
 * MACHINE SAFETY: HOME, the daemon dirs and the streams dirs are temp paths; the
 * only processes signalled are the daemons and stand-in CLIs this file started.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { sessionSettingsHooks } from '../../src/providers/session-settings-hooks.js'
import { compactHookArgs, HOOK_FILE_FLAG, HOOK_FILES_CAPABILITY } from '../../src/providers/hook-files.js'
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

// Records its argv, then reads stdin until told to exit. As a one-shot, answers one result line.
const FAKE_CLI = `
const fs = require('fs')
const out = process.argv[2]
fs.appendFileSync(out, JSON.stringify({ pid: process.pid, argv: process.argv.slice(3) }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
if (process.argv.includes('-p')) {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n')
  process.exit(0)
}
setTimeout(() => process.exit(0), 60000).unref()
process.on('SIGTERM', () => process.exit(0))
process.stdin.on('data', () => {})
setInterval(() => {}, 1000)
`

interface Daemon { proc: ChildProcess; ws: WebSocket; streams: string; events: Array<Record<string, unknown>> }
const daemons: Daemon[] = []
const spawnedPids = new Set<number>()
let rpcId = 1

async function boot(twin: Twin): Promise<Daemon> {
  const daemonDir = path.join(root, 'daemon')
  const streams = path.join(root, 'streams')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: undefined,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: streams,
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
    onDaemonEarlyExit(proc, { daemonDir: daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  const d: Daemon = { proc, ws, streams, events: [] }
  ws.on('message', (data: Buffer) => { try { d.events.push(JSON.parse(data.toString())) } catch { /* not ours */ } })
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

const recorded = (): Array<{ pid: number; argv: string[] }> => {
  const f = path.join(root, 'argv.jsonl')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}
const commandLine = (pid: number) => spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout
const valueOf = (argv: string[], flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }

// What the server sends: the real session hooks, a prompt that names a clone, an MCP config.
const SETTINGS = JSON.stringify({ env: { OPEN_WALNUT_API_URL: 'http://127.0.0.1:1' }, hooks: sessionSettingsHooks({}) })
const PROMPT = 'You are a Walnut task. Clone with git clone --shared into your task directory; playwright-report stays in /tmp.'
/** A settings file read back as the CLI got it inline: each hook it runs from a file is that file's text. */
function asInline(settingsFile: string, argvDir: string): unknown {
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
  let fromFiles = 0
  for (const groups of Object.values(settings.hooks)) for (const g of groups) for (const h of g.hooks) {
    const m = /\. '([^']+)'$/.exec(h.command)
    if (!m) continue
    expect(path.dirname(m[1])).toBe(path.join(argvDir, 'hooks'))
    expect(fs.statSync(m[1]).mode & 0o777).toBe(0o600)
    h.command = fs.readFileSync(m[1], 'utf8')
    fromFiles++
  }
  expect(fromFiles, 'the long hooks run from files').toBeGreaterThan(5)
  return settings
}
const MCP = JSON.stringify({ mcpServers: { walnut: { command: 'walnut', args: ['mcp'] } } })

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-argv-files-src-'))
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

describe.each(TWINS)('cli argv files: $name', (twin) => {
  it('a session start and its resume pass file paths; the files hold the inline values', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-argv-files-')))
    fs.mkdirSync(path.join(root, 'home'), { recursive: true })
    const d = await boot(twin)
    const sid = 'bbbbbbbb-0000-4000-8000-00000000000b'
    const out = path.join(root, 'argv.jsonl')
    const sh = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} ${JSON.stringify(out)} "$@"`
    const args = ['/bin/sh', '-c', sh, 'sh', '--output-format', 'stream-json', '--append-system-prompt', PROMPT,
      '--mcp-config', MCP, '--settings', SETTINGS, '--input-format', 'stream-json', '--resume', sid]
    const first = await rpc(d, { cmd: 'start', sid, cwd: root, message: '', resume: true, mode: 'default', args })
    expect(first).toMatchObject({ ok: true })
    spawnedPids.add(first.pid as number)
    expect(await waitFor(() => recorded().length === 1)).toBe(true)

    const [{ argv, pid }] = recorded()
    const settingsFile = valueOf(argv, '--settings')!
    const promptFile = valueOf(argv, '--append-system-prompt-file')!
    const mcpFile = valueOf(argv, '--mcp-config')!
    expect(argv).not.toContain('--append-system-prompt')
    expect(argv).toEqual(['--output-format', 'stream-json', '--append-system-prompt-file', promptFile,
      '--mcp-config', mcpFile, '--settings', settingsFile, '--input-format', 'stream-json', '--resume', sid])
    const argvDir = path.join(d.streams, 'argv')
    for (const f of [settingsFile, promptFile, mcpFile]) {
      expect(path.dirname(f)).toBe(argvDir)
      expect(fs.statSync(f).mode & 0o777).toBe(0o600)
    }
    expect(fs.statSync(argvDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(settingsFile).size).toBeLessThan(8 * 1024)
    expect(asInline(settingsFile, argvDir)).toEqual(JSON.parse(SETTINGS))
    expect(fs.readFileSync(promptFile, 'utf8')).toBe(PROMPT)
    expect(fs.readFileSync(mcpFile, 'utf8')).toBe(MCP)

    // What pgrep -f reads: the live command line names none of the hook or prompt text.
    const live = commandLine(pid)
    expect(live).toContain(settingsFile)
    expect(live).not.toMatch(/clone|playwright|hookSpecificOutput|PreToolUse/)

    // The registry keeps the inline args: a fork reads the live prompt from there.
    const status = await rpc(d, { cmd: 'status', sid, includeArgs: true })
    expect(status.args).toEqual(args)

    // A resume of the same session reuses the same files, and a path stays a path.
    // Ended the way a CLI ends on its own (the pid is the stand-in this test started).
    process.kill(pid, 'SIGTERM')
    expect(await waitFor(() => commandLine(pid).trim() === '')).toBe(true)
    // The daemon reaps it.
    expect(await waitFor(() => d.events.some((e) => e.ev === 'session_state' && e.sid === sid && e.state === 'dead'))).toBe(true)
    const pathArgs = args.map((a) => (a === MCP ? '/etc/walnut-mcp.json' : a))
    const second = await rpc(d, { cmd: 'start', sid, cwd: root, message: '', resume: true, mode: 'default', args: pathArgs })
    expect(second).toMatchObject({ ok: true })
    spawnedPids.add(second.pid as number)
    expect(await waitFor(() => recorded().length === 2)).toBe(true)
    const again = recorded()[1].argv
    expect(valueOf(again, '--settings')).toBe(settingsFile)
    expect(valueOf(again, '--append-system-prompt-file')).toBe(promptFile)
    expect(valueOf(again, '--mcp-config')).toBe('/etc/walnut-mcp.json')
    expect(fs.readdirSync(argvDir).sort()).toEqual([settingsFile, promptFile, mcpFile].map((f) => path.basename(f)).concat('hooks').sort())
  }, 180_000)

  it('a template start (hook-files-v1 texts beside the settings) runs the hooks from files and records the inline args', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-argv-files-')))
    fs.mkdirSync(path.join(root, 'home'), { recursive: true })
    const d = await boot(twin)
    expect((await rpc(d, { cmd: 'hello' })).capabilities as string[]).toContain(HOOK_FILES_CAPABILITY)
    const sid = 'cccccccc-0000-4000-8000-00000000000c'
    const out = path.join(root, 'argv.jsonl')
    const sh = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} ${JSON.stringify(out)} "$@"`
    const inline = ['/bin/sh', '-c', sh, 'sh', '--output-format', 'stream-json', '--settings', SETTINGS, '--input-format', 'stream-json', '--resume', sid]
    const args = compactHookArgs(inline) as string[]
    const texts = args.filter((_a, i) => args[i - 1] === HOOK_FILE_FLAG)
    expect(texts.length).toBeGreaterThan(5)
    const first = await rpc(d, { cmd: 'start', sid, cwd: root, message: '', resume: true, mode: 'default', args })
    expect(first).toMatchObject({ ok: true })
    spawnedPids.add(first.pid as number)
    expect(await waitFor(() => recorded().length === 1)).toBe(true)

    const [{ argv, pid }] = recorded()
    const settingsFile = valueOf(argv, '--settings')!
    expect(argv).toEqual(['--output-format', 'stream-json', '--settings', settingsFile, '--input-format', 'stream-json', '--resume', sid])
    const argvDir = path.join(d.streams, 'argv')
    const scripts = fs.readdirSync(path.join(argvDir, 'hooks'))
    expect(scripts).toHaveLength(texts.length)
    for (const f of scripts) expect(texts).toContain(fs.readFileSync(path.join(argvDir, 'hooks', f), 'utf8'))
    expect(asInline(settingsFile, argvDir)).toEqual(JSON.parse(SETTINGS))
    // The sound guard, run from its file the way the CLI runs a hook, still refuses speech.
    const hooks = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    const pre = hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command)).filter((c) => c.includes(argvDir))
    expect(pre.length).toBeGreaterThan(3)
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'say hi' }, cwd: root })
    const answers = pre.map((c) => spawnSync('/bin/sh', ['-c', c], { input, cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), TMPDIR: root } }))
    expect(answers.some((a) => /would make sound/.test(a.stdout + a.stderr))).toBe(true)

    const live = commandLine(pid)
    expect(live).toContain(settingsFile)
    expect(live).not.toMatch(/walnut-hook-file|PreToolUse|clone/)
    // The registry keeps the inline args: an older daemon that takes it over (a rollback) re-spawns those.
    expect((await rpc(d, { cmd: 'status', sid, includeArgs: true })).args).toEqual(inline)
  }, 180_000)

  it('a one-shot claude run passes file paths too', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-argv-files-')))
    fs.mkdirSync(path.join(root, 'home'), { recursive: true })
    const d = await boot(twin)
    const out = path.join(root, 'argv.jsonl')
    const reply = await rpc(d, {
      cmd: 'oneshot.run', runId: 'o1', command: process.execPath,
      args: [cliPath, out, '-p', '--system-prompt', PROMPT, '--settings', SETTINGS], cwd: root, input: 'hi', endInput: true,
    })
    expect(reply).toMatchObject({ ok: true })
    expect(await waitFor(() => recorded().length === 1)).toBe(true)
    const { argv } = recorded()[0]
    expect(argv).toEqual(['-p', '--system-prompt-file', valueOf(argv, '--system-prompt-file'), '--settings', valueOf(argv, '--settings')])
    expect(fs.readFileSync(valueOf(argv, '--system-prompt-file')!, 'utf8')).toBe(PROMPT)
    expect(asInline(valueOf(argv, '--settings')!, path.join(d.streams, 'argv'))).toEqual(JSON.parse(SETTINGS))
    expect(await waitFor(() => d.events.some((e) => e.ev === 'oneshot.exit' || e.event === 'oneshot.exit' || JSON.stringify(e).includes('oneshot.exit')))).toBe(true)
  }, 120_000)
})
