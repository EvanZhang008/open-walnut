/**
 * The processes a live e2e test made, and the only ones it may signal.
 *
 * A live test (tests/e2e/*-live-e2e.test.ts) starts real servers and daemons. Each one is
 * registered the moment it exists, with the proof that it is the test's: a ChildProcess the test
 * spawned (exact until its exit event, since Node reaps it only then), a pid whose parent is such
 * a running child, a daemon pid file inside the test's own directory whose process runs in that
 * directory, or a pid whose command line names a file inside it. Every entry but a child keeps the pid's start time and command line: a
 * signal goes out only while the pid still names that same process, never after a pid reuse,
 * never to a pid <= 1. A pid whose start time still matches but whose command line changed is
 * not proven either way: it is neither signalled nor counted as exited.
 *
 * Stopping is TERM and a wait for an exit the process table proves; never KILL. A process that
 * outlives the deadline, a failed read of the table, or a process still naming the test's
 * directory at the end fails the run and keeps the directory for the evidence (finish()).
 */
import { execFile, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface ProcRow { pid: number; ppid: number; pgid: number; stat: string; lstart: string; command: string }
export type Sig = 'SIGTERM' | 'SIGSTOP' | 'SIGCONT'

/** The machine as the helper sees it; tests pass a fake one. */
export interface ProcTable {
  /** One read of the whole table. Throws when the read fails: a failure is never an empty table. */
  read(): Promise<Map<number, ProcRow>>
  /** One process, read synchronously (a signal handler cannot wait); null when it is gone, throws when the read fails. */
  rowSync(pid: number): ProcRow | null
  /** The process's working directory, or null when it cannot be read. */
  cwd(pid: number): Promise<string | null>
  kill(pid: number, sig: Sig): void
  now(): number
  sleep(ms: number): Promise<void>
  realpath(p: string): string
}

type How = 'child' | 'descendant' | 'pidfile' | 'command'
export interface Owned {
  label: string
  pid: number
  how: How
  lstart: string
  command: string
  child?: ChildProcess
  paused: boolean
  /** An exit was proven (the child's exit event, or the table no longer naming this process). */
  exited: boolean
}

export class NotOursError extends Error {}

export class LiveProcs {
  readonly owned: Owned[] = []
  readonly refused: string[] = []
  readonly failures: string[] = []

  constructor(private readonly table: ProcTable, private readonly base: string) {}

  /** A child the test spawned: registered at once, before it reports anything (a boot may fail first). */
  child(label: string, proc: ChildProcess): Owned | null {
    if (!proc.pid || proc.pid <= 1) { this.failures.push(`${label}: spawn gave no pid`); return null }
    const o: Owned = { label, pid: proc.pid, how: 'child', lstart: '', command: '', child: proc, paused: false, exited: false }
    if (proc.exitCode !== null || proc.signalCode !== null) o.exited = true
    proc.once('exit', () => { o.exited = true })
    this.owned.push(o)
    return o
  }

  /**
   * A process a running child of the test started (a keeper's daemon): the table lists `parent`
   * as its parent. Proven at once, before the process writes anything; kept by start time and
   * command line from then on, so it stays the test's after the parent is gone.
   */
  async childOf(label: string, pid: number, parent: Owned): Promise<Owned> {
    if (parent.how !== 'child' || parent.exited) throw this.notOurs(`${label}: ${parent.label} is not a running child of the test`)
    const row = await this.rowOf(label, pid)
    if (row.ppid !== parent.pid) throw this.notOurs(`${label}: pid ${pid} has parent ${row.ppid}, not ${parent.label} (${parent.pid})`)
    return this.keep(label, row, 'descendant')
  }

  /**
   * A daemon the test's server started: its pid file is inside `dir`, and it runs in `dir`.
   * `ifRunning` (cleanup after a boot that failed): no pid file, or a pid no longer running,
   * is null instead of a refusal; a running pid that does not run in `dir` is still refused.
   */
  async pidFile(label: string, dir: string): Promise<Owned>
  async pidFile(label: string, dir: string, opts: { ifRunning: true }): Promise<Owned | null>
  async pidFile(label: string, dir: string, opts: { ifRunning?: boolean } = {}): Promise<Owned | null> {
    let text: string | null = null
    try { text = fs.readFileSync(`${dir}/daemon.pid`, 'utf8') } catch { if (!opts.ifRunning) throw this.notOurs(`${label}: no ${dir}/daemon.pid`) }
    if (text === null) return null
    const n = Number(text.trim())
    if (!Number.isInteger(n)) throw this.notOurs(`${label}: no pid in ${dir}/daemon.pid`)
    if (opts.ifRunning) {
      if (!(n > 1)) throw this.notOurs(`${label}: pid ${n}`)
      let rows: Map<number, ProcRow>
      try { rows = await this.table.read() } catch { throw this.notOurs(`${label}: the process table could not be read`) }
      const r = rows.get(n)
      if (!r || r.stat.startsWith('Z')) return null
    }
    const row = await this.rowOf(label, n)
    const cwd = await this.table.cwd(n)
    if (!cwd || this.table.realpath(cwd) !== this.table.realpath(dir)) throw this.notOurs(`${label}: pid ${n} runs in ${cwd ?? 'an unreadable dir'}, not ${dir}`)
    return this.keep(label, row, 'pidfile')
  }

  /** A pid whose command line names a file inside the test's directory (a mock CLI a daemon runs, once it runs it). */
  async command(label: string, pid: number, file: string): Promise<Owned> {
    if (!file.startsWith(this.base + '/')) throw this.notOurs(`${label}: ${file} is outside ${this.base}`)
    const row = await this.rowOf(label, pid)
    if (!row.command.includes(file)) throw this.notOurs(`${label}: pid ${pid} runs ${row.command.slice(0, 120)}`)
    return this.keep(label, row, 'command')
  }

  /**
   * 'ours' while the pid still names the registered process; 'gone' once it exited (no row, a
   * zombie, or another start time); 'unknown' when the table could not be read, or the start time
   * matches but the command line changed.
   */
  async state(o: Owned): Promise<'ours' | 'gone' | 'unknown'> {
    if (o.exited) return 'gone'
    if (o.how === 'child') return 'ours' // not reaped before its exit event, so the pid cannot be reused
    let rows: Map<number, ProcRow>
    try { rows = await this.table.read() } catch { return 'unknown' }
    const row = rows.get(o.pid)
    if (!row || row.stat.startsWith('Z') || row.lstart !== o.lstart) { o.exited = true; return 'gone' }
    return row.command === o.command ? 'ours' : 'unknown'
  }

  /** Sends sig only to a process proven ours right now. */
  async signal(o: Owned, sig: Sig): Promise<boolean> {
    if (!(o.pid > 1)) { this.refused.push(`${o.label}: ${sig} to pid ${o.pid}`); return false }
    const s = await this.state(o)
    if (s !== 'ours') { if (s === 'unknown') this.refused.push(`${o.label}: ${sig} to pid ${o.pid} not proven ours`); return false }
    try { this.table.kill(o.pid, sig) } catch (err) { this.failures.push(`${o.label}: ${sig} failed: ${String(err)}`); return false }
    if (sig === 'SIGSTOP') o.paused = true
    if (sig === 'SIGCONT') o.paused = false
    return true
  }

  /** A cleanup step that did not happen (a daemon that would not stop its CLI): finish fails on it. */
  fail(msg: string): void { this.failures.push(msg) }

  pause(o: Owned): Promise<boolean> { return this.signal(o, 'SIGSTOP') }
  resume(o: Owned): Promise<boolean> { return this.signal(o, 'SIGCONT') }

  /**
   * Synchronous SIGCONT to what the test paused, each re-read first and only while it is the same
   * process. For a SIGTERM handler: a frozen process cannot act on the TERM that follows.
   */
  resumeSync(): void {
    for (const o of this.owned) {
      if (!o.paused || o.exited || !(o.pid > 1)) continue
      if (o.how === 'child') {
        if (o.child!.exitCode !== null || o.child!.signalCode !== null) continue
      } else {
        let row: ProcRow | null
        try { row = this.table.rowSync(o.pid) } catch { continue }
        if (!row || row.stat.startsWith('Z') || row.lstart !== o.lstart || row.command !== o.command) continue
      }
      try { this.table.kill(o.pid, 'SIGCONT'); o.paused = false } catch { /* gone meanwhile */ }
    }
  }

  /** TERM, then wait for a proven exit. Never KILL: past the deadline it records a failure and returns false. */
  async stop(o: Owned, ms: number): Promise<boolean> {
    if (o.exited) return true
    if (o.paused) await this.resume(o)
    if (!(await this.signal(o, 'SIGTERM')) && !o.exited) {
      this.failures.push(`${o.label} (${o.pid}): TERM not sent`)
      return false
    }
    return this.awaitGone(o, ms, `still running ${ms} ms after TERM`)
  }

  /** Waits for a proven exit without sending anything (a mock CLI its daemon was asked to stop). */
  waitExit(o: Owned, ms: number): Promise<boolean> {
    return this.awaitGone(o, ms, `no exit within ${ms} ms`)
  }

  /** Resumes what the test paused, then stops each still running, in the given order (default: newest first). */
  async stopAll(ms: number, order: Owned[] = [...this.owned].reverse()): Promise<boolean> {
    for (const o of this.owned) if (o.paused) await this.resume(o)
    let ok = true
    for (const o of order) if (!(await this.stop(o, ms))) ok = false
    return ok
  }

  /** Rows that still name the test's directory, read once (a failed read is a failure, not none). */
  async leftovers(): Promise<ProcRow[] | null> {
    try {
      const rows = await this.table.read()
      return [...rows.values()].filter((r) => r.command.includes(this.base) && !r.stat.startsWith('Z'))
    } catch { return null }
  }

  /** After stopAll: removes the directory only when every process exited and none is left; else throws and keeps it. */
  async finish(remove: () => Promise<void>): Promise<void> {
    // An exit nobody waited for (a CLI that ended with its daemon) is proven by one more look.
    for (const o of this.owned) if (!o.exited) await this.state(o)
    const left = await this.leftovers()
    if (left === null) this.failures.push('the process table could not be read for the final check')
    else for (const r of left) this.failures.push(`left running: ${r.pid} ${r.command.slice(0, 160)}`)
    for (const o of this.owned) if (!o.exited) this.failures.push(`${o.label} (${o.pid}): no exit proven`)
    if (this.failures.length > 0 || this.refused.length > 0) {
      throw new Error(`live cleanup failed; ${this.base} is kept\n${[...this.failures, ...this.refused.map((r) => `refused: ${r}`)].join('\n')}`)
    }
    await remove()
  }

  private async awaitGone(o: Owned, ms: number, why: string): Promise<boolean> {
    const end = this.table.now() + ms
    while (this.table.now() < end) {
      if ((await this.state(o)) === 'gone') return true
      await this.table.sleep(100)
    }
    if ((await this.state(o)) === 'gone') return true
    this.failures.push(`${o.label} (${o.pid}): ${why}`)
    return false
  }

  private async rowOf(label: string, pid: number): Promise<ProcRow> {
    if (!(pid > 1)) throw this.notOurs(`${label}: pid ${pid}`)
    let rows: Map<number, ProcRow>
    try { rows = await this.table.read() } catch { throw this.notOurs(`${label}: the process table could not be read`) }
    const row = rows.get(pid)
    if (!row || row.stat.startsWith('Z')) throw this.notOurs(`${label}: pid ${pid} is not running`)
    return row
  }

  private keep(label: string, row: ProcRow, how: How): Owned {
    const o: Owned = { label, pid: row.pid, how, lstart: row.lstart, command: row.command, paused: false, exited: false }
    this.owned.push(o)
    return o
  }

  private notOurs(msg: string): NotOursError {
    this.refused.push(msg)
    return new NotOursError(msg)
  }
}

/** Parses `ps -o pid=,ppid=,pgid=,stat=,lstart=,command=` under LC_ALL=C (lstart is five words). */
export function parsePs(out: string): Map<number, ProcRow> {
  const rows = new Map<number, ProcRow>()
  for (const line of out.split('\n')) {
    const w = line.trim().split(/\s+/)
    if (w.length < 10) continue
    const [pid, ppid, pgid] = [Number(w[0]), Number(w[1]), Number(w[2])]
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue
    rows.set(pid, { pid, ppid, pgid, stat: w[3]!, lstart: w.slice(4, 9).join(' '), command: w.slice(9).join(' ') })
  }
  return rows
}

const PS_COLUMNS = 'pid=,ppid=,pgid=,stat=,lstart=,command='
// The start time's words follow the locale; parsePs reads the C one. Both tools run by full path.
const PS_ENV = { LC_ALL: 'C' }

/** The real machine: ps and lsof or /proc (read only), process.kill for the three signals the helper sends. */
export function realProcTable(): ProcTable {
  return {
    async read() {
      const { stdout } = await run('/bin/ps', ['-A', '-ww', '-o', PS_COLUMNS], { maxBuffer: 32 << 20, timeout: 15_000, env: PS_ENV })
      const rows = parsePs(stdout)
      if (rows.size === 0) throw new Error('ps returned no rows')
      return rows
    },
    rowSync(pid) {
      if (!(pid > 1)) throw new Error(`no row for pid ${pid}`)
      try {
        const out = execFileSync('/bin/ps', ['-ww', '-o', PS_COLUMNS, '-p', String(pid)], { timeout: 5_000, env: PS_ENV, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
        return parsePs(out).get(pid) ?? null
      } catch (err) {
        // ps -p exits 1 with no rows for a pid that is gone; anything else is a failed read.
        const e = err as { status?: number; stdout?: Buffer }
        if (e.status === 1 && !String(e.stdout ?? '').trim()) return null
        throw err
      }
    },
    async cwd(pid) {
      if (process.platform === 'linux') { try { return fs.readlinkSync(`/proc/${pid}/cwd`) } catch { return null } }
      try {
        const { stdout } = await run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 15_000, env: PS_ENV })
        const line = stdout.split('\n').find((l) => l.startsWith('n'))
        return line ? line.slice(1) : null
      } catch { return null }
    },
    kill(pid, sig) {
      if (!(pid > 1)) throw new Error(`refusing ${sig} to pid ${pid}`)
      process.kill(pid, sig)
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    realpath: (p) => { try { return fs.realpathSync(p) } catch { return p } },
  }
}
