/**
 * A folder that was gone is there again (a move's links made the old place answer, a disk
 * remounted, a folder restored): the start's own look puts back what the gap stopped.
 *
 *  - a session marked gone (folder-gone.ts) loses the mark, and what was parked on the folder
 *    goes out, as the button does for a folder that is present (folderIsBack);
 *  - a trigger Walnut stopped because its check's folder did not exist is armed again; its next
 *    check reads what came in meanwhile (the check's own state and dedup do that).
 *
 * Only what the gap stopped, never older: a mark or a stop of the last day, a row parked in the
 * last day, a session that is still its open task's session, a trigger a person did not pause on a
 * task still open and not stopped with its team. The user's switch for restart recovery turns it off. Local
 * only (a remote folder is the daemon's to judge). 2026-11-20: between the notes' move and their
 * links (11:39Z to 12:47Z) four sessions kept their messages and six triggers stopped, all in
 * folders under notes/.
 */
import fsp from 'node:fs/promises'
import { log } from '../../logging/index.js'
import { triggerRunState } from '../cron/trigger-run-state.js'
import { folderIsBack, folderState, isLocal } from './folder-gone.js'

/** How far back a gap counts. */
const RECENT_MS = 24 * 60 * 60 * 1000
const CWD_GONE = /cwd does not exist: (.+)$/

export interface FolderBackReport { sessions: string[]; messages: number; triggers: string[] }

export async function sendWhereFoldersCameBack(now = Date.now()): Promise<FolderBackReport> {
  const report: FolderBackReport = { sessions: [], messages: 0, triggers: [] }
  await sessionsBack(now, report).catch((err) => log.session.warn('folder back: sessions not looked at', { error: String(err) }))
  await triggersBack(now, report).catch((err) => log.session.warn('folder back: triggers not looked at', { error: String(err) }))
  if (report.sessions.length || report.triggers.length) log.session.info('folder back: what a gone folder stopped runs again', { ...report })
  return report
}

async function sessionsBack(now: number, report: FolderBackReport): Promise<void> {
  const { listSessions } = await import('../session-tracker.js')
  const { getTask } = await import('../task-manager.js')
  for (const r of await listSessions()) {
    const gone = r.cwdGone
    if (!gone || r.archived || !r.taskId || !r.cwd || gone.cwd !== r.cwd || !isLocal(r.host)) continue
    const at = Date.parse(gone.at)
    if (!(now - at < RECENT_MS)) continue
    const task = await getTask(r.taskId).catch(() => null)
    if (!task || task.phase === 'COMPLETE' || (task.session_id && task.session_id !== r.claudeSessionId)) continue
    if ((await folderState(r.cwd, r.host)) !== 'present') continue
    // Every row the gap parked, of the last day (the mark keeps only the latest refusal's time).
    const sent = await folderIsBack(r.claudeSessionId, r.taskId, { since: now - RECENT_MS })
    report.sessions.push(r.claudeSessionId)
    report.messages += sent
  }
}

async function triggersBack(now: number, report: FolderBackReport): Promise<void> {
  const { getCronService } = await import('../../web/routes/cron.js')
  const { routineTargetTask } = await import('../cron/trigger-apply.js')
  const { patchRoutine } = await import('../routines/routines-core.js')
  const { getTask } = await import('../task-manager.js')
  const { stoppedByTeam } = await import('./team-stop.js')
  const service = getCronService()
  if (!service) return
  for (const job of await service.list({ includeDisabled: true })) {
    if (!job.check || !isLocal(job.check.host) || triggerRunState(job) !== 'stopped') continue
    const err = CWD_GONE.exec(job.state?.lastError ?? job.state?.lastCheck?.error ?? '')
    const lastAt = job.state?.lastRunAtMs ?? job.state?.lastCheck?.atMs ?? 0
    if (!err || now - lastAt >= RECENT_MS) continue
    const cwd = err[1]!.trim()
    if (job.check.cwd && job.check.cwd !== cwd) continue
    if (!(await fsp.stat(cwd).then((st) => st.isDirectory(), () => false))) continue
    // Only for a task still open and not stopped with its team: those keep their triggers off.
    const owner = routineTargetTask(job)
    const task = owner ? await getTask(owner).catch(() => null) : null
    if (!task || task.phase === 'COMPLETE' || stoppedByTeam(task.id, now)) continue
    await patchRoutine(job.id, { enabled: true }, 'folder-back')
    report.triggers.push(job.id)
  }
}
