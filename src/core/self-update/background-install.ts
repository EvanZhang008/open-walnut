/**
 * The startup update's npm install, run so that it may outlive the wait for it
 * (startup-update.ts). Whoever waits for the server (the Mac app: 180 s, a
 * service manager, a person) must not wait for npm: the server gives the
 * install STARTUP_UPDATE_BUDGET_MS, then starts the version in use while the
 * install goes on, and the next start runs the new one.
 *
 * So npm is never killed half way (an interrupted global install can leave the
 * package directory missing or partly written):
 *
 *   - It runs detached (its own process group), so a terminal's Ctrl-C or a
 *     launcher stopping the server does not reach it.
 *   - Its output goes to a file, never to this process's stdout: a pipe whose
 *     reader went away (the server stopped, the app closed its reader) would
 *     end npm on its next write. While the server waits, the file is copied to
 *     stderr, so the progress still shows.
 *   - A record (pid, its start time, the version) says it is running, so the
 *     next start does not run a second npm into the same prefix while the first
 *     one still writes there. A record whose process is gone, or whose pid now
 *     belongs to a later process, does not count.
 *
 * The compiled file the server runs is not in the way: it unpacked itself into
 * the data dir, and a running file keeps its own copy when npm replaces it.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pidAlive, processStart } from './install-lock.js'

export interface InstallJob {
  /** The installer's exit code (a signal is 128 + its number); rejects when it could not start. */
  done: Promise<number>
  /** Stop copying its output (the wait is over); what it writes stays in the log file. */
  quiet: () => void
}

interface JobRecord { pid: number; version: string; start: string }

export interface DetachedInstallOptions {
  /** Where npm's output goes. */
  logFile: string
  /** The running-install record (installRunning reads it). */
  record: string
  version: string
  /** Where the output is copied while someone waits (default: this process's stderr). */
  tail?: (text: string) => void
  pollMs?: number
}

/**
 * npm moves the installed package aside before it downloads the new one, so for the whole
 * download a start finds no Walnut there (measured: 100 s at 512 KB/s, and the start failed
 * with ENOENT). The download goes first, with the install untouched (`npm cache add` of the
 * launcher and this machine's platform package), then the install runs from the cache: what
 * is left of that gap is the unpack. Null when there is nothing to fetch ahead (not npm, or
 * the platform package is not known).
 */
export function prefetchArgv(argv: { file: string; args: string[] }, spec: string, platformSpec: string | null): { file: string; args: string[] } | null {
  const i = argv.args.indexOf('install')
  if (i < 0 || !platformSpec) return null
  // What comes before `install` stays: the archive's npm-cli.js after its Node.
  return { file: argv.file, args: [...argv.args.slice(0, i), 'cache', 'add', spec, platformSpec] }
}

/** `@open-walnut/<target>@<version>` for the platform package this process runs from, or null. */
export function platformSpecFor(execPath: string, version: string): string | null {
  const m = /\/node_modules\/@open-walnut\/((?:darwin|linux)-(?:arm64|x64)(?:-musl)?)\/[^/]+$/.exec(execPath.replace(/\\/g, '/'))
  return m ? `@open-walnut/${m[1]}@${version}` : null
}

/** Commands run one after another (a failed fetch ahead does not stop the install); the last one's exit is the job's. */
export function sequenceArgv(steps: Array<{ file: string; args: string[] }>): { file: string; args: string[] } {
  if (steps.length === 1) return steps[0]!
  const q = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`
  return { file: '/bin/sh', args: ['-c', steps.map((st) => [st.file, ...st.args].map(q).join(' ')).join('; ')] }
}

export function startDetachedInstall(file: string, args: string[], o: DetachedInstallOptions): InstallJob {
  fs.mkdirSync(path.dirname(o.logFile), { recursive: true })
  const fd = fs.openSync(o.logFile, 'w')
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(file, args, { detached: true, stdio: ['ignore', fd, fd] })
  } catch (e) {
    // Some runtimes throw here for a missing file where Node emits 'error'.
    return { done: Promise.reject(e), quiet: () => {} }
  } finally {
    fs.closeSync(fd)
  }
  // The server may end before npm does; npm must not keep it alive either.
  child.unref()
  const tail = o.tail ?? ((text: string) => { process.stderr.write(text) })
  let offset = 0
  const copy = () => {
    try {
      const size = fs.statSync(o.logFile).size
      if (size <= offset) return
      const buf = Buffer.alloc(size - offset)
      const at = fs.openSync(o.logFile, 'r')
      try { fs.readSync(at, buf, 0, buf.length, offset) } finally { fs.closeSync(at) }
      offset = size
      tail(buf.toString('utf8'))
    } catch { /* the log went away: nothing to show */ }
  }
  let timer: ReturnType<typeof setInterval> | null = setInterval(copy, o.pollMs ?? 250)
  timer.unref?.()
  const quiet = () => {
    if (!timer) return
    clearInterval(timer)
    timer = null
    copy()
  }
  const pid = child.pid ?? null
  let exited = false
  if (pid) {
    void processStart(pid).then((start) => {
      // A quick install may be over before its start time is known: no record then.
      if (exited) return
      try {
        fs.mkdirSync(path.dirname(o.record), { recursive: true })
        fs.writeFileSync(o.record, `${JSON.stringify({ pid, version: o.version, start } satisfies JobRecord)}\n`)
      } catch { /* a record is a courtesy to the next start */ }
    })
  }
  const done = new Promise<number>((resolve, reject) => {
    child.on('error', (e) => { quiet(); reject(e) })
    child.on('exit', (code, signal) => {
      exited = true
      quiet()
      try {
        const rec = JSON.parse(fs.readFileSync(o.record, 'utf8')) as JobRecord
        if (rec.pid === pid) fs.rmSync(o.record, { force: true })
      } catch { /* no record (written after it ended, or never) */ }
      resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 0))
    })
  })
  return { done, quiet }
}

/** An install an earlier start began and that still runs, or null (a stale record is removed). */
export async function installRunning(record: string, deps: { alive?: (pid: number) => boolean; started?: (pid: number) => Promise<string> } = {}): Promise<{ pid: number; version: string } | null> {
  let rec: JobRecord
  try {
    rec = JSON.parse(fs.readFileSync(record, 'utf8')) as JobRecord
  } catch {
    return null
  }
  const alive = deps.alive ?? pidAlive
  const started = deps.started ?? processStart
  if (Number.isInteger(rec.pid) && alive(rec.pid) && (!rec.start || (await started(rec.pid)) === rec.start)) {
    return { pid: rec.pid, version: rec.version }
  }
  fs.rmSync(record, { force: true })
  return null
}

let installedVersion: string | null = null

/** A version this server installed after it started: a restart runs it. */
export function noteInstalledInBackground(version: string): void { installedVersion = version }
export function installedInBackground(): string | null { return installedVersion }

/** The version a background install put in, and the one it replaced, until its first start. */
export function readUnverified(file: string): { version: string; from: string } | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; from?: unknown }
    return typeof v.version === 'string' && typeof v.from === 'string' ? { version: v.version, from: v.from } : null
  } catch {
    return null
  }
}

export function writeUnverified(file: string, pending: { version: string; from: string } | null): void {
  try {
    if (!pending) { fs.rmSync(file, { force: true }); return }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(pending)}\n`)
  } catch { /* without it, that start is not watched; nothing else changes */ }
}

