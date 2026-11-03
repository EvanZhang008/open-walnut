/**
 * Which installs a running Walnut may replace while it serves (live-update.ts),
 * and so which `walnut web` starts as a supervisor (restart-supervisor.ts).
 *
 * Only the compiled file, in a place this user can write: the install.sh layout,
 * or an npm install of the file. A Node build imports its content-hashed chunks
 * lazily from the package directory, so replacing that package under a live
 * process breaks its next lazy import; it keeps updating at start. Never an
 * ephemeral server, a replica (its checker is disabled), a source checkout, a
 * Homebrew keg, a server whose update checks are off, or one the Mac app
 * updates itself (WALNUT_LAUNCHER_UPDATES=1).
 */

import { IS_EPHEMERAL } from '../../constants.js'
import { runsCompiled } from './install-kind.js'
import { binaryRootWritable, installDirWritable, LAUNCHER_UPDATES_ENV } from './startup-update.js'
import type { UpdateStatus } from './update-check.js'

export function canSelfInstallLive(
  status: Pick<UpdateStatus, 'enabled' | 'install'>,
  env: Record<string, string | undefined>,
  compiled: boolean = runsCompiled(),
): boolean {
  if (!status.enabled || IS_EPHEMERAL || env[LAUNCHER_UPDATES_ENV] === '1') return false
  const install = status.install
  if (install.kind === 'binary') return !!install.binary && binaryRootWritable(install.binary.root)
  if (install.kind === 'npm') return compiled && !!install.manager && installDirWritable(install.packageRoot)
  return false
}

/**
 * Does this `walnut web` run as the supervisor of its server? Whenever its install
 * can live-update. `updates.auto` is not asked: with it off the person's Update
 * button still installs and restarts, and that restart needs the supervisor too.
 */
export async function supervisesFromStart(env: Record<string, string | undefined>): Promise<boolean> {
  const { UpdateChecker } = await import('./update-check.js')
  return canSelfInstallLive(new UpdateChecker({ env }).status(), env)
}
