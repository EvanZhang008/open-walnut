/**
 * A session whose working folder is gone keeps working (2026-10-30, the user: "if a
 * folder is gone ... as long as Claude Code has the chat history, we can show a button:
 * this can't be found any more, but we found your conversation history ... don't
 * recreate the original folder ... let it continue working").
 *
 * Claude Code keeps a conversation at `<projects>/<encoded cwd>/<sid>.jsonl`, and a
 * resume runs in a directory, so a session whose folder was deleted (a reboot emptied
 * /tmp, the user moved a notes folder) could never run again: every start, resume,
 * Retry and delivery stopped at the spawn's folder check. Walnut never recreates the
 * old folder. Instead:
 *
 *  - every refusal of that kind records `record.cwdGone` (noteFolderGone): the folder,
 *    whether the conversation's history is still on the host, and the folder the session
 *    would move to, the task's own directory (src/lib/task-dir.ts, which outlives a
 *    reboot). The session panel, the undelivered message row and the toast read it and
 *    offer one button;
 *  - the button (continueInNewFolder) moves the transcript to where the CLI looks for the
 *    new folder (the official layout: a resume in that folder finds it there, with every
 *    CLI version), points the session at the new folder, and sends the messages that
 *    waited, the first of them carrying a notice that the folder moved;
 *  - when the history itself is gone too, the same button starts a new conversation for
 *    the task in its directory, carrying the waiting messages and what Walnut recorded.
 *
 * ACP engines (Codex and the rest) keep their history by thread id, not by folder, so
 * they only change folder. Host-local reads and moves go through the host's daemon.
 */
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { log } from '../../logging/index.js'
import type { SessionRecord } from '../types.js'
import { SessionControlError } from './session-controls.js'
import { createEnvelopeKit } from '../peers/envelope-kit.js'
import { DEFAULT_ENGINE, engineCaps } from '../agents/engine-registry.js'

const kit = createEnvelopeKit()

export type CwdGone = NonNullable<SessionRecord['cwdGone']>
export type FolderState = 'present' | 'gone' | 'unknown'

export const isLocal = (host?: string | null) => !host || host === '__local__'
const PROBE_MS = 5_000

import { frameAsWalnut } from './send-frame.js'
import { readHostOf } from './session-row-owner.js'
import { goesOnFolder, stopFenceOf, type FolderWaitPick } from './folder-wait.js'
export { FOLDER_GONE_RE, isFolderGoneReason } from './folder-gone-words.js'

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

/** Whether a folder exists on a host: 'unknown' when the host could not be asked. */
export async function folderState(cwd: string, host?: string | null): Promise<FolderState> {
  if (!cwd) return 'gone'
  try {
    if (isLocal(host)) {
      const fsp = await import('node:fs/promises')
      const st = await fsp.stat(cwd)
      return st.isDirectory() ? 'present' : 'gone'
    }
    const { DaemonFileReader } = await import('../daemon-file-reader.js')
    const st = await withTimeout(new DaemonFileReader(host!).stat(cwd), PROBE_MS)
    return st ? 'present' : 'gone'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'gone'
    return 'unknown'
  }
}

/**
 * A new task's start folder that is gone, said for the person (null: it is there, or nobody can
 * tell now). quickStartSession asks it before it files a task (2026-11-23: a project's own folder
 * had been deleted on the Mac; the task was made, its session never started, and the draft said
 * nothing). `~` is everyone's home and is never asked.
 */
export async function missingStartFolder(cwd: string, host?: string | null): Promise<string | null> {
  if (!cwd || cwd === '~' || cwd.startsWith('~/')) return null
  if ((await folderState(cwd, host)) !== 'gone') return null
  return isLocal(host) ? `The folder ${cwd} is gone. Pick another folder.` : `The folder ${cwd} is gone on ${host}. Pick another folder.`
}

/** Whether the session's engine keeps its history in a folder-keyed transcript (Claude Code). */
export function historyInFolder(record: Pick<SessionRecord, 'engine' | 'provider'>): boolean {
  if (record.provider && record.provider !== 'cli') return false
  // An engine this build does not know is not read as Claude-shaped (engineCaps degrades
  // unknowns to Claude defaults; session-lifecycle.ts resumeConversationExists).
  if (record.engine && record.engine !== DEFAULT_ENGINE) return false
  return engineCaps(record.engine).historySource === 'provider-jsonl'
}

/** Where the session's Claude Code transcript is on its host, wherever its project dir is. */
export async function findTranscript(record: Pick<SessionRecord, 'claudeSessionId' | 'cwd' | 'host'>): Promise<{ state: 'found'; path: string } | { state: 'missing' } | { state: 'unknown' }> {
  const at = readHostOf(record)
  try {
    if (isLocal(at)) {
      const { findLocalJsonlPath } = await import('../session-file-reader.js')
      const p = await findLocalJsonlPath(record.claudeSessionId, record.cwd ?? undefined)
      return p ? { state: 'found', path: p } : { state: 'missing' }
    }
    const { DaemonFileReader } = await import('../daemon-file-reader.js')
    const p = await withTimeout(new DaemonFileReader(at!).findSessionPath(record.claudeSessionId), PROBE_MS * 2)
    return p ? { state: 'found', path: p } : { state: 'missing' }
  } catch (err) {
    log.session.warn('folder gone: transcript probe failed', { sessionId: record.claudeSessionId, host: record.host, error: err instanceof Error ? err.message : String(err) })
    return { state: 'unknown' }
  }
}

/**
 * Record that a start or resume of `sessionId` found its folder gone. Re-checks the folder
 * first (a refusal from a stale cache must not mark a live folder), never throws, and
 * returns what it recorded.
 */
export function noteFolderGone(sessionId: string, opts: { cwd?: string | null; host?: string | null; remake?: false } = {}): Promise<CwdGone | null> {
  // One refusal reaches this from more than one place (the spawn's catch and the queue's
  // settle): they share one probe.
  // A remake's own fallback (remake: false) is not folded into the refusal it follows.
  const key = opts.remake === false ? `${sessionId}\0no-remake` : sessionId
  const running = noting.get(key)
  if (running) return running
  const p = noteFolderGoneNow(sessionId, opts).finally(() => setTimeout(() => { if (noting.get(key) === p) noting.delete(key) }, 2_000).unref?.())
  noting.set(key, p)
  return p
}
const noting = new Map<string, Promise<CwdGone | null>>()

async function noteFolderGoneNow(sessionId: string, opts: { cwd?: string | null; host?: string | null; remake?: false }): Promise<CwdGone | null> {
  try {
    const { getSessionByClaudeId, updateSessionRecordConditionally } = await import('../session-tracker.js')
    const record = await getSessionByClaudeId(sessionId)
    if (!record) return null
    // A refusal of a spawn in a folder the session no longer uses (it moved while that
    // spawn was on its way) says nothing about where it runs now.
    if (opts.cwd && record.cwd && opts.cwd !== record.cwd) return null
    const cwd = opts.cwd ?? record.cwd
    if (!cwd) return null
    const host = opts.host !== undefined ? opts.host : record.host
    const state = await folderState(cwd, host)
    // Back already. A remake of the task's workspace that ended while these lines were being parked
    // (its own send found nothing yet): what waits on it goes out now, as the button does, so no
    // line stays parked behind a folder that is there. Any other present folder only loses its mark:
    // a refusal this check contradicts is never sent again by itself (no loop on a stale refusal).
    if (state === 'present') {
      const remake = await import('../workspaces/remake.js')
      if (record.taskId && await remake.remadeHolds(record.taskId, cwd, host).catch(() => false)) await folderIsBack(sessionId, record.taskId)
      else await clearFolderGone(sessionId)
      return null
    }
    if (state !== 'gone') return null
    // A folder in the task's own workspace, which a cleanup removed: it is made again and what
    // waited goes out then, so nothing is offered (workspaces/remake.ts).
    if (record.taskId && opts.remake !== false) {
      const { kickRemake } = await import('../workspaces/remake.js')
      if (await kickRemake(record.taskId, sessionId, cwd, host).catch(() => false)) return null
    }
    const history: CwdGone['history'] = historyInFolder(record)
      ? (await findTranscript({ ...record, cwd })).state
      : 'found'
    let newCwd: string | undefined
    if (record.taskId) {
      const { taskDirForHost } = await import('./task-dir-place.js')
      newCwd = (await taskDirForHost(record.taskId, host).catch(() => null)) ?? undefined
    }
    const cwdGone: CwdGone = { cwd, at: new Date().toISOString(), history, ...(newCwd ? { newCwd } : {}) }
    const written = await updateSessionRecordConditionally(sessionId, { cwdGone }, (current) => current.cwd === record.cwd, { preserveLastActiveAt: true })
    if (!written) return null
    log.session.info('folder gone: recorded', { sessionId, taskId: record.taskId, cwd, history, newCwd })
    if (record.taskId) {
      const { getTask, updateTask } = await import('../task-manager.js')
      const task = await getTask(record.taskId).catch(() => null)
      if (task && task.cwd === cwd && !task.cwd_missing) {
        await updateTask(task.id, { cwd_missing: true }, { source: 'folder-gone' }).catch(() => {})
      }
    }
    return cwdGone
  } catch (err) {
    log.session.warn('folder gone: recording failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** The folder is there again (restored, remounted) or the session runs elsewhere now: no banner. */
export async function clearFolderGone(sessionId: string | null | undefined): Promise<void> {
  if (!sessionId) return
  try {
    const { getSessionByClaudeId, updateSessionRecordConditionally } = await import('../session-tracker.js')
    const record = await getSessionByClaudeId(sessionId)
    if (!record?.cwdGone) return
    await updateSessionRecordConditionally(sessionId, { cwdGone: undefined }, (current) => current.cwdGone?.at === record.cwdGone?.at, { preserveLastActiveAt: true })
  } catch { /* the banner stays until the next start answers */ }
}

/** The notice the session reads in its next message, once. */
export function folderMovedNotice(moved: { from: string; to: string }, kind: 'kept' | 'fresh' | 'own-folder', extra?: { recorded?: string }): string {
  const body = kind === 'own-folder'
    ? `Walnut moved this conversation from ${moved.from} to ${moved.to}, this task's own directory, which survives reboots. `
      + `A VP or lead runs in a folder of its own, so no repository's instruction files (CLAUDE.md, AGENTS.md, its memory) load into every request. `
      + `Nothing in ${moved.from} changed: read it by its absolute path when you need to, and hand work in it to a team (task_send, task_create).`
    : kind === 'kept'
    ? `Your working folder ${moved.from} no longer exists. Walnut did not recreate it: this conversation now continues in ${moved.to}, this task's own directory, which survives reboots. `
      + `Files that were in the old folder are not here; before you rely on a path under ${moved.from}, find out where its files went (the user may have moved or deleted them).`
    : `This task's earlier conversation could not be continued: its working folder ${moved.from} no longer exists, and neither does that conversation's history, so this is a new conversation. `
      + `You run in ${moved.to}, this task's own directory, which survives reboots. Walnut did not recreate the old folder.`
      + (extra?.recorded ? `\n\nWhat Walnut recorded about the earlier work:\n${extra.recorded}` : '')
      + `\n\nWhat follows was sent to the earlier conversation.`
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', outcome: 'folder-moved', note: 'automated Walnut status notice' },
    body,
  })
}

export type ContinueResult =
  /** Same conversation, new folder; `sent` = waiting messages now on their way. */
  | { status: 'continued'; sessionId: string; cwd: string; from: string; history: 'kept'; sent: number }
  /** The history was gone: a new conversation for the task starts in the new folder. */
  | { status: 'started'; oldSessionId: string; sessionId: string; taskId: string; cwd: string; from: string; history: 'fresh'; carried: number }

/**
 * The button: continue `sessionId` in its task's own directory, its old folder being gone.
 * Refuses (SessionControlError) a folder that is still there, a host that cannot be asked,
 * and a session whose process still runs.
 */
export function continueInNewFolder(sessionId: string, opts: { by?: string; pick?: FolderWaitPick } = {}): Promise<ContinueResult> {
  // The banner and the message row offer the same button: a second press while the
  // first moves the files gets the first one's answer, never a half-moved second try.
  const running = continuing.get(sessionId)
  if (running) return running
  const p = continueNow(sessionId, opts).finally(() => { if (continuing.get(sessionId) === p) continuing.delete(sessionId) })
  continuing.set(sessionId, p)
  return p
}
const continuing = new Map<string, Promise<ContinueResult>>()

async function continueNow(sessionId: string, opts: { by?: string; pick?: FolderWaitPick }): Promise<ContinueResult> {
  const by = opts.by ?? 'human'
  // A person's press sends every row that waited on the folder; Walnut's own (a remake's end) only
  // the rows that wait by the rule (folder-wait.ts), never an old one a person may have sent again,
  // unless a person pressed while that remake was on its way (`pick`, remake.ts resumeAfterRemake).
  const pick: FolderWaitPick = opts.pick ?? (by.startsWith('walnut:') ? 'waited' : 'all')
  const { getSessionByClaudeId, updateSessionRecord, emitSessionStatusChanged } = await import('../session-tracker.js')
  const record = await getSessionByClaudeId(sessionId)
  if (!record) throw new SessionControlError('Session not found', 404)
  if (record.archived) throw new SessionControlError('This session is archived; its task has a newer one', 409, { code: 'archived' })
  if (!record.taskId) throw new SessionControlError('Session has no task, so it has no task directory to move to', 400)
  const from = record.cwd ?? ''
  if (!from) throw new SessionControlError('This session has no working folder recorded', 400)
  let state = await folderState(from, record.host)
  // A folder in the task's own workspace, which a cleanup removed: made again where it was,
  // and the session continues there (workspaces/remake.ts); any other folder is never recreated.
  const remake = await import('../workspaces/remake.js')
  if (state === 'gone') {
    // A short wait: a route answers, it never hangs (the remake's end sends what waits).
    const remade = await remake.remakeForGoneFolder(record.taskId, from, record.host, { waitMs: remake.BUTTON_WAIT_MS, resume: true })
    if (remade === 'present') state = 'present'
    // The press is kept on the remake, so its end sends all that waited, as this answer promises.
    // Not kept (the remake ended between its answer and the note): the folder is looked at again,
    // and a folder there now sends them all below, as the press does.
    if (remade === 'pending' && pick === 'all' && !await remake.notePressedDuringRemake(record.taskId, sessionId)
      && await folderState(from, record.host) === 'present') state = 'present'
    else if (remade === 'pending') throw new SessionControlError(`Walnut is making this task's workspace again at ${from}; the waiting messages go out when it is ready`, 409, { code: 'workspace_remaking' })
  }
  if (state === 'present') {
    // Pressed twice, or the folder came back: whatever still waits on a gone folder goes
    // out now, so the button never leaves a message stuck behind a refusal.
    const sent = await folderIsBack(sessionId, record.taskId, { pick })
    if (sent > 0) return { status: 'continued', sessionId, cwd: from, from: record.folderMoved?.from ?? from, history: 'kept', sent }
    throw new SessionControlError(`The folder ${from} is there; send a message to continue in it`, 409, { code: 'folder_present' })
  }
  if (state === 'unknown') throw new SessionControlError(`Could not ask ${record.host} whether ${from} still exists; try again when the host answers, or move the task to another host (task_move)`, 503, { code: 'host_unreachable' })
  // A pid probe answers for a Claude Code CLI; an ACP engine has no pid to probe (the
  // probe says "alive" for it), so its record's own word decides.
  const { isSessionProcessAlive } = await import('../../utils/session-liveness.js')
  const alive = historyInFolder(record)
    ? await isSessionProcessAlive(record).catch(() => false)
    : record.process_status === 'running'
  if (alive) {
    throw new SessionControlError('This session\'s process is still running in the deleted folder; stop it first, then continue it in a new folder', 409, { code: 'session_running' })
  }

  const { ensureTaskDirOnHost } = await import('./task-dir-place.js')
  const made = await ensureTaskDirOnHost(record.taskId, record.host)
  if ('error' in made) throw new SessionControlError(made.error, made.status, { code: 'task_dir' })
  const to = made.path

  if (historyInFolder(record)) {
    const moved = await moveConversation(record, to)
    if (moved === 'unknown') throw new SessionControlError(`Could not look for this conversation's history on ${record.host ?? 'this machine'}; try again, or move the task to another host (task_move)`, 503, { code: 'host_unreachable' })
    if (moved === 'missing') return startFresh(record, from, to, by, pick)
  }

  const at = new Date().toISOString()
  // Told now when a waiting message will carry the notice (sendWaiting below), so a send
  // arriving meanwhile does not carry a second one.
  const { getQueue } = await import('../session-message-queue.js')
  const fence = await stopFenceOf(sessionId)
  const willCarry = (await getQueue(sessionId)).some((m) => goesOnFolder(m, pick, fence))
  const updated = await updateSessionRecord(sessionId, {
    cwd: to,
    cwdGone: undefined,
    folderMoved: { from, to, at, by, ...(willCarry ? { told: true } : {}) },
    errorMessage: undefined,
    errorKind: undefined,
    ...(record.process_status === 'error' ? { process_status: 'stopped' as const, status_reason: 'retry_reconnect' as const, status_changed_by: 'user' as const, last_status_change: at } : {}),
  } as Partial<SessionRecord>)
  emitSessionStatusChanged(updated, {}, ['*'])
  try {
    const { sessionRunner } = await import('../../providers/claude-code-session.js')
    sessionRunner.adoptNewCwd(sessionId, to)
  } catch { /* no runner in this process (a replica, a test): the record decides the next spawn */ }
  await moveTaskCwd(record.taskId, from, to)

  const sent = await sendWaiting(sessionId, record.taskId, folderMovedNotice({ from, to }, 'kept'), undefined, pick)
  // Nothing waited after all (it went meanwhile): the next message carries the notice.
  if (willCarry && sent === 0) await updateSessionRecord(sessionId, { folderMoved: { from, to, at, by } }).catch(() => {})
  log.session.info('folder gone: continued in a new folder', { sessionId, taskId: record.taskId, from, to, sent, by })
  return { status: 'continued', sessionId, cwd: to, from, history: 'kept', sent }
}

/**
 * Move a Claude Code session's conversation to where a resume in `to` finds it: its transcript
 * (wherever its project dir is) and the `<sid>/` sidecar, through the host's daemon. 'in-place'
 * (it is already there: another spawn moved it), 'missing' and 'unknown' (the host could not be
 * asked) move nothing; a conflict throws. Shared by the gone folder's button and the VP's move to
 * its own folder (org-own-folder.ts). The CLI must not be running: it appends to the transcript
 * by path.
 */
export async function moveConversation(record: SessionRecord, to: string): Promise<'moved' | 'in-place' | 'missing' | 'unknown'> {
  const found = await findTranscript(record)
  if (found.state !== 'found') return found.state
  return await moveTranscript(record, found.path, to) ? 'moved' : 'in-place'
}

/**
 * Move the transcript (and its sidecar dir) into the new folder's project dir, through the host's
 * daemon. False: it was there already, nothing moved.
 */
async function moveTranscript(record: SessionRecord, found: string, to: string): Promise<boolean> {
  const { encodeProjectPath, isSafeForProjectEncoding } = await import('../session-file-reader.js')
  if (!isSafeForProjectEncoding(to)) throw new SessionControlError(`The task directory ${to} is too long a path for Claude Code's history layout`, 500)
  const sid = record.claudeSessionId
  const projectsRoot = path.posix.dirname(path.posix.dirname(found))
  // The CLI names a project dir by the folder's real path (macOS /tmp is /private/tmp).
  const at = readHostOf(record)
  const realOf = async (p: string) => isLocal(at)
    ? await (await import('node:fs/promises')).realpath(p).catch(() => p)
    : await (await import('../transfer/daemon-transfer-client.js')).realpathOn(at!, p).catch(() => p)
  const targetDir = `${projectsRoot}/${encodeProjectPath(await realOf(to))}`
  const target = `${targetDir}/${sid}.jsonl`
  const reader = isLocal(at) ? await localFiles() : new (await import('../daemon-file-reader.js')).DaemonFileReader(at!)
  const conflict = (a: string, b: string) => new SessionControlError(`This conversation's history is in two places (${a} and ${b}); Walnut moved neither. Keep the one you want and try again.`, 409, { code: 'history_conflict', files: [a, b] })
  if (found === target) {
    // Already there, unless a copy is also where the session ran (the lookup may find either).
    const source = record.cwd ? `${projectsRoot}/${encodeProjectPath(await realOf(record.cwd))}/${sid}.jsonl` : null
    if (source && source !== target && await reader.stat(source).catch(() => null)) throw conflict(source, target)
    return false
  }
  await reader.ensureDir(targetDir)
  // Never over another file. The CLI resumes the copy in its own folder's project dir
  // first, so two copies would quietly continue the older one: say so instead.
  if (await reader.stat(target)) throw conflict(found, target)
  await reader.renamePath(found, target)
  // Subagent transcripts, tool results and workflow manifests live beside it, under <sid>/.
  const sidecar = `${path.posix.dirname(found)}/${sid}`
  if (await reader.stat(sidecar).catch(() => null) && !(await reader.stat(`${targetDir}/${sid}`).catch(() => null))) {
    await reader.renamePath(sidecar, `${targetDir}/${sid}`).catch((err) => log.session.warn('folder gone: sidecar move failed (the conversation itself moved)', {
      sessionId: sid, error: err instanceof Error ? err.message : String(err),
    }))
  }
  log.session.info('folder gone: transcript moved', { sessionId: sid, host: record.host ?? '__local__', from: found, to: target })
  return true
}

/** This machine's files, in the shape moveTranscript uses for a host's (the server owns this disk). */
async function localFiles() {
  const fsp = await import('node:fs/promises')
  return {
    ensureDir: async (p: string) => { await fsp.mkdir(p, { recursive: true }) },
    stat: async (p: string) => fsp.lstat(p).then(() => ({}), () => null),
    renamePath: async (from: string, to: string) => {
      // Never over an existing path (the daemon's fs.rename refuses one the same way).
      if (await fsp.lstat(to).then(() => true, () => false)) throw new Error(`fs.rename failed: target already exists (EEXIST): ${to}`)
      await fsp.rename(from, to)
    },
  }
}

/** A task whose own folder was the gone one moves with its session. */
async function moveTaskCwd(taskId: string, from: string, to: string): Promise<void> {
  try {
    const { getTask, updateTask } = await import('../task-manager.js')
    const task = await getTask(taskId)
    if (task.cwd === from) await updateTask(taskId, { cwd: to }, { source: 'folder-gone' })
  } catch { /* the task's own folder is unchanged */ }
}

/**
 * Put the session's waiting messages back in line with `notice` in front of the first one,
 * and kick a delivery. Returns how many go out.
 */
/**
 * The folder is there again: the mark goes and what waited on it goes out, a moved workspace's
 * notice first. The button's answer for a folder that is present, and the start's own look
 * (folder-back.ts), which passes `since` so only what was parked from then on goes.
 */
export async function folderIsBack(sessionId: string, taskId: string, opts: { since?: number; pick?: FolderWaitPick } = {}): Promise<number> {
  await clearFolderGone(sessionId)
  const remake = await import('../workspaces/remake.js')
  const notice = await remake.workspaceRemakeNotice(sessionId)
  const sent = await sendWaiting(sessionId, taskId, notice?.text ?? null, opts.since, opts.pick ?? 'waited')
  if (sent > 0 && notice) await notice.markTold()
  await remake.settleRemakeResume(taskId)
  return sent
}

async function sendWaiting(sessionId: string, taskId: string, notice: string | null, since: number | undefined, pick: FolderWaitPick): Promise<number> {
  const here = await sendWaitingHere(sessionId, taskId, notice, since, pick)
  // A session its host runs: what its host parked on the folder waits there (its own queue).
  return here + await sendWaitingOnHost(sessionId, here > 0 ? null : notice, since, pick)
}

/**
 * The host that runs `sessionId` sends what it parked on the gone folder (host-lifecycle.ts
 * sendFolderWaiting). 0 for a session this server runs, or a host that could not be asked (an older
 * one answers no_such_member): logged, its rows wait for the button there.
 */
async function sendWaitingOnHost(sessionId: string, notice: string | null, since: number | undefined, pick: FolderWaitPick): Promise<number> {
  const { judgingHostOf } = await import('./judge-of.js')
  if (!judgingHostOf(sessionId)) return 0
  try {
    const { onJudgingHost } = await import('./host-judged-controls.js')
    // `pick` is a fourth argument: a host before it ignores it and sends every row on the folder.
    const sent = await onJudgingHost(sessionId, 'sendFolderWaiting', [notice, since ?? null, pick])
    return typeof sent === 'number' ? sent : 0
  } catch (err) {
    log.session.warn('folder gone: the host that runs the session did not send what waited on the folder (a host before this step answers no_such_member: its rows wait there until it is updated, or for the button)', { sessionId, error: err instanceof Error ? err.message : String(err) })
    return 0
  }
}

/**
 * On the host that runs `sessionId` (its leader's sendWaiting asks it, host-lifecycle.ts): the
 * folder is there again, so its mark goes and what this host parked on it goes out. `pick` 'all'
 * only for a person's press on the leader; a leader before the argument leaves it out, which reads
 * as Walnut's own ('waited').
 */
export async function sendFolderWaiting(sessionId: string, notice?: string | null, since?: number | null, pick?: string | null): Promise<number> {
  const { getSessionByClaudeId } = await import('../session-tracker.js')
  const record = await getSessionByClaudeId(sessionId)
  if (!record) return 0
  await clearFolderGone(sessionId)
  return sendWaitingHere(sessionId, record.taskId ?? '', typeof notice === 'string' && notice ? notice : null, typeof since === 'number' ? since : undefined, pick === 'all' ? 'all' : 'waited')
}

async function sendWaitingHere(sessionId: string, taskId: string, notice: string | null, since: number | undefined, pick: FolderWaitPick): Promise<number> {
  const { getQueue, unparkMessage } = await import('../session-message-queue.js')
  const { mutateStore } = await import('../session-queue-store.js')
  // A Stop not settled yet: Walnut sends nothing by itself (a person's press still goes, as a Retry).
  const fence = await stopFenceOf(sessionId)
  if (fence === undefined && pick === 'waited') return 0
  const rows = (await getQueue(sessionId)).filter((m) => goesOnFolder(m, pick, fence ?? null))
    .filter((m) => since === undefined || m.status === 'pending' || Date.parse((m as { parkedAt?: string }).parkedAt ?? '') >= since)
  if (rows.length === 0) return 0
  const first = rows[0]
  if (notice) {
    await mutateStore((s) => {
      const row = s.queues[sessionId]?.find((m) => m.id === first.id)
      const outcome = /outcome="([^"]+)"/.exec(notice)?.[1]
      if (row && !(outcome && row.message.includes(`outcome="${outcome}"`))) row.message = `${notice}\n\n${row.message}`
    })
  }
  // Counted as they really go: a row another path took or removed meanwhile is not one of them.
  let sent = rows.filter((m) => m.status === 'pending').length
  for (const row of rows) if (row.status === 'parked' && await unparkMessage(sessionId, row.id)) sent++
  if (sent === 0) return 0
  const { bus, EventNames } = await import('../event-bus.js')
  bus.emit(EventNames.SESSION_SEND, { sessionId, taskId, message: '' }, ['session-runner'], { source: 'folder-moved' })
  return sent
}

/** History gone too: a new conversation for the task in the new folder, carrying what waited. */
async function startFresh(record: SessionRecord, from: string, to: string, by: string, pick: FolderWaitPick): Promise<ContinueResult> {
  const sid = record.claudeSessionId
  const { getTask, clearSession, clearSessionSlot } = await import('../task-manager.js')
  const task = await getTask(record.taskId!).catch(() => null)
  if (!task) throw new SessionControlError('Associated task not found', 404)
  const { getQueue, deleteMessage } = await import('../session-message-queue.js')
  const { stripInstructionNotice } = await import('./instruction-notice.js')
  const fence = await stopFenceOf(sid)
  const rows = (await getQueue(sid)).filter((m) => goesOnFolder(m, pick, fence ?? null))
  const waiting = rows.map((m) => stripInstructionNotice(m.message)).filter(Boolean).join('\n\n')
  const recorded = [task.summary, record.title && !task.summary ? `Earlier session: ${record.title}` : ''].filter(Boolean).join('\n').slice(0, 4000)
  const message = `${folderMovedNotice({ from, to }, 'fresh', { recorded })}\n\n${waiting || frameAsWalnut('Continue this task.', 'folder moved')}`
  const { updateSessionRecord } = await import('../session-tracker.js')
  // One session per task: the old one is detached (kept as the task's history) first.
  await updateSessionRecord(sid, { archived: true, archive_reason: 'folder_and_history_gone' } as Partial<SessionRecord>)
  await clearSession(task.id, sid).catch(() => {})
  await clearSessionSlot(task.id, sid).catch(() => {})
  const { detachTaskSession } = await import('./task-session-claim.js')
  await detachTaskSession(task.id, sid, 'its folder and its history are gone; continued in a new conversation')
  const newId = randomUUID()
  try {
    const { sessionRunner } = await import('../../providers/claude-code-session.js')
    // Awaited to the spawn: the waiting messages leave the old session only once the new
    // one has them.
    await sessionRunner.startSession({
      taskId: task.id,
      message,
      // A notice, then the rows that waited as they were stored (a task's rows kept their frame).
      attributed: true,
      attributionSource: 'folder-gone:stored-rows',
      cwd: to,
      project: task.project ?? '',
      ...(record.mode && record.mode !== 'default' ? { mode: record.mode } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(record.host ? { host: record.host } : {}),
      preassignedSessionId: newId,
    })
  } catch (err) {
    await relinkTaskSession(task.id, sid)
    const why = err instanceof Error ? err.message : String(err)
    log.session.warn('folder gone: the new conversation did not start; the old session is back', { sessionId: sid, taskId: task.id, error: why })
    throw new SessionControlError(`The new conversation did not start (${why}). The waiting messages are kept; try again.`, 502, { code: 'start_failed' })
  }
  const at = new Date().toISOString()
  await updateSessionRecord(sid, { cwdGone: undefined, folderMoved: { from, to, at, by, told: true } } as Partial<SessionRecord>).catch(() => {})
  await moveTaskCwd(task.id, from, to)
  // The messages rode the new conversation's first message; the old rows are done.
  for (const m of rows) {
    await deleteMessage(sid, m.id, { exit: { step: 'written', via: 'start', why: `its words rode the first line of the new conversation ${newId}` } }).catch(() => false)
  }
  log.session.info('folder gone: history gone too, started a new conversation', { oldSessionId: sid, sessionId: newId, taskId: task.id, from, to, carried: rows.length, by })
  return { status: 'started', oldSessionId: sid, sessionId: newId, taskId: task.id, cwd: to, from, history: 'fresh', carried: rows.length }
}

/** Undo startFresh's detach: the old session is the task's again, unarchived. */
async function relinkTaskSession(taskId: string, sid: string): Promise<void> {
  try {
    const { updateSessionRecord } = await import('../session-tracker.js')
    await updateSessionRecord(sid, { taskId, legacyTaskId: undefined, archived: false, archive_reason: undefined } as Partial<SessionRecord>)
    const { updateTaskRaw } = await import('../task-manager.js')
    await updateTaskRaw(taskId, (cur) => ({
      session_ids: [...new Set([...(cur.session_ids ?? []), sid])],
      legacy_session_ids: (cur.legacy_session_ids ?? []).filter((x) => x !== sid),
      ...(cur.session_id ? {} : { session_id: sid }),
    }), { source: 'folder-gone', push: false })
  } catch (err) {
    log.session.warn('folder gone: relinking the old session failed', { sessionId: sid, taskId, error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * A move no waiting message carried the notice for: the next message into the session
 * carries it (session-message-queue.ts sendMessageToSession), once.
 */
export async function pendingFolderMovedNotice(sessionId: string): Promise<{ text: string; markTold: () => Promise<void> } | null> {
  try {
    const { getSessionByClaudeId, updateSessionRecordConditionally } = await import('../session-tracker.js')
    const record = await getSessionByClaudeId(sessionId)
    const moved = record?.folderMoved
    if (!moved || moved.told) {
      // Its task's workspace was removed under it and is made again (workspaces/remake.ts).
      const { workspaceRemakeNotice } = await import('../workspaces/remake.js')
      const remade = await workspaceRemakeNotice(sessionId)
      if (remade) return remade
      // A VP's or lead's move into its own folder found its history in two places: said once.
      const failed = record?.ownFolderMove
      if (failed?.why !== 'history-conflict' || failed.told) return null
      const { ownFolderConflictNotice } = await import('./org-own-folder.js')
      return {
        text: kit.buildWalnutMessage({
          kind: 'notification',
          attrs: { from: 'Walnut', outcome: 'folder-not-moved', note: 'automated Walnut status notice' },
          body: ownFolderConflictNotice(failed),
        }),
        markTold: async () => {
          await updateSessionRecordConditionally(
            sessionId,
            { ownFolderMove: { ...failed, told: true } } as Record<string, unknown>,
            (current) => current.ownFolderMove?.at === failed.at,
            { preserveLastActiveAt: true },
          ).catch(() => {})
        },
      }
    }
    return {
      text: folderMovedNotice(moved, moved.why === 'own-folder' ? 'own-folder' : 'kept'),
      markTold: async () => {
        await updateSessionRecordConditionally(
          sessionId,
          { folderMoved: { ...moved, told: true } } as Record<string, unknown>,
          (current) => current.folderMoved?.at === moved.at,
          { preserveLastActiveAt: true },
        ).catch(() => {})
      },
    }
  } catch {
    return null
  }
}
