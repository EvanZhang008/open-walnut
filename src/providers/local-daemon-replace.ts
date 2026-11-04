/**
 * A daemon this server starts itself (this machine without a service, the cloud companion's
 * tunnel daemon) is replaced the way a service is. 2026-11-04 review: the server stopped the
 * old daemon and then spawned the new build, so a build that could not start left the
 * machine with none. Now:
 *
 *   trial     the new build serves first in a throwaway dir (daemon-boot-proof.ts) while the
 *             old daemon keeps serving; one that does not keeps the old daemon in place.
 *   previous  the files the old daemon runs from are kept, so a new daemon that passes the
 *             trial and then does not start on the real dir is followed by the old one. They
 *             live in previousKeepDir for a daemon dir that lasts (the production one, the
 *             companion's): under ${XDG_STATE_HOME:-~/.local/state}/open-walnut/, one dir per
 *             daemon dir (2026-11-04 review 4: in /tmp/open-walnut/previous a reboot inside the
 *             build's day off lost them, and the next start ran the refused build). Beside the
 *             daemon's files (<daemon dir>/previous) for a throwaway daemon dir (a test, an
 *             ephemeral or a deploy's smoke server: its copy goes with it, never left in the
 *             home), and when the home cannot take the copy (a quota, a full disk). Both are
 *             read, the newest copy first, so an older build's <daemon dir>/previous still is.
 *               the source daemon (npm installs, the companion): its script and sidecars
 *                 move there before the new ones are written (keepPreviousSource, from
 *                 materializeSourceDaemon);
 *               a daemon binary on Linux: the running process's own file, /proc/<pid>/exe
 *                 (there even after a deploy replaced the path), is copied there.
 *               a daemon binary elsewhere (a Mac): a clone of the file it was started from,
 *                 kept once it served (keepRunningBinary; APFS clones cost no space).
 *               the compiled walnut file (the server's own file, its daemon `walnut
 *                 __daemon --start`): the same two ways, judged by the file's identity
 *                 (singleFile().execId), not a .version beside it. 2026-11-04 review: it
 *                 kept none, so every release upgrade of a compiled install without a
 *                 service left the machine with no daemon when the new build died on the
 *                 real data. The copy starts as `<copy> --start` with the server's
 *                 WALNUT_RUNTIME_DIR, so it unpacks its own tree beside and prunes nothing.
 *             A kept file carries a stamp of its build (<file>.version), and is started again
 *             also when the old daemon died while the new build is refused (keptPrevious).
 *             Nothing to keep (a legacy daemon with no version) and keeping that failed are
 *             not the same: a copy that failed (a full disk, a clone refused) throws
 *             KeepFailedError, and the old daemon keeps serving (2026-11-04 review: it was
 *             stopped anyway, and a new build that then failed left no daemon at all).
 *             Known gap: the first update from a release older than these copies, of a daemon
 *             binary or the compiled file on a Mac, has no clone yet (a deploy replaced the old
 *             file before this server started), so that one update has no way back; Linux
 *             reads /proc and has one.
 *   gate      the trial runs beside the old daemon, never in the way of a start (2026-11-04
 *             review: a build that hangs without listening held startup ~75 s, and a trial
 *             that could not run at all threw out of ensureRunning); a build that passed it
 *             and then did not start on the real dir is left alone until another build
 *             comes (or a day), on every branch, so the healthy old daemon is not stopped
 *             again every ten minutes (ReplacementGate).
 *   stay      the new daemon that answered on the real dir counts as up only once it stayed
 *             STAY_MS (StayWatch in local-daemon-stay.ts, its probation, kept on disk); one gone
 *             before then is refused like one that did not start, and the kept previous one
 *             starts. 2026-11-04 review: the port file (one answer) counted, so a build that
 *             listened and then exited was started again on the next connect, and the old
 *             daemon never came back. Till it passed, its own files wait in the pending slot
 *             (keepPendingBinary, keepPreviousSource 'next'), and become the way back then.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { proveDaemonBoot } from './daemon-boot-proof.js'
import { PREVIOUS_DIR, previousKeyOf } from './daemon-previous-key.js'
import { BUILD_BACKOFF_MS, type BuildBackoffEntry } from './daemon-build-backoff.js'
import { fileIdentity, singleFile } from '../lib/single-file.js'

export { PREVIOUS_DIR, previousKeyOf }
// The probation's watch lives in local-daemon-stay.ts; still importable from here.
export { bootTime, STAY_CHECK_EVERY_MS, STAY_MS, STAY_SETTLE_SLACK_MS, StayWatch, type StayStore } from './local-daemon-stay.js'

/**
 * The dir the copies of the daemon that ran before live in, for `daemonDir`: one that survives a
 * reboot (the state dir, as a task's working dir), never /tmp. WALNUT_DAEMON_PREVIOUS_ROOT
 * replaces the whole root (tests).
 */
export function previousKeepDir(daemonDir: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const override = env.WALNUT_DAEMON_PREVIOUS_ROOT
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state')
  const root = override && path.isAbsolute(override) ? path.resolve(override) : path.join(state, 'open-walnut', 'daemon-previous')
  return path.join(root, previousKeyOf(path.resolve(daemonDir)))
}

/** Where the copies are read: the kept dir, then <daemon dir>/previous (an older build's, a throwaway dir's, a fallback). */
function keepDirs(daemonDir: string): string[] {
  return [previousKeepDir(daemonDir), path.join(daemonDir, PREVIOUS_DIR)]
}

/** A promote (promotePending) cut between its two renames left the way back as `<keep dir>.old`: it goes back first. */
async function recoverPromote(daemonDir: string): Promise<void> {
  for (const keep of keepDirs(daemonDir)) {
    if (await fsp.stat(keep).then(() => true, () => false)) continue
    await fsp.rename(`${keep}.old`, keep).catch(() => {})
  }
}

/**
 * Where a copy is written, in order: the kept dir only for a daemon dir that lasts (`durable`),
 * then beside the daemon's files. 2026-11-04 review 5: every throwaway server (a deploy's smoke
 * boot, an ephemeral server) left a copy of its daemon in the real home, and a home that could
 * not take one (a quota) held every update off for good.
 */
function keepTargets(daemonDir: string, durable: boolean): string[] {
  const beside = path.join(daemonDir, PREVIOUS_DIR)
  return durable ? [previousKeepDir(daemonDir), beside] : [beside]
}

/** A rename, or where the kept dir is on another disk than the daemon dir (/tmp a tmpfs), a copy and a remove. */
async function moveFile(from: string, to: string): Promise<void> {
  try { await fsp.rename(from, to) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await fsp.copyFile(from, to)
    await fsp.chmod(to, (await fsp.stat(from)).mode & 0o7777)
    await fsp.unlink(from)
  }
}
/** How long a build that failed its trial is left alone before it is tried again. */
export const LOCAL_REPLACE_RETRY_MS = 10 * 60_000
/** How long a build that passed its trial and then did not start on the real dir is left alone (a newer build ends it sooner; wall clock, kept across restarts). */
export const REAL_DIR_BACKOFF_MS = BUILD_BACKOFF_MS

/** How the daemon file is started: the compiled walnut file as `__daemon`, a script under this runtime, else the binary itself. */
export function daemonLaunch(binaryPath: string, compiledSelf: boolean): { cmd: string; args: string[] } {
  if (compiledSelf) return { cmd: process.execPath, args: ['__daemon', '--start'] }
  if (binaryPath.endsWith('.cjs') || binaryPath.endsWith('.js')) return { cmd: process.execPath, args: [binaryPath, '--start'] }
  return { cmd: binaryPath, args: ['--start'] }
}

/** null when the new daemon served in a throwaway dir of its own; else why not, in a sentence. */
export function trialDaemon(binaryPath: string, compiledSelf: boolean, env: NodeJS.ProcessEnv): Promise<string | null> {
  const { cmd, args } = daemonLaunch(binaryPath, compiledSelf)
  // The compiled file unpacks its runtime tree first: the server's own, never one in the trial's HOME.
  const extra: Record<string, string> = env.WALNUT_RUNTIME_DIR ? { WALNUT_RUNTIME_DIR: env.WALNUT_RUNTIME_DIR } : {}
  return proveDaemonBoot({ executable: cmd, args, path: env.PATH ?? '/usr/bin:/bin', env: extra })
}

/** Keeping the running daemon's file to go back to failed: it must not be stopped. */
export class KeepFailedError extends Error {}

/**
 * Before the source daemon's files are rewritten: the ones there now move to previous/
 * (renames, no copies). `running`: the build that ran last here (daemon.version), stamped as
 * `stamp`. A previous/ already of that build stays as it is, and files that are another
 * build's (written for one whose trial failed or never ran) are no way back and are not moved
 * over it. 2026-11-04 review: previous/ was emptied every time, so A running, B written and
 * refused, then C made previous/ B's files, and A had nothing to go back to.
 */
export async function keepPreviousSource(daemonDir: string, names: string[], running: string | null = null, stamp = 'daemon-fallback.cjs.version', durable = false, slot: 'previous' | 'next' = 'previous'): Promise<void> {
  // Async: the server's event loop (2026-11-04 review 5: a copy across disks ran sync there).
  const stampOf = async (dir: string) => (await fsp.readFile(path.join(dir, stamp), 'utf8').catch(() => '')).trim()
  if (running) {
    if (await stampOf(daemonDir) !== running) return
    for (const dir of keepDirs(daemonDir)) if (await stampOf(dir) === running) return
  }
  // 'next' (the build that runs is on its probation): beside the way back, which it must not take yet.
  if (slot === 'next' && !running) return
  const targets = keepTargets(daemonDir, durable).map((keep) => (slot === 'next' ? `${keep}${NEXT_SUFFIX}` : keep))
  for (const keep of targets) {
    try {
      await fsp.mkdir(path.dirname(keep), { recursive: true, mode: 0o700 })
      await fsp.rm(keep, { recursive: true, force: true })
      await fsp.mkdir(keep, { mode: 0o700 })
    } catch { continue }
    const moved: string[] = []
    let full = false
    for (const name of names) {
      try {
        await moveFile(path.join(daemonDir, name), path.join(keep, name))
        moved.push(name)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        full = true
        break
      }
    }
    if (!full) {
      if (slot === 'next') await fsp.writeFile(path.join(keep, NEXT_STAMP), `${running}\n`, { mode: 0o600 }).catch(() => {})
      return
    }
    // It did not fit there (a quota, a full disk): what moved goes back, and the next place is tried.
    let back = true
    for (const name of moved) { try { await moveFile(path.join(keep, name), path.join(daemonDir, name)) } catch { back = false } }
    if (back) await fsp.rm(keep, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * The file to start again when the new daemon does not start, or null. `version`: the build
 * the old daemon answered with; a kept script of another build is never taken for it.
 */
export async function previousDaemon(o: { daemonDir: string; binaryPath: string; compiledSelf: boolean; pid: number | null; version: string; platform?: string; durable?: boolean }): Promise<string | null> {
  if (!o.version) return null
  await recoverPromote(o.daemonDir)
  // A copy of that build, kept here or by an older build in the daemon dir: the source daemon's
  // (keepPreviousSource), or a clone kept once that build served (keepRunningBinary).
  for (const dir of keepDirs(o.daemonDir)) {
    const file = path.join(dir, path.basename(o.binaryPath))
    const was = (await fsp.readFile(`${file}.version`, 'utf8').catch(() => '')).trim()
    if (was === o.version && await fsp.stat(file).then((s) => s.isFile(), () => false)) return file
  }
  if (o.binaryPath.endsWith('.cjs') || o.binaryPath.endsWith('.js')) return null
  if ((o.platform ?? process.platform) !== 'linux') {
    // No clone kept yet: one now, while the file on disk still is the build that runs (else the
    // known gap in the header: nothing to keep). A clone that fails keeps the old daemon serving.
    const cloned = await cloneRunningBinary({ ...o, version: o.version })
    if (cloned.kept) return cloned.kept
    if (cloned.failed) throw new KeepFailedError(`the running daemon's file could not be cloned to go back to (${cloned.failed})`)
    return null
  }
  if (!o.pid || o.pid <= 1) return null
  const exe = `/proc/${o.pid}/exe`
  const target = (await fsp.readlink(exe).catch(() => '')).replace(/ \(deleted\)$/, '')
  // A daemon run by node or bun is not its own file: nothing to keep that way.
  if (path.basename(target) !== path.basename(o.binaryPath)) return null
  let failed = ''
  for (const keep of keepTargets(o.daemonDir, o.durable === true)) {
    const kept = path.join(keep, path.basename(o.binaryPath))
    try {
      await fsp.mkdir(path.dirname(keep), { recursive: true, mode: 0o700 })
      await fsp.rm(keep, { recursive: true, force: true })
      await fsp.mkdir(keep, { mode: 0o700 })
      await fsp.copyFile(exe, `${kept}.tmp`)
      await fsp.chmod(`${kept}.tmp`, 0o700)
      await fsp.rename(`${kept}.tmp`, kept)
      // Stamped like a kept clone: started again later only as the build that ran (keptPrevious).
      await fsp.writeFile(`${kept}.version`, `${o.version}\n`, { mode: 0o600 })
      return kept
    } catch (error) {
      // It did not fit there (a quota, a full disk): the next place.
      await fsp.rm(keep, { recursive: true, force: true }).catch(() => {})
      failed = error instanceof Error ? error.message : String(error)
    }
  }
  throw new KeepFailedError(`the running daemon's file could not be copied to go back to (${failed})`)
}

/**
 * The kept file of the build that ran before (a file, with a stamp of its build), or null: of the
 * kept dir's and <daemon dir>/previous, the one stamped last (the other may be an older build's).
 */
export async function keptPrevious(daemonDir: string, binaryPath: string): Promise<{ file: string; version: string } | null> {
  await recoverPromote(daemonDir)
  let best: { file: string; version: string; at: number } | null = null
  for (const dir of keepDirs(daemonDir)) {
    const file = path.join(dir, path.basename(binaryPath))
    const stamped = await fsp.stat(`${file}.version`).catch(() => null)
    if (!stamped || (best && stamped.mtimeMs <= best.at)) continue
    const version = (await fsp.readFile(`${file}.version`, 'utf8').catch(() => '')).trim()
    if (version && await fsp.stat(file).then((st) => st.isFile(), () => false)) best = { file, version, at: stamped.mtimeMs }
  }
  return best && { file: best.file, version: best.version }
}

/**
 * Once a daemon binary served (not the source daemon, not the compiled walnut file), keep a
 * clone of the file beside a stamp of its build, so the next build's replacement has one to
 * go back to on a Mac, where a deploy removes the old file and /proc does not exist. A copy
 * where cloning is not supported; Linux reads /proc instead (previousDaemon). Best effort.
 */
export async function keepRunningBinary(o: { daemonDir: string; binaryPath: string; compiledSelf: boolean; version: string | null; platform?: string; durable?: boolean }): Promise<boolean> {
  return !!(await cloneRunningBinary(o)).kept
}

/**
 * The pending slot (`<keep dir>.next`, stamped in its `build` file): the files of a build on its
 * probation, kept beside the way back without taking its place, then made the way back once the
 * build passed (promotePending), or dropped (discardPending). 2026-11-04 review 6: the build was
 * kept only at its window's end, from the file on disk, which a deploy inside the 15 minutes had
 * replaced already: the way back silently became the build before it, or none. An older release
 * reads only the keep dirs, never this one.
 */
const NEXT_SUFFIX = '.next'
const NEXT_STAMP = 'build'

/** A clone of the binary that starts on its probation now (binaryPath while it still is `version`), in the pending slot. */
export async function keepPendingBinary(o: { daemonDir: string; binaryPath: string; compiledSelf: boolean; version: string; platform?: string; durable?: boolean }): Promise<boolean> {
  return !!(await cloneRunningBinary(o, 'next')).kept
}

/** The pending files of `version` become the way back (its probation passed). False: none of that build. */
export async function promotePending(daemonDir: string, version: string): Promise<boolean> {
  await recoverPromote(daemonDir)
  for (const keep of keepDirs(daemonDir)) {
    const next = `${keep}${NEXT_SUFFIX}`
    if ((await fsp.readFile(path.join(next, NEXT_STAMP), 'utf8').catch(() => '')).trim() !== version) continue
    const old = `${keep}.old`
    await fsp.rm(old, { recursive: true, force: true }).catch(() => {})
    try {
      await fsp.rename(keep, old).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      await fsp.rename(next, keep)
    } catch {
      await fsp.rename(old, keep).catch(() => {})
      return false
    }
    await fsp.rm(old, { recursive: true, force: true }).catch(() => {})
    return true
  }
  return false
}

/** The pending files of `version` (any build when not given) dropped: it did not pass, or no one knows. */
export async function discardPending(daemonDir: string, version?: string): Promise<void> {
  for (const keep of keepDirs(daemonDir)) {
    const next = `${keep}${NEXT_SUFFIX}`
    const was = (await fsp.readFile(path.join(next, NEXT_STAMP), 'utf8').catch(() => '')).trim()
    if (version === undefined || was === version) await fsp.rm(next, { recursive: true, force: true }).catch(() => {})
  }
}

/** keepRunningBinary's work: the file kept, or why not (failed: a copy that did not work; neither: not this build's file, or not one to clone). */
async function cloneRunningBinary(o: { daemonDir: string; binaryPath: string; compiledSelf: boolean; version: string | null; platform?: string; durable?: boolean }, slot: 'previous' | 'next' = 'previous'): Promise<{ kept: string | null; failed?: string }> {
  if (!o.version || (o.platform ?? process.platform) === 'linux' || o.binaryPath.endsWith('.cjs') || o.binaryPath.endsWith('.js')) return { kept: null }
  for (const dir of keepDirs(o.daemonDir)) {
    const file = path.join(dir, path.basename(o.binaryPath))
    if ((await fsp.readFile(`${file}.version`, 'utf8').catch(() => '')).trim() === o.version) return { kept: file }
  }
  // The compiled walnut file has no .version beside it: it is this server's build (the version
  // compiled into it) while the file is still the one the server started from (an npm update
  // writes a new file in its place).
  const sameBuild = o.compiledSelf
    ? async () => !!singleFile()?.execId && fileIdentity(o.binaryPath) === singleFile()?.execId && singleFile()?.daemonVersion === o.version
    : async () => (await fsp.readFile(`${o.binaryPath}.version`, 'utf8').catch(() => '')).trim() === o.version
  if (!(await sameBuild())) return { kept: null }
  let failed = ''
  for (const target of keepTargets(o.daemonDir, o.durable === true)) {
    const keep = slot === 'next' ? `${target}${NEXT_SUFFIX}` : target
    const kept = path.join(keep, path.basename(o.binaryPath))
    try {
      // The pending slot holds one build: whatever was there (another build's) goes first.
      if (slot === 'next') await fsp.rm(keep, { recursive: true, force: true })
      await fsp.mkdir(keep, { recursive: true, mode: 0o700 })
      await fsp.copyFile(o.binaryPath, `${kept}.tmp`, fs.constants.COPYFILE_FICLONE)
      // A deploy that replaced the file during the copy: what was copied is not that build.
      if (!(await sameBuild())) { await fsp.rm(`${kept}.tmp`, { force: true }).catch(() => {}); return { kept: null } }
      await fsp.chmod(`${kept}.tmp`, 0o700)
      await fsp.rm(`${kept}.version`, { force: true })
      await fsp.rename(`${kept}.tmp`, kept)
      await fsp.writeFile(`${kept}.version`, `${o.version}\n`, { mode: 0o600 })
      if (slot === 'next') await fsp.writeFile(path.join(keep, NEXT_STAMP), `${o.version}\n`, { mode: 0o600 })
      return { kept }
    } catch (error) {
      // It did not fit there (a quota, a full disk, no clone across disks): the next place.
      await fsp.rm(`${kept}.tmp`, { force: true }).catch(() => {})
      failed = error instanceof Error ? error.message : String(error)
    }
  }
  return { kept: null, failed }
}

/**
 * When a new build may replace the running daemon (LocalDaemon.refuseReplacement).
 *   check     'go' once its trial passed; 'wait' while the trial runs beside the old daemon
 *             (its end calls `retry`); else the reason it may not.
 *   refuse    a failed trial (asked again after LOCAL_REPLACE_RETRY_MS), or a build that
 *             passed it and did not start on the real dir (left alone until another build,
 *             or REAL_DIR_BACKOFF_MS).
 *   replaced  the replacement went ahead: the next build gets a trial of its own.
 */
export class ReplacementGate {
  private refused: { expected: string; at: number; reason: string; untilNewBuild: boolean } | null = null
  private trial: { expected: string; passed: boolean } | null = null
  private running: Promise<void> | null = null
  private loaded = false

  /**
   * `now` is the wall clock: refusals must run out in real time across sleep. `store` keeps a
   * real-dir refusal across server restarts (daemon-build-backoff.ts): a deploy restarted the
   * server, and the next start stopped the healthy daemon for the same build (2026-11-04 review).
   * A failed trial's 10 min stay in memory: after a restart the trial runs again, and a trial
   * stops nothing.
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly store?: { read(): Promise<BuildBackoffEntry | null>; write(entry: BuildBackoffEntry): Promise<void> },
  ) {}

  /** Once per process: the refusal kept from before a restart. */
  async load(): Promise<void> {
    if (this.loaded || !this.store) return
    this.loaded = true
    const kept = await this.store.read().catch(() => null)
    if (kept && !this.refused) this.refused = { expected: kept.expected, at: kept.at, reason: kept.reason, untilNewBuild: true }
  }

  /** `expected` is refused now (its trial failed lately, or it did not start on the real dir): the reason, else null. */
  refusedNow(expected: string): string | null {
    const r = this.refused
    if (!r || r.expected !== expected) return null
    return Math.abs(this.now() - r.at) < (r.untilNewBuild ? REAL_DIR_BACKOFF_MS : LOCAL_REPLACE_RETRY_MS) ? r.reason : null
  }

  /** The trial running beside the old daemon, with its retry called (tests and shutdown wait for it). */
  get pending(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  check(expected: string, run: () => Promise<string | null>, retry: () => void): 'go' | 'wait' | { refused: string } {
    const refused = this.refusedNow(expected)
    if (refused) return { refused }
    if (this.trial?.expected === expected) return this.trial.passed ? 'go' : 'wait'
    const trial = { expected, passed: false }
    this.trial = trial
    const running = this.running = (async () => {
      let reason: string | null
      try { reason = await run() } catch (error) {
        // mkdtemp on a full /tmp, EMFILE: no verdict on the build, and the old daemon keeps serving.
        reason = `the trial could not run (${error instanceof Error ? error.message : String(error)})`
      }
      if (this.trial !== trial) return
      if (reason) { this.trial = null; this.refuse(expected, reason, false) } else trial.passed = true
      retry()
    })()
    void running.finally(() => { if (this.running === running) this.running = null })
    return 'wait'
  }

  refuse(expected: string, reason: string, untilNewBuild: boolean): void {
    this.refused = { expected, at: this.now(), reason, untilNewBuild }
    if (untilNewBuild) void this.store?.write({ expected, at: this.refused.at, reason }).catch(() => {})
    // Its trial counts no more: once the refusal is over, the build is tried again from its trial,
    // not let straight through on the one it passed before (2026-11-04 review).
    if (this.trial?.expected === expected) this.trial = null
  }

  replaced(): void {
    this.trial = null
  }

  /**
   * The build refused until another build (its probation failed, or it did not start on the real
   * dir: the refusal kept on disk) while that refusal holds, else null. Call load() first.
   */
  refusedUntilNewBuild(): string | null {
    const r = this.refused
    return r && r.untilNewBuild && this.refusedNow(r.expected) ? r.expected : null
  }

  /** Why `expected` may not replace the daemon now, or null (for status and logs). */
  refusal(expected: string): string | null {
    const r = this.refused
    return r && r.expected === expected ? r.reason : null
  }
}
