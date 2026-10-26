/**
 * What the live e2e tests (tests/e2e/*-live-e2e.test.ts) share: their temp base, booting a
 * real Walnut server as a direct child inside the walls, and the cleanup that ends with every
 * exit proven or the base kept.
 *
 * A server runs as `bun <boot script>`, the test's own bun as the direct child: bun runs
 * TypeScript as it is, so no wrapper stands between the test and the server (the tsx CLI
 * answered a TERM by relaying it and, 60 ms later, SIGKILLed a child that did not acknowledge
 * it, which is exactly the force-kill a live test may not do).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TMP_REAPER_KEEP } from '../setup/tmp-reaper.js'
import { prodLockClash, walled } from './live-isolation.js'
import type { LiveProcs, Owned } from './live-procs.js'

export interface LiveServer {
  name: string; proc: ChildProcess | null; port: number; log: string; data: string; home: string; daemonDir: string
  /** The server process the test spawned, and the server's own local daemon (from its pid file). */
  server: Owned | null; daemon: Owned | null
}

export const blankServer = (name: string): LiveServer => ({ name, proc: null, port: 0, log: '', data: '', home: '', daemonDir: '', server: null, daemon: null })

/** Where the connect guard records a dial to the real Walnut's ports (tests/helpers/live-connect-guard.cjs). */
export const guardLogOf = (base: string): string => path.join(base, 'guard-hits.log')

/** Where a server's `claude` stub records a call. */
export const claudeLogOf = (s: LiveServer): string => path.join(s.home, 'claude-calls.log')

/**
 * The test's base: a real path (the walls, the pid file check and the leftover scan compare
 * paths), marked so the harness's temp reaper never removes it (finish() does, once every exit
 * is proven; a failed cleanup keeps it as the evidence), and none of its daemon dirs holding the
 * production daemon's instance-lock port.
 */
export async function liveBase(prefix: string, daemonDirs: readonly string[]): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const base = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)))
    await fsp.writeFile(path.join(base, TMP_REAPER_KEEP), '')
    if (prodLockClash(daemonDirs.map((d) => path.join(base, d))).length === 0) return base
    await fsp.rm(base, { recursive: true, force: true })
  }
  throw new Error('no temp base whose daemon dirs avoid the production daemon\'s lock port')
}

/** A server's home with a `claude` that refuses and leaves a line the cleanup reads. */
export async function prepareServer(s: LiveServer, base: string, name: string): Promise<void> {
  s.home = path.join(base, name, 'home')
  s.data = path.join(base, name, 'data')
  s.daemonDir = path.join(base, name.slice(0, 2) + 'd')
  for (const d of [path.join(s.home, 'bin'), s.data, s.daemonDir]) await fsp.mkdir(d, { recursive: true })
  await fsp.writeFile(path.join(s.home, 'bin', 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(claudeLogOf(s))}\necho "claude is disabled in this test" >&2\nexit 1\n`, { mode: 0o755 })
}

/**
 * The lines every boot script ends with: stop on TERM or INT, and once the test process is gone.
 * A stop that hangs ends the process after 20 s with code 1 (it exits itself; nothing kills it).
 */
export const BOOT_TAIL = `
let closing = false
const close = async () => {
  if (closing) return
  closing = true
  setTimeout(() => process.exit(1), 20_000)
  try { await stopServer() } catch {}
  process.exit(0)
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
armGracefulSignalExit()
// The test is this server's keeper: once its process is gone, stop (never left running on the machine).
// Signal 0 only asks whether the pid exists; inside the walls a live keeper answers EPERM.
const keeper = Number(process.env.WALNUT_TEST_KEEPER_PID)
if (keeper > 1) setInterval(() => { try { process.kill(keeper, 0) } catch (e) { if (e.code === 'ESRCH') void close() } }, 5_000).unref()
`

/** The first line of every boot script: the pid the test checks against the one it spawned. */
export const BOOT_HEAD = `process.stdout.write(JSON.stringify({ pid: process.pid }) + '\\n')`

/**
 * Boots `script` as a direct child inside the walls and registers it at once (a boot may fail
 * before it reports). Resolves with the port it prints (`WALNUT_PORT=`); `onLine` sees every JSON
 * line. `ownDaemon`: the server runs its own local daemon (the Mac), registered from its pid file
 * once the server is up; otherwise one is registered only if it exists.
 */
export async function bootLiveServer(procs: LiveProcs, s: LiveServer, input: {
  base: string; repo: string; file: string; script: string; env: NodeJS.ProcessEnv; ownDaemon: boolean; onLine?: (line: string) => void
}): Promise<void> {
  await fsp.writeFile(input.file, input.script)
  s.server = s.daemon = null
  const [cmd, args] = walled(process.execPath, [input.file], { base: input.base, repo: input.repo })
  const proc = spawn(cmd, args, { cwd: input.repo, env: input.env, stdio: ['ignore', 'pipe', 'pipe'] })
  s.proc = proc
  const server = procs.child(`${s.name} server`, proc)
  if (!server) throw new Error(`${s.name}: spawn gave no pid`)
  s.server = server
  proc.stderr!.on('data', (b: Buffer) => { s.log = (s.log + b.toString()).slice(-300_000) })
  if (process.env.DEBUG_LIVE) proc.stderr!.on('data', (b: Buffer) => process.stderr.write(b))
  s.port = await new Promise<number>((resolve, reject) => {
    let out = ''
    const t = setTimeout(() => reject(new Error(`${s.name} did not report a port in 180s\n${s.log.slice(-3000)}`)), 180_000)
    proc.stdout!.on('data', (b: Buffer) => {
      out += b.toString()
      for (const l of out.split('\n')) {
        if (!l.startsWith('{')) continue
        try {
          const j = JSON.parse(l)
          if (typeof j.pid === 'number' && j.pid !== proc.pid) { clearTimeout(t); reject(new Error(`${s.name}: the script runs as ${j.pid}, not the spawned ${proc.pid}`)); return }
        } catch { /* partial */ }
        input.onLine?.(l)
      }
      const m = /WALNUT_PORT=(\d+)/.exec(out)
      if (m) { clearTimeout(t); resolve(Number(m[1])) }
    })
    proc.once('exit', (code) => { clearTimeout(t); reject(new Error(`${s.name} exited early (${code})\n${s.log.slice(-3000)}`)) })
  })
  s.daemon = input.ownDaemon
    ? await procs.pidFile(`${s.name} daemon`, s.daemonDir)
    : await procs.pidFile(`${s.name} daemon`, s.daemonDir, { ifRunning: true })
}

/**
 * While the test runs: a TERM to this worker (the run harness's deadline) first resumes what the
 * test paused, since a frozen process cannot act on the TERM that reaches it, then takes its
 * normal course. An exit of this worker does the same (its runner may end it first). Returns the
 * uninstall.
 */
export function resumeOnTerm(procs: LiveProcs): () => void {
  const onTerm = () => {
    procs.resumeSync()
    process.removeListener('SIGTERM', onTerm)
    if (process.listenerCount('SIGTERM') === 0) process.kill(process.pid, 'SIGTERM')
  }
  const onExit = () => { procs.resumeSync() }
  process.on('SIGTERM', onTerm)
  process.on('exit', onExit)
  return () => { process.removeListener('SIGTERM', onTerm); process.removeListener('exit', onExit) }
}

/** A server's own daemon, from its pid file, when none is registered or the registered one exited (it may have restarted). */
async function adoptDaemons(procs: LiveProcs, servers: LiveServer[]): Promise<void> {
  for (const s of servers) {
    if (!s.daemonDir || (s.daemon && !s.daemon.exited)) continue
    const d = await procs.pidFile(`${s.name} daemon`, s.daemonDir, { ifRunning: true }).catch(() => null)
    if (d) s.daemon = d
  }
}

/**
 * Lines of the daemons' own logs (`<base>/<dir>/daemon-*.log`) that record a SIGKILL: the test never
 * sends one, and a daemon's stop ladder should never need one for a mock CLI either.
 */
async function daemonKills(base: string): Promise<string[]> {
  const hits: string[] = []
  for (const d of await fsp.readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue
    for (const f of await fsp.readdir(path.join(base, d.name)).catch(() => [] as string[])) {
      if (!/^daemon-.*\.log$/.test(f)) continue
      const text = await fsp.readFile(path.join(base, d.name, f), 'utf8').catch(() => '')
      for (const line of text.split('\n')) if (/SIGKILL|cleaning dead session process group/.test(line)) hits.push(`${d.name}/${f}: ${line.slice(0, 300)}`)
    }
  }
  return hits
}

/**
 * The cleanup: resume what is paused, stop the servers first (so none restarts a session or
 * redials while the rest stops), then `between` (the leader test ends its mock CLIs through their
 * daemons), then every daemon. Each stop is TERM and a proven exit. A `claude` call or a dial to
 * the real Walnut's ports fails the run too. The base goes only when finish() proves it may.
 */
export async function finishLive(procs: LiveProcs, base: string, servers: LiveServer[], between?: () => Promise<void>): Promise<void> {
  await adoptDaemons(procs, servers)
  for (const o of procs.owned) if (o.paused) await procs.resume(o)
  for (const o of procs.owned.filter((x) => x.label.endsWith(' server'))) await procs.stop(o, 30_000)
  await adoptDaemons(procs, servers)
  await between?.()
  // Newest first: a keeper's daemon before its keeper, which ends after it.
  await procs.stopAll(30_000, [...procs.owned].reverse().filter((o) => o.how !== 'command'))
  for (const k of await daemonKills(base)) procs.fail(`a daemon sent SIGKILL: ${k}`)
  for (const s of servers) {
    const calls = s.home ? await fsp.readFile(claudeLogOf(s), 'utf8').catch(() => '') : ''
    if (calls) procs.fail(`${s.name} ran claude: ${calls.slice(0, 300)}`)
  }
  const dials = await fsp.readFile(guardLogOf(base), 'utf8').catch(() => '')
  if (dials) procs.fail(`a process dialed the real Walnut's ports: ${dials.slice(0, 600)}`)
  await fsp.mkdir(path.join(base, 'logs'), { recursive: true })
  for (const s of servers) await fsp.writeFile(path.join(base, 'logs', `${s.name}.log`), s.log).catch(() => {})
  if (process.env.DEBUG_LIVE) for (const s of servers) process.stderr.write(`--- ${s.name} ---\n${s.log.slice(-6000)}\n`)
  await procs.finish(async () => { if (!process.env.KEEP_LEADER_LIVE) await fsp.rm(base, { recursive: true, force: true }) })
}
