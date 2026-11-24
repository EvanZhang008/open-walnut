/**
 * A message parked because its session's working folder was gone goes out by itself once that
 * folder is back, whichever way it came back (2026-11-24: rows a host parked while a released
 * workspace was gone stayed parked for hours after the workspace was made again, while the session
 * itself ran in that folder; only the one remake path that asked the host sent them).
 *
 * The ways a folder comes back are many (a remake of the task's workspace, Continue in a new folder,
 * the task's own directory restored, a task folder changed, the folder made again by hand, a remount,
 * a host restart), so the release does not hang on any of them. It sits where every one of them ends:
 *
 *   ride ahead   a row of the session that goes out now (a delivery takes it: the CLI is written to,
 *                started or resumed in the session's folder) takes the session's waiting rows with
 *                it, ahead of it in their own order (session-queue-park.ts unparkRowsAhead). The same
 *                CLI in the same folder takes all of them, or refuses all of them and they park again.
 *   the clock    with nothing going out, the delivery clock (delivery-retry.ts) looks at the folder
 *                of a session with such a row due and puts the rows back in line when it is there
 *                (folderIsBackFor), on its growing wait, so a refusal the look contradicts never loops.
 *   the remake   a remake's end, the restart's look (folder-back.ts) and the host's sendFolderWaiting
 *                send them at once (folder-gone.ts sendWaiting, pick 'waited').
 *
 * Only rows this rule parked: a park on a gone folder marks the row (`folderWait`, queue-held-spans.ts
 * parkRow), and only a marked row goes by itself. Rows parked before the mark existed, and rows that
 * waited longer than FOLDER_WAIT_MAX_AGE_MS since they were queued, wait for a person (Retry or
 * Discard): a person may have sent their words again meanwhile, and sending them twice is worse than
 * asking (2026-11-24: a remake sent a five-hour-old row a person had already sent again by hand).
 * A row a Stop came after stays parked for the person, as with every automatic resend. A person's
 * own Continue in a new folder still sends every row that waited on the folder (pick 'all').
 *
 * The rule itself imports only the folder-gone words (the queue's park reads it); the clock's look
 * loads the session machinery when it runs.
 */
import { isFolderGoneReason } from './folder-gone-words.js'

/** How long since it was queued a row may wait on a gone folder and still go by itself. */
export const FOLDER_WAIT_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Which waiting rows a release sends: those that wait by this rule, or every one (a person's press). */
export type FolderWaitPick = 'waited' | 'all'

interface WaitRow {
  status: string
  parkedReason?: string
  folderWait?: true
  stopFence?: string
  enqueuedAt: string
}

/** Is this a row parked on a gone folder that Walnut sends by itself once the folder is back? */
export function waitsForFolder(row: WaitRow, stopFence: string | null, now: number = Date.now()): boolean {
  if (row.status !== 'parked' || row.folderWait !== true || !isFolderGoneReason(row.parkedReason)) return false
  if ((row.stopFence ?? null) !== stopFence) return false
  const queued = Date.parse(row.enqueuedAt)
  return Number.isFinite(queued) && now - queued < FOLDER_WAIT_MAX_AGE_MS
}

/** The mark a park on `reason` gives its row (queue-held-spans.ts parkRow): on a gone folder only. */
export function folderWaitMark(reason: string): true | undefined {
  return isFolderGoneReason(reason) ? true : undefined
}

/**
 * A row a folder's return sends: a pending one, and a parked one on the gone folder; by Walnut
 * itself ('waited') only one that waits by the rule (waitsForFolder). `fence` undefined: a Stop
 * waits for its host, so Walnut sends no parked row by itself.
 */
export function goesOnFolder(m: WaitRow, pick: FolderWaitPick, fence: string | null | undefined): boolean {
  if (m.status === 'pending') return true
  if (m.status !== 'parked' || !isFolderGoneReason(m.parkedReason)) return false
  if (pick === 'all') return true
  return fence !== undefined && waitsForFolder(m, fence)
}

/** The session's stop fence now, or undefined while a Stop waits for its host. */
export async function stopFenceOf(sessionId: string): Promise<string | null | undefined> {
  try {
    const { sessionStops } = await import('./session-stop.js')
    return await sessionStops.fence(sessionId)
  } catch {
    return undefined
  }
}

/** When the clock last asked a session's remote folder, and how often: a remote one is asked on a growing clock. */
const folderLooks = new Map<string, { tries: number; at: number }>()

/**
 * The delivery clock (delivery-retry.ts) has a row of `sessionId` due that waits on its gone folder:
 * is the session's folder there now, however it came back? A folder on this machine is looked at
 * each time (one stat); a remote one at most on `delayMs`'s growing clock. An archived session, or
 * one whose folder cannot be asked, reads not back.
 */
export async function folderIsBackFor(sessionId: string, now: number, o: { delayMs: (tries: number) => number }): Promise<boolean> {
  const { getSessionByClaudeId } = await import('../session-tracker.js')
  const record = await getSessionByClaudeId(sessionId).catch(() => null)
  if (!record?.cwd || record.archived) return false
  const { execHostOf } = await import('./session-row-owner.js')
  const host = execHostOf(record) ?? null
  const look = folderLooks.get(sessionId)
  if (host && look && now - look.at < o.delayMs(look.tries - 1)) return false
  const { folderState } = await import('./folder-gone.js')
  if (await folderState(record.cwd, host) === 'present') {
    folderLooks.delete(sessionId)
    const { log } = await import('../../logging/index.js')
    log.session.info('folder back: the messages that waited on it go out', { sessionId, taskId: record.taskId, cwd: record.cwd, host })
    return true
  }
  folderLooks.set(sessionId, { tries: (look?.tries ?? 0) + 1, at: now })
  return false
}

/** Test seam. */
export function _resetFolderLooksForTesting(): void {
  folderLooks.clear()
}
