/**
 * A command that outlives the daemon that started it (host_exec `detach`, plugin scripts
 * `detach`): its output goes straight to files, never through a pipe to the daemon, and one
 * small `/bin/sh` wrapper that ends with it writes the command's exit status to a file. A daemon
 * that starts after a restart (an update, a crash) finds the run on disk and follows it to its end
 * as the first one would have (host-exec-core.ts adopt).
 *
 * The daemon starts the wrapper as a process group leader (spawn `detached`), so the run's group is
 * the wrapper's pid, as it was the shell's before. The wrapper runs the command in the foreground
 * with a TERM trap of its own: a stop that sends SIGTERM to the whole group ends the command (whose
 * TERM is the default again: a trap with a handler is not inherited), while the wrapper waits for it
 * and then writes its status (`$?`: the exit code, 128+N for signal N) to `<id>.exit`, whole (a temp
 * file renamed). Only SIGKILL ends the wrapper too: then no status is written, and the run's end is
 * that kill. No job control is used, so the command sees what a plain `sh -c` child sees (Debian's
 * dash has none without a terminal; 2026-11-21 check: `set -m` gave no group of its own there).
 *
 * Bundled into host-exec-core (the binary daemon and the host-exec-core.cjs sidecar).
 */
import fs from 'node:fs'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'

const WRAPPER = [
  'x=$1; shift',
  // Its own words (a shell's "Terminated" for a child a signal ended) go nowhere; the command's
  // stderr is the run's. The child puts it back itself, then becomes the command (exec): a
  // redirection on the wrapper's own line would still hold while it waits, and dash prints there.
  // fd 9, not 3: a plugin script's text comes on fd 3 (host-exec-script.ts).
  'exec 9>&2 2>/dev/null',
  'trap : TERM',
  '/bin/sh -c \'exec 2>&9 9>&-; exec "$@"\' walnut-detached "$@"',
  's=$?',
  'printf \'%s\\n\' "$s" > "$x.t" && mv -f "$x.t" "$x"',
].join('\n')

/** The marker a wrapper's command line carries (ps shows it), after `-c <script>`. */
export const WRAPPER_NAME = 'walnut-detached'

/** Where a run's exit status is written: beside its log (`<log>.exit`). */
export function exitFileOf(logFile: string): string {
  return `${logFile.replace(/\.log$/, '')}.exit`
}

/** The wrapper's command line: `/bin/sh -c <script> walnut-detached <exit file> <cmd> <args...>`. */
export function wrapperArgv(cmd: string, args: string[], exitFile: string): { cmd: string; args: string[] } {
  return { cmd: '/bin/sh', args: ['-c', WRAPPER, WRAPPER_NAME, exitFile, cmd, ...args] }
}

/** The status the wrapper wrote; null while it is not there (or not whole yet). */
const statusOf = (text: string): number | null => {
  const m = /^(\d+)\s*$/.exec(text)
  return m ? Number(m[1]) : null
}

/** The status the wrapper wrote, or null (none yet, or unreadable). */
export async function readExitFile(file: string): Promise<number | null> {
  try { return statusOf(await fs.promises.readFile(file, 'utf8')) } catch { return null }
}

const SIGNAL_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(os.constants.signals).map(([name, n]) => [n as number, name]),
)

/**
 * The wait status as an exit: 128+N reads as signal N only when the run was signalled (a stop, its
 * deadline, a dialog it sat at, the daemon going), as the shell that signal ended would have
 * answered; a command that itself exits 143 keeps its exit code.
 */
export function exitOf(status: number | null, signalled: boolean): { code: number | null; signal: string | null } {
  if (status === null) return { code: null, signal: null }
  if (signalled && status > 128 && SIGNAL_NAMES[status - 128]) return { code: null, signal: SIGNAL_NAMES[status - 128]! }
  return { code: status, signal: null }
}

export interface DetachedWatch {
  exitFile: string
  /** The wrapper as this daemon started it: its exit is the run's end. */
  wrapper?: ChildProcess
  /** For a run adopted after a restart: whether its wrapper still runs (its pid and start time). */
  wrapperAlive?: () => boolean
  /** Whether the run was signalled (exitOf). */
  signalled: () => boolean
  /** The end of a wrapper gone with no status, when this daemon did not see it go (default SIGKILL); null: no signal (it was let go). */
  killedBy?: () => string | null
  /** How often an adopted run's files are looked at. */
  pollMs?: number
}

export type DetachedChild = ChildProcess & { stopWatching(): void }

/**
 * A stand-in for the command's ChildProcess, as host-exec-group.ts watchShellEnd reads one: it
 * emits 'exit' (code, signal) once the wrapper ended, then 'close' (there are no pipes to drain:
 * the output is already in its file).
 */
export function detachedChild(w: DetachedWatch): DetachedChild {
  const ee = new EventEmitter() as unknown as DetachedChild
  let done = false
  let timer: ReturnType<typeof setInterval> | null = null
  const finish = (fallback: { code: number | null; signal: string | null }, known?: number) => {
    if (done) return
    done = true
    if (timer) clearInterval(timer)
    void (known !== undefined ? Promise.resolve(known) : readExitFile(w.exitFile)).then((status) => {
      const end = status !== null ? exitOf(status, w.signalled()) : fallback
      ee.emit('exit', end.code, end.signal)
      ee.emit('close', end.code, end.signal)
    })
  }
  ee.stopWatching = () => { done = true; if (timer) clearInterval(timer) }
  if (w.wrapper) {
    const wr = w.wrapper
    wr.on('error', (err) => { if (!done) { done = true; ee.emit('error', err) } })
    wr.on('exit', (_code, signal) => finish({ code: null, signal: signal ?? null }))
    // It may have ended already (a quick command): its exit was emitted before this listened.
    if (wr.exitCode !== null || wr.signalCode !== null) setImmediate(() => finish({ code: null, signal: wr.signalCode ?? null }))
    return ee
  }
  // One look at a time, off the event loop (an async read of a tiny file, then one kill(0)).
  let looking = false
  const look = async () => {
    if (done || looking) return
    looking = true
    try {
      const status = await readExitFile(w.exitFile)
      if (done) return
      if (status !== null) return finish({ code: null, signal: null }, status)
      if (w.wrapperAlive && !w.wrapperAlive()) {
        // Gone with no status: killed (SIGKILL), unless it wrote it between the two looks (finish reads it again).
        return finish({ code: null, signal: w.killedBy ? w.killedBy() : 'SIGKILL' })
      }
    } finally { looking = false }
  }
  timer = setInterval(() => { void look() }, w.pollMs ?? 250)
  timer.unref?.()
  setImmediate(() => { void look() })
  return ee
}

/** Removes a run's exit file (and its temp file) once its end is recorded elsewhere. */
export async function removeExitFile(exitFile: string): Promise<void> {
  for (const f of [exitFile, `${exitFile}.t`]) {
    try { await fs.promises.unlink(f) } catch { /* gone */ }
  }
}
