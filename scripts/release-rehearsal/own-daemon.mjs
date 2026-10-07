// Stop the session daemon a rehearsal or smoke run started in its own daemon dir.
//
// The daemon outlives its server on purpose, so whoever made it must end it. It
// writes into its dir while it stops, so a caller that removes the dir right after
// sending SIGTERM races it: on 2026-10-07 the 0.6.5 Mac app smoke passed every step
// and then failed on `rmdir .../daemon: ENOTEMPTY`. This returns only once the
// process is gone.
import fs from 'node:fs'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH, or EPERM: the pid now belongs to another user's process, so ours is gone.
    return false
  }
}

/**
 * SIGTERM the pid `<daemonDir>/daemon.pid` records, wait for it to exit, and
 * SIGKILL it after `graceMs`. Only ever the pid in the caller's own dir, and
 * never pid 0 or 1. Returns the pid it stopped, or null when there was none.
 */
export async function stopOwnDaemon(daemonDir, { graceMs = 15_000, killWaitMs = 5_000 } = {}) {
  const pidFile = path.join(daemonDir, 'daemon.pid')
  const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : NaN)
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return null
  try { process.kill(pid, 'SIGTERM') } catch { return null }
  for (const deadline = Date.now() + graceMs; alive(pid) && Date.now() < deadline;) await sleep(100)
  if (alive(pid)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* it went in between */ }
    for (const deadline = Date.now() + killWaitMs; alive(pid) && Date.now() < deadline;) await sleep(100)
  }
  return pid
}
