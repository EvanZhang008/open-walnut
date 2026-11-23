// Stop the session daemon a rehearsal or smoke run started in its own daemon dir.
//
// The daemon outlives its server on purpose, so whoever made it must end it. It
// writes into its dir while it stops, so a caller that removes the dir right after
// sending SIGTERM races it: on 2026-10-07 the 0.6.5 Mac app smoke passed every step
// and then failed on `rmdir .../daemon: ENOTEMPTY`. This returns only once the
// process is gone.
import { execFileSync } from 'node:child_process'
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

/** When `pid` started (ps lstart, Linux and macOS), or null when no such process runs. */
function startOf(pid) {
  try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 }).trim() || null } catch { return null }
}

/**
 * SIGTERM the pid `<daemonDir>/daemon.pid` records, wait for it to exit, and
 * SIGKILL it after `graceMs`. Only ever the pid in the caller's own dir, and
 * never pid 0 or 1; pinned by its start time, so a pid the system gave to
 * another process meanwhile is never signalled. Returns the pid it stopped, or
 * null when there was none.
 */
export async function stopOwnDaemon(daemonDir, { graceMs = 15_000, killWaitMs = 5_000 } = {}) {
  const pidFile = path.join(daemonDir, 'daemon.pid')
  const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : NaN)
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !alive(pid)) return null
  const started = startOf(pid)
  if (!started) return null
  const same = () => alive(pid) && startOf(pid) === started
  try { process.kill(pid, 'SIGTERM') } catch { return null }
  for (const deadline = Date.now() + graceMs; same() && Date.now() < deadline;) await sleep(100)
  if (same()) {
    try { process.kill(pid, 'SIGKILL') } catch { /* it went in between */ }
    for (const deadline = Date.now() + killWaitMs; same() && Date.now() < deadline;) await sleep(100)
  }
  return pid
}
