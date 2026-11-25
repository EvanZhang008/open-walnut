/**
 * What a newer leader owes of one host session's facts after an upgrade from an older leader
 * (host-judged-rollback.mjs, the `upgrade` scenario): which records it must hear, which turn ends it
 * must act on, and which the older leader acted on. It mirrors the leader's own rules, so the
 * rehearsal measures them instead of assuming them:
 *
 *   honoured mark   a fact the host kept with `judgedBy: 'leader'` that happened more than the
 *                   leader's STARTED_SLACK_MS before its process started (leader-apply.ts markOf):
 *                   applied, never said, never acted on; the older leader acted on its turn.
 *   slack mark      the same mark on a fact of the last STARTED_SLACK_MS before that start: not
 *                   honoured (the older leader may have read as answering only because its link did
 *                   not close cleanly), so the newer leader acts on it too. When the older leader did
 *                   act on it, that is the second known duplicate (beside the `early` window): at worst
 *                   twice, never lost.
 *   held end        a turn end the host wrote while standing down (`standDownHeld`,
 *                   stand-down-held.ts): the leader says nothing of it (leader-apply.ts awaitHeld) and
 *                   waits for the host to say it again at its stand-up. That said-again record is the
 *                   same turn end, not a second one: it is the one heard and acted on.
 *
 * Pure: the rehearsal passes the host's records of one session after the stored cursor, in log order.
 */
import crypto from 'node:crypto'

const TURN_ENDS = new Set(['session:result', 'session:error'])
const isEnd = (r) => TURN_ENDS.has(r.name)
const isHeld = (r) => isEnd(r) && r.data?.standDownHeld === true
/** A turn end's data without what the host stamps on it at the time it writes it (the held mark, who took it). */
const endKey = (r) => { const { standDownHeld: _h, hostTakenBy: _t, ...rest } = r.data ?? {}; return JSON.stringify(rest) }

/** leader-apply.ts markOf, on the host's time of the record (one machine here: no clock offset). */
export function markOf(r, { startedAt, slackMs }) {
  if (r.judgedBy !== 'leader') return 'none'
  return typeof r.at === 'number' && r.at < startedAt - slackMs ? 'honoured' : 'slack'
}

/**
 * The records of one session (`recs`, host facts after the cursor, log order) as the newer leader
 * (`process`: its startedAt and startedSlackMs, read from its probe) owes them.
 *   owedRecs   the records it must hear on its bus, once and in this order
 *   ends       the real turn ends, each with its mark and the record that says it again (if held)
 *   actsNew    how many of them it must act on itself; actsOld: how many the host says the older one did
 *   slackDuplicates   ends both act on (slack marks)
 *   unsaidHeld held ends nobody said again (no later turn end of the session): the leader acts on such
 *              an end only at its HELD_SAY_AGAIN_MS deadline
 */
export function owedOf(recs, process) {
  const p = { startedAt: process.startedAt, slackMs: process.startedSlackMs }
  const saidAgain = new Set()
  const ends = []
  let prevEnd = null
  for (const r of recs) {
    if (!isEnd(r)) continue
    // The host says a held end again as it was (stand-down-held.ts payOwed): the next turn end of the
    // session, with the same data but for its stamps. A later turn of its own has other data.
    if (prevEnd && isHeld(prevEnd.rec) && !isHeld(r) && !prevEnd.saidBy && endKey(r) === endKey(prevEnd.rec)) {
      prevEnd.saidBy = r
      saidAgain.add(r.seq)
      continue
    }
    prevEnd = { rec: r, held: isHeld(r), mark: markOf(r, p), saidBy: null }
    ends.push(prevEnd)
  }
  const lastEnd = ends.at(-1)
  const unsaidHeld = ends.filter((e) => e.held && !e.saidBy && e.mark !== 'honoured' && e === lastEnd).map((e) => e.rec.seq)
  const owedRecs = recs.filter((r) => markOf(r, p) !== 'honoured' && !isHeld(r))
  return {
    owedRecs,
    ends: ends.map((e) => ({ seq: e.rec.seq, name: e.rec.name, held: e.held, mark: e.mark, saidAgainAt: e.saidBy?.seq ?? null })),
    saidAgain: [...saidAgain],
    actsNew: ends.filter((e) => e.mark !== 'honoured').length,
    actsOld: ends.filter((e) => e.mark !== 'none').length,
    slackDuplicates: ends.filter((e) => e.mark === 'slack').length,
    unsaidHeld,
  }
}

/** A turn end's or fact's data, in a line: the marks and fields that decide who acts on it. */
function dataSummary(d) {
  if (!d || typeof d !== 'object') return d ?? null
  const pick = {}
  for (const k of ['standDownHeld', 'hostTakenBy', 'isError']) if (k in d) pick[k] = d[k]
  if (typeof d.result === 'string') pick.result = d.result.slice(0, 80)
  return pick
}
const shortHash = (d) => crypto.createHash('sha256').update(JSON.stringify(d ?? null) ?? 'null').digest('hex').slice(0, 12)
/** The host's fact records of one session, for the evidence. */
export const dumpFacts = (recs, s) => recs.filter((x) => x.sid === s).map((x) => ({ seq: x.seq, name: x.name, at: x.at, ...(x.judgedBy ? { judgedBy: x.judgedBy } : {}), hash: x.refs ? 'cut' : shortHash(x.data), data: dataSummary(x.data) }))
/** A leader probe's bus events of one session, for the evidence. */
export const dumpEvents = (events) => events.map((e) => ({ name: e.name, source: e.source, at: e.at, seenAt: e.seenAt, ...(e.late ? { late: true } : {}), hash: e.hash.slice(0, 12), data: dataSummary(e.data) }))
