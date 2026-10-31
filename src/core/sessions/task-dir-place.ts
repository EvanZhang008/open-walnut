/**
 * The server's view of task directories (src/lib/task-dir.ts): which path a
 * task's directory has on a host, and making one on demand.
 *
 * The local host's daemon runs with this server's env and HOME, so the server
 * computes the local path itself. A remote host reports its own root in its
 * hello (`taskDirRoot`, task-dir-v1); until a connection has said so, its path
 * is unknown and callers name only `$WALNUT_TASK_DIR`.
 */
import os from 'node:os'
import path from 'node:path'
import { taskDirPath, taskDirRoot } from '../../lib/task-dir.js'

const isLocal = (host: string | null | undefined) => !host || host === '__local__'

/** Same home the local daemon resolves `~` with (WALNUT_HOME_OVERRIDE is a test's). */
export function localTaskDirRoot(env: NodeJS.ProcessEnv = process.env): string {
  return taskDirRoot(env, env.WALNUT_HOME_OVERRIDE || env.HOME || os.homedir())
}

/** The task's directory on a host, or null when that host has not told its root. */
export async function taskDirForHost(taskId: string, host?: string | null): Promise<string | null> {
  if (!taskId) return null
  let root: string | null = null
  try {
    // The daemon's own word first, for the local host too: a service daemon or
    // one adopted across a server restart may run with another env.
    const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
    root = getConnectedDaemonConnection(isLocal(host) ? '__local__' : host!)?.taskDirRoot ?? null
  } catch { /* no daemon module: tests, a replica */ }
  if (!root && isLocal(host)) root = localTaskDirRoot()
  return root ? taskDirPath(root, taskId) : null
}

export type EnsureTaskDirResult = { path: string; host: string } | { error: string; status: number }

/** Make the task's directory on a host (idempotent) and say where it is. */
export async function ensureTaskDirOnHost(taskId: string, host?: string | null): Promise<EnsureTaskDirResult> {
  if (isLocal(host)) {
    // Through the local daemon when it can (its root is the one sessions get),
    // else in-process with the same rules.
    try {
      const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
      const conn = getConnectedDaemonConnection('__local__')
      if (conn?.hasCapability?.('task-dir-v1')) {
        const { WALNUT_HOME } = await import('../../constants.js')
        const res = await conn.send('taskdir.ensure', { taskId, home: WALNUT_HOME }, 10_000) as { ok?: boolean; path?: unknown }
        if (res?.ok !== false && typeof res?.path === 'string') return { path: res.path, host: '__local__' }
      }
    } catch { /* fall through to in-process */ }
    const { ensureTaskDir } = await import('../../providers/task-dir-core.js')
    const { WALNUT_HOME } = await import('../../constants.js')
    const dir = ensureTaskDir(localTaskDirRoot(), taskId, WALNUT_HOME)
    return dir ? { path: dir, host: '__local__' } : { error: 'the task directory could not be made on this host', status: 500 }
  }
  const { getConfig } = await import('../config-manager.js')
  const { hostEntryOf } = await import('../../replica/self-host.js')
  const hostDef = hostEntryOf((await getConfig()).hosts, host!)
  if (!hostDef?.hostname) return { error: `unknown host ${host}`, status: 404 }
  const { link } = await import('../hosts/link.js')
  const { boundHostRead } = await import('../hosts/remote-read-bound.js')
  return boundHostRead(host!, async () => {
    const conn = await link(host!)
    if (!conn.hasCapability?.('task-dir-v1')) return { error: `the daemon on ${host} is too old for task directories; it upgrades on the next session start`, status: 409 }
    const { WALNUT_HOME } = await import('../../constants.js')
    const res = await conn.send('taskdir.ensure', { taskId, home: WALNUT_HOME }) as { ok?: boolean; path?: unknown; error?: string }
    return res?.ok !== false && typeof res?.path === 'string'
      ? { path: res.path, host: host! }
      : { error: res?.error || 'the host did not make the task directory', status: 502 }
  })
}

/**
 * The folder a local start uses when the task, its parents and its project name none:
 * the task's own directory, made now. It used to be `memory/projects/<project>/`, which
 * left an empty folder in the user's memory tree for every project a session ever
 * started in, test runs' projects included (2026-10-31: "zz test heron 141057" and
 * twenty more on the Memory page). tests/core/memory-tree-writers.test.ts keeps every
 * start path off the memory tree.
 */
export async function localFallbackFolder(taskId: string): Promise<string> {
  const made = await ensureTaskDirOnHost(taskId, '__local__')
  if ('error' in made) throw new Error(`Task ${taskId} has no folder and its task directory could not be made: ${made.error}`)
  return made.path
}

/**
 * A folder a session got only because its task named none: a task's own directory
 * or, for sessions started before 2026-10-31, a project's memory folder. Nobody picks
 * it again: another task never takes it over (a worker filed by a lead in its own
 * directory would work in the lead's), and the launcher never offers it as a
 * frequent directory.
 */
export async function isFallbackFolder(cwd: string, host: string | null | undefined): Promise<boolean> {
  const { PROJECTS_MEMORY_DIR } = await import('../../constants.js')
  const local = isLocal(host)
  if (local && isMemoryProjectFolder(cwd, PROJECTS_MEMORY_DIR)) return true
  const probe = await taskDirForHost('probe', local ? '__local__' : host).catch(() => null)
  return !!probe && path.posix.dirname(cwd.replace(/\/+$/, '')) === path.posix.dirname(probe)
}

/** The same test with no daemon to ask, for this Mac only (a synchronous reader). */
export function isLocalFallbackFolder(cwd: string, projectsMemoryDir: string): boolean {
  if (isMemoryProjectFolder(cwd, projectsMemoryDir)) return true
  return path.dirname(cwd.replace(/\/+$/, '')) === localTaskDirRoot()
}

/** The tree itself or one project's folder in it; a folder the user keeps deeper is theirs. */
function isMemoryProjectFolder(cwd: string, projectsMemoryDir: string): boolean {
  const c = cwd.replace(/\/+$/, '')
  return c === projectsMemoryDir || path.dirname(c) === projectsMemoryDir
}

/**
 * A session whose folder is its task's own directory gets that directory back when
 * the sweep removed it (task-dir-sweep.ts, 7 days after completion): the CLI keeps
 * the conversation under the path, not inside the folder, so the same path resumes
 * it. Any other gone folder stays gone (folder-gone.ts). True when it was remade.
 */
export async function restoreOwnTaskDir(taskId: string, cwd: string, host: string | null | undefined): Promise<boolean> {
  if (!taskId || !cwd) return false
  const own = await taskDirForHost(taskId, host).catch(() => null)
  if (!own || cwd.replace(/\/+$/, '') !== own) return false
  if (isLocal(host)) {
    const fs = await import('node:fs')
    if (fs.existsSync(own)) return false
  }
  const made = await ensureTaskDirOnHost(taskId, host).catch(() => null)
  return !!made && !('error' in made)
}
