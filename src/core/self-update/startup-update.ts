/**
 * Update on restart: `walnut web` installs a newer open-walnut BEFORE the server
 * starts, then starts again as the new code.
 *
 * Why at startup and never in the running server: dist/ is a few hundred
 * content-hashed chunks that the server imports lazily, so replacing the package
 * under a live process makes the next lazy import 404 (dev-prod.sh runs a staged
 * copy for the same reason). The one moment the install directory is not in use
 * is before listen, so that is when the install happens. The running server only
 * tells the user (update-check.ts); any restart applies.
 *
 * Who it applies to: an npm/pnpm/bun/yarn install whose directory this process
 * can write (a root-owned prefix gets the sudo hint and starts as it is), and
 * the compiled file in install.sh's versions layout (binary-install.ts, the
 * same swap a file update always is), with `updates.auto` not false in
 * config.yaml and WALNUT_NO_AUTO_UPDATE unset. A source checkout, a replica, a
 * Homebrew keg and the ephemeral servers never do this.
 *
 * Failure is never fatal: a registry that does not answer, an installer that
 * exits non-zero or cannot start, a file download that takes longer than a
 * minute all print one line and the old version starts. A signal while it runs
 * cleans up and starts nothing. The restarted process carries
 * WALNUT_UPDATE_APPLIED=1 so it starts without asking again, whatever the
 * registry says. One that exits non-zero before it listens is gone back from:
 * the old version is linked (or installed) again and starts, and the new one is
 * held back until a newer release (held-versions.ts). A launcher that updates
 * the install itself while the server runs (the Mac app) sets
 * WALNUT_LAUNCHER_UPDATES=1, and nothing here runs.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import type { UpdateStatus } from './update-check.js'
import { binaryLinkOf, managerArgv, runsCompiled, type BinaryInstall, type InstallInfo } from './install-kind.js'

export const APPLIED_ENV = 'WALNUT_UPDATE_APPLIED'
export const NO_AUTO_UPDATE_ENV = 'WALNUT_NO_AUTO_UPDATE'
/** Set by a launcher that updates the install itself while the server runs (the Mac app): no update before listen. */
export const LAUNCHER_UPDATES_ENV = 'WALNUT_LAUNCHER_UPDATES'
/** The file the restarted server writes once it listens (web.ts): it started, so its exit is no failure to start. */
export const READY_FILE_ENV = 'WALNUT_STARTUP_READY_FILE'
/**
 * How long the file's download and check may hold the start before the old
 * version starts instead. A launcher waits for the port (the Mac app 180 s);
 * `walnut update` has no such limit.
 */
export const STARTUP_UPDATE_BUDGET_MS = 60_000
/** The version gone back to, ended this soon without serving, failed to start too. */
const QUICK_EXIT_MS = 120_000

export type StartupUpdateDecision =
  | { action: 'skip'; reason: 'applied' | 'off' | 'launcher' | 'not-npm' | 'disabled' | 'unreachable' | 'current' | 'held' | 'not-writable' | 'no-manager'; note?: string }
  | { action: 'install'; version: string; argv: { file: string; args: string[] } }
  /** The compiled file's own update: download, check, swap the link (binary-install.ts). */
  | { action: 'install-file'; version: string; install: BinaryInstall }

export interface StartupUpdateInputs {
  /** config.yaml `updates.auto` (default true) after the env override. */
  auto: boolean
  /** This process just restarted after an install. */
  applied: boolean
  /** The install directory can be replaced by this process. */
  writable: boolean
  /** Why the published version is held back here (held-versions.ts), or null. */
  held?: string | null
}

export function autoUpdateEnabled(configAuto: boolean | undefined, env: Record<string, string | undefined>): boolean {
  const v = env[NO_AUTO_UPDATE_ENV]
  if (v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false') return false
  return configAuto !== false
}

/** Can this process replace the package? The package root and its parent (where the manager renames) must both be writable. */
export function installDirWritable(packageRoot: string | null, access: (p: string, mode: number) => void = fs.accessSync): boolean {
  if (!packageRoot) return false
  try {
    access(packageRoot, fs.constants.W_OK)
    access(path.dirname(packageRoot), fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Can this process swap a binary install's version? Its versions/ and bin/ must take new entries. */
export function binaryRootWritable(root: string, access: (p: string, mode: number) => void = fs.accessSync): boolean {
  try {
    for (const dir of [path.join(root, 'versions'), path.join(root, 'bin')]) access(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

export function decideStartupUpdate(status: UpdateStatus, inputs: StartupUpdateInputs): StartupUpdateDecision {
  if (inputs.applied) return { action: 'skip', reason: 'applied' }
  if (!inputs.auto) return { action: 'skip', reason: 'off' }
  const binary = status.install.kind === 'binary' ? status.install.binary ?? null : null
  if (status.install.kind !== 'npm' && !binary) return { action: 'skip', reason: 'not-npm' }
  if (!status.enabled) return { action: 'skip', reason: 'disabled', note: status.reason }
  if (!status.latest) return { action: 'skip', reason: 'unreachable', note: status.error ?? undefined }
  if (!status.available) return { action: 'skip', reason: 'current' }
  if (inputs.held) return { action: 'skip', reason: 'held', note: inputs.held }
  if (binary) {
    if (!inputs.writable) return { action: 'skip', reason: 'not-writable', note: `make ${binary.root} writable by this user, or run install.sh again as its owner` }
    return { action: 'install-file', version: status.latest, install: binary }
  }
  if (!status.install.manager) return { action: 'skip', reason: 'no-manager' }
  if (!inputs.writable) {
    return { action: 'skip', reason: 'not-writable', note: `sudo ${status.install.updateCommand ?? 'npm install -g open-walnut@latest'}` }
  }
  return { action: 'install', version: status.latest, argv: managerArgv(status.install.manager, `open-walnut@${status.latest}`, status.install.runtimePrefix) }
}

/** How a restarted server ended. */
export interface ReexecResult {
  exitCode: number
  /** It wrote its ready file: it listened before it exited. */
  served: boolean
  /** This parent passed it a signal: it was stopped, it did not fail. */
  stopped: boolean
  /** How long it ran. */
  ms: number
}

/** The start's own end: the time budget, or a signal to this process. */
export interface UpdateStop {
  signal: AbortSignal
  /** The signal that arrived, or null (the budget ran out, or nothing happened). */
  received: () => NodeJS.Signals | null
  /** Stop listening, before the server or the restarted one takes the signals. */
  done: () => void
}

/** Watch for the budget (none when null) and for SIGINT/SIGTERM/SIGHUP while an update runs. */
export function watchStop(budgetMs: number | null = STARTUP_UPDATE_BUDGET_MS): UpdateStop {
  const controller = new AbortController()
  let received: NodeJS.Signals | null = null
  const timer = budgetMs === null ? null : setTimeout(() => controller.abort(new Error(`it took longer than ${Math.round(budgetMs / 1000)} s`)), budgetMs)
  timer?.unref?.()
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((sig) => {
    const fn = () => { received ??= sig; controller.abort(new Error(`stopped by ${sig}`)) }
    process.on(sig, fn)
    return [sig, fn] as const
  })
  return {
    signal: controller.signal,
    received: () => received,
    done: () => { if (timer) clearTimeout(timer); for (const [sig, fn] of handlers) process.off(sig, fn) },
  }
}

export interface StartupUpdateDeps {
  checkNow: () => Promise<UpdateStatus>
  configAuto: () => Promise<boolean | undefined>
  env: Record<string, string | undefined>
  writable: (packageRoot: string | null) => boolean
  /** Can a binary install's root take the new version? (Default: binaryRootWritable.) */
  binaryWritable?: (root: string) => boolean
  /** Why the published version is held back here (held-versions.ts), or null. */
  held?: (status: UpdateStatus) => string | null
  /** The installer with inherited stdio; resolves to its exit code. A signal to this process is passed on to it. */
  run: (file: string, args: string[], stop?: UpdateStop) => Promise<number>
  /** The file's own update (binary-install.ts installFileVersion); throws with the reason. Resolves to the version it replaced. */
  installFile?: (install: BinaryInstall, version: string, signal: AbortSignal) => Promise<{ from: string | null } | void>
  /** What the install's relaunch prints for `--version`, or null when it does not run. */
  versionOf?: (install: InstallInfo) => Promise<string | null>
  /** Point the install back at `from` after `to` failed to start, and hold `to` back. Throws when it cannot. */
  rollBack?: (status: UpdateStatus, from: string, to: string, reason: string) => Promise<void>
  /** `to` was not the cause after all: undo rollBack. */
  undoRollBack?: (status: UpdateStatus, to: string) => Promise<void>
  /** Start this same command again as the new code. */
  reexec: (env: Record<string, string | undefined>, install: InstallInfo) => Promise<ReexecResult>
  /** The budget and the signals (default: watchStop()). */
  watch?: () => UpdateStop
  err: (line: string) => void
}

export type StartupUpdateOutcome =
  /** Start the server in this process. */
  | { kind: 'continue'; decision: StartupUpdateDecision; installFailed?: string }
  /** The new code ran in a child and has exited; this process ends with its code. */
  | { kind: 'reexeced'; version: string; exitCode: number; rolledBackFrom?: string }
  /** A signal arrived while the update ran: it cleaned up, and nothing starts. */
  | { kind: 'stopped'; signal: NodeJS.Signals }

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const failedToStart = (r: ReexecResult): boolean => r.exitCode !== 0 && !r.served && !r.stopped

export async function updateOnStart(deps: StartupUpdateDeps): Promise<StartupUpdateOutcome> {
  const applied = deps.env[APPLIED_ENV] === '1'
  if (applied) return { kind: 'continue', decision: { action: 'skip', reason: 'applied' } }
  if (deps.env[LAUNCHER_UPDATES_ENV] === '1') return { kind: 'continue', decision: { action: 'skip', reason: 'launcher' } }
  const auto = autoUpdateEnabled(await deps.configAuto().catch(() => undefined), deps.env)
  // Nothing to ask when the answer cannot lead to an install: no registry call at all.
  if (!auto) return { kind: 'continue', decision: { action: 'skip', reason: 'off' } }
  const status = await deps.checkNow()
  const binary = status.install.kind === 'binary' ? status.install.binary ?? null : null
  const writable = binary ? (deps.binaryWritable ?? binaryRootWritable)(binary.root) : deps.writable(status.install.packageRoot)
  const held = status.available && status.latest ? deps.held?.(status) ?? null : null
  const decision = decideStartupUpdate(status, { auto, applied, writable, held })
  if (decision.action === 'skip') {
    if (decision.reason === 'not-writable') {
      const what = binary ? 'Fix it: ' : 'Run: '
      deps.err(`Open Walnut ${status.latest} is published, but this install is not writable by this user. ${what}${decision.note}`)
    }
    if (decision.reason === 'held') deps.err(`Open Walnut ${status.latest} is published, but ${decision.note}. Starting ${status.current}.`)
    return { kind: 'continue', decision }
  }
  deps.err(`Open Walnut ${decision.version} is published (this is ${status.current}); installing it before starting. Set updates.auto: false in config.yaml or ${NO_AUTO_UPDATE_ENV}=1 to start without updating.`)
  const stop = (deps.watch ?? watchStop)()
  let from: string | null = status.current
  try {
    if (decision.action === 'install-file') {
      try {
        if (!deps.installFile) throw new Error('this build cannot update its file')
        const done = await deps.installFile(decision.install, decision.version, stop.signal)
        if (done && 'from' in done) from = done.from
      } catch (e) {
        const signal = stop.received()
        if (signal) return { kind: 'stopped', signal }
        const message = stop.signal.aborted ? `${messageOf(stop.signal.reason)}; \`walnut update\` installs it without a limit` : messageOf(e)
        deps.err(`Could not install ${decision.version} (${message}); starting ${status.current} as it is.`)
        return { kind: 'continue', decision, installFailed: message }
      }
    } else {
      let code: number
      try {
        code = await deps.run(decision.argv.file, decision.argv.args, stop)
      } catch (e) {
        const message = messageOf(e)
        deps.err(`Could not run ${decision.argv.file} (${message}); starting ${status.current} as it is.`)
        return { kind: 'continue', decision, installFailed: message }
      }
      const signal = stop.received()
      if (signal) return { kind: 'stopped', signal }
      if (code !== 0) {
        deps.err(`${decision.argv.file} exited with ${code}; starting ${status.current} as it is.`)
        return { kind: 'continue', decision, installFailed: `exit ${code}` }
      }
      const problem = await confirmNpmInstall({ ...deps, status, version: decision.version, argv: decision.argv, stop })
      if (problem) return { kind: 'continue', decision, installFailed: problem }
    }
    const signal = stop.received()
    if (signal) return { kind: 'stopped', signal }
  } finally {
    stop.done()
  }
  deps.err(`Installed Open Walnut ${decision.version}; starting it.`)
  return startInstalled(deps, status, decision.version, from)
}

/**
 * After an npm install: does the install's relaunch start `version` now? npm
 * can finish without the platform package (optional dependencies turned off,
 * a registry mirror that lags), and the launcher alone runs nothing. One more
 * install, then the old version goes back. Resolves to null when the new
 * version starts, else what went wrong.
 */
export async function confirmNpmInstall(o: {
  status: UpdateStatus
  version: string
  argv: { file: string; args: string[] }
  run: StartupUpdateDeps['run']
  versionOf?: StartupUpdateDeps['versionOf']
  stop?: UpdateStop
  err: (line: string) => void
}): Promise<string | null> {
  if (!o.versionOf) return null
  let printed = await o.versionOf(o.status.install)
  if (printed?.split(/\s/)[0] === o.version) return null
  o.err(`The installed launcher does not start ${o.version} (it printed: ${printed || 'nothing'}); installing it once more.`)
  const again = await o.run(o.argv.file, o.argv.args, o.stop)
  if (again === 0) {
    printed = await o.versionOf(o.status.install)
    if (printed?.split(/\s/)[0] === o.version) return null
  }
  const problem = again === 0 ? `it still starts ${printed || 'nothing'}` : `${o.argv.file} exited with ${again}`
  const manager = o.status.install.manager
  if (!manager) {
    o.err(`Open Walnut ${o.version} did not install its file for this machine (${problem}).`)
    return problem
  }
  const back = managerArgv(manager, `open-walnut@${o.status.current}`, o.status.install.runtimePrefix)
  const code = await o.run(back.file, back.args).catch(() => -1)
  o.err(code === 0
    ? `Open Walnut ${o.version} did not install its file for this machine (${problem}); ${o.status.current} is back.`
    : `Open Walnut ${o.version} did not install its file for this machine (${problem}), and putting ${o.status.current} back failed. Run: ${back.file} ${back.args.join(' ')}`)
  return problem
}

/**
 * Start the new version. One that exits non-zero before it serves is gone back
 * from: the install points at `from` again, the new version is held back until
 * a newer release, and `from` starts. When `from` fails to start as well, the
 * new version was not the cause, and that is undone.
 */
async function startInstalled(deps: StartupUpdateDeps, status: UpdateStatus, version: string, from: string | null): Promise<StartupUpdateOutcome> {
  const env = { ...deps.env, [APPLIED_ENV]: '1' }
  const first = await deps.reexec(env, status.install)
  if (!failedToStart(first) || !from || from === version || !deps.rollBack) return { kind: 'reexeced', version, exitCode: first.exitCode }
  const reason = `exited with ${first.exitCode} before it served`
  deps.err(`Open Walnut ${version} ${reason}; going back to ${from}. ${version} is skipped until a newer release is published.`)
  try {
    await deps.rollBack(status, from, version, reason)
  } catch (e) {
    deps.err(`Could not go back to ${from} (${messageOf(e)}).`)
    return { kind: 'reexeced', version, exitCode: first.exitCode }
  }
  const second = await deps.reexec(env, status.install)
  if (failedToStart(second) && second.ms < QUICK_EXIT_MS) {
    deps.err(`Open Walnut ${from} did not start either, so ${version} was not the cause; the next start runs ${version} again.`)
    await deps.undoRollBack?.(status, version).catch((e) => deps.err(`Could not undo going back (${messageOf(e)}).`))
  }
  return { kind: 'reexeced', version: from, exitCode: second.exitCode, rolledBackFrom: version }
}

/**
 * The startup update as `walnut web` runs it: this process's own install
 * (install-kind.ts), the registry's answer, npm or the file's own installer,
 * and the restart. `configAuto` reads config.yaml's `updates.auto`.
 */
export async function runStartupUpdate(configAuto: () => Promise<boolean | undefined>): Promise<StartupUpdateOutcome> {
  const { UpdateChecker } = await import('./update-check.js')
  const { installFileVersion, registryBaseFor, rollBack, undoRollBack } = await import('./binary-install.js')
  const { badDirFor, clearBad, heldBack, markBad } = await import('./held-versions.js')
  const { WALNUT_HOME } = await import('../../constants.js')
  const err = (line: string) => { process.stderr.write(`${line}\n`) }
  return updateOnStart({
    checkNow: () => new UpdateChecker().checkNow(),
    configAuto,
    env: process.env,
    writable: installDirWritable,
    held: (status) => heldBack(status.install, status.latest!, badDirFor(status.install, WALNUT_HOME)),
    run: runInherited,
    installFile: async (install, version, signal) => {
      const done = await installFileVersion({ install, version, registry: registryBaseFor(process.env.WALNUT_UPDATE_REGISTRY_URL), log: err, signal })
      return { from: done.from }
    },
    versionOf: relaunchVersion,
    rollBack: async (status, from, to, reason) => {
      const binary = status.install.kind === 'binary' ? status.install.binary : null
      if (binary) return rollBack(binary.root, from, to, reason)
      const dir = badDirFor(status.install, WALNUT_HOME)
      if (!status.install.manager || !dir) throw new Error('no package manager to go back with')
      markBad(dir, to, reason)
      const back = managerArgv(status.install.manager, `open-walnut@${from}`, status.install.runtimePrefix)
      const code = await runInherited(back.file, back.args)
      if (code !== 0) throw new Error(`${back.file} exited with ${code}; run: ${back.file} ${back.args.join(' ')}`)
    },
    undoRollBack: async (status, to) => {
      const binary = status.install.kind === 'binary' ? status.install.binary : null
      if (binary) return undoRollBack(binary.root, to)
      clearBad(badDirFor(status.install, WALNUT_HOME), to)
    },
    reexec: reexecSelf,
    err,
  })
}

/** The installer, in the terminal (or the service log): the user sees npm's own progress. A signal to this process goes on to it. */
export function runInherited(file: string, args: string[], stop?: UpdateStop): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit' })
    const pass = () => { const sig = stop?.received(); if (sig && child.exitCode === null) child.kill(sig) }
    stop?.signal.addEventListener('abort', pass, { once: true })
    child.on('error', (e) => { stop?.signal.removeEventListener('abort', pass); reject(e) })
    child.on('exit', (code, signal) => {
      stop?.signal.removeEventListener('abort', pass)
      resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 0))
    })
  })
}

/** What the install's relaunch (the command a restart runs) prints for `--version`, or null. */
export function relaunchVersion(install: InstallInfo): Promise<string | null> {
  const { file, args } = relaunchArgv(install, [process.argv[0] ?? '', process.argv[1] ?? '', '--version'])
  const env = { ...process.env }
  for (const key of [APPLIED_ENV, READY_FILE_ENV, 'BUN_BE_BUN']) delete env[key]
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: 60_000, encoding: 'utf8' }, (e, stdout) => resolve(e ? null : stdout.trim()))
  })
}

/**
 * The command that starts this install again as its newest code: the install's
 * own relaunch (the npm launcher, which finds the new platform package; a binary
 * install's `bin/walnut` link, now pointing at the new version) with this
 * process's arguments, else this process's own command line: a script runtime
 * with argv[1], the bin shim's path, which an install replaces in place; the
 * compiled file without it. Both keep their user's arguments from argv[2] on.
 */
export function relaunchArgv(install: Pick<InstallInfo, 'relaunch' | 'binary'> | null, argv: string[] = process.argv, execPath = process.execPath): { file: string; args: string[] } {
  const relaunch = install?.relaunch?.length ? install.relaunch : install?.binary ? [binaryLinkOf(install.binary.root)] : null
  if (relaunch) return { file: relaunch[0]!, args: [...relaunch.slice(1), ...argv.slice(2)] }
  // The compiled file's argv[1] is its own entry inside it, which it adds again itself.
  return { file: execPath, args: argv.slice(runsCompiled(argv) ? 2 : 1) }
}

/**
 * Run this install again (relaunchArgv) and stay alive as a thin parent:
 * signals are forwarded, and the result says whether it served first.
 */
export function reexecSelf(env: Record<string, string | undefined>, install: InstallInfo | null = null): Promise<ReexecResult> {
  return new Promise((resolve) => {
    const { file, args } = relaunchArgv(install)
    const ready = path.join(os.tmpdir(), `walnut-ready-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
    const started = Date.now()
    let stopped = false
    let ended = false
    const child = spawn(file, args, { stdio: 'inherit', env: { ...env, [READY_FILE_ENV]: ready } })
    const forward = (signal: NodeJS.Signals) => () => {
      stopped = true
      if (child.exitCode === null && child.signalCode === null) child.kill(signal)
    }
    const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((sig) => [sig, forward(sig)] as const)
    for (const [sig, fn] of handlers) process.on(sig, fn)
    const finish = (exitCode: number) => {
      if (ended) return
      ended = true
      for (const [sig, fn] of handlers) process.off(sig, fn)
      const served = fs.existsSync(ready)
      fs.rmSync(ready, { force: true })
      resolve({ exitCode, served, stopped, ms: Date.now() - started })
    }
    child.on('exit', (code, signal) => finish(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 0)))
    child.on('error', () => finish(1))
  })
}
