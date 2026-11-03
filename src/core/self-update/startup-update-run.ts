/**
 * The startup update with its real installers (startup-update.ts holds the
 * decisions): this process's own install, the registry's answer, npm or the
 * file's own installer, and the restart. Split out to keep both files small.
 */

import path from 'node:path'
import { installDirWritable, runInherited, updateOnStart, type StartupUpdateOutcome } from './startup-update.js'
import { managerArgv } from './install-kind.js'
import { reexecSelf, relaunchVersion, RESTART_SUPERVISED_ENV } from './startup-relaunch.js'

/**
 * The startup update as `walnut web` runs it: this process's own install
 * (install-kind.ts), the registry's answer, npm or the file's own installer,
 * and the restart. `configAuto` reads config.yaml's `updates.auto`. The new
 * version runs supervised: this process loops when it asks for a restart.
 * `o.current`: the version the install runs now, when this process is not it
 * (a restart loop's parent, restart-supervisor.ts); `o.env`: the child's env;
 * `o.stopSignal`: a signal that parent already received, so nothing is started;
 * `o.readyAlso`: the ready file of a parent above this one, told once the new version listens.
 */
export async function runStartupUpdate(
  configAuto: () => Promise<boolean | undefined>,
  o: { env?: Record<string, string | undefined>; current?: string; stopSignal?: () => NodeJS.Signals | null; readyAlso?: string } = {},
): Promise<StartupUpdateOutcome> {
  const { UpdateChecker } = await import('./update-check.js')
  const { installFileVersion, registryBaseFor, rollBack, undoRollBack } = await import('./binary-install.js')
  const { badDirFor, clearBad, heldBack, markBad } = await import('./held-versions.js')
  const { installRunning, noteInstalledInBackground, platformSpecFor, prefetchArgv, readUnverified, sequenceArgv, startDetachedInstall, writeUnverified } = await import('./background-install.js')
  const { WALNUT_HOME } = await import('../../constants.js')
  const err = (line: string) => { process.stderr.write(`${line}\n`) }
  const record = path.join(WALNUT_HOME, 'local', 'update-installing.json')
  const unverifiedFile = path.join(WALNUT_HOME, 'local', 'update-unverified.json')
  return updateOnStart({
    checkNow: () => new UpdateChecker(o.current ? { current: o.current, currentKnown: true } : {}).checkNow(),
    configAuto,
    env: { ...(o.env ?? process.env), [RESTART_SUPERVISED_ENV]: '1' },
    writable: installDirWritable,
    held: (status) => heldBack(status.install, status.latest!, badDirFor(status.install, WALNUT_HOME)),
    run: runInherited,
    startInstall: (file, args, version) => {
      // The download first, the install untouched; then the install from the cache (background-install.ts).
      const ahead = prefetchArgv({ file, args }, `open-walnut@${version}`, platformSpecFor(process.execPath, version))
      const job = sequenceArgv(ahead ? [ahead, { file, args }] : [{ file, args }])
      return startDetachedInstall(job.file, job.args, { logFile: path.join(WALNUT_HOME, 'local', 'update-install.log'), record, version })
    },
    busy: async () => {
      const job = await installRunning(record)
      return job ? `the install of ${job.version} an earlier start began still runs (pid ${job.pid})` : null
    },
    installedLater: noteInstalledInBackground,
    unverified: async () => readUnverified(unverifiedFile),
    markUnverified: (pending) => writeUnverified(unverifiedFile, pending),
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
    reexec: (env, install) => reexecSelf(env, install, { readyAlso: o.readyAlso }),
    ...(o.stopSignal ? { stopSignal: o.stopSignal } : {}),
    err,
  })
}
