/**
 * `wait_for` on host_exec and host_exec_read, the server's half: the host's daemon does the
 * waiting (src/providers/host-exec-wait.ts, 'host-exec-wait-v1'), its lines tested in the
 * daemon's killable matcher, and this relays it in reads of at most HOST_WAIT_MAX_MS, inside what
 * the caller's answer time allows (budgetLeft). No pattern ever runs on this server's loop: a
 * daemon without the capability gets no wait at all, and the call is refused before anything
 * runs until it updates (on its next connect, or now with host_daemon_update).
 *
 * Every wait is bounded, and a wait on a run already started never fails the call: a read that
 * fails ends the wait with the run as last seen and `waitedFor.error`. A run whose deadline falls
 * in the wait is waited on to its end (the stop at its deadline and its kill grace), so an answer
 * never says it keeps running while the host stops it (2026-11-04 usability review).
 *
 * The line a wait matched leaves this server only as the output filter, run over it with the
 * lines around it, allows (shownWait): a private key's body line looks like nothing on its own.
 */
import { parseWaitFor, type WaitFor, type WaitedFor } from '../../providers/host-exec-wait.js'
import { stripAnsi } from '../../providers/host-exec-matcher.js'
import { HOST_WAIT_MAX_MS, HostExecError, REPLY_MARGIN_MS, budgetLeft, daemonError, hostName, readJob, redact, type Caller, type dial } from './host-exec.js'
import { isReadStop } from './host-exec-grant.js'

export const WAIT_CAPABILITY = 'host-exec-wait-v1'
const KILL_GRACE_MS = 3_000
/** What a run left in its group gets this long after its shell exits (host-exec-group.ts EXIT_DRAIN_MS). */
const EXIT_DRAIN_MS = 2_000
const FOREGROUND_DEFAULT_MS = 2 * 60_000
const FOREGROUND_MAX_MS = 10 * 60_000
const BACKGROUND_DEFAULT_MS = 2 * 60 * 60_000
/** A background run's wait for its wait_for, unless wait_ms says; and the most wait_ms may ask. */
const BACKGROUND_WAIT_MS = 2 * 60_000
export const WAIT_MAX_MS = 10 * 60_000

type Conn = Awaited<ReturnType<typeof dial>>
export type { WaitFor, WaitedFor }

/** The wait ran out of time (no match, no pattern stopped as too slow, no error): only then did a hold end it. */
export function ranOut(w: WaitedFor | undefined): boolean {
  return !w || (!w.matched && !w.tooSlow && !w.error && !w.unreachable)
}

/** A wait_for as the caller gave it, or null for none; a bad one is refused before anything runs. */
export function checkWaitFor(raw: unknown, nothing = 'Nothing ran.'): WaitFor | null {
  if (raw === undefined || raw === null) return null
  const parsed = parseWaitFor(raw)
  // Said plainly, so a refusal is never read as a run that failed (2026-11-04 usability review).
  if (!parsed.ok) throw new HostExecError(`${parsed.error}. ${nothing}`, 400, 'bad_request')
  return parsed.waitFor
}

/** A wait waits in that host's daemon: one that cannot is refused before the call starts anything. */
export async function assertWaitSupported(conn: Conn, host: string, waitFor: WaitFor | null): Promise<void> {
  if (!waitFor || conn.hasCapability(WAIT_CAPABILITY)) return
  throw new HostExecError(`The Walnut daemon on ${await hostName(host)} must update before it can wait (wait_for); nothing ran. `
    + 'It updates on its next connect (host_daemon_update asks for it now); until then run the command without wait_for and read it with host_exec_read and wait_ms.', 400, 'wait_for_needs_daemon_upgrade')
}

/**
 * How long host_exec waits for its wait_for: `waitMs` (wait_ms) when given, at most 10 minutes;
 * else a foreground run to its deadline and its stop there, a background one 2 minutes. A run
 * whose deadline (timeout_ms) falls inside the wait is waited on to its stop. timeout_ms is only
 * the deadline (2026-11-04 usability review: with background:true it was the wait too, so "wait
 * 20 s for the port, keep the server for an hour" was not one call).
 */
export function execWaitWanted(background: boolean, timeoutMs: number, waitMs: number | undefined): number {
  const stop = timeoutMs + KILL_GRACE_MS + 2_000
  const wait = typeof waitMs === 'number' && waitMs >= 0 ? Math.min(waitMs, WAIT_MAX_MS) : background ? BACKGROUND_WAIT_MS : stop
  return timeoutMs <= wait ? stop : wait
}

/** execWaitWanted, never past the caller's answer time. */
export function execWaitWindow(caller: Caller, since: number, background: boolean, timeoutMs: number, waitMs: number | undefined): number {
  return Math.max(0, Math.min(execWaitWanted(background, timeoutMs, waitMs), budgetLeft(caller, since)))
}

export interface WaitOpts {
  /** The call's start: the caller's answer time counts from here (budgetLeft). */
  since: number
  /** How long the wait may run. */
  within: number
  /** The read's offset: the answer reads from there, and the output is tested from there unless `scanFrom` says. */
  offset?: number
  /** Where the output is tested from: 0 for a run host_exec started; else the offset; else the log's start. */
  scanFrom?: number
  /** The run as host_exec started it: a failed read then ends the wait with this instead of failing the call. */
  started?: Record<string, unknown>
}

/** A matched line in an answer: at most this much of it, after its redaction. */
const MATCH_SHOW_MAX = 300
/**
 * What a read of a wait leaves its answer to get back here, between the host's bound for it (`by`)
 * and the read's own deadline. The host's looks may go past `wait` (a first batch, a port or file
 * look, a last look after the job ended) but never past `by` (2026-11-04 review: an answer at the
 * bound came after the read gave up, and "not yet" read as host_offline).
 */
export const READ_RETURN_MS = 1_000

/** Two reads' long lines as one count; a daemon older than `last` names only the first. */
export function mergeLong(seen: WaitedFor['long'], next: NonNullable<WaitedFor['long']>): NonNullable<WaitedFor['long']> {
  if (!seen) return next
  const last = seen.last ?? seen.at
  const again = next.at <= last ? 1 : 0
  return { lines: seen.lines + next.lines - again, at: seen.at, last: next.last ?? next.at }
}

/** Wait on a job until wait_for holds, it ends, or `within` runs out: the last read and what the wait saw. */
export async function waitOnJob(conn: Conn, host: string, caller: Caller, jobId: string, waitFor: WaitFor, opts: WaitOpts): Promise<{ reply: Record<string, unknown>; waitedFor: WaitedFor }> {
  const t0 = Date.now()
  let until = t0 + Math.max(0, opts.within)
  // A run at its deadline is waited on past `within` once, and never past this (2026-11-04 review:
  // each read that still said running at deadline 0 moved the end 5 s on, so a caller on the Mac,
  // whose answer time has no end, waited forever on a host that did not stop the run).
  const latest = until + 1_000 + KILL_GRACE_MS + EXIT_DRAIN_MS + 3_000
  let extended = false
  const left = () => Math.max(0, until - Date.now())
  let last: Record<string, unknown> | undefined = opts.started
  const read = async (params: Record<string, unknown>, wait: number): Promise<Record<string, unknown>> => {
    const timeout = wait + Math.min(REPLY_MARGIN_MS, Math.max(2_000, budgetLeft(caller, opts.since) - wait))
    const r = await readJob(conn, host, caller.taskId, { ...params, by: timeout - READ_RETURN_MS }, timeout)
    if (!r.ok) throw daemonError(r, 'the host could not read the job')
    last = r
    return r
  }
  const base: { jobId: string; taskId: string; offset?: number } = { jobId, taskId: caller.taskId, ...(opts.offset !== undefined ? { offset: opts.offset } : {}) }
  let seen: WaitedFor = { matched: null, ms: 0 }
  // Lines tested only on their head, over every read (2026-11-05 review: a wait relayed in several
  // reads kept only the last read's, and the sentence that explains a miss lost an early long line).
  let long: WaitedFor['long']
  const withLong = (w: WaitedFor): WaitedFor => (long ? { ...w, long: { lines: long.lines, at: long.at } } : w)
  try {
    // Each read goes on testing the output where the one before got to.
    let scanFrom: number | undefined = opts.scanFrom
    for (let first = true; ; first = false) {
      const wait = Math.min(left(), HOST_WAIT_MAX_MS)
      const r = await read({ ...base, until: waitFor, wait, ...(scanFrom !== undefined ? { scanFrom } : {}) }, wait)
      // The host read from where it could (an offset past the log's end is its end): every read after reads from there too.
      if (base.offset !== undefined && typeof r.offset === 'number' && r.offset < base.offset) base.offset = r.offset
      const w = r.waitedFor as WaitedFor | undefined
      if (w) {
        // "Already there" is the wait's first look, not a later read's; for a run this call just
        // started, only what held before it started (its first look comes a moment after the start).
        const { already, beforeRun, sinceRun, ...rest } = w
        const held = beforeRun ? { already: true as const, beforeRun } : first && already && !opts.started ? { already, ...(sinceRun ? { sinceRun } : {}) } : {}
        seen = { ...rest, ...held }
        // A read that began on the long line the last one stopped inside counts it again: once. A
        // read goes on where the last stopped, so only its first long line can be the last one's
        // last (2026-11-05 review: one counted twice read "2 lines longer than 64 K").
        if (w.long) long = mergeLong(long, w.long)
      }
      if (w?.matched || w?.tooSlow || w?.error || w?.unreachable) break
      // At its deadline (or within a second of it): waited on to its end, as far as the call's
      // answer time allows, so the answer says how it ended instead of "keeps running".
      const toDeadline = typeof r.deadlineInMs === 'number' ? r.deadlineInMs : null
      if (!extended && r.running === true && toDeadline !== null && toDeadline <= Math.max(1_000, left())) {
        extended = true
        until = Math.max(until, Math.min(Date.now() + toDeadline + KILL_GRACE_MS + EXIT_DRAIN_MS + 1_000, latest, Date.now() + Math.max(0, budgetLeft(caller, opts.since))))
      }
      // A job that ended is waited on while its output is still being tested.
      if (left() <= 0 || (r.running !== true && !w?.untested)) break
      if (typeof w?.scanned === 'number') scanFrom = w.scanned
    }
  } catch (err) {
    // A revoke or a closed host while it waited ends the call, never a wait that "stopped".
    if (!last || isReadStop(err)) throw err
    const error = err instanceof Error ? err.message : String(err)
    // Where the output was tested up to stays known, so the next step goes on from there.
    return { reply: last, waitedFor: withLong({ matched: null, ms: Date.now() - t0, ...(seen.scanned !== undefined ? { scanned: seen.scanned } : {}), error }) }
  }
  // The line it matched, as the host saw it: shownWait hides it as the lines around it say.
  return { reply: last!, waitedFor: withLong({ ...seen, ms: Date.now() - t0 }) }
}

/**
 * The read of a call that named a job_id this task already started (host-exec.ts sameJob): a
 * foreground call waits for the run's end as the first one would have, a wait_for waits again.
 * The host's `unknown_job` comes back as the reply, for that call to say what it means.
 */
export async function readAgain(conn: Conn, host: string, caller: Caller, jobId: string, since: number, o: { background: boolean; waitFor: WaitFor | null; asked?: number; waitMs?: number }): Promise<{ reply: Record<string, unknown>; waitedFor?: WaitedFor }> {
  if (!o.waitFor) {
    const wait = o.background ? 0 : Math.max(0, Math.min(HOST_WAIT_MAX_MS, Math.min(FOREGROUND_MAX_MS, budgetLeft(caller, since)) - 2_000))
    return { reply: await readJob(conn, host, caller.taskId, { jobId, taskId: caller.taskId, ...(wait ? { wait } : {}) }, wait + Math.min(REPLY_MARGIN_MS, Math.max(2_000, budgetLeft(caller, since) - wait))) }
  }
  await assertWaitSupported(conn, host, o.waitFor)
  const timeoutMs = typeof o.asked === 'number' && o.asked > 0 ? Math.min(o.asked, o.background ? BACKGROUND_DEFAULT_MS : FOREGROUND_MAX_MS) : o.background ? BACKGROUND_DEFAULT_MS : FOREGROUND_DEFAULT_MS
  try {
    // The same run again: its output from its start, as the first call tested it.
    const { reply, waitedFor } = await waitOnJob(conn, host, caller, jobId, o.waitFor, { since, within: execWaitWindow(caller, since, o.background, timeoutMs, o.waitMs), scanFrom: 0 })
    return { reply: { ok: true, ...reply }, waitedFor }
  } catch (err) {
    if (err instanceof HostExecError && err.code === 'unknown_job') return { reply: { ok: false, code: err.code, error: err.message } }
    throw err
  }
}

/** How many lines before it a line the wait matched right after the output shown is checked with (a private key is fewer). */
const CONTEXT_LINES = 200
/** A matched line elsewhere in the log is read with this much before it, and this much from its start. */
const AROUND_BEFORE_BYTES = 32 * 1024
const AROUND_AFTER_BYTES = 32 * 1024

/** Reads the job's log at an offset (one exec.read, no wait): the lines a match elsewhere in the log sits among. */
export type ReadAt = (offset: number, maxBytes: number) => Promise<{ output?: unknown } | null>

/** A ReadAt for one job on one host. */
export function readAtOf(conn: Conn, host: string, caller: Caller, jobId: string, since: number): ReadAt {
  return async (offset, maxBytes) => {
    if (budgetLeft(caller, since) < 2_000) return null
    const r = await readJob(conn, host, caller.taskId, { jobId, taskId: caller.taskId, offset, maxBytes }, Math.min(REPLY_MARGIN_MS, Math.max(1_000, budgetLeft(caller, since) - 1_000)))
      .catch((err) => { if (isReadStop(err)) throw err; return null })
    return r?.ok ? r : null
  }
}

/**
 * The line a wait matched (and the unfinished one that would match) as the answer shows it. A
 * private key's body line looks like nothing on its own, so the output filter must see it with
 * the lines around it (2026-11-04 review: a key's body line outside the output shown matched
 * \w{40,} and came back in clear). `reply` is the host's read, its output as written; `answer`
 * that output as the filter left it. Inside the output shown, the line is hidden when the output
 * hid it; right after it (the line still being written), it is checked with the lines before it;
 * anywhere else, the lines around it are read from the log (`readAt`) and it is checked with them
 * (2026-11-04 usability review: a server's ready line followed by 256 KB of log came back hidden,
 * and the URL in it took one more call). Where it cannot be checked (no offset from an older host,
 * no read), it is hidden, and the note names the read that shows it. Then cut to MATCH_SHOW_MAX.
 */
export async function shownWait(reply: Record<string, unknown>, answer: Record<string, unknown>, waitedFor: WaitedFor, readAt?: ReadAt): Promise<WaitedFor> {
  const out = { ...waitedFor }
  const raw = String(reply.output ?? '')
  const shown = String(answer.output ?? '')
  const from = typeof reply.offset === 'number' ? reply.offset : null
  const to = typeof reply.nextOffset === 'number' ? reply.nextOffset : null
  for (const [key, atKey] of [['match', 'matchAt'], ['wouldMatch', 'wouldMatchAt']] as const) {
    const line = out[key]
    if (line === undefined || (key === 'match' && out.matched !== 'output')) continue
    const at = out[atKey]
    const alone = await redact(line)
    let text = alone.redacted ? alone.text : line
    const inside = typeof at === 'number' && from !== null && to !== null ? at >= from && at < to : stripAnsi(raw).includes(line)
    if (alone.redacted) { /* hidden on its own */ } else if (inside) {
      // The line is tested without its colour codes: compare it so with the output shown (2026-11-04 review).
      if (answer.redactedLines && !stripAnsi(shown).includes(line)) {
        // The output's own placeholder when it used one kind, so the two say the same (2026-11-05 review claude13).
        const kinds = new Set(shown.split('\n').filter((l) => l.startsWith('[Walnut hid this line: it looks like a credential (')))
        text = kinds.size === 1 ? [...kinds][0]! : '[Walnut hid this line: it may be part of a credential the output hid]'
      }
    } else if (typeof at === 'number' && at === to) {
      const before = raw.split('\n').slice(-CONTEXT_LINES - 1).join('\n')
      const checked = await redact(before + line)
      const last = checked.text.split('\n').pop()
      if (checked.redacted && last !== line) text = '[Walnut hid this line: it may be part of a credential the lines before it hold]'
    } else {
      const start = typeof at === 'number' ? Math.max(0, at - AROUND_BEFORE_BYTES) : null
      const around = start !== null && readAt ? await readAt(start, at! - start + AROUND_AFTER_BYTES).catch((err) => { if (isReadStop(err)) throw err; return null }) : null
      const lines = typeof around?.output === 'string' ? around.output : null
      if (lines !== null && stripAnsi(lines).includes(line)) {
        const checked = await redact(lines)
        if (checked.redacted && !stripAnsi(checked.text).includes(line)) text = '[Walnut hid this line: it may be part of a credential the lines around it hold]'
      } else {
        text = `[Walnut hid this line: it is not in the output shown here, so Walnut could not check it with the lines around it${typeof at === 'number' ? `; host_exec_read with offset ${at} shows it` : ''}]`
      }
    }
    out[key] = text.startsWith('[Walnut hid this line') ? text : text.slice(0, MATCH_SHOW_MAX)
  }
  return out
}
