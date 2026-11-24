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
 * own Continue in a new folder still sends every row that waited on the folder (pick 'all'), also
 * when it was pressed while the workspace was still being made again (remake.ts pressed).
 *
 * Who is told: nobody hears "not delivered" of a marked row while its folder is one Walnut makes
 * again (waitsForFolderNow). A folder of the user's own that went is reported as before, and the row
 * then loses its mark (dropFolderWait); a row past its day, or whose remake failed, loses its mark
 * and its asker hears it once (endFolderWaits).
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
  // A look older than any row may wait is of a session nothing waits on any more.
  for (const [sid, look] of folderLooks) if (now - look.at > FOLDER_WAIT_MAX_AGE_MS) folderLooks.delete(sid)
  const { getSessionByClaudeId } = await import('../session-tracker.js')
  const record = await getSessionByClaudeId(sessionId).catch(() => null)
  if (!record?.cwd || record.archived) {
    folderLooks.delete(sessionId)
    return false
  }
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

/**
 * What an asker reads of its message while it waits on the folder (session-request-notify.ts): it is
 * on its way, never "not delivered" (2026-11-24: a message waiting 21 s for its workspace to be made
 * again was reported to its sender as not delivered, and the sender set out to send it again).
 */
export const FOLDER_WAIT_WORDS = "its session's working folder is not there yet (its task's workspace is being made again); Walnut sends the message by itself once the folder is back, for up to 24 hours, and tells you if it does not"

/**
 * Whether `row` waits on its session's gone folder and goes by itself, so nobody is told it was not
 * delivered: it waits by the rule (waitsForFolder, against the session's stop fence now), and its
 * folder is one Walnut makes again (its task's workspace, remake.ts remakeBringsBack). A folder of the
 * user's own that went is reported as before. Every reader that tells an asker or a person "not
 * delivered" asks it first (tests/core/sessions/folder-wait-ratchet.test.ts), and one that then tells
 * an asker drops the row's mark (dropFolderWait): told it failed, it is never sent by itself after.
 */
export async function waitsForFolderNow(row: WaitRow & { sessionId: string }, now: number = Date.now()): Promise<boolean> {
  if (row.status !== 'parked' || row.folderWait !== true) return false
  const fence = await stopFenceOf(row.sessionId)
  if (fence === undefined || !waitsForFolder(row, fence, now)) return false
  const { remakeBringsBack } = await import('../workspaces/remake.js')
  return remakeBringsBack(row.sessionId).catch(() => false)
}

/**
 * Drops the mark of these parked rows of `sessionId` (all its marked ones when `ids` is left out):
 * they no longer go by themselves. The rows whose mark this call dropped, each once.
 */
export async function dropFolderWait(sessionId: string, ids?: readonly string[]): Promise<Array<{ id: string; sessionId: string; message: string; parkedReason?: string }>> {
  const { mutateStore } = await import('../session-queue-store.js')
  return mutateStore((s) => {
    const dropped: Array<{ id: string; sessionId: string; message: string; parkedReason?: string }> = []
    for (const m of s.queues[sessionId] ?? []) {
      if (m.status !== 'parked' || m.folderWait !== true || (ids && !ids.includes(m.id))) continue
      delete m.folderWait
      dropped.push({ id: m.id, sessionId, message: m.message, ...(m.parkedReason ? { parkedReason: m.parkedReason } : {}) })
    }
    return dropped
  })
}

/** Why a row that waited on its folder goes by itself no more (endFolderWaits). */
export const FOLDER_WAIT_ENDED = {
  tooOld: "its session's working folder was not back within 24 hours, so Walnut no longer sends it by itself",
  notMade: "its session's working folder could not be made again",
} as const

/**
 * Rows of `sessionId` that waited on the folder go by themselves no more (`ids`, or every marked
 * one): their mark is dropped, and each asker hears once that its message was not delivered, also
 * one told at its deadline that it was on its way (review S2: that promise must not lapse quietly).
 */
export async function endFolderWaits(sessionId: string, why: string, ids?: readonly string[]): Promise<number> {
  const dropped = await dropFolderWait(sessionId, ids)
  if (dropped.length === 0) return 0
  const { log } = await import('../../logging/index.js')
  log.session.info('folder wait ended: these rows go by themselves no more', { sessionId, rows: dropped.map((r) => r.id), why })
  const { requestIdOf } = await import('./undelivered-requests.js')
  const { getSessionRequest } = await import('../session-requests.js')
  const { notifyRequesterFallback, notifyFolderWaitEnded } = await import('./session-request-notify.js')
  for (const row of dropped) {
    const id = requestIdOf(row)
    if (!id) continue
    try {
      const request = await getSessionRequest(id)
      if (request?.status === 'pending') await notifyRequesterFallback(request, 'error', { notDelivered: why })
      else if (request?.status === 'expired') await notifyFolderWaitEnded(request, why)
    } catch (err) {
      log.session.warn('folder wait ended: telling the asker failed', { sessionId, messageId: row.id, requestId: id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return dropped.length
}
