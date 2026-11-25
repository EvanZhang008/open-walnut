/**
 * The one stop of the follower servers a service started, named by their pid files
 * (`<install root>/host-server/server-*.pid`): a service start stops an older daemon's (service-entry.ts),
 * an uninstall stops its own (daemon-service-uninstall-tail.ts). Its own module so the uninstall,
 * which is bundled into the daemon, never pulls in service-entry.ts and the server it starts.
 */
import fs from 'node:fs'

/** Deps of stopOldFollowers (tests hand their own). */
export interface StopFollowerDeps {
  startTimeOf?: (pid: number) => string | null
  killGroup?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  exists?: (pid: number) => boolean
  unknownRetryMs?: number
  /** Who stops them and whose followers they are, for the stderr line (default: a service start, an older daemon's). */
  says?: { by: string; whose: string }
  /**
   * Try every pid file, and answer at the end (an uninstall: each follower left would run on with no
   * parent). Off (a service start): the first that does not stop ends it, since this start ends then anyway.
   */
  tryEach?: boolean
}

/**
 * Stops the follower children an older daemon started from these specs (their pid files): they hold
 * the data dir's lock and the port, or run on unmanaged. False when one did not stop, or may still
 * run (its start time did not read): its pid file is kept and this start ends.
 */
export async function stopOldFollowers(pidFiles: string[], deps: StopFollowerDeps = {}): Promise<boolean> {
  if (pidFiles.length === 0) return true
  const [{ stopRecordedServer }, { defaultReadStartTime }] = await Promise.all([
    import('./host-server-core.js'), import('./daemon-core.js'),
  ])
  let allStopped = true
  for (const pidFile of pidFiles) {
    const stopped = await stopRecordedServer({
      pidFile, fs,
      startTimeOf: deps.startTimeOf ?? ((pid) => defaultReadStartTime(fs, pid)),
      killGroup: deps.killGroup ?? ((pid, signal) => { if (pid > 1) process.kill(-pid, signal) }),
      ...(deps.exists ? { exists: deps.exists } : {}),
      ...(deps.unknownRetryMs !== undefined ? { unknownRetryMs: deps.unknownRetryMs } : {}),
    })
    if (stopped !== 'none') {
      const what = stopped === 'stays' ? 'did not stop' : stopped === 'unknown' ? 'may still run (its start time did not read); its pid file is kept' : 'was stopped'
      process.stderr.write(`${deps.says?.by ?? 'walnut --service'}: the follower ${deps.says?.whose ?? 'an older daemon'} started ${what}\n`)
    }
    if (stopped === 'stays' || stopped === 'unknown') {
      if (!deps.tryEach) return false
      allStopped = false
    }
  }
  return allStopped
}
