/**
 * One bound for a daemon update, whatever holds it.
 *
 * 2026-11-05: clouddev's daemon ran an old build for about 17.6 hours, its update postponed
 * 50 to 80 times an hour. Each hold had its own clock or none: host_exec runs (3 h) and open
 * ACP turns (6 h) each restarted theirs whenever one check did not see them, and the server's
 * in-flight commands, a connect in progress and the daemon's own refusal (a relay, an ACP
 * worker, any request of any client still open: "Daemon has active operations") had no bound
 * at all. A host whose sessions always run met one reason or another at every try.
 *
 * So the bound is on the update itself: since when the host has run a daemon other than the
 * build this server would put there. A deploy while it waits does not restart it (the host is
 * still behind), the reasons taking turns do not either; a check that finds the host on this
 * build clears it. It is kept on disk beside the other hold clocks (acp-upgrade-hold.ts),
 * because every deploy is a new server. Past DAEMON_UPDATE_BEHIND_MAX_MS the update is overdue:
 * every hold in DAEMON_UPDATE_HOLDS gives way (logged), and the swap asks the daemon to go over
 * its own work (daemon-over-busy.ts): `force` on service.update for a daemon that knows it,
 * else a restart by its service; either ends the requests, ACP workers and host_exec runs still
 * open (each run's log says why), as a plain daemon restart always did. Session commands and file
 * writes in flight finish first, and the CLI sessions keep running across the swap.
 */
import { dropHoldClocks, upgradeHoldClock } from './acp-upgrade-hold.js'

export const DAEMON_UPDATE_BEHIND_MAX_MS = 3 * 60 * 60_000

/**
 * A host behind is checked at least every 15 minutes while its server runs (the longest
 * recheck delay, the update gap is 20 min); one not checked for this long (the server was
 * down, the host offline) starts its clock over rather than being updated at once over work
 * that just began.
 */
export const DAEMON_UPDATE_BEHIND_STALE_MS = 2 * 60 * 60_000

/** How long an overdue update waits for the server's own in-flight writes before it goes over them. */
export const OVERDUE_GATE_WAIT_MS = 30_000

/**
 * Whether `host`'s update is overdue: `running` is the build the host runs now ('' when unknown),
 * `behind` whether that is another build than the one this server would put there. The clock is
 * per running build: an update that landed (even on a build that is already old again, after a
 * deploy) starts it over, so a daemon just replaced is never overdue.
 * `behindMs`: how long it has been behind on this build (0 when it is not).
 */
export function daemonUpdateOverdue(host: string, running: string, behind: boolean, now: number = Date.now()): { overdue: boolean; behindMs: number } {
  // A version that could not be read (or no daemon at all) says nothing: the clock is left as it is.
  if (!running) return { overdue: false, behindMs: 0 }
  const key = `behind:${host}:${running}`
  dropHoldClocks(`behind:${host}:`, key)
  const { holds, heldMs } = upgradeHoldClock(key, behind, DAEMON_UPDATE_BEHIND_MAX_MS, now, DAEMON_UPDATE_BEHIND_STALE_MS)
  return { overdue: behind && !holds, behindMs: heldMs }
}

/** The daemon capability that takes `force` on service.update (both twins advertise it; informational for servers). */
export const SERVICE_UPDATE_FORCE_CAP = 'service-update-force-v1'

export type DaemonUpdateHoldKind =
  /** Work that holds the update: it gives way once the update is overdue. */
  | 'hold'
  /** A wait with its own bound (`bound`, a constant exported from `boundFile`). */
  | 'bounded'
  /** Nothing to wait for: a check or an upload that failed, asked again with a backoff. */
  | 'retry'

export interface DaemonUpdateHold {
  file: string
  /** The method the update is put off in. */
  method: string
  /** Text at the call or in the lines just above it (the reason it gives). */
  near: string
  kind: DaemonUpdateHoldKind
  bound?: string
  boundFile?: string
  /** A `hold`: the behaviour test that shows it gives way once the update is overdue (its file, words of its name). */
  proof?: { test: string; name: string }
  why: string
}

const DC = 'src/providers/daemon-connection.ts'
const LD = 'src/providers/local-daemon.ts'
const NU = 'src/providers/daemon-net-update.ts'

/**
 * Every place a daemon update is put off: each `postponeUpgrade(` of daemon-connection.ts, each
 * `scheduleUpgradeRecheck()` of local-daemon.ts, each `this.postpone(` of daemon-net-update.ts.
 * tests/providers/daemon-update-holds-ratchet.test.ts finds the calls and fails on one not
 * listed, on a `hold` whose method never reads the overdue verdict or that names no behaviour
 * test showing it give way, and on a `bounded` one whose constant is gone.
 */
export const DAEMON_UPDATE_HOLDS: readonly DaemonUpdateHold[] = [
  { file: DC, method: 'shouldUpgradeDaemon', near: 'could not check the OS-service state', kind: 'retry', why: 'no answer from the service probe; nothing is stopped without one' },
  { file: DC, method: 'shouldUpgradeDaemon', near: 'daemonUpdateGapWhy(', kind: 'bounded', bound: 'DAEMON_UPDATE_MIN_GAP_MS', boundFile: 'src/providers/daemon-update-gap.ts', why: 'one replacement per gap, at most one gap in all; skipped when overdue' },
  { file: DC, method: 'shouldUpgradeDaemon', near: 'the new daemon could not be put on the host', kind: 'retry', why: 'the upload failed; asked again with a backoff' },
  { file: DC, method: 'shouldUpgradeDaemon', near: 'right after an update; asked again when its cooldown ends', kind: 'bounded', bound: 'UPGRADE_RETRY_COOLDOWN_MS', boundFile: 'src/providers/daemon-connection.ts', why: 'the daemon still reports another build right after an update (its version stamp may be broken); asked again once the cooldown ends' },
  { file: DC, method: 'shouldUpgradeDaemon', near: 'the version check did not finish', kind: 'retry', why: 'the version read failed' },
  { file: DC, method: 'shouldUpgradeDaemon', near: 'is on its probation after it replaced another one', kind: 'bounded', bound: 'STAY_MS', boundFile: DC, why: 'the build that runs replaced another lately; the kept files of the one before it are the way back until its stay ends, and a keep for this update would put it over them' },
  { file: DC, method: 'shouldUpgradeDaemon', near: 'files could not be kept to go back to', kind: 'retry', why: 'copying the running daemon\'s files failed (an SSH error, a timeout, a runtime not known); the old daemon is not stopped without its way back, asked again with a backoff' },
  { file: DC, method: 'shouldUpgradeDaemon', near: 'did not start in a trial run', kind: 'retry', why: 'the staged build did not serve in a trial run, so it was taken off the disk and the old daemon keeps serving; asked again with a backoff' },
  { file: DC, method: 'holdUpgradeForFoldPrewarm', near: 'fold checkpoints for the new daemon are being prepared', kind: 'bounded', bound: 'REMOTE_FOLD_PREWARM_MAX_MS', boundFile: 'src/providers/remote-fold-prewarm.ts', why: 'one prewarm per build; a failed or timed-out one lets the update go ahead' },
  { file: DC, method: 'acpTurnsOpen', near: "'ACP turns are open'", kind: 'hold', proof: { test: 'tests/providers/daemon-connection-service-guard.test.ts', name: 'overdue, open ACP turns no longer hold the update' }, why: 'a swap ends a running ACP turn' },
  { file: DC, method: 'execRunsOpen', near: 'postponeUpgrade(why', kind: 'hold', proof: { test: 'tests/providers/daemon-connection-deferred-upgrade.test.ts', name: 'a host behind past the bound: writes in flight, host_exec runs and a busy daemon no longer hold it' }, why: 'host_exec runs end with the daemon' },
  { file: DC, method: 'holdUpgrade', near: 'postponeUpgrade(hold', kind: 'hold', proof: { test: 'tests/providers/daemon-connection-deferred-upgrade.test.ts', name: 'a host behind past the bound: writes in flight, host_exec runs and a busy daemon no longer hold it' }, why: 'this server\'s commands that change a session or a file are in flight' },
  { file: DC, method: 'runUpgradeRecheck', near: "'a connect was in progress'", kind: 'retry', why: 'the connect decides the update itself, with the same holds and the same clock' },
  { file: DC, method: 'runUpgradeRecheck', near: 'the managed update did not complete', kind: 'bounded', bound: 'UPGRADE_RETRY_COOLDOWN_MS', boundFile: 'src/providers/daemon-connection.ts', why: 'a managed update failed after it started (its daemon never answered as the new build); asked again after the cooldown' },
  { file: DC, method: 'runUpgradeRecheck', near: 'the check failed', kind: 'retry', why: 'the decision threw' },
  { file: DC, method: 'updateManagedDaemon', near: 'the previous daemon update is still running on the host', kind: 'bounded', bound: 'UPDATE_RUNNER_MAX_MS', boundFile: 'src/providers/daemon-update-readback.ts', why: 'the record of an earlier update says its runner may still work on the host; two runners would race on one service, and the record reads as finished once its runner time is over' },
  { file: DC, method: 'updateManagedDaemon', near: 'probation still watches the new daemon', kind: 'bounded', bound: 'PROBATION_SECONDS', boundFile: 'src/providers/daemon-update-probation.ts', why: 'the last update\'s probation watches its daemon with the copies of the one before it, which a new snapshot would take; asked again when it ends' },
  { file: DC, method: 'updateManagedDaemon', near: 'the new daemon could not be put on the host', kind: 'retry', why: 'the upload failed; asked again with a backoff' },
  { file: DC, method: 'updateManagedDaemon', near: 'postponeUpgrade(said, expected', kind: 'bounded', bound: 'UPDATE_RUNNER_MAX_MS', boundFile: 'src/providers/daemon-update-readback.ts', why: 'held right before the launch, after the upload: another update\'s runner or probation at work on the host, or the install lock taken; nothing was changed, and those end on their own' },
  { file: DC, method: 'updateManagedDaemon', near: 'said.slice(deferredAt', kind: 'bounded', bound: 'UPGRADE_RETRY_COOLDOWN_MS', boundFile: DC, why: 'the host deferred it (launchd starts no jobs in a dark wake): nothing changed there; asked again after the cooldown' },
  { file: DC, method: 'updateManagedDaemon', near: 'asked again when its cooldown ends', kind: 'bounded', bound: 'UPGRADE_RETRY_COOLDOWN_MS', boundFile: 'src/providers/daemon-connection.ts', why: 'a try of this build did not finish; asked again when its cooldown ends' },
  { file: DC, method: 'updateManagedDaemon', near: "the host's daemon is busy", kind: 'hold', proof: { test: 'tests/providers/daemon-connection-deferred-upgrade.test.ts', name: 'a host behind past the bound: writes in flight, host_exec runs and a busy daemon no longer hold it' }, why: 'the daemon refused before it changed anything; overdue, the swap asks it to go over its work' },
  { file: LD, method: 'ensureRunningInner', near: 'ACP turns open', kind: 'hold', proof: { test: 'tests/providers/local-daemon-service-guard.test.ts', name: 'overdue, open ACP turns and host_exec runs on this Mac no longer hold the upgrade' }, why: 'open ACP turns on this Mac' },
  { file: LD, method: 'ensureRunningInner', near: 'file could not be kept to go back to', kind: 'retry', why: 'keeping the running daemon\'s file failed (a full disk, a clone refused); it is not stopped without its way back, asked again on the upgrade clock' },
  { file: LD, method: 'ensureRunningInner', near: "cold?.kind === 'back'", kind: 'retry', why: 'the kept build serves again after a failed probation; the build on disk is tried next, through its trial, on the upgrade clock' },
  { file: LD, method: 'deferForProbation', near: 'the running build is on its probation', kind: 'bounded', bound: 'STAY_MS', boundFile: 'src/providers/local-daemon-stay.ts', why: 'the build that runs replaced another lately; the file of the one before it is the way back until its stay ends' },
  { file: LD, method: 'refuseReplacement', near: "verdict !== 'wait'", kind: 'bounded', bound: 'LOCAL_REPLACE_RETRY_MS', boundFile: 'src/providers/local-daemon-replace.ts', why: 'the new build failed its trial run (or answered ok and did not stay serving, a day: REAL_DIR_BACKOFF_MS); the old daemon keeps serving' },
  { file: LD, method: 'startManagedUpdate', near: 'managed update failed; the daemon that serves now is adopted', kind: 'bounded', bound: 'LOCAL_MANAGED_UPDATE_COOLDOWN_MS', boundFile: LD, why: 'a managed update failed; what serves is adopted and the recheck tries again once its cooldown ends (a build that did not stay serving: a day)' },
  { file: LD, method: 'startManagedUpdate', near: '} else if (outcome !== null) {', kind: 'bounded', bound: 'OVER_BUSY_WAIT_MS', boundFile: 'src/providers/daemon-over-busy.ts', why: 'the managed local daemon refused as busy (or another update or a probation is at work), or a try of this build was within its cooldown; overdue, the next try (a minute later) forces after OVER_BUSY_PLAIN_MS and has the service restart it by OVER_BUSY_WAIT_MS' },
  { file: LD, method: 'deferForExecRuns', near: 'host_exec runs', kind: 'hold', proof: { test: 'tests/providers/local-daemon-service-guard.test.ts', name: 'overdue, open ACP turns and host_exec runs on this Mac no longer hold the upgrade' }, why: 'host_exec runs on this Mac' },
  { file: NU, method: 'attempt', near: 'this.launched.unread', kind: 'bounded', bound: 'UPDATE_RUNNER_MAX_MS', boundFile: 'src/providers/daemon-update-readback.ts', why: 'the record of an earlier update says its runner may still work on the host; it reads as finished once its runner time is over' },
  { file: NU, method: 'attempt', near: 'postpone(held)', kind: 'hold', proof: { test: 'tests/providers/daemon-net-update.test.ts', name: 'overdue (behind past the bound), host_exec runs no longer hold it' }, why: 'writes in flight or host_exec runs on a host network machine' },
  { file: NU, method: 'attempt', near: "the host's daemon is busy", kind: 'hold', proof: { test: 'tests/providers/daemon-net-update.test.ts', name: 'a busy refusal is a postponement, never a failure' }, why: 'the daemon refused before it changed anything; overdue, the next swap goes over its work (--over-busy)' },
  { file: NU, method: 'attempt', near: 'postpone(msg.slice(deferredAt)', kind: 'retry', why: 'the host deferred it (launchd starts no jobs in a dark wake): nothing changed there; asked again after the cooldown' },
  { file: NU, method: 'attempt', near: 'postpone(err.message', kind: 'retry', why: 'held right before the launch, after the upload; overdue, only a dropped link or a refused grant gets here (holds() answers null)' },
]

/**
 * Every place a daemon update is not done and no clock asks again, logged as such: each says why
 * that is right (a setting, a permanent condition, or a wait that brings the update back itself).
 * The ratchet fails on a log of an update deferred, refused or held in these files that is
 * neither next to a listed hold nor listed here.
 */
export const DAEMON_UPDATE_STOPS: readonly { file: string; near: string; why: string }[] = [
  { file: DC, near: 'managed daemon update was deferred; use', why: 'no update is possible from here: a read-only or test server, no service scope, an unknown config, no daemon file; nothing a clock would change' },
  { file: LD, near: 'Managed local daemon version differs; automatic update was deferred', why: 'not a production daemon dir, an unknown config or no service scope; nothing a clock would change' },
  { file: LD, near: 'local daemon: deferred upgrade check failed', why: 'the recheck itself failed: a failed managed update has already set the next recheck (ensureRunningInner), and any other failure is a start that every caller of ensureRunning retries' },
  { file: LD, near: '; trying again later', why: 'updateManagedDaemon answers \'busy\' to startManagedUpdate, which sets the recheck (its listed hold)' },
  { file: LD, near: 'upgrade DEFERRED (preparing fold checkpoints)', why: 'the prewarm runs at most REMOTE_FOLD_PREWARM_MAX_MS and calls ensureRunning itself when it ends (deferUpgradeForFoldPrewarm)' },
  { file: NU, near: 'daemon update held by the host setting', why: "the host's own setting (autofix: false) or the user's: updated on request" },
  { file: NU, near: 'host network daemon not updated', why: 'each skip names its reason; the gap, the cooldown, an unknown system, a missing walnut file and a failure ask again on their own clock (later), the rest wait for a request, a setting or the next build' },
]
