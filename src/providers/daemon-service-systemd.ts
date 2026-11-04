/**
 * The systemd counterpart of launchd's ensureLoaded (daemon-service-launchd.ts): the last
 * step of a failed install, update, rollback or restart of a unit that was running before.
 * A rollback whose own steps stopped early (a daemon-reload that failed, a restart refused
 * by the start limit the new daemon used up) left the unit stopped, and a stopped user unit
 * stays stopped until the next boot: the host is unreachable meanwhile (2026-11-04, the
 * same class as the LaunchAgent left unloaded). So it reloads, clears the start limit and
 * starts the unit, asking again for a while.
 */
import type { DaemonServiceCommandResult } from './daemon-service-manager.js'

/** The value of `systemctl show -p <key>` (`<key>=<value>`), also from a newer systemd's bare --value form. */
export function systemdShownValue(stdout: string, key: string): string {
  return stdout.trim().replace(new RegExp(`^${key}=`), '')
}

/** How long a stopped unit is asked to start again. */
export const UNIT_START_RETRY_MS = 30_000
const RETRY_PAUSE_MS = 2_000

export interface UnitIo {
  run(program: string, args: string[]): Promise<DaemonServiceCommandResult>
  sleep(ms: number): Promise<void>
  /** Monotonic (performance.now): every wait here is in this process, and a sleep must not end one. */
  now(): number
}

export async function keepUnitActive(
  io: UnitIo, scoped: (args: string[]) => string[], unit: string,
): Promise<{ active: boolean; did: boolean; why?: string }> {
  // Active, reloading, or starting. Not a unit waiting out a crash (`activating` with SubState
  // auto-restart): systemd gives that one up at its start limit, and nothing starts it again.
  const running = async (): Promise<boolean> => {
    const shown = await io.run('systemctl', scoped(['is-active', unit]))
    const word = shown.stdout.trim()
    if (shown.code === 0 || word === 'reloading') return true
    if (word !== 'activating') return false
    // No --value: systemd before 230 (219 on long-lived distributions) rejects it, and an empty
    // answer read as "not waiting out a crash" (2026-11-04 review). Every version prints SubState=<word>.
    return systemdShownValue((await io.run('systemctl', scoped(['show', '-p', 'SubState', unit]))).stdout, 'SubState') !== 'auto-restart'
  }
  if (await running()) return { active: true, did: false }
  const deadline = io.now() + UNIT_START_RETRY_MS
  let last: DaemonServiceCommandResult
  for (;;) {
    // Each one is best effort: the start below is what has to work.
    await io.run('systemctl', scoped(['daemon-reload']))
    await io.run('systemctl', scoped(['reset-failed', unit]))
    last = await io.run('systemctl', scoped(['start', unit]))
    if (last.code === 0 && await running()) return { active: true, did: true }
    if (io.now() >= deadline) break
    await io.sleep(RETRY_PAUSE_MS)
  }
  const line = ['systemctl', ...scoped(['start', unit])].join(' ')
  return { active: false, did: false, why: `${line} kept failing for ${Math.round(UNIT_START_RETRY_MS / 1000)} s (last exit ${last.code})` }
}
