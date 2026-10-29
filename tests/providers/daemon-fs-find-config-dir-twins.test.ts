/**
 * fs.find over the default transcripts root walks the daemon's own
 * CLAUDE_CONFIG_DIR too, on both daemon twins.
 *
 * Every CLI a daemon spawns inherits its env, so with CLAUDE_CONFIG_DIR set the
 * transcripts live in $CLAUDE_CONFIG_DIR/projects, while a server that does not
 * know that host's env asks for `~/.claude/projects` (DaemonFileReader.findSessionPath).
 * The find used to walk only that, so a remote session under another config dir
 * had no history. Also pinned: an explicit root walks only itself, and a config
 * dir that is ~/.claude (here by symlink) answers each file once.
 *
 * MACHINE SAFETY: HOME, the config dir and the daemon dirs are temp paths; the
 * only processes started and stopped are the daemons this file spawns.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-find-cfgdir-')))
const scriptPath = path.join(root, 'daemon.cjs')
fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const TWINS: Array<{ name: string; command: [string, string[]] }> = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: [BUN, [STANDALONE, '--start']] as [string, string[]] }] : []),
]

interface Daemon { proc: ChildProcess; ws: WebSocket }
const daemons: Daemon[] = []
let rpcId = 1

async function boot(command: [string, string[]], name: string, home: string, configDir: string): Promise<Daemon> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: '/usr/bin:/bin',
    HOME: home,
    WALNUT_HOME_OVERRIDE: home,
    CLAUDE_CONFIG_DIR: configDir,
    WALNUT_DAEMON_DIR: path.join(root, name, 'daemon'),
    WALNUT_STREAMS_DIR: path.join(root, name, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, name, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, name, 'spawn-journal.jsonl'),
    WALNUT_DAEMON_PARENT_PID: String(process.pid),
  }
  const proc = spawn(command[0], command[1], { env, stdio: ['ignore', 'pipe', 'ignore'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 60_000)
    let out = ''
    proc.stdout?.on('data', (chunk) => {
      out += chunk.toString()
      const m = out.match(/^(\d+)$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[1], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  const d = { proc, ws }
  daemons.push(d)
  return d
}

function rpc(d: Daemon, cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), 30_000)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); d.ws.off('message', onMessage); resolve(msg) }
    }
    d.ws.on('message', onMessage)
    d.ws.send(JSON.stringify({ id, ...cmd }))
  })
}

function writeTranscript(projectsDir: string, sid: string): string {
  const dir = path.join(projectsDir, '-work-marina')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sid}.jsonl`)
  fs.writeFileSync(file, '{"type":"user"}\n')
  return file
}

afterAll(async () => {
  for (const d of daemons) {
    try { d.ws.close() } catch { /* closed */ }
    if (d.proc.exitCode === null) {
      d.proc.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { try { d.proc.kill('SIGKILL') } catch { /* gone */ } resolve() }, 10_000)
        d.proc.once('exit', () => { clearTimeout(t); resolve() })
      })
    }
  }
  fs.rmSync(root, { recursive: true, force: true })
}, 60_000)

describe.each(TWINS)('fs.find default root under CLAUDE_CONFIG_DIR: $name', ({ name, command }) => {
  const slug = name.replace(/\W+/g, '-')

  it('finds a transcript in the config dir and in ~/.claude; an explicit root walks only itself', async () => {
    const home = path.join(root, slug, 'home')
    const configDir = path.join(root, slug, 'claude-config')
    const inConfig = writeTranscript(path.join(configDir, 'projects'), 'sid-in-config')
    const inHome = writeTranscript(path.join(home, '.claude', 'projects'), 'sid-in-home')
    const d = await boot(command, slug, home, configDir)

    expect(await rpc(d, { cmd: 'fs.find', path: '~/.claude/projects', name: 'sid-in-config.jsonl', maxDepth: 3 })).toMatchObject({ ok: true, files: [inConfig] })
    // No path: the same default root.
    expect(await rpc(d, { cmd: 'fs.find', name: 'sid-in-config.jsonl', maxDepth: 3 })).toMatchObject({ ok: true, files: [inConfig] })
    expect(await rpc(d, { cmd: 'fs.find', path: '~/.claude/projects', name: 'sid-in-home.jsonl', maxDepth: 3 })).toMatchObject({ ok: true, files: [inHome] })
    // An explicit root is walked alone.
    expect(await rpc(d, { cmd: 'fs.find', path: path.join(home, '.claude', 'projects'), name: 'sid-in-config.jsonl', maxDepth: 3 })).toMatchObject({ ok: true, files: [] })
  }, 90_000)

  it('a config dir that is ~/.claude answers each transcript once', async () => {
    const home = path.join(root, slug + '-link', 'home')
    fs.mkdirSync(home, { recursive: true })
    const realClaude = path.join(home, '.claude')
    const inHome = writeTranscript(path.join(realClaude, 'projects'), 'sid-linked')
    const link = path.join(root, slug + '-link', 'config-link')
    fs.symlinkSync(realClaude, link)
    const d = await boot(command, slug + '-link', home, link)
    const found = await rpc(d, { cmd: 'fs.find', path: '~/.claude/projects', name: 'sid-linked.jsonl', maxDepth: 3 })
    expect(found.ok).toBe(true)
    expect(found.files).toHaveLength(1)
    expect([inHome, path.join(link, 'projects', '-work-marina', 'sid-linked.jsonl')]).toContain((found.files as string[])[0])
  }, 90_000)
})
