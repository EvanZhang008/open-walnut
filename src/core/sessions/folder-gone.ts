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

const isLocal = (host?: string | null) => !host || host === '__local__'
const PROBE_MS = 5_000

import { isFolderGoneReason } from './folder-gone-words.js'
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
  try {
    if (isLocal(record.host)) {
      const { findLocalJsonlPath } = await import('../session-file-reader.js')
      const p = await findLocalJsonlPath(record.claudeSessionId, record.cwd ?? undefined)
      return p ? { state: 'found', path: p } : { state: 'missing' }
    }
    const { DaemonFileReader } = await import('../daemon-file-reader.js')
    const p = await withTimeout(new DaemonFileReader(record.host!).findSessionPath(record.claudeSessionId), PROBE_MS * 2)
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
export function noteFolderGone(sessionId: string, opts: { cwd?: string | null; host?: string | null } = {}): Promise<CwdGone | null> {
  // One refusal reaches this from more than one place (the spawn's catch and the queue's
  // settle): they share one probe.
  const key = sessionId
  const running = noting.get(key)
  if (running) return running
  const p = noteFolderGoneNow(sessionId, opts).finally(() => setTimeout(() => { if (noting.get(key) === p) noting.delete(key) }, 2_000).unref?.())
  noting.set(key, p)
  return p
}
const noting = new Map<string, Promise<CwdGone | null>>()

async function noteFolderGoneNow(sessionId: string, opts: { cwd?: string | null; host?: string | null }): Promise<CwdGone | null> {
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
    if (state === 'present') await clearFolderGone(sessionId)
    if (state !== 'gone') return null
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
export function folderMovedNotice(moved: { from: string; to: string }, kind: 'kept' | 'fresh', extra?: { recorded?: string }): string {
  const body = kind === 'kept'
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
export function continueInNewFolder(sessionId: string, opts: { by?: string } = {}): Promise<ContinueResult> {
  // The banner and the message row offer the same button: a second press while the
  // first moves the files gets the first one's answer, never a half-moved second try.
  const running = continuing.get(sessionId)
  if (running) return running
  const p = continueNow(sessionId, opts).finally(() => { if (continuing.get(sessionId) === p) continuing.delete(sessionId) })
  continuing.set(sessionId, p)
  return p
}
const continuing = new Map<string, Promise<ContinueResult>>()

async function continueNow(sessionId: string, opts: { by?: string }): Promise<ContinueResult> {
  const by = opts.by ?? 'human'
  const { getSessionByClaudeId, updateSessionRecord, emitSessionStatusChanged } = await import('../session-tracker.js')
  const record = await getSessionByClaudeId(sessionId)
  if (!record) throw new SessionControlError('Session not found', 404)
  if (record.archived) throw new SessionControlError('This session is archived; its task has a newer one', 409, { code: 'archived' })
  if (!record.taskId) throw new SessionControlError('Session has no task, so it has no task directory to move to', 400)
  const from = record.cwd ?? ''
  if (!from) throw new SessionControlError('This session has no working folder recorded', 400)
  const state = await folderState(from, record.host)
  if (state === 'present') {
    // Pressed twice, or the folder came back: whatever still waits on a gone folder goes
    // out now, so the button never leaves a message stuck behind a refusal.
    await clearFolderGone(sessionId)
    const sent = await sendWaiting(sessionId, record.taskId, null)
    if (sent > 0) return { status: 'continued', sessionId, cwd: from, from: record.folderMoved?.from ?? from, history: 'kept', sent }
    throw new SessionControlError(`The folder ${from} is there; send a message to continue in it`, 409, { code: 'folder_present' })
  }
  if (state === 'unknown') throw new SessionControlError(`Could not ask ${record.host} whether ${from} still exists; try again when the host answers`, 503, { code: 'host_unreachable' })
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
    const found = await findTranscript(record)
    if (found.state === 'unknown') throw new SessionControlError(`Could not look for this conversation's history on ${record.host ?? 'this machine'}; try again`, 503, { code: 'host_unreachable' })
    if (found.state === 'missing') return startFresh(record, from, to, by)
    await moveTranscript(record, found.path, to)
  }

  const at = new Date().toISOString()
  // Told now when a waiting message will carry the notice (sendWaiting below), so a send
  // arriving meanwhile does not carry a second one.
  const { getQueue } = await import('../session-message-queue.js')
  const willCarry = (await getQueue(sessionId)).some(waitsOnTheFolder)
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

  const sent = await sendWaiting(sessionId, record.taskId, folderMovedNotice({ from, to }, 'kept'))
  // Nothing waited after all (it went meanwhile): the next message carries the notice.
  if (willCarry && sent === 0) await updateSessionRecord(sessionId, { folderMoved: { from, to, at, by } }).catch(() => {})
  log.session.info('folder gone: continued in a new folder', { sessionId, taskId: record.taskId, from, to, sent, by })
  return { status: 'continued', sessionId, cwd: to, from, history: 'kept', sent }
}

/** Move the transcript (and its sidecar dir) into the new folder's project dir, through the host's daemon. */
async function moveTranscript(record: SessionRecord, found: string, to: string): Promise<void> {
  const { encodeProjectPath, isSafeForProjectEncoding } = await import('../session-file-reader.js')
  if (!isSafeForProjectEncoding(to)) throw new SessionControlError(`The task directory ${to} is too long a path for Claude Code's history layout`, 500)
  const sid = record.claudeSessionId
  const projectsRoot = path.posix.dirname(path.posix.dirname(found))
  // The CLI names a project dir by the folder's real path (macOS /tmp is /private/tmp).
  const real = isLocal(record.host)
    ? await (await import('node:fs/promises')).realpath(to).catch(() => to)
    : await (await import('../transfer/daemon-transfer-client.js')).realpathOn(record.host!, to).catch(() => to)
  const targetDir = `${projectsRoot}/${encodeProjectPath(real)}`
  const target = `${targetDir}/${sid}.jsonl`
  if (found === target) return
  const reader = isLocal(record.host) ? await localFiles() : new (await import('../daemon-file-reader.js')).DaemonFileReader(record.host!)
  await reader.ensureDir(targetDir)
  // Never over another file. The CLI resumes the copy in its own folder's project dir
  // first, so two copies would quietly continue the older one: say so instead.
  if (await reader.stat(target)) {
    throw new SessionControlError(`This conversation's history is in two places (${found} and ${target}); Walnut moved neither. Keep the one you want and try again.`, 409, { code: 'history_conflict' })
  }
  await reader.renamePath(found, target)
  // Subagent transcripts, tool results and workflow manifests live beside it, under <sid>/.
  const sidecar = `${path.posix.dirname(found)}/${sid}`
  if (await reader.stat(sidecar).catch(() => null) && !(await reader.stat(`${targetDir}/${sid}`).catch(() => null))) {
    await reader.renamePath(sidecar, `${targetDir}/${sid}`).catch((err) => log.session.warn('folder gone: sidecar move failed (the conversation itself moved)', {
      sessionId: sid, error: err instanceof Error ? err.message : String(err),
    }))
  }
  log.session.info('folder gone: transcript moved', { sessionId: sid, host: record.host ?? '__local__', from: found, to: target })
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
async function sendWaiting(sessionId: string, taskId: string, notice: string | null): Promise<number> {
  const { getQueue, unparkMessage } = await import('../session-message-queue.js')
  const { mutateStore } = await import('../session-queue-store.js')
  const rows = (await getQueue(sessionId)).filter(waitsOnTheFolder)
  if (rows.length === 0) return 0
  const first = rows[0]
  if (notice) {
    await mutateStore((s) => {
      const row = s.queues[sessionId]?.find((m) => m.id === first.id)
      if (row && !row.message.includes('outcome="folder-moved"')) row.message = `${notice}\n\n${row.message}`
    })
  }
  for (const row of rows) if (row.status === 'parked') await unparkMessage(sessionId, row.id)
  const { bus, EventNames } = await import('../event-bus.js')
  bus.emit(EventNames.SESSION_SEND, { sessionId, taskId, message: '' }, ['session-runner'], { source: 'folder-moved' })
  return rows.length
}

/** History gone too: a new conversation for the task in the new folder, carrying what waited. */
async function startFresh(record: SessionRecord, from: string, to: string, by: string): Promise<ContinueResult> {
  const sid = record.claudeSessionId
  const { getTask, clearSession, clearSessionSlot } = await import('../task-manager.js')
  const task = await getTask(record.taskId!).catch(() => null)
  if (!task) throw new SessionControlError('Associated task not found', 404)
  const { getQueue, deleteMessage } = await import('../session-message-queue.js')
  const { stripInstructionNotice } = await import('./instruction-notice.js')
  const rows = (await getQueue(sid)).filter(waitsOnTheFolder)
  const waiting = rows.map((m) => stripInstructionNotice(m.message)).filter(Boolean).join('\n\n')
  const recorded = [task.summary, record.title && !task.summary ? `Earlier session: ${record.title}` : ''].filter(Boolean).join('\n').slice(0, 4000)
  const message = `${folderMovedNotice({ from, to }, 'fresh', { recorded })}\n\n${waiting || 'Continue this task.'}`
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
  for (const m of rows) await deleteMessage(sid, m.id).catch(() => false)
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

/** A row that waits because the folder was gone (or a plain pending one), never one a Stop parked. */
function waitsOnTheFolder(m: { status: string; parkedReason?: string }): boolean {
  return m.status === 'pending' || (m.status === 'parked' && isFolderGoneReason(m.parkedReason))
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
    if (!moved || moved.told) return null
    return {
      text: folderMovedNotice(moved, 'kept'),
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
