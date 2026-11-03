/**
 * The thin parent that restarts Walnut into an update (live-update.ts).
 *
 * A server started by a thin parent of this version (WALNUT_RESTART_SUPERVISED=1)
 * restarts by exiting with RESTART_EXIT_CODE (75); the parent then runs the
 * startup update path again, which finds the install record a live install
 * wrote (update-unverified.json), starts the new version, watches its first
 * start and goes back when it fails, and it loops for as long as its child
 * keeps asking. Two parents loop: the one a startup update leaves behind, and a
 * `walnut web` whose install can live-update (live-eligible.ts), which never
 * runs the server itself and starts it as its child from the start. A server
 * neither started has no way to restart: its install waits for the next start.
 *
 * Signals: while a child runs, reexecSelf passes SIGINT/SIGTERM/SIGHUP on and
 * this process ends with the child's code; one that arrives between children
 * stops the loop before it starts another. Nothing here signals anything itself.
 */

import os from 'node:os'
import type { StartupUpdateOutcome } from './startup-update.js'
import { APPLIED_ENV, READY_FILE_ENV, RESTART_EXIT_CODE, RESTART_SUPERVISED_ENV, type ReexecResult } from './startup-relaunch.js'

export { RESTART_EXIT_CODE, RESTART_SUPERVISED_ENV }

/** More restarts than this inside RESTART_STORM_MS is a child that asks for ever: stop. */
const RESTART_STORM_COUNT = 5
const RESTART_STORM_MS = 10 * 60 * 1000

/** web.ts, at the top: was this process started by a looping parent? The variable goes, so no session or child inherits it. */
export function takeRestartSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  const supervised = env[RESTART_SUPERVISED_ENV] === '1'
  delete env[RESTART_SUPERVISED_ENV]
  return supervised
}

export interface SignalRecorder {
  /** The first stop signal since recording began, or null. */
  received: () => NodeJS.Signals | null
  done: () => void
}

/**
 * Remember SIGINT/SIGTERM/SIGHUP, never act on them: the loop reads it between
 * steps, and a running child gets them from reexecSelf.
 */
export function recordSignals(): SignalRecorder {
  let received: NodeJS.Signals | null = null
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((sig) => {
    const fn = () => { received ??= sig }
    process.on(sig, fn)
    return [sig, fn] as const
  })
  return { received: () => received, done: () => { for (const [sig, fn] of handlers) process.off(sig, fn) } }
}

const signalCode = (sig: NodeJS.Signals): number => 128 + (os.constants.signals[sig] ?? 0)

export interface SuperviseDeps {
  /** The startup update path again (runStartupUpdate): may start the new version itself, watched. */
  update: () => Promise<StartupUpdateOutcome>
  /** Start the install's current version as a child and wait for it (reexecSelf); `readyAlso`: a parent's ready file to pass its listening on to. */
  start: (env: Record<string, string | undefined>, readyAlso?: string) => Promise<ReexecResult>
  /** The child's env, RESTART_SUPERVISED_ENV set. */
  env: Record<string, string | undefined>
  signals: SignalRecorder
  err: (line: string) => void
  now?: () => number
}

/**
 * Loop while the child's exit is RESTART_EXIT_CODE; resolves to the code this
 * process ends with (the last child's, or the signal's).
 */
export async function superviseRestarts(firstCode: number, deps: SuperviseDeps): Promise<number> {
  const now = deps.now ?? Date.now
  const recent: number[] = []
  let code = firstCode
  while (code === RESTART_EXIT_CODE) {
    const before = deps.signals.received()
    if (before) return signalCode(before)
    const at = now()
    while (recent.length && at - recent[0]! > RESTART_STORM_MS) recent.shift()
    recent.push(at)
    if (recent.length > RESTART_STORM_COUNT) {
      deps.err(`Walnut asked to restart ${recent.length} times in ${Math.round(RESTART_STORM_MS / 60_000)} minutes; not starting it again.`)
      return 1
    }
    deps.err('Walnut is restarting into its update.')
    const outcome = await deps.update()
    if (outcome.kind === 'stopped') return signalCode(outcome.signal)
    if (outcome.kind === 'reexeced') {
      code = outcome.exitCode
    } else {
      const sig = deps.signals.received()
      if (sig) return signalCode(sig)
      code = (await deps.start({ ...deps.env, [APPLIED_ENV]: '1' })).exitCode
    }
    // Stopped by a person while it ran: never start it again, whatever it exited with.
    if (deps.signals.received()) return code === RESTART_EXIT_CODE ? 0 : code
  }
  return code
}

/**
 * The version the install runs now, for a loop parent that may be older than it:
 * what the install's relaunch prints, else the version the live install recorded
 * (a relaunch that prints nothing must not read as "this parent's version", which
 * would drop that record and with it the watch and the rollback).
 */
export function loopCurrent(printed: string | null | undefined, pending: { version: string } | null, valid: (v: string) => boolean): string | undefined {
  const word = printed?.split(/\s/)[0]
  if (word && valid(word)) return word
  return pending?.version
}

/**
 * A supervisor from the start (web.ts, an install that can live-update): the
 * server never runs in this process. Its first child starts as the startup update
 * left things (APPLIED: that update already ran here), then the loop.
 */
export async function superviseFromStart(deps: SuperviseDeps, readyAlso?: string): Promise<number> {
  const before = deps.signals.received()
  if (before) return signalCode(before)
  const first = await deps.start({ ...deps.env, [APPLIED_ENV]: '1' }, readyAlso)
  if (deps.signals.received()) return first.exitCode === RESTART_EXIT_CODE ? 0 : first.exitCode
  return superviseRestarts(first.exitCode, deps)
}

/**
 * The env every child of the supervisor starts with: the boot env, marked
 * supervised, without this process's own update marker or a parent's ready file
 * (the supervisor writes that one itself once its child listens).
 */
export function supervisedChildEnv(baseEnv: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv, [RESTART_SUPERVISED_ENV]: '1' }
  delete env[APPLIED_ENV]
  delete env[READY_FILE_ENV]
  return env
}

/**
 * The loop as web.ts runs it. `baseEnv`: the env this `walnut web` started with
 * (web.ts keeps a copy), minus the restart marker of an earlier start, plus the
 * supervision marker. `fromStart`: start the first child here (superviseFromStart),
 * passing its listening on to `readyAlso`; else `firstCode` is a child's exit.
 */
export async function superviseWalnut(
  configAuto: () => Promise<boolean | undefined>,
  o: { baseEnv: Record<string, string | undefined>; firstCode?: number; readyAlso?: string },
): Promise<number> {
  const signals = recordSignals()
  const { runStartupUpdate } = await import('./startup-update-run.js')
  const { reexecSelf, relaunchVersion } = await import('./startup-relaunch.js')
  const { detectInstall } = await import('./install-kind.js')
  const { parseVersion } = await import('./version-compare.js')
  const { readUnverified } = await import('./background-install.js')
  const { WALNUT_HOME } = await import('../../constants.js')
  const path = await import('node:path')
  const env = supervisedChildEnv(o.baseEnv)
  const deps: SuperviseDeps = {
    update: async () => {
      const printed = await relaunchVersion(detectInstall()).catch(() => null)
      const pending = readUnverified(path.join(WALNUT_HOME, 'local', 'update-unverified.json'))
      const current = loopCurrent(printed, pending, (v) => parseVersion(v) !== null)
      return runStartupUpdate(configAuto, { env, current, stopSignal: signals.received })
    },
    start: (childEnv, readyAlso) => reexecSelf(childEnv, detectInstall(), { readyAlso }),
    env,
    signals,
    err: (line) => { process.stderr.write(`${line}\n`) },
  }
  try {
    return o.firstCode === undefined ? await superviseFromStart(deps, o.readyAlso) : await superviseRestarts(o.firstCode, deps)
  } finally {
    signals.done()
  }
}

/** Load what the loop runs now, while the install directory still holds this version's files. */
export async function preloadRestartLoop(): Promise<void> {
  await Promise.all([
    import('./startup-update.js'), import('./startup-update-run.js'), import('./startup-relaunch.js'), import('./install-kind.js'),
    import('./version-compare.js'), import('./update-check.js'), import('./binary-install.js'), import('./held-versions.js'),
    import('./background-install.js'), import('../../constants.js'), import('../config-manager.js'),
  ])
}
