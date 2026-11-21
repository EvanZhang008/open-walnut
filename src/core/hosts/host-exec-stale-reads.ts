/**
 * A loop that reads a host job which can no longer change is told so, once.
 *
 * Why (2026-11-21, health alarm log.spike:19jarl4): a task's session waited on a clouddev job with
 * `until walnut tools call host_exec_read ... | grep -q '"running":false'; do sleep 20; done`. The
 * CLI prints indented JSON (`"running": false`, with a space), so the test never held. The job
 * ended at 08:56; the loop read it every 20 s for an hour, then the host forgot the finished job
 * (it keeps one for an hour) and every read answered 404 `unknown_job` for half an hour more, until
 * the session noticed by itself. The task stood still for 90 minutes waiting on a job that was done.
 *
 * Every read a caller makes of an existing job (host_exec_read, host_exec again with the same
 * job_id) reports here what it answered. A read of an ended job that answers exactly what the last
 * one did (same offset and end), or a read of a job the host no longer holds, is a repeat; after
 * STALE_READ_REPEATS repeats over at least STALE_READ_MIN_SPAN_MS the reading session gets one Walnut notice naming the job, how it
 * ended and how to wait instead. A read of a running job, or one that pages on through an ended
 * job's log, is no repeat. One notice per session and job; a trigger check's reads are not counted.
 *
 * repeat-answers.ts counts the same 404s for another end: a repeat logs at info, not warn, so a
 * stuck loop no longer rings the log alarm. That makes this notice the one sign the loop gets.
 */
import { log } from '../../logging/index.js'

/** Identical reads of a job that cannot change before its session is told. */
export const STALE_READ_REPEATS = 5
/** ...spread over at least this long: a quick burst of re-reads is no waiting loop. */
export const STALE_READ_MIN_SPAN_MS = 60_000
/** A job's record is dropped this long after its last read. */
const RECORD_TTL_MS = 6 * 60 * 60 * 1000
/** Most jobs tracked at once; the oldest go first. */
const MAX_RECORDS = 500

export interface JobReadSeen {
  /** The reading session (Caller.sid) and its task. */
  sid: string
  taskId: string
  host: string
  jobId: string
  /** What the read answered: the job still running, ended, or no longer held by the host. */
  state: 'running' | 'ended' | 'gone'
  offset?: number | null
  readTo?: number | null
  exitCode?: number | null
}

interface Rec { sig: string; repeats: number; firstAt: number; lastAt: number; told: boolean; endedSeen: boolean }

const records = new Map<string, Rec>()

/** Sends the notice; false when it had no session to go to. */
type Notify = (seen: JobReadSeen, repeats: number, sinceMs: number, endedSeen: boolean) => Promise<boolean>
let notifyImpl: Notify = deliverNotice

/** The notice's words (English: the models read them). Exported for tests. */
export function staleReadNotice(seen: JobReadSeen, repeats: number, sinceMs: number, endedSeen: boolean): string {
  const mins = Math.max(1, Math.round(sinceMs / 60_000))
  const what = seen.state === 'gone'
    ? `which ${seen.host} no longer holds (a host keeps a finished job for an hour; its log stays in your task's directory there)${endedSeen ? ' after it ended' : ''}`
    : `which ended${typeof seen.exitCode === 'number' ? ` with exit ${seen.exitCode}` : ''}`
  return `You have read job ${seen.jobId} on ${seen.host}, ${what}, ${repeats} times in about ${mins} min, and each read answered the same. `
    + 'A loop waiting on it is not seeing its end: stop that loop now and read the job once (or its log file). '
    + 'To wait for a job, call host_exec_read with wait_ms (up to 60000) or wait_for, and test the answer\'s `running` field with jq or python; '
    + 'never grep the CLI\'s JSON, which is indented ("running": false, with a space), and end the loop on an error such as unknown_job.'
}

/** Record one read a caller made of a job. Never throws; a notice is sent without holding the read. */
export function noteJobRead(seen: JobReadSeen, now = Date.now()): void {
  try {
    // A trigger check reads as its task (trigger-caller.ts) but is no session to tell, and its reads are not the session's loop.
    if (!seen.sid || seen.sid.startsWith('trigger:')) return
    const key = `${seen.sid}\0${seen.taskId}\0${seen.host}\0${seen.jobId}`
    if (seen.state === 'running') {
      // A running job may still change: no repeat. One already told stays told.
      const r = records.get(key)
      if (r) { r.sig = ''; r.repeats = 0; r.lastAt = now }
      return
    }
    const sig = seen.state === 'gone' ? 'gone' : `ended:${seen.offset ?? 'tail'}:${seen.readTo ?? ''}`
    let r = records.get(key)
    if (!r) {
      prune(now)
      // No answer seen yet: this first read starts the count at 0 below.
      r = { sig: '', repeats: 0, firstAt: now, lastAt: now, told: false, endedSeen: false }
      records.set(key, r)
    }
    if (seen.state === 'ended') r.endedSeen = true
    // The first read of the same answer is no repeat; each one after it is.
    if (r.sig === sig) r.repeats += 1
    else { r.sig = sig; r.repeats = 0; r.firstAt = now }
    r.lastAt = now
    const sinceMs = now - r.firstAt
    if (r.told || r.repeats < STALE_READ_REPEATS || sinceMs < STALE_READ_MIN_SPAN_MS) return
    r.told = true
    const rec = r
    // Told only once it went out: an undelivered notice is tried again after as many repeats more.
    const untell = () => { rec.told = false; rec.repeats = 0; rec.firstAt = rec.lastAt }
    log.session.warn('host exec: a session keeps reading a job that cannot change; told it', {
      taskId: seen.taskId, sessionId: seen.sid, host: seen.host, jobId: seen.jobId, state: seen.state, repeats: r.repeats, sinceMs,
    })
    void notifyImpl(seen, r.repeats, sinceMs, r.endedSeen).then((sent) => { if (!sent) untell() }, (err) => {
      untell()
      log.session.warn('host exec: the stale-read notice was not delivered', { taskId: seen.taskId, jobId: seen.jobId, error: err instanceof Error ? err.message : String(err) })
    })
  } catch (err) {
    log.session.warn('host exec: a job read was not recorded', { jobId: seen.jobId, error: err instanceof Error ? err.message : String(err) })
  }
}

function prune(now: number): void {
  for (const [k, r] of records) if (now - r.lastAt > RECORD_TTL_MS) records.delete(k)
  while (records.size >= MAX_RECORDS) {
    const oldest = records.keys().next().value
    if (oldest === undefined) break
    records.delete(oldest)
  }
}

/** Through deliverToSession, as every Walnut notice: a session held on a permission prompt gets it queued. */
async function deliverNotice(seen: JobReadSeen, repeats: number, sinceMs: number, endedSeen: boolean): Promise<boolean> {
  const [{ buildWalnutMessage }, { deliverToSession }, { getSessionByClaudeId }] = await Promise.all([
    import('../peers/walnut-message-tag.js'), import('../sessions/session-send-core.js'), import('../session-tracker.js'),
  ])
  const record = seen.sid ? await getSessionByClaudeId(seen.sid) : undefined
  if (!record) {
    log.session.info('host exec: the stale-read notice has no session to go to', { taskId: seen.taskId, jobId: seen.jobId })
    return false
  }
  const message = buildWalnutMessage({
    kind: 'notification', attrs: { from: 'Walnut', note: `job ${seen.jobId} cannot change any more` }, body: staleReadNotice(seen, repeats, sinceMs, endedSeen),
  })
  await deliverToSession(record, { busText: message, enqueueText: message, source: 'walnut-notify', taskId: seen.taskId })
  return true
}

/** Tests: forget every record, and send notices through `notify` (undefined restores the real one). */
export function resetStaleReadsForTest(notify?: Notify): void {
  records.clear()
  notifyImpl = notify ?? deliverNotice
}

/** What a host's read answer says of its job, for noteJobRead. */
export function readStateOf(reply: Record<string, unknown>): JobReadSeen['state'] | null {
  if (reply.ok === false) return reply.code === 'unknown_job' ? 'gone' : null
  return reply.running === true ? 'running' : 'ended'
}
