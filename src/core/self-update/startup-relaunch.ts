/**
 * The restart after a startup update (startup-update.ts): this same command
 * again, as the install's newest code, with this process staying alive as a
 * thin parent that forwards signals and tells whether the child served.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { binaryLinkOf, runsCompiled, type InstallInfo } from './install-kind.js'

/** Set on the restarted process: it starts without asking the registry again. */
export const APPLIED_ENV = 'WALNUT_UPDATE_APPLIED'
/** The file the restarted server writes once it listens (web.ts): it started, so its exit is no failure to start. */
export const READY_FILE_ENV = 'WALNUT_STARTUP_READY_FILE'

export interface ReexecResult {
  exitCode: number
  /** It wrote its ready file: it listened before it exited. */
  served: boolean
  /** This parent passed it a signal: it was stopped, it did not fail. */
  stopped: boolean
  /** How long it ran. */
  ms: number
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
