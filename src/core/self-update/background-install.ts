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
    const write = (start: string) => {
      try {
        fs.mkdirSync(path.dirname(o.record), { recursive: true })
        fs.writeFileSync(o.record, `${JSON.stringify({ pid, version: o.version, start } satisfies JobRecord)}\n`)
      } catch { /* a record is a courtesy to the next start */ }
    }
    // At once, by pid alone: another installer looking now must see this one (ps may take
    // seconds to name its start time, and a `walnut update` started in that gap ran npm beside it).
    write('')
    void processStart(pid).then((start) => {
      // A quick install may be over before its start time is known: its record is gone then.
      if (exited || !start) return
      write(start)
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
  // This process's own claim counts while it runs, also as pid 1 in a container (pidAlive says no to it).
  const alive = deps.alive ?? ((pid: number) => pid === process.pid || pidAlive(pid))
  const started = deps.started ?? processStart
  if (Number.isInteger(rec.pid) && alive(rec.pid) && (!rec.start || (await started(rec.pid)) === rec.start)) {
    return { pid: rec.pid, version: rec.version }
  }
  // Removed only if it is still the record judged: another installer may have taken it meanwhile.
  try {
    const now = JSON.parse(fs.readFileSync(record, 'utf8')) as JobRecord
    if (now.pid !== rec.pid || now.start !== rec.start) return null
  } catch { /* gone, or unreadable: the claimer judges it */ }
  fs.rmSync(record, { force: true })
  return null
}

const UNREADABLE_STALE_MS = 10_000

function removeUnreadable(record: string, now: number): void {
  try {
    JSON.parse(fs.readFileSync(record, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    try {
      if (now - fs.statSync(record).mtimeMs >= UNREADABLE_STALE_MS) fs.rmSync(record, { force: true })
    } catch { /* gone meanwhile */ }
  }
}

/** Where every npm install of this data home says it runs: the server's (startup, live) and `walnut update`'s. */
export function installRecordFile(home: string): string {
  return path.join(home, 'local', 'update-installing.json')
}

export type InstallClaim =
  | { ok: true; release: () => void }
  | { ok: false; held: { pid: number; version: string } }

/**
 * Take the install record for this process before an npm install starts, made with an
 * exclusive create, so two installers never both start: 2026-11-04, a nightly's server
 * began its live install while `walnut update` ran npm into the same prefix, and one npm
 * failed on the other's bin link (EEXIST). A record of a live install is `held`; a stale
 * one is removed and taken. The detached install then writes its own pid over this one
 * (startDetachedInstall); `release` removes the record only while it is still this
 * process's, so it never takes away a running npm's.
 */
export async function claimInstall(record: string, version: string, deps: { alive?: (pid: number) => boolean; started?: (pid: number) => Promise<string>; pid?: number; now?: () => number } = {}): Promise<InstallClaim> {
  const pid = deps.pid ?? process.pid
  const start = await (deps.started ?? processStart)(pid)
  fs.mkdirSync(path.dirname(record), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(record, `${JSON.stringify({ pid, version, start } satisfies JobRecord)}\n`, { flag: 'wx' })
      return {
        ok: true,
        release: () => {
          try {
            const rec = JSON.parse(fs.readFileSync(record, 'utf8')) as JobRecord
            if (rec.pid === pid) fs.rmSync(record, { force: true })
          } catch { /* gone, or another's now */ }
        },
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const held = await installRunning(record, deps)
    if (held) return { ok: false, held }
    // A record no one can read (a full disk, a write cut by a crash) is stale once it is a few
    // seconds old; younger, its writer may still be at it.
    removeUnreadable(record, deps.now?.() ?? Date.now())
  }
  const held = await installRunning(record, deps)
  return { ok: false, held: held ?? { pid: 0, version: 'another version' } }
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

