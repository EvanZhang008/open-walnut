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
 * can write (a root-owned prefix gets the sudo hint and starts as it is), with
 * `updates.auto` not false in config.yaml and WALNUT_NO_AUTO_UPDATE unset. A
 * source checkout, a replica and the ephemeral servers never do this.
 *
 * Failure is never fatal: a registry that does not answer, an installer that
 * exits non-zero or cannot start all print one line and the old version starts.
 * The restarted process carries WALNUT_UPDATE_APPLIED=1 so it starts without
 * asking again, whatever the registry says.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { UpdateStatus } from './update-check.js'
import { managerArgv } from './install-kind.js'

export const APPLIED_ENV = 'WALNUT_UPDATE_APPLIED'
export const NO_AUTO_UPDATE_ENV = 'WALNUT_NO_AUTO_UPDATE'

export type StartupUpdateDecision =
  | { action: 'skip'; reason: 'applied' | 'off' | 'not-npm' | 'disabled' | 'unreachable' | 'current' | 'not-writable' | 'no-manager'; note?: string }
  | { action: 'install'; version: string; argv: { file: string; args: string[] } }

export interface StartupUpdateInputs {
  /** config.yaml `updates.auto` (default true) after the env override. */
  auto: boolean
  /** This process just restarted after an install. */
  applied: boolean
  /** The install directory can be replaced by this process. */
  writable: boolean
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

export function decideStartupUpdate(status: UpdateStatus, inputs: StartupUpdateInputs): StartupUpdateDecision {
  if (inputs.applied) return { action: 'skip', reason: 'applied' }
  if (!inputs.auto) return { action: 'skip', reason: 'off' }
  if (status.install.kind !== 'npm') return { action: 'skip', reason: 'not-npm' }
  if (!status.enabled) return { action: 'skip', reason: 'disabled', note: status.reason }
  if (!status.latest) return { action: 'skip', reason: 'unreachable', note: status.error ?? undefined }
  if (!status.available) return { action: 'skip', reason: 'current' }
  if (!status.install.manager) return { action: 'skip', reason: 'no-manager' }
  if (!inputs.writable) {
    return { action: 'skip', reason: 'not-writable', note: `sudo ${status.install.updateCommand ?? 'npm install -g open-walnut@latest'}` }
  }
  return { action: 'install', version: status.latest, argv: managerArgv(status.install.manager, `open-walnut@${status.latest}`) }
}

export interface StartupUpdateDeps {
  checkNow: () => Promise<UpdateStatus>
  configAuto: () => Promise<boolean | undefined>
  env: Record<string, string | undefined>
  writable: (packageRoot: string | null) => boolean
  /** The installer with inherited stdio; resolves to its exit code. */
  run: (file: string, args: string[]) => Promise<number>
  /** Start this same command again as the new code; resolves to its exit code. */
  reexec: (env: Record<string, string | undefined>) => Promise<number>
  err: (line: string) => void
}

export type StartupUpdateOutcome =
  /** Start the server in this process. */
  | { kind: 'continue'; decision: StartupUpdateDecision; installFailed?: string }
  /** The new code ran in a child and has exited; this process ends with its code. */
  | { kind: 'reexeced'; version: string; exitCode: number }

export async function updateOnStart(deps: StartupUpdateDeps): Promise<StartupUpdateOutcome> {
  const applied = deps.env[APPLIED_ENV] === '1'
  const auto = autoUpdateEnabled(await deps.configAuto().catch(() => undefined), deps.env)
  // Nothing to ask when the answer cannot lead to an install: no registry call at all.
  if (applied || !auto) return { kind: 'continue', decision: { action: 'skip', reason: applied ? 'applied' : 'off' } }
  const status = await deps.checkNow()
  const decision = decideStartupUpdate(status, { auto, applied, writable: deps.writable(status.install.packageRoot) })
  if (decision.action === 'skip') {
    if (decision.reason === 'not-writable') {
      deps.err(`Open Walnut ${status.latest} is published, but this install is not writable by this user. Run: ${decision.note}`)
    }
    return { kind: 'continue', decision }
  }
  deps.err(`Open Walnut ${decision.version} is published (this is ${status.current}); installing it before starting. Set updates.auto: false in config.yaml or ${NO_AUTO_UPDATE_ENV}=1 to start without updating.`)
  let code: number
  try {
    code = await deps.run(decision.argv.file, decision.argv.args)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    deps.err(`Could not run ${decision.argv.file} (${message}); starting ${status.current} as it is.`)
    return { kind: 'continue', decision, installFailed: message }
  }
  if (code !== 0) {
    deps.err(`${decision.argv.file} exited with ${code}; starting ${status.current} as it is.`)
    return { kind: 'continue', decision, installFailed: `exit ${code}` }
  }
  deps.err(`Installed Open Walnut ${decision.version}; starting it.`)
  const exitCode = await deps.reexec({ ...deps.env, [APPLIED_ENV]: '1' })
  return { kind: 'reexeced', version: decision.version, exitCode }
}

/** The installer, in the terminal (or the service log): the user sees npm's own progress. */
export function runInherited(file: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}

/**
 * Run this process's own command line again (the bin shim now resolves to the
 * new package) and stay alive as a thin parent: signals are forwarded, the exit
 * code comes back. argv[1] is the shim's path, which an install replaces in place.
 */
export function reexecSelf(env: Record<string, string | undefined>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit', env })
    const forward = (signal: NodeJS.Signals) => () => { if (child.exitCode === null) child.kill(signal) }
    const onInt = forward('SIGINT')
    const onTerm = forward('SIGTERM')
    const onHup = forward('SIGHUP')
    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)
    process.on('SIGHUP', onHup)
    child.on('exit', (code, signal) => {
      process.off('SIGINT', onInt)
      process.off('SIGTERM', onTerm)
      process.off('SIGHUP', onHup)
      resolve(code ?? (signal ? 1 : 0))
    })
    child.on('error', () => resolve(1))
  })
}
