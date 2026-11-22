/**
 * The service launcher's variables, read once at the server's start and taken out of process.env
 * before anything copies that env into a child (the session daemon, an agent CLI, a plugin job):
 * only this server writes the launcher's marks (serve-launcher-beat.ts).
 *
 *  - WALNUT_LAUNCHER_DIR: the launcher's dir (service-launcher-script.ts exports it).
 *  - WALNUT_LAUNCHER_SERVICE_PID: the pid the launcher started, when that is not this process (the
 *    Mac's run script puts the server under Walnut.app's session host: scripts/lib/devprod-launcher.sh).
 */

export interface LauncherEnv { dir: string | undefined; servicePid: number | null }

let taken: LauncherEnv | null = null

/** A whole number above 1, else null. */
export function launcherServicePid(raw: string | undefined): number | null {
  if (!raw || !/^[0-9]{1,10}$/.test(raw)) return null
  const pid = Number(raw)
  return pid > 1 ? pid : null
}

/** Read and remove the launcher's variables; with none set now, what an earlier call took. */
export function takeLauncherEnv(): LauncherEnv {
  const env = process.env
  if (env.WALNUT_LAUNCHER_DIR === undefined && env.WALNUT_LAUNCHER_SERVICE_PID === undefined) return taken ?? { dir: undefined, servicePid: null }
  taken = { dir: env.WALNUT_LAUNCHER_DIR, servicePid: launcherServicePid(env.WALNUT_LAUNCHER_SERVICE_PID) }
  delete env.WALNUT_LAUNCHER_DIR
  delete env.WALNUT_LAUNCHER_SERVICE_PID
  return taken
}

/** Tests only. */
export function _resetLauncherEnvForTesting(): void { taken = null }
