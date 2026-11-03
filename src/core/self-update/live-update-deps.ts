/**
 * The live update's real installers and readers (live-update.ts), the same
 * machinery the startup update uses once its budget runs out
 * (startup-update.ts runStartupUpdate):
 *
 *   - the compiled file in install.sh's layout: installFileVersion (download,
 *     check, swap the link under the root's update lock);
 *   - npm (pnpm, bun, yarn) of the compiled file: the release fetched into the
 *     cache first, then the install, detached with its output in a file and a
 *     record so no second npm runs into the same prefix; then the install's
 *     relaunch must print the new version.
 *
 * Who may install live: live-eligible.ts.
 */

import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { getConfig } from '../config-manager.js'
import {
  installRunning, noteInstalledInBackground, installedInBackground, platformSpecFor, prefetchArgv,
  readUnverified, sequenceArgv, startDetachedInstall, writeUnverified,
} from './background-install.js'
import { installFileVersion, registryBaseFor, versionInUse } from './binary-install.js'
import { lockHolder } from './install-lock.js'
import { badDirFor, clearBad, heldBack } from './held-versions.js'
import { managerArgv } from './install-kind.js'
import { canSelfInstallLive } from './live-eligible.js'
import type { LiveUpdateDeps } from './live-update.js'
import { relaunchVersion } from './startup-relaunch.js'
import { countInProcessTurns } from './idle-gate.js'
import { getUpdateChecker, type UpdateStatus } from './update-check.js'
import { isNewer } from './version-compare.js'

const RECORD = () => path.join(WALNUT_HOME, 'local', 'update-installing.json')
const UNVERIFIED = () => path.join(WALNUT_HOME, 'local', 'update-unverified.json')
const INSTALL_LOG = () => path.join(WALNUT_HOME, 'local', 'update-install.log')

/** The npm install of `version`, detached, as the startup update runs it past its budget. */
async function installNpm(status: UpdateStatus, version: string): Promise<{ from: string | null }> {
  const manager = status.install.manager
  if (!manager) throw new Error('no package manager installed this Walnut')
  const argv = managerArgv(manager, `open-walnut@${version}`, status.install.runtimePrefix)
  const ahead = prefetchArgv(argv, `open-walnut@${version}`, platformSpecFor(process.execPath, version))
  const job = sequenceArgv(ahead ? [ahead, argv] : [argv])
  const run = startDetachedInstall(job.file, job.args, { logFile: INSTALL_LOG(), record: RECORD(), version, tail: () => {} })
  run.quiet() // nobody waits at a terminal: its output stays in update-install.log
  const code = await run.done
  if (code !== 0) throw new Error(`${argv.file} exited with ${code} (see ${INSTALL_LOG()})`)
  const printed = await relaunchVersion(status.install)
  if (printed?.split(/\s/)[0] !== version) {
    throw new Error(`the installed launcher does not start ${version} (it printed: ${printed || 'nothing'})`)
  }
  return { from: status.current }
}

/** When this process started: an in-process turn recorded before it is a dead server's. */
const PROCESS_STARTED_MS = Date.now() - process.uptime() * 1000

async function countRunningTurns(): Promise<number> {
  const { getActiveSessionsByHost, listNonTerminalSessions } = await import('../session-tracker.js')
  const byHost = await getActiveSessionsByHost()
  const cli = Object.values(byHost).reduce((n, list) => n + list.length, 0)
  // Embedded and SDK turns run inside this server (no daemon keeps them): a restart cuts them.
  return cli + countInProcessTurns(await listNonTerminalSessions(), PROCESS_STARTED_MS)
}

/** Someone else installing: an earlier start's npm, or a live holder of the file's update lock. */
async function installBusy(): Promise<string | null> {
  const job = await installRunning(RECORD())
  if (job) return `the install of ${job.version} an earlier start began still runs (pid ${job.pid})`
  const status = getUpdateChecker().status()
  const root = status.install.kind === 'binary' ? status.install.binary?.root : null
  if (!root) return null
  // The supervisor's startup download that outlived its budget holds this lock, as install.sh does.
  const pid = await lockHolder(root)
  return pid === null ? null : `an update of ${root} is running${pid ? ` (pid ${pid})` : ''}`
}

export function realLiveUpdateDeps(onChange: () => void): LiveUpdateDeps {
  const env = process.env
  return {
    now: Date.now,
    status: () => getUpdateChecker().status(),
    configAuto: async () => (await getConfig()).updates?.auto,
    env,
    canSelfInstall: (status) => canSelfInstallLive(status, env),
    held: (status) => (status.latest ? heldBack(status.install, status.latest, badDirFor(status.install, WALNUT_HOME)) : null),
    busy: installBusy,
    unverified: () => readUnverified(UNVERIFIED()),
    install: async (status, version, asked) => {
      const binary = status.install.kind === 'binary' ? status.install.binary : null
      let done: { from: string | null }
      if (binary) {
        const r = await installFileVersion({
          install: binary, version, registry: registryBaseFor(env.WALNUT_UPDATE_REGISTRY_URL),
          log: (line) => log.web.info(`live update: ${line}`),
        })
        done = { from: r.from }
      } else {
        done = await installNpm(status, version)
      }
      // The person asked for this version: a mark that held it back goes (as `walnut update` does).
      if (asked) clearBad(badDirFor(status.install, WALNUT_HOME), version)
      return done
    },
    markUnverified: (pending) => writeUnverified(UNVERIFIED(), pending),
    noteInstalled: noteInstalledInBackground,
    installedLater: async (status) => {
      // In this process; or by the supervisor's start, whose install outlived its budget:
      // its record names a newer version, and no install of it runs any more.
      const here = installedInBackground()
      if (here) return here
      const pending = readUnverified(UNVERIFIED())
      if (!pending || !isNewer(pending.version, status.current)) return null
      // A file install is in once the link names it (one cut short never swapped it).
      const binary = status.install.kind === 'binary' ? status.install.binary : null
      if (binary) return versionInUse(binary.root) === pending.version ? pending.version : null
      return (await installRunning(RECORD())) ? null : pending.version
    },
    turnsRunning: countRunningTurns,
    checkNow: () => getUpdateChecker().checkNow(),
    onChange,
    log: (level, msg, meta) => log.web[level](msg, meta ?? {}),
  }
}
