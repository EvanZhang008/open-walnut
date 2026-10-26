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
  const { getDaemonConnection } = await import('../../providers/daemon-connection.js')
  const { boundHostRead } = await import('../hosts/remote-read-bound.js')
  const sshTarget = { hostname: hostDef.hostname ?? host!, user: hostDef.user, port: hostDef.port }
  return boundHostRead(host!, async () => {
    const conn = await getDaemonConnection(host!, sshTarget)
    if (!conn.hasCapability?.('task-dir-v1')) return { error: `the daemon on ${host} is too old for task directories; it upgrades on the next session start`, status: 409 }
    const { WALNUT_HOME } = await import('../../constants.js')
    const res = await conn.send('taskdir.ensure', { taskId, home: WALNUT_HOME }) as { ok?: boolean; path?: unknown; error?: string }
    return res?.ok !== false && typeof res?.path === 'string'
      ? { path: res.path, host: host! }
      : { error: res?.error || 'the host did not make the task directory', status: 502 }
  })
}
