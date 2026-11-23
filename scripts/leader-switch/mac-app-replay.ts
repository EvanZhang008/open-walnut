/**
 * The Mac app's handling of its server (desktop/main.swift, desktop/DesktopDiagnostics.swift),
 * replayed step for step on any machine so a test can run it for minutes against a port whose
 * server changes under it (a leader switch: the standby page, the standby giving its port up,
 * the console replica taking over, the new leader going away). desktop/ itself is never built or
 * changed: this is a port of what it does, each step named after its Swift function.
 *
 *   startServer()            a live holder of <home>/server.lock.json -> waitForRunningServer,
 *                            else checkExistingServer(first port)
 *   checkExistingServer      GET / (2 s): 200 -> the orphan check (the app's own recorded child
 *                            listening there: stop it, start our own) or attachExistingServer;
 *                            no answer -> the next port; past the last -> tryStartServerOnPort(0)
 *   attachExistingServer     GET /api/config (3 tries): `loginSession.problems` with
 *                            user_lookup or dns_config -> replaceEndedSessionServer (stops the
 *                            listener, once a launch) else attach, and the same check again in 90 s
 *   tryStartServerOnPort     spawn `walnut web --port <p>`; its output naming
 *                            "listening on http://localhost:<p>" -> ownsServer, pollForServer
 *                            (GET / every 0.5 s, 60 tries); an exit before that line ->
 *                            EADDRINUSE: the next port, else the error screen; no line in 180 s
 *                            -> terminate, the error screen
 *   terminationHandler       an owned server that exits -> scheduleServerRecovery: restart after
 *                            1, 2, 4, 8, 16 s (reset by a server healthy for 120 s), then the
 *                            error screen
 *   watchdog                 GET / every 60 s: logs only
 *
 * Every stop it does is recorded (`kills`), as is every spawn, attach and error screen: a test
 * asserts no stop of a healthy server and no spawn loop.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface ReplayEvent { at: number; kind: string; port?: number; pid?: number; detail?: string }

export interface ReplayOptions {
  /** OPEN_WALNUT_HOME (its server.lock.json is the lock the app reads). */
  home: string
  /** WALNUT_DESKTOP_PORTS (the app's default is [3456, 4567]). */
  ports: number[]
  /** The command the app spawns for a port: `walnut web --port <p>` with its env. */
  command(port: number): { cmd: string; args: string[]; env: Record<string, string> }
  /** Whether a pid runs a Walnut server (`ps -o command=`, ServerLockHolder.isWalnutServerCommand). */
  isWalnutServer?(pid: number): boolean
  /** The pid listening on a port (lsof); tests may pass their own. */
  listener?(port: number): number | null
  /** Shortened clocks for a test (the app's own when unset). */
  clocks?: Partial<typeof APP_CLOCKS>
  log?(e: ReplayEvent): void
}

/** The app's own times (seconds), DesktopDiagnostics.swift and main.swift. */
export const APP_CLOCKS = {
  checkTimeout: 2, pollEvery: 0.5, pollTries: 60, startupTimeout: 180, waitPoll: 2, waitRequestTimeout: 5,
  maxRediscoveries: 3, restartDelays: [1, 2, 4, 8, 16] as number[], healthyReset: 120, endedRecheck: 90, watchdog: 60,
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function get(url: string, timeoutS: number): Promise<{ status: number; text: string } | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutS * 1000) })
    return { status: r.status, text: await r.text() }
  } catch {
    return null
  }
}

/** ServerLockHolder.isWalnutServerCommand. */
export function isWalnutServerCommand(command: string): boolean {
  const parts = command.split(' ')
  const webAt = parts.indexOf('web')
  if (webAt <= 0) return false
  return parts.slice(0, webAt).some((p) => {
    const name = path.basename(p)
    return name === 'walnut' || name.startsWith('walnut-') || name === 'open-walnut' || name === 'cli.js' || name === 'cli.ts'
  })
}

function psCommand(pid: number): string {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ') } catch { return '' }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

function lsofListener(port: number): number | null {
  // /proc/net/tcp{,6}: the socket inode listening on the port, then the process holding it.
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  const inodes = new Set<string>()
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = ''
    try { text = fs.readFileSync(f, 'utf8') } catch { continue }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/)
      if (c.length > 9 && c[1]?.endsWith(`:${hex}`) && c[3] === '0A') inodes.add(c[9]!)
    }
  }
  if (!inodes.size) return null
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    let fds: string[] = []
    try { fds = fs.readdirSync(`/proc/${pid}/fd`) } catch { continue }
    for (const fd of fds) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))
        if (m && inodes.has(m[1]!)) return Number(pid)
      } catch { /* gone */ }
    }
  }
  return null
}

export class MacAppReplay {
  readonly events: ReplayEvent[] = []
  private readonly c: typeof APP_CLOCKS
  private stopped = false
  private ownsServer = false
  private serverPort: number | null = null
  private serverProcess: ChildProcess | null = null
  private recordedPid: number | null = null
  private lastSpawnedPid: number | null = null
  private serverReadyAt: number | null = null
  private restartAttempts = 0
  private rediscoveries = 0
  private replacedEnded = false
  private generation = 0
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private readonly children = new Set<ChildProcess>()

  constructor(private readonly o: ReplayOptions) {
    this.c = { ...APP_CLOCKS, ...o.clocks }
  }

  private note(kind: string, more: Omit<ReplayEvent, 'at' | 'kind'> = {}): void {
    const e = { at: Date.now(), kind, ...more }
    this.events.push(e)
    this.o.log?.(e)
  }

  /** Stops of a server the app did itself (orphan reclaim, ended session, startup timeout). */
  kills(): ReplayEvent[] { return this.events.filter((e) => e.kind.startsWith('kill:')) }
  spawns(): ReplayEvent[] { return this.events.filter((e) => e.kind === 'spawn') }
  errors(): ReplayEvent[] { return this.events.filter((e) => e.kind === 'error_screen') }
  /** The port it shows, or null while it shows a loading or error screen. */
  attachedPort(): number | null { return this.shownPort }
  private shownPort: number | null = null

  start(): void {
    this.note('launch')
    this.watchdogTimer = setInterval(() => { void this.watchdog() }, this.c.watchdog * 1000)
    void this.startServer()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.generation++
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    // Quitting the app stops the server it owns (applicationWillTerminate).
    for (const ch of this.children) if (ch.exitCode === null && ch.signalCode === null) try { ch.kill('SIGTERM') } catch { /* gone */ }
    for (let i = 0; i < 100 && [...this.children].some((ch) => ch.exitCode === null && ch.signalCode === null); i++) await sleep(100)
  }

  private isWalnutServer(pid: number): boolean {
    return this.o.isWalnutServer ? this.o.isWalnutServer(pid) : alive(pid) && isWalnutServerCommand(psCommand(pid))
  }

  private listener(port: number): number | null {
    return this.o.listener ? this.o.listener(port) : lsofListener(port)
  }

  private lockHolder(): { pid: number; port: number | null } | null {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.o.home, 'server.lock.json'), 'utf8')) as { pid?: number; port?: number }
      return typeof j.pid === 'number' ? { pid: j.pid, port: typeof j.port === 'number' ? j.port : null } : null
    } catch {
      return null
    }
  }

  private liveLockHolder(): { pid: number; port: number | null } | null {
    const h = this.lockHolder()
    if (!h || h.pid === process.pid || h.pid === this.lastSpawnedPid || h.pid === this.recordedPid || !this.isWalnutServer(h.pid)) return null
    return h
  }

  private async startServer(): Promise<void> {
    if (this.stopped) return
    this.note('discovery')
    const holder = this.liveLockHolder()
    if (holder) return this.waitForRunningServer(holder)
    return this.checkExistingServer(0)
  }

  private async waitForRunningServer(holder: { pid: number; port: number | null }): Promise<void> {
    const gen = this.generation
    this.note('wait_holder', { pid: holder.pid, ...(holder.port ? { port: holder.port } : {}) })
    const began = Date.now()
    let port = holder.port
    while (!this.stopped && gen === this.generation) {
      if (!this.isWalnutServer(holder.pid)) {
        this.note('holder_gone', { pid: holder.pid })
        if (this.rediscoveries < this.c.maxRediscoveries) { this.rediscoveries++; return this.startServer() }
        return this.errorScreen('Walnut kept stopping while it started.')
      }
      if (Date.now() - began >= this.c.startupTimeout * 1000) return this.errorScreen(`a running server (pid ${holder.pid}) never answered`)
      if (port === null) { const now = this.lockHolder(); if (now?.pid === holder.pid) port = now.port }
      if (port !== null) {
        const r = await get(`http://localhost:${port}`, this.c.waitRequestTimeout)
        if (r?.status === 200) return this.attachExistingServer(port)
      }
      await sleep(this.c.waitPoll * 1000)
    }
  }

  private async checkExistingServer(index: number): Promise<void> {
    if (this.stopped) return
    if (index >= this.o.ports.length) return this.tryStartServerOnPort(0)
    const port = this.o.ports[index]!
    const r = await get(`http://localhost:${port}`, this.c.checkTimeout)
    if (r?.status === 200) {
      const orphan = this.orphanedWalnutServerPid(port)
      if (orphan !== null) {
        await this.kill('kill:orphan_reclaimed', orphan, port)
        return this.tryStartServerOnPort(index)
      }
      return this.attachExistingServer(port)
    }
    return this.checkExistingServer(index + 1)
  }

  private orphanedWalnutServerPid(port: number): number | null {
    if (this.recordedPid === null) return null
    const pid = this.listener(port)
    if (pid === null || pid !== this.recordedPid) return null
    if (!this.isWalnutServer(pid)) { this.recordedPid = null; return null }
    return pid
  }

  private async askLoginSession(port: number, attempts: number): Promise<string[] | null> {
    for (let i = 0; i < attempts; i++) {
      const r = await get(`http://localhost:${port}/api/config`, 10)
      if (r?.status === 200) {
        try {
          const problems = (JSON.parse(r.text) as { loginSession?: { problems?: unknown } }).loginSession?.problems
          return Array.isArray(problems) ? problems.filter((p): p is string => p === 'user_lookup' || p === 'dns_config') : []
        } catch { return [] }
      }
    }
    return null
  }

  private async attachExistingServer(port: number): Promise<void> {
    if (this.replacedEnded) return this.attachServer(port)
    const problems = await this.askLoginSession(port, 3)
    if (!problems || !problems.length) {
      this.attachServer(port)
      this.scheduleEndedRecheck(port)
      return
    }
    return this.replaceEndedSessionServer(port, problems)
  }

  private scheduleEndedRecheck(port: number): void {
    const gen = this.generation
    setTimeout(() => {
      void (async () => {
        if (this.stopped || gen !== this.generation || this.replacedEnded || this.ownsServer || this.serverPort !== port) return
        const problems = await this.askLoginSession(port, 2)
        if (problems?.length && !this.replacedEnded && this.serverPort === port) await this.replaceEndedSessionServer(port, problems)
      })()
    }, this.c.endedRecheck * 1000).unref?.()
  }

  private async replaceEndedSessionServer(port: number, problems: string[]): Promise<void> {
    this.replacedEnded = true
    const lock = this.lockHolder()
    const pid = (lock && lock.port === port ? lock.pid : null) ?? this.listener(port)
    if (pid === null || pid <= 1 || !this.isWalnutServer(pid)) return this.attachServer(port)
    this.serverPort = null
    this.shownPort = null
    const gone = await this.kill('kill:ended_session_replaced', pid, port, problems.join(','))
    if (!gone) return this.attachServer(port)
    if (this.recordedPid === pid) this.recordedPid = null
    return this.tryStartServerOnPort(Math.max(0, this.o.ports.indexOf(port)))
  }

  private attachServer(port: number): void {
    this.generation++
    this.rediscoveries = 0
    this.restartAttempts = 0
    this.ownsServer = false
    this.serverPort = port
    this.shownPort = port
    this.serverReadyAt = null
    this.note('attached', { port })
  }

  private tryStartServerOnPort(index: number): void {
    if (this.stopped) return
    if (index >= this.o.ports.length) return void this.handleStartupFailure(`could not start on ports ${this.o.ports.join(', ')}`)
    const port = this.o.ports[index]!
    const { cmd, args, env } = this.o.command(port)
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.children.add(child)
    this.serverProcess = child
    this.recordedPid = child.pid ?? null
    this.lastSpawnedPid = child.pid ?? null
    this.note('spawn', { port, ...(child.pid ? { pid: child.pid } : {}) })
    let out = ''
    let portConfirmed = false
    let settled = false
    const onText = (d: Buffer) => {
      out += String(d)
      if (!portConfirmed && out.includes(`listening on http://localhost:${port}`)) {
        portConfirmed = true
        this.note('port_confirmed', { port, ...(child.pid ? { pid: child.pid } : {}) })
        this.ownsServer = true
        this.serverPort = port
        this.serverReadyAt = Date.now()
        void this.pollForServer(port)
      }
    }
    child.stdout?.on('data', onText)
    child.stderr?.on('data', onText)
    const began = Date.now()
    const deadline = setInterval(() => {
      if (portConfirmed || settled || this.serverProcess !== child) { clearInterval(deadline); return }
      if (Date.now() - began < this.c.startupTimeout * 1000) return
      clearInterval(deadline)
      settled = true
      if (child.exitCode === null) void this.kill('kill:startup_timeout', child.pid ?? -1, port)
      this.serverProcess = null
      void this.handleStartupFailure(`never said it listens on ${port}`)
    }, 1000)
    child.on('exit', (code, signal) => {
      this.children.delete(child)
      clearInterval(deadline)
      this.note('server_exited', { port, ...(child.pid ? { pid: child.pid } : {}), detail: `code ${code} signal ${signal}; ${out.trim().split('\n').slice(-2).join(' | ')}` })
      if (this.recordedPid === child.pid) this.recordedPid = null
      const current = this.serverProcess === child
      if (portConfirmed && this.ownsServer && !this.stopped && current) {
        const healthyFor = this.serverReadyAt ? (Date.now() - this.serverReadyAt) / 1000 : null
        this.serverProcess = null
        this.serverPort = null
        this.shownPort = null
        this.serverReadyAt = null
        this.ownsServer = false
        return void this.scheduleServerRecovery('owned_process_exited', healthyFor)
      }
      if (portConfirmed || settled) return
      settled = true
      if (current) this.serverProcess = null
      if (/eaddrinuse|address already in use/i.test(out)) return void this.tryStartServerOnPort(index + 1)
      void this.handleStartupFailure(`exited with code ${code}`)
    })
  }

  private async pollForServer(port: number): Promise<void> {
    for (let i = 1; i <= this.c.pollTries && !this.stopped; i++) {
      const r = await get(`http://localhost:${port}`, 2)
      if (r?.status === 200) { this.shownPort = port; this.note('loaded', { port }); return }
      if (this.serverPort !== port) return
      await sleep(this.c.pollEvery * 1000)
    }
    if (!this.stopped) await this.handleStartupFailure(`started on ${port} but never became ready`)
  }

  private async handleStartupFailure(message: string): Promise<void> {
    const holder = this.liveLockHolder()
    if (holder) return this.waitForRunningServer(holder)
    if (this.restartAttempts > 0) return this.scheduleServerRecovery('recovery_start_failed', null, message)
    return this.errorScreen(message)
  }

  private scheduleServerRecovery(reason: string, healthyFor: number | null, detail = ''): void {
    if (healthyFor !== null && healthyFor >= this.c.healthyReset) this.restartAttempts = 0
    if (this.restartAttempts >= this.c.restartDelays.length) return void this.errorScreen(`could not keep the server running after ${this.restartAttempts} restarts. ${detail}`)
    const delay = this.c.restartDelays[this.restartAttempts]!
    this.restartAttempts++
    this.note('restart_scheduled', { detail: `${reason}, attempt ${this.restartAttempts}, in ${delay} s` })
    const gen = this.generation
    setTimeout(() => { if (!this.stopped && gen === this.generation) { this.serverPort = null; void this.startServer() } }, delay * 1000)
  }

  private errorScreen(message: string): void {
    this.shownPort = null
    this.note('error_screen', { detail: message })
  }

  private async watchdog(): Promise<void> {
    if (this.stopped || this.serverPort === null) return
    const r = await get(`http://localhost:${this.serverPort}`, 10)
    const bundle = r && /assets\/index-[^"']+\.js/.test(r.text)
    this.note('watchdog', { port: this.serverPort, detail: r ? `${r.status}${bundle ? ' bundle' : ' no bundle'}` : 'no answer' })
  }

  private async kill(kind: string, pid: number, port: number, detail?: string): Promise<boolean> {
    this.note(kind, { pid, port, ...(detail ? { detail } : {}) })
    if (pid <= 1) return false
    try { process.kill(pid, 'SIGTERM') } catch { return true }
    for (let i = 0; i < 80 && alive(pid); i++) await sleep(100)
    if (alive(pid)) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    return !alive(pid)
  }
}
