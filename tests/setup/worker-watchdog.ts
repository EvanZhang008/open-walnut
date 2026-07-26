// Worker parent-liveness watchdog. When the vitest runner is killed hard
// (SIGKILL, terminal close, agent timeout), its forked workers are reparented
// to launchd/init and keep running forever — 3 orphaned `node (vitest N)`
// workers were found burning RAM 10+ minutes after their runner died, one at
// 4.2GB (2026-07-25). Same pattern as the daemon's WALNUT_DAEMON_PARENT_PID
// watchdog (daemon-standalone.ts): notice the parent is gone, then exit.
//
// Loaded via setupFiles so it runs once per worker process.
//
// Detection: vitest forks workers with an IPC channel, so node emits
// 'disconnect' the instant the parent dies — immediate and free. The 5s ppid
// poll stays as a belt-and-braces fallback for pools without a live channel.
const WORKER_PARENT_POLL_MS = 5_000

/**
 * Exit this worker. Deliberately does NOT signal our process group: a worker is
 * usually NOT the group leader, so `kill(-pid)` would land on the whole group —
 * the runner and its sibling workers included — turning a targeted self-exit
 * into a shotgun. Anything a test spawned is covered by its own supervision
 * (daemons carry WALNUT_DAEMON_PARENT_PID and self-exit; see daemon-standalone.ts),
 * so exiting cleanly here is both sufficient and the safe option.
 */
function bail(reason: string): never {
  // eslint-disable-next-line no-console
  console.error(`[worker-watchdog] ${reason} — exiting worker ${process.pid}`)
  process.exit(1)
}

const initialPpid = process.ppid

// Primary signal: IPC channel to the runner closed → runner is gone.
if (typeof process.disconnect === 'function') {
  process.on('disconnect', () => bail('runner IPC channel disconnected'))
}

// Fallback: poll the parent. unref() so a finished worker isn't held open.
if (initialPpid > 1) {
  const timer = setInterval(() => {
    // Reparented away from the original runner → the runner is dead. (No
    // kill(pid,0) probe: if ppid still equals initialPpid the parent's process
    // entry exists by definition, so the probe could never fail.)
    if (process.ppid !== initialPpid) bail(`vitest runner (pid ${initialPpid}) gone`)
  }, WORKER_PARENT_POLL_MS)
  timer.unref()
}

export {}
