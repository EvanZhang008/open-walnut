/**
 * Where a task's own working files live on a host: its task directory.
 *
 * Every task gets one directory per host its sessions run on, made by that
 * host's daemon when it starts a session for the task and handed to the
 * session as WALNUT_TASK_DIR (and named in its prompt). It holds what the
 * session must not lose: temporary clones and worktrees, unmerged commits,
 * candidate builds, evidence and reports. Walnut removes it after the task
 * has been complete for a while, and never while a repo in it still holds
 * work that exists nowhere else (src/providers/task-dir-core.ts).
 *
 * Why (2026-10-25): a restart emptied /tmp, and with it several tasks'
 * working clones, one task's only copy of an unmerged commit, and evidence
 * kept for later. Walnut had given its sessions no place that outlives a
 * reboot, so each one picked /tmp.
 *
 * Where: `$XDG_STATE_HOME/open-walnut/tasks/<taskId>`, which is
 * `~/.local/state/open-walnut/tasks/<taskId>` on hosts that do not set
 * XDG_STATE_HOME (macOS and Linux alike). Not /tmp or the OS temp dir (wiped
 * at boot, swept between boots), not the data home (git-sync would carry
 * gigabytes of clones to the hub), not a cache dir (an OS may purge one).
 * WALNUT_TASK_DIR_ROOT replaces the whole root (tests and ephemeral servers
 * point it inside their own temp dir).
 *
 * Pure path logic, shared by the server and the daemon sidecar.
 */
import path from 'node:path'

/** File every task directory carries, so a sweep only ever touches Walnut's own dirs. */
export const TASK_DIR_MARKER = '.walnut-task.json'

/** Days a task directory stays after its task completed (WALNUT_TASK_DIR_KEEP_DAYS overrides). */
export const TASK_DIR_KEEP_DAYS = 7

type Env = Record<string, string | undefined>

export function taskDirRoot(env: Env, home: string): string {
  const override = env.WALNUT_TASK_DIR_ROOT
  if (override && path.isAbsolute(override)) return path.resolve(override)
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : path.join(home, '.local', 'state')
  return path.join(state, 'open-walnut', 'tasks')
}

/** Task ids are uuids or short base36 ids; anything else never becomes a path. */
export function isTaskDirId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes('..')
}

export function taskDirPath(root: string, taskId: string): string | null {
  return isTaskDirId(taskId) ? path.join(root, taskId) : null
}

export function taskDirKeepDays(env: Env): number {
  const n = Number(env.WALNUT_TASK_DIR_KEEP_DAYS)
  return Number.isFinite(n) && n >= 1 ? n : TASK_DIR_KEEP_DAYS
}

/** Days after its task completed before a directory's clean clones and build output go (task-dir-core.ts pruneTaskDirs); 0 turns pruning off. */
export const TASK_DIR_PRUNE_DAYS = 1
/** The same while this machine's disk is low: an hour. Pruning keeps anything unique, so waiting buys nothing then. */
export const TASK_DIR_PRUNE_DAYS_LOW_DISK = 1 / 24

export function taskDirPruneDays(env: Env, lowDisk = false): number {
  const raw = env.WALNUT_TASK_DIR_PRUNE_DAYS
  const n = raw === undefined || raw === '' ? TASK_DIR_PRUNE_DAYS : Number(raw)
  const days = Number.isFinite(n) && n >= 0 ? n : TASK_DIR_PRUNE_DAYS
  return days > 0 && lowDisk ? Math.min(days, TASK_DIR_PRUNE_DAYS_LOW_DISK) : days
}

/**
 * Days a task directory stays unused, whatever its task's phase, before the
 * host drops its build output (task-dir-core.ts pruneTaskBuilds); 0 turns it
 * off. An open task's next build reinstalls what it needs.
 */
export const TASK_DIR_BUILD_IDLE_DAYS = 2
/** The same while this machine's disk is low (under taskDirLowDiskFloorBytes, or disk-watermark.ts warn or critical). */
export const TASK_DIR_BUILD_IDLE_DAYS_LOW_DISK = 0.25

/**
 * Free space under which this machine's disk counts as low for task directories (GiB): the
 * floor under which new work already starts elsewhere (WALNUT_PLACE_MIN_DISK_GB, placement.ts).
 * 2026-11-08: the Mac refilled from 30 to 12 GiB within hours, all of it from tasks still running.
 */
export function taskDirLowDiskFloorBytes(env: Env): number {
  for (const raw of [env.WALNUT_TASK_DIR_LOW_DISK_GB, env.WALNUT_PLACE_MIN_DISK_GB]) {
    const n = raw === undefined || raw === '' ? NaN : Number(raw)
    if (Number.isFinite(n) && n >= 0) return n * 1024 ** 3
  }
  return 20 * 1024 ** 3
}

export function taskDirBuildIdleDays(env: Env, lowDisk = false): number {
  const raw = env.WALNUT_TASK_DIR_BUILD_IDLE_DAYS
  const n = raw === undefined || raw === '' ? TASK_DIR_BUILD_IDLE_DAYS : Number(raw)
  const days = Number.isFinite(n) && n >= 0 ? n : TASK_DIR_BUILD_IDLE_DAYS
  return days > 0 && lowDisk ? Math.min(days, TASK_DIR_BUILD_IDLE_DAYS_LOW_DISK) : days
}
