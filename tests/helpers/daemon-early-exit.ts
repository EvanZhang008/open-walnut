/**
 * Why a test's daemon died while booting, in the error itself.
 *
 * A boot helper spawns a daemon and waits for its port line; when the daemon
 * exits first it used to reject with a bare `daemon exited early: <code>`. The
 * cause was invisible in CI: the test discarded the daemon's stderr, and the
 * daemon's own FATAL line goes to its log in the daemon dir
 * (`daemon-d-<pid>-<hash>.log`, plus `daemon-exit-d-<pid>-<hash>.log` on a
 * JS-visible death, see daemonCrash in daemon-standalone.ts / daemon-source.ts),
 * which sits in a temp dir the test removes afterwards.
 *
 * `onDaemonEarlyExit(proc, { daemonDir }, fail)` replaces the boot helper's
 * `proc.on('exit', ...)`: it keeps the last few KB of stderr and of stdout (the
 * port line left out), and when the process exits it reads the tails of that
 * daemon's log and exit breadcrumb, then calls `fail` with an Error whose first
 * line is exactly `daemon exited early: <code>`. Attach it where the boot helper
 * attaches its stdout listener (before any output can arrive). Nothing here
 * throws: every read is best effort, so a broken dir only means a shorter message.
 *
 * tests/scripts/daemon-early-exit-ratchet.test.ts fails on a file that builds
 * the bare error itself.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'

const STREAM_TAIL_BYTES = 4096
const LOG_TAIL_BYTES = 4096
/** How long to wait after `exit` for stdio to close, so a last stderr chunk is not lost. */
const STDIO_SETTLE_MS = 500
const PORT_LINE = /^\d+$/

export interface DaemonEarlyExitOptions {
  /** The WALNUT_DAEMON_DIR the daemon was started with; its log is read from there. */
  daemonDir?: string | null
}

export interface DaemonEarlyExitDetails {
  code: number | null
  signal?: NodeJS.Signals | null
  pid?: number
  stderr?: string
  stdout?: string
  daemonDir?: string | null
}

/** Keep the last `max` characters of a growing text. */
class Tail {
  private text = ''
  constructor(private readonly max: number) {}
  push(chunk: unknown): void {
    try {
      this.text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      if (this.text.length > this.max * 2) this.text = this.text.slice(-this.max)
    } catch { /* never throw from a stream listener */ }
  }
  value(): string { return this.text.slice(-this.max) }
}

function readTail(file: string, bytes: number): string {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    const text = buf.toString('utf8')
    // Start at a whole line when the tail was cut.
    return len < size && text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : text
  } catch {
    return ''
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch { /* ignore */ }
  }
}

/**
 * Pick this daemon's file among `daemon-d-<pid>-<hash>.log` (prefix `daemon-`)
 * or `daemon-exit-d-...` (prefix `daemon-exit-`): the one naming `pid`, else the
 * newest, since a wrapper process may carry another pid than the daemon.
 */
function pickLog(daemonDir: string, prefix: 'daemon-' | 'daemon-exit-', pid?: number): string | null {
  try {
    const re = new RegExp('^' + prefix + 'd-(\\d+)-[0-9a-f]+\\.log$')
    const found = fs.readdirSync(daemonDir)
      .map((name) => ({ name, m: re.exec(name) }))
      .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
    if (found.length === 0) return null
    const own = pid !== undefined ? found.find((x) => Number(x.m[1]) === pid) : undefined
    if (own) return path.join(daemonDir, own.name)
    let best: { file: string; mtime: number } | null = null
    for (const x of found) {
      const file = path.join(daemonDir, x.name)
      let mtime = 0
      try { mtime = fs.statSync(file).mtimeMs } catch { continue }
      if (!best || mtime > best.mtime) best = { file, mtime }
    }
    return best?.file ?? null
  } catch {
    return null
  }
}

function section(title: string, body: string): string {
  const text = body.trimEnd()
  return text ? `\n--- ${title} ---\n${text}` : ''
}

/** Build the error. First line is exactly `daemon exited early: <code>`. Never throws. */
export function daemonEarlyExitError(d: DaemonEarlyExitDetails): Error {
  let message = 'daemon exited early: ' + d.code
  try {
    if (d.signal) message += `\nsignal: ${d.signal}`
    message += section('daemon stderr (tail)', d.stderr ?? '')
    const stdout = (d.stdout ?? '').split('\n').filter((l) => !PORT_LINE.test(l.trim())).join('\n')
    message += section('daemon stdout (tail)', stdout)
    if (d.daemonDir) {
      const log = pickLog(d.daemonDir, 'daemon-', d.pid)
      const crumb = pickLog(d.daemonDir, 'daemon-exit-', d.pid)
      if (crumb) message += section(`exit breadcrumb ${path.basename(crumb)}`, readTail(crumb, LOG_TAIL_BYTES))
      if (log) message += section(`daemon log ${path.basename(log)} (tail)`, readTail(log, LOG_TAIL_BYTES))
      if (!log && !crumb) message += `\n(no daemon log in ${d.daemonDir})`
    }
  } catch { /* keep what was built */ }
  return new Error(message)
}

/**
 * Collect the daemon's output from now on, and on exit call `fail` with the
 * error above (after stdio closed, or STDIO_SETTLE_MS at most).
 */
export function onDaemonEarlyExit(
  proc: ChildProcess,
  opts: DaemonEarlyExitOptions,
  fail: (err: Error) => void,
): void {
  const stderr = new Tail(STREAM_TAIL_BYTES)
  const stdout = new Tail(STREAM_TAIL_BYTES)
  try { proc.stderr?.on('data', (c) => stderr.push(c)) } catch { /* ignore */ }
  try { proc.stdout?.on('data', (c) => stdout.push(c)) } catch { /* ignore */ }
  const pid = proc.pid
  proc.once('exit', (code, signal) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      let err: Error
      try {
        err = daemonEarlyExitError({ code, signal, pid, stderr: stderr.value(), stdout: stdout.value(), daemonDir: opts.daemonDir })
      } catch {
        err = new Error('daemon exited early: ' + code)
      }
      fail(err)
    }
    // Kept referenced: the report must arrive even when nothing else holds the loop.
    const timer = setTimeout(finish, STDIO_SETTLE_MS)
    const open = [proc.stderr, proc.stdout].filter((s) => s && !s.destroyed && !s.readableEnded)
    if (open.length === 0) { finish(); return }
    let left = open.length
    for (const s of open) s!.once('close', () => { if (--left === 0) finish() })
  })
}
