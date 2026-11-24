/**
 * The folder a CLI is about to start or resume in, made ready the one way every start takes it,
 * whoever runs the CLI (2026-11-24: a host's resume of a session skipped it; every task whose
 * isolated workspace a completion released, woken later by a message, failed on its host with
 * "Working directory no longer exists" and nothing made the workspace again).
 *
 *   prepareSessionFolder   the task's own directory restored when a sweep removed it, the folder
 *                          checked on its host, and a folder in the task's released workspace made
 *                          again at the same path, waited for (core/workspaces/remake.ts). The
 *                          runner's spawn runs it for a CLI this leader starts.
 *   prepareFolderForHost   the same, on this leader, against the host, before a start or a resume
 *                          is handed to the host that runs the session: a host's service is a
 *                          replica, which cannot make a workspace (remake.ts answers 'no' there).
 *                          Every hand of that kind goes through it
 *                          (tests/providers/host-folder-prep-entry-ratchet.test.ts).
 *   noteHostFolderGone     a host that still refused a start or resume on a gone folder: this leader
 *                          takes the folder-gone way the runner takes for its own (noteFolderGone,
 *                          which makes a released workspace again first, kickRemake).
 */
import { log } from '../logging/index.js'
import { isFolderGoneReason } from '../core/sessions/folder-gone-words.js'
import { sessionPort } from '../core/sessions/session-port.js'
import { checkCwdExists, type CwdCheckResult } from './cwd-check.js'
import type { SshTarget } from './session-io.js'

export interface FolderPrep {
  taskId?: string | null
  cwd: string
  /** The host the CLI runs on (null or undefined: this machine). */
  host?: string | null
  sshTarget?: SshTarget
  /** The spawn's step clock (its timing breakdown). */
  onStep?: (step: 'taskDirMs' | 'cwdCheckMs') => void
  /**
   * How long to wait here for a remake (default SPAWN_WAIT_MS, the spawn's). 0: ask for it and
   * return at once; the caller hands the wait to the background remake (kickRemake).
   */
  remakeWaitMs?: number
}

/** What a preparation found: the folder is there (ok), or why not, and what became of its remake. */
export type FolderPrepResult = CwdCheckResult & {
  /** A remake was asked for: 'pending' still on its way, 'no' not a workspace this Walnut can make. */
  remake?: 'present' | 'pending' | 'no'
}

/** Restore, check, and remake: the folder is there (ok), or why not, in the spawn's own words. */
export async function prepareSessionFolder(p: FolderPrep): Promise<FolderPrepResult> {
  const host = p.host ?? undefined
  if (p.taskId) {
    const { restoreOwnTaskDir } = await sessionPort().launch.loadTaskDirPlace()
    await restoreOwnTaskDir(p.taskId, p.cwd, host).catch(() => false)
  }
  p.onStep?.('taskDirMs')
  let check: FolderPrepResult = await checkCwdExists(p.cwd, host, p.sshTarget)
  // A folder in the task's isolated workspace, which a cleanup removed after the task was
  // completed: the workspace is made again at the same path and the start waits for it, so a
  // message to a woken task runs instead of parking.
  if (!check.ok && p.taskId && isFolderGoneReason(check.error)) {
    const { remakeForGoneFolder, SPAWN_WAIT_MS } = await import('../core/workspaces/remake.js')
    const remade = await remakeForGoneFolder(p.taskId, p.cwd, host, { waitMs: p.remakeWaitMs ?? SPAWN_WAIT_MS, resume: true }).catch(() => 'no' as const)
    check = remade === 'present' ? await checkCwdExists(p.cwd, host, p.sshTarget) : { ...check, remake: remade }
  }
  p.onStep?.('cwdCheckMs')
  return check
}

const isLocalHost = (h: string | null | undefined): boolean => !h || h === '__local__' || h === 'local'

/** The transport target of `host` from config, or undefined (unknown host: it cannot be asked). */
async function targetOf(host: string): Promise<SshTarget | undefined> {
  try {
    const { getConfig } = await sessionPort().config.loadConfigManager()
    const config = await getConfig()
    if (!config.hosts || !Object.hasOwn(config.hosts, host)) return undefined
    const { linkTarget } = await import('../core/hosts/link.js')
    return linkTarget(host, config)
  } catch {
    return undefined
  }
}

/**
 * Before a start or a resume of a CLI is handed to the host that runs it: prepareSessionFolder on
 * this leader, against that host. `host` is the row's (or the start's) own host name, the one the
 * task's workspace was made on. ok: hand it on. Not ok: the folder is gone and was not made again
 * (the caller takes the folder-gone way here, as the runner's spawn does).
 * A folder this leader cannot ask about (no folder named, not an absolute path, a host it has no
 * target for) is the host's to judge: ok.
 */
export async function prepareFolderForHost(sid: string | null, p: { taskId?: string | null; cwd?: string | null; host: string; remakeWaitMs?: number }): Promise<FolderPrepResult> {
  const cwd = p.cwd ?? ''
  if (!cwd.startsWith('/')) return { ok: true }
  const sshTarget = isLocalHost(p.host) ? undefined : await targetOf(p.host)
  // checkCwdExists reads this machine's disk without a target: never for another host's folder.
  if (!isLocalHost(p.host) && !sshTarget) return { ok: true }
  const check = await prepareSessionFolder({ taskId: p.taskId, cwd, host: isLocalHost(p.host) ? null : p.host, sshTarget, ...(p.remakeWaitMs !== undefined ? { remakeWaitMs: p.remakeWaitMs } : {}) })
  if (!check.ok) log.session.warn('host session: its folder is gone and is not there yet; nothing is handed to its host', { sessionId: sid, taskId: p.taskId, host: p.host, cwd, error: check.error, remake: check.remake })
  return check
}

/** A CLI of the session runs on its host now (its row says so): a send reaches it, no start. */
const liveOnHost = (status: string | undefined): boolean => status === 'running' || status === 'idle'

/**
 * prepareFolderForHost for a session its host runs and judges, from its row: a wake of its CLI (a
 * send whose lines run, a Restart). A session whose CLI runs is not asked (its folder is there).
 * `folder` names what was checked, for the caller's folder-gone way.
 */
export async function prepareHostSessionFolder(sid: string, host: string, o: { remakeWaitMs?: number } = {}): Promise<FolderPrepResult & { folder?: { cwd: string; host: string } }> {
  const { getSessionByClaudeId } = await sessionPort().records.loadTracker()
  const row = await getSessionByClaudeId(sid).catch(() => null)
  if (!row?.cwd || liveOnHost(row.process_status)) return { ok: true }
  const rowHost = row.host ?? host
  const check = await prepareFolderForHost(sid, { taskId: row.taskId, cwd: row.cwd, host: rowHost, ...o })
  return check.ok ? check : { ...check, folder: { cwd: row.cwd, host: rowHost } }
}

/**
 * A host that runs `sid` refused its start or resume on a gone folder (its session:error over the
 * channel): this leader records it the runner's way (noteFolderGone, which makes a folder in the
 * task's released workspace again first and sends what waited once it is there).
 */
export async function noteHostFolderGone(sid: string, error: unknown): Promise<void> {
  if (!sid || !isFolderGoneReason(error)) return
  const { judgingHostOf } = await import('../core/sessions/judge-of.js')
  if (!judgingHostOf(sid)) return
  const { noteFolderGone } = await sessionPort().recovery.loadFolderGone()
  await noteFolderGone(sid).catch(() => null)
}
