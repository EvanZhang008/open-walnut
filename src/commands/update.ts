/**
 * `walnut update`: is a newer open-walnut published, and install it.
 *
 * Updates the install THIS command runs from (not whatever server happens to be
 * on :3456): the CLI and the server are the same package, and the install kind
 * is read off this process's own path (src/core/self-update/install-kind.ts).
 *
 *   - npm/pnpm/bun/yarn install: ask the registry, then run that manager's
 *     global install with inherited stdio, so its own progress and prompts show.
 *     A running server keeps the old code until it is restarted; say so.
 *   - the compiled file in install.sh's layout: download the newer file, check
 *     it, and swap the link (src/core/self-update/binary-install.ts).
 *   - a file Homebrew installed: name `brew upgrade open-walnut`. A 0.6.x
 *     keg's archive that updated itself onto the npm launcher updates as npm
 *     does, and says that `brew upgrade` moves it to the file (homebrew-keg.ts).
 *   - source checkout: print the git steps and do nothing. The developer owns
 *     that tree (an unexpected pull over local work is worse than no update).
 *   - cloud replica / unpacked bundle: say where the update comes from.
 *
 * `--check` only reports. `--channel stable|nightly` follows that dist-tag
 * instead of the installed version's own channel (a nightly build follows
 * `nightly`, a release follows `latest`). `--auto` is the update a launcher runs
 * on its own (the Mac app, while its server runs): it keeps `updates.auto:
 * false` and WALNUT_NO_AUTO_UPDATE, and a version held back
 * (src/core/self-update/held-versions.ts); without it the published version
 * installs and its mark goes. After an npm install, the launcher must start the
 * new version (npm can skip its platform package), else the old one goes back.
 * An install this user cannot write (a root-owned npm prefix) is not handed to
 * npm, which would only fail with EACCES: the command names the sudo one, as
 * the start does. Exit 0 when the question was answered (newer or not), 1 when
 * the registry could not be reached, the install is not this user's to write or
 * the install did not take, the installer's code when it failed.
 */

import os from 'node:os'
import type { GlobalOptions } from '../core/types.js'
import type { UpdateChannel, UpdateStatus } from '../core/self-update/update-check.js'
import { managerArgv, notWritableFix, type BinaryInstall, type InstallInfo } from '../core/self-update/install-kind.js'
import type { UpdateStop } from '../core/self-update/startup-update.js'
import { apiBaseUrl } from '../utils/api-client.js'

export interface UpdateOptions {
  /** Report only; never install. */
  check?: boolean
  channel?: string
  /** A launcher's own update: keeps updates.auto and the versions held back. */
  auto?: boolean
}

export function parseChannel(raw: string | undefined): UpdateChannel | undefined {
  if (raw === undefined) return undefined
  if (raw === 'stable' || raw === 'nightly') return raw
  throw new Error(`--channel must be stable or nightly, not "${raw}"`)
}

export interface UpdatePlan {
  /** What to print before (and instead of) installing. */
  lines: string[]
  /** The installer to run; absent when there is nothing to run. */
  install?: { file: string; args: string[] }
  /** The compiled file's own update: this version into this layout. */
  installFile?: { install: BinaryInstall; version: string }
  exitCode: number
}

/**
 * `writable: false` is an install this user cannot replace (a root-owned npm
 * prefix, a binary root owned by someone else): the plan names the fix the start
 * names (notWritableFix) and runs nothing, where the installer would only end
 * in its own permission error. Without it the install counts as writable.
 */
export function planUpdate(status: UpdateStatus, opts: { check: boolean; writable?: boolean }): UpdatePlan {
  const { install } = status
  if (install.kind === 'source') {
    const dir = install.sourceDir ?? 'the checkout'
    return {
      exitCode: 0,
      lines: [
        `Open Walnut ${status.current} here runs from a source checkout (${dir}), so it updates with git:`,
        `  cd ${dir} && git pull && bun install && bun run build`,
        'Then restart the server.',
      ],
    }
  }
  if (install.kind === 'replica') {
    return { exitCode: 0, lines: ['This is a cloud replica. Update the primary console, then redeploy the replica with the cloud scripts.'] }
  }
  if (!status.enabled) {
    return { exitCode: 0, lines: [`The update check is off here (${status.reason ?? 'disabled'}). Releases: ${status.packageUrl}`] }
  }
  if (!status.latest) {
    return { exitCode: 1, lines: [`Could not reach the npm registry: ${status.error ?? 'no answer'}. Releases: ${status.packageUrl}`] }
  }
  const onChannel = status.channel === 'nightly' ? ' on the nightly channel' : ''
  if (!status.available) {
    const other = status.channel === 'nightly' ? status.tags.latest : status.tags.nightly
    const otherName = status.channel === 'nightly' ? 'stable' : 'nightly'
    return {
      exitCode: 0,
      lines: [
        `Open Walnut ${status.current} is the newest${onChannel} (${status.latest}).`,
        ...(other ? [`The ${otherName} channel is at ${other}: walnut update --channel ${otherName}`] : []),
      ],
    }
  }
  const head = `A newer Open Walnut is available${onChannel}: ${status.current} → ${status.latest}.`
  const updatesItself = (install.kind === 'binary' && install.binary) || (install.kind === 'npm' && install.manager)
  if (opts.writable === false && updatesItself) {
    const fix = notWritableFix(install)
    const what = install.kind === 'binary' ? 'Fix it' : 'Run'
    if (opts.check) return { exitCode: 0, lines: [head, `${what}: ${fix}`] }
    const where = install.binary?.root ?? install.packageRoot
    return { exitCode: 1, lines: [head, `This install${where ? ` (${where})` : ''} is not writable by this user, so nothing was changed. ${what}: ${fix}`] }
  }
  if (install.kind === 'binary' && install.binary) {
    if (opts.check) return { exitCode: 0, lines: [head, 'Run: walnut update'] }
    return { exitCode: 0, lines: [head, `Installing it into ${install.binary.root}...`], installFile: { install: install.binary, version: status.latest } }
  }
  if (install.kind !== 'npm' || !install.manager) {
    if (install.updateCommand) return { exitCode: 0, lines: [head, `Update it with: ${install.updateCommand}`] }
    return { exitCode: 0, lines: [head, `This install has no package manager to update it with. Releases: ${status.packageUrl}`] }
  }
  const argv = managerArgv(install.manager, `open-walnut@${status.latest}`, install.runtimePrefix)
  if (opts.check) return { exitCode: 0, lines: [head, `Run: ${install.updateCommand}`] }
  return { exitCode: 0, lines: [head, `Running: ${argv.file} ${argv.args.join(' ')}`], install: argv }
}

export interface UpdateDeps {
  checkNow: (channel?: UpdateChannel) => Promise<UpdateStatus>
  /** Can this user replace this install (startup-update.ts installWritable)? Absent: yes. */
  writable?: (install: InstallInfo) => boolean
  run: (file: string, args: string[], stop?: UpdateStop) => Promise<number>
  /** The file's own update (binary-install.ts installFileVersion); throws with the reason. */
  installFile?: (install: BinaryInstall, version: string, signal?: AbortSignal) => Promise<void>
  /** What the install's relaunch prints for `--version` (startup-update.ts relaunchVersion), or null. */
  versionOf?: (install: InstallInfo) => Promise<string | null>
  /** config.yaml `updates.auto` after WALNUT_NO_AUTO_UPDATE (for --auto). */
  autoEnabled?: () => Promise<boolean>
  /** Why the published version is held back here, or null (for --auto). */
  held?: (status: UpdateStatus) => string | null
  /** Clear the published version's held-back mark once it is installed. */
  clearHeld?: (status: UpdateStatus, version: string) => void
  /** SIGINT/SIGTERM/SIGHUP while an install runs: it cleans up, then this command ends. */
  watch?: () => UpdateStop
  /** Is a Walnut server answering at the default address? (It keeps the old code until restarted.) */
  serverRunning: () => Promise<boolean>
  /** A Homebrew keg that updates itself: the `brew upgrade` line, or null (homebrew-keg.ts). */
  brewHint?: (status: UpdateStatus) => Promise<{ note: string } | null>
  out: (line: string) => void
  err: (line: string) => void
}

async function probeServer(): Promise<boolean> {
  try {
    const res = await fetch(`${apiBaseUrl()}/api/system/update`, { signal: AbortSignal.timeout(1_500) })
    return res.ok
  } catch {
    return false
  }
}

export async function defaultDeps(): Promise<UpdateDeps> {
  const { UpdateChecker } = await import('../core/self-update/update-check.js')
  const { installFileVersion, registryBaseFor } = await import('../core/self-update/binary-install.js')
  const { autoUpdateEnabled, installWritable, relaunchVersion, runInherited, watchStop } = await import('../core/self-update/startup-update.js')
  const { badDirFor, clearBad, heldBack } = await import('../core/self-update/held-versions.js')
  const { WALNUT_HOME } = await import('../constants.js')
  const { brewUpgradeHint } = await import('../core/self-update/homebrew-keg.js')
  return {
    // A fresh checker, not the server's: this process is the install being updated.
    checkNow: (channel) => new UpdateChecker(channel ? { channel } : {}).checkNow(),
    writable: (install) => installWritable(install),
    run: runInherited,
    installFile: async (install, version, signal) => {
      await installFileVersion({
        install, version, registry: registryBaseFor(process.env.WALNUT_UPDATE_REGISTRY_URL),
        log: (line) => process.stdout.write(`${line}\n`), signal,
      })
    },
    versionOf: relaunchVersion,
    autoEnabled: async () => {
      let configAuto: boolean | undefined
      try {
        const { getConfig } = await import('../core/config-manager.js')
        configAuto = (await getConfig()).updates?.auto
      } catch { /* the default */ }
      return autoUpdateEnabled(configAuto, process.env)
    },
    held: (status) => (status.latest ? heldBack(status.install, status.latest, badDirFor(status.install, WALNUT_HOME)) : null),
    clearHeld: (status, version) => clearBad(badDirFor(status.install, WALNUT_HOME), version),
    watch: () => watchStop(null),
    serverRunning: probeServer,
    brewHint: (status) => brewUpgradeHint(status.install.homebrewKeg, status.current).catch(() => null),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }
}

/** Returns the exit code; the caller sets process.exitCode so stdio flushes. */
export async function runUpdateWith(options: UpdateOptions, globals: GlobalOptions, deps: UpdateDeps): Promise<number> {
  let channel: UpdateChannel | undefined
  try {
    channel = parseChannel(options.channel)
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err))
    return 2
  }
  if (options.auto && deps.autoEnabled && !(await deps.autoEnabled())) {
    deps.out('Automatic updates are off here (updates.auto: false in config.yaml, or WALNUT_NO_AUTO_UPDATE).')
    return 0
  }
  const status = await deps.checkNow(channel)
  const held = options.auto && status.available && status.latest ? deps.held?.(status) ?? null : null
  if (held) {
    deps.out(`Open Walnut ${status.latest} is published, but ${held}.`)
    return 0
  }
  const plan = planUpdate(status, { check: options.check === true, writable: deps.writable?.(status.install) ?? true })
  const brew = await deps.brewHint?.(status) ?? null
  if (globals.json) {
    deps.out(JSON.stringify({ ...status, plan: { lines: plan.lines, install: plan.install ?? null, installFile: plan.installFile ?? null }, brewHint: brew }, null, 2))
  } else {
    for (const line of plan.lines) (plan.exitCode === 0 ? deps.out : deps.err)(line)
    if (brew) deps.out(brew.note)
  }
  if (plan.installFile) {
    const stop = deps.watch?.()
    try {
      if (!deps.installFile) throw new Error('this build cannot update its file')
      await deps.installFile(plan.installFile.install, plan.installFile.version, stop?.signal)
    } catch (err) {
      const signal = stop?.received()
      if (signal) {
        deps.err(`Stopped by ${signal}; Open Walnut ${status.current} is unchanged.`)
        return 128 + (os.constants.signals[signal] ?? 0)
      }
      deps.err(`Could not install ${plan.installFile.version}: ${err instanceof Error ? err.message : String(err)}. Open Walnut ${status.current} is unchanged.`)
      return 1
    } finally {
      stop?.done()
    }
    return finishInstalled(status, deps)
  }
  if (!plan.install) return plan.exitCode
  const stop = deps.watch?.()
  try {
    let code: number
    try {
      code = await deps.run(plan.install.file, plan.install.args, stop)
    } catch (err) {
      deps.err(`Could not run ${plan.install.file}: ${err instanceof Error ? err.message : String(err)}`)
      return 1
    }
    if (code !== 0) {
      deps.err(`${plan.install.file} exited with ${code}; Open Walnut ${status.current} is unchanged.`)
      return code
    }
    const { confirmNpmInstall } = await import('../core/self-update/startup-update.js')
    const problem = await confirmNpmInstall({ status, version: status.latest!, argv: plan.install, run: deps.run, versionOf: deps.versionOf, stop, err: deps.err })
    if (problem) return 1
  } finally {
    stop?.done()
  }
  deps.clearHeld?.(status, status.latest!)
  return finishInstalled(status, deps)
}

async function finishInstalled(status: UpdateStatus, deps: UpdateDeps): Promise<number> {
  deps.out(`Installed Open Walnut ${status.latest}.`)
  if (await deps.serverRunning()) {
    deps.out(`The server at ${apiBaseUrl()} still runs ${status.current} until it is restarted (stop \`walnut web\`, then start it again).`)
  }
  return 0
}

export async function runUpdate(options: UpdateOptions, globals: GlobalOptions): Promise<void> {
  process.exitCode = await runUpdateWith(options, globals, await defaultDeps())
}
