/**
 * What GET /api/system/update answers and the `system:update` WS frame carries:
 * the checker's status, whether `open-walnut web` installs updates on start
 * (config `updates.auto`), and the live update's state (live-update.ts).
 *
 * Only an npm or binary install updates itself; Homebrew and source never do.
 * An install this server's user cannot write (a root-owned npm prefix, installed
 * with `sudo npm i -g`, or a compiled file's root) does not either, and its
 * command is the sudo one the start names.
 */

import { getConfig } from '../config-manager.js'
import { installedInBackground } from './background-install.js'
import { notWritableFix } from './install-kind.js'
import { getLiveUpdater, offLiveStatus } from './live-update.js'
import { autoUpdateEnabled, installWritable } from './startup-update.js'
import { getUpdateChecker } from './update-check.js'

/** The running-turn count a GET waits for at most; past it the gate's last count answers. */
const TURNS_DEADLINE_MS = 1_500

export async function updateStatusForClient(o: { freshTurns?: boolean } = {}) {
  let configAuto: boolean | undefined
  try { configAuto = (await getConfig()).updates?.auto } catch { /* default */ }
  const status = getUpdateChecker().status()
  const selfUpdates = status.install.kind === 'npm' || status.install.kind === 'binary'
  // A 0.6.x Homebrew keg that updates itself: the way to the compiled file, when brew takes nothing back.
  let brewHint: { note: string; command: string } | null = null
  if (status.install.homebrewKeg) {
    const { brewUpgradeHint } = await import('./homebrew-keg.js')
    const hint = await brewUpgradeHint(status.install.homebrewKeg, status.current).catch(() => null)
    if (hint) brewHint = { note: hint.note, command: hint.command }
  }
  // Installed after this server started (the startup update outlived its budget, or a live install): a restart runs it.
  const installed = installedInBackground()
  const writable = !selfUpdates || installWritable(status.install)
  // Every kind that updates itself: an unwritable compiled file's `walnut update` only exits 1.
  const install = !writable ? { ...status.install, updateCommand: notWritableFix(status.install) } : status.install
  const updater = getLiveUpdater()
  const live = updater
    ? await updater.snapshot(o.freshTurns ? TURNS_DEADLINE_MS : undefined)
    : offLiveStatus(autoUpdateEnabled(configAuto, process.env))
  return {
    ...status, install, autoUpdate: selfUpdates && writable && autoUpdateEnabled(configAuto, process.env),
    ...(brewHint ? { brewHint } : {}), ...(installed ? { installed } : {}),
    live,
  }
}
