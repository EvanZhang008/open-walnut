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
