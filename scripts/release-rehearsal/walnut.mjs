/**
 * One installed Walnut, fully isolated: its own npm prefix, HOME, data dir,
 * daemon dir and stream dirs under one work directory, with a mock `claude`
 * (tests/providers/mock-claude.mjs) first on PATH. Nothing it does reaches the
 * machine's own Walnut, its daemon, or the npm global prefix.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopOwnDaemon } from './own-daemon.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const MOCK_CLAUDE = path.join(repo, 'tests/providers/mock-claude.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

/** Run a command to completion with a deadline; output goes to `logFile`. Resolves the exit code. */
export function runLogged(cmd, argv, { env, cwd, logFile, timeoutMs }) {
  return new Promise((resolve) => {
    const log = fs.openSync(logFile, 'a')
    fs.writeSync(log, `\n$ ${cmd} ${argv.join(' ')}\n`)
    const child = spawn(cmd, argv, { env, cwd, stdio: ['ignore', log, log] })
    const timer = setTimeout(() => { fs.writeSync(log, `\n[timed out after ${timeoutMs}ms]\n`); child.kill('SIGTERM') }, timeoutMs)
    child.on('close', (code) => { clearTimeout(timer); fs.closeSync(log); resolve(code ?? 1) })
  })
}

export class IsolatedWalnut {
  /** `name` labels the work subdirectory; `npm` is the npm binary to install with. */
  constructor({ work, name, npm = 'npm', extraEnv = {} }) {
    this.dir = path.join(work, name)
    this.prefix = path.join(this.dir, 'prefix')
    this.home = path.join(this.dir, 'home')
    this.walnutHome = path.join(this.home, '.open-walnut')
    this.daemonDir = path.join(this.dir, 'daemon')
    this.project = path.join(this.dir, 'project')
    this.binDir = path.join(this.dir, 'bin')
    this.logFile = path.join(this.dir, 'log.txt')
    this.npm = npm
    this.server = null
    this.port = null
    for (const d of [this.prefix, this.home, this.project, this.binDir, path.join(this.home, '.local/bin')]) fs.mkdirSync(d, { recursive: true })
    // The CLI the daemon spawns, on PATH and where Claude Code's installer puts it.
    const shim = `#!/bin/sh\nexec "${process.execPath}" "${MOCK_CLAUDE}" "$@"\n`
    for (const p of [path.join(this.binDir, 'claude'), path.join(this.home, '.local/bin/claude')]) fs.writeFileSync(p, shim, { mode: 0o755 })
    const prefixBin = path.join(this.prefix, 'bin')
    this.env = {
      PATH: [this.binDir, prefixBin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
      HOME: this.home,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      npm_config_prefix: this.prefix,
      npm_config_cache: process.env.npm_config_cache ?? path.join(path.dirname(this.dir), 'npm-cache'),
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      OPEN_WALNUT_HOME: this.walnutHome,
      WALNUT_DAEMON_DIR: this.daemonDir,
      WALNUT_STREAMS_DIR: `${this.daemonDir}-streams`,
      WALNUT_LEGACY_STREAMS_DIR: `${this.daemonDir}-legacy-streams`,
      // The mock writes a transcript the way the CLI does, where the CLI keeps it.
      MOCK_CLAUDE_TRANSCRIPT_DIR: path.join(this.home, '.claude/projects'),
      ...extraEnv,
    }
  }

  get bin() { return path.join(this.prefix, 'bin', 'open-walnut') }
  get base() { return `http://127.0.0.1:${this.port}` }

  /** `npm install -g <spec>` into this prefix, as the updater runs it (same --allow-scripts list). */
  async install(spec, allowScripts) {
    const code = await runLogged(this.npm, ['install', '-g', spec, `--allow-scripts=${allowScripts.join(',')}`], {
      env: this.env, cwd: this.dir, logFile: this.logFile, timeoutMs: 15 * 60_000,
    })
    if (code !== 0) throw new Error(`npm install -g ${spec} exited ${code} (log: ${this.logFile})`)
    if (!fs.existsSync(this.bin)) throw new Error(`npm install -g ${spec} left no ${this.bin}`)
  }

  version() {
    return execFileSync(this.bin, ['--version'], { env: this.env, encoding: 'utf8', timeout: 60_000 }).trim()
  }

  async start({ timeoutMs = 300_000 } = {}) {
    this.port ??= await freePort()
    const log = fs.openSync(this.logFile, 'a')
    fs.writeSync(log, `\n$ open-walnut web --port ${this.port}\n`)
    this.server = spawn(this.bin, ['web', '--port', String(this.port)], { env: this.env, cwd: this.project, stdio: ['ignore', log, log] })
    fs.closeSync(log)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.server.exitCode !== null) throw new Error(`open-walnut web exited ${this.server.exitCode} before serving (log: ${this.logFile})`)
      try {
        const res = await fetch(`${this.base}/api/system/health`, { signal: AbortSignal.timeout(2_000) })
        if (res.ok) return await res.json()
      } catch { /* not up yet */ }
      await sleep(1_000)
    }
    throw new Error(`open-walnut web did not answer within ${timeoutMs / 1000}s (log: ${this.logFile})`)
  }

  async api(method, p, body) {
    const res = await fetch(`${this.base}${p}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json, text }
  }

  /** Poll the session's history until an assistant message contains `needle`; returns the messages. */
  async waitForAnswer(sessionId, needle, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs
    let last = ''
    while (Date.now() < deadline) {
      const { status, json, text } = await this.api('GET', `/api/v1/sessions/${sessionId}/history?tail=200`)
      last = `${status} ${text.slice(0, 300)}`
      const messages = Array.isArray(json?.messages) ? json.messages : []
      if (status === 200 && messages.some((m) => m.role === 'assistant' && typeof m.text === 'string' && m.text.includes(needle))) return messages
      await sleep(1_000)
    }
    throw new Error(`no answer "${needle}" in session ${sessionId}'s history (last: ${last})`)
  }

  /** Stop the server and wait until it is gone (escalating to SIGKILL). Our own child only. */
  async stop() {
    const child = this.server
    this.server = null
    if (!child || child.exitCode !== null || !child.pid || child.pid <= 1) return
    const gone = new Promise((r) => child.once('close', r))
    child.kill('SIGTERM')
    if (await Promise.race([gone.then(() => true), sleep(20_000).then(() => false)])) return
    child.kill('SIGKILL')
    await Promise.race([gone, sleep(5_000)])
  }

  /** Stop the server, then the daemon it started (the pid its own daemon dir records), and its CLIs. */
  async shutdown() {
    await this.stop()
    // Once: a second pass could signal a pid the system has since handed to someone else.
    if (this.shutDown) return
    this.shutDown = true
    await stopOwnDaemon(this.daemonDir)
    // Mock CLIs the daemon spawned: process groups recorded in our own streams dir,
    // never this process's own group.
    const streams = `${this.daemonDir}-streams`
    const ownGroup = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim())
    for (const f of fs.existsSync(streams) ? fs.readdirSync(streams) : []) {
      if (!f.endsWith('.pgid')) continue
      const pgid = Number(fs.readFileSync(path.join(streams, f), 'utf8').trim())
      if (Number.isInteger(pgid) && pgid > 1 && pgid !== ownGroup) { try { process.kill(-pgid, 'SIGTERM') } catch { /* gone */ } }
    }
  }
}
