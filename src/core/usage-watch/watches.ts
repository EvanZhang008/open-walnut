/**
 * Watches: what a task that shipped a change asks real use to show, and until when. A watch
 * names its targets (`op:task_get`, `route:GET /api/tasks/:id`, `page:home`) and checks
 * a machine can judge; at its check time each target is judged on the hours since it was set:
 *  - Passed: every op or route target had enough use and met every check;
 *  - Failed: a check failed (it names which);
 *  - Too little use: a target had fewer uses than `min_uses` (checked again once, as long again);
 *  - Unknown: the server was not recording for part of the time.
 * While it is armed, an alarm on one of its targets goes to its task (route.ts).
 */
import { randomUUID } from 'node:crypto'
import { callerSide, emptyAgg, mergeAgg, msPercentile, ownFaults, type Agg, type UsageKind } from './agg.js'
import { readAlive, readHours, readSlept, usageDb } from './store.js'
import { ASLEEP_CODE, pageKindIsPagesOwn, pageRequestOf } from './normalize.js'
import { RECORDED_NON_OPS } from './counters.js'
import { sleptBetween } from '../../lib/sleep-ledger.js'
import { PAGE_ALIASES, pageOfPart, targetOfVisitKey, visitKeyOfTarget } from '../page-places.js'
import { isCountedPlace, placeUseOf } from './page-uses.js'

const HOUR_MS = 3_600_000
export const MIN_CHECK_AFTER_MS = HOUR_MS
export const MAX_CHECK_AFTER_MS = 14 * 24 * HOUR_MS
export const DEFAULT_CHECKS: Required<WatchChecks> = {
  max_answer_chars: 20_000, max_fail_pct: 5, no_new_codes: true, max_p95_ms: 2_000, min_uses: 20,
}

export interface WatchChecks {
  /** An op's largest answer (characters or CLI bytes), and no answer Claude Code cut. */
  max_answer_chars?: number
  /** Errors, timeouts and bad arguments as a share of calls (designed refusals and unreachable hosts not counted). */
  max_fail_pct?: number
  /** No error code that the 7 days before the watch did not have. */
  no_new_codes?: boolean
  /** A route's p95 time. */
  max_p95_ms?: number
  /** Uses each op or route target needs before it can pass. */
  min_uses?: number
}

/** `unwatched`: the task was closed (by its lead or a person) after it shipped, with no watch and no exemption: a gap shown, not a check. */
export type WatchState = 'watching' | 'passed' | 'failed' | 'too_little_use' | 'unknown' | 'dropped' | 'exempt' | 'unwatched'

/** No watch here, and why: nothing in real use can show the change, the ship did not happen, or it is watched outside Walnut. */
export const EXEMPT_KINDS = ['copy', 'colour', 'docs', 'tests', 'not_shipped', 'watched_elsewhere'] as const
export type ExemptKind = typeof EXEMPT_KINDS[number]

export interface Watch {
  id: string
  taskId: string
  targets: string[]
  checks: WatchChecks
  /** `this task`, or the id of another open task that watches it. */
  who: string
  /** A trigger that checks what these checks cannot (aimed at an open task other than this one). */
  triggerId?: string
  createdAt: number
  /** The ship this watch belongs to (the task's latest when it was set). */
  shipAt?: number
  checkAt: number
  extended: boolean
  state: WatchState
  checkedAt?: number
  result?: TargetResult[]
  /** The recipient a result or alarm went to last. */
  told?: string
  by?: string
  /** No watch, and why: a change nothing in real use can show, or a ship that did not happen. */
  exempt?: { kind: ExemptKind; reason: string }
}

export interface TargetResult {
  target: string
  uses: number
  ok: boolean
  /** What failed or was short, in a few words; empty when it passed. */
  notes: string[]
  largest?: number
  failPct?: number
  p95Ms?: number
  newCodes?: string[]
  cut?: number
  /**
   * The caller's side, never a failure (agg.ts callerSide): calls refused for their arguments or by a
   * rule's design, their share and any codes new since the week before.
   */
  callerSide?: { calls: number; pct: number; badArgs: number; refused: number; newCodes?: string[] }
  /** A page target: of its uses (visits), those known only by the day (page-uses.ts placeUseOf). */
  byDay?: number
}

/** What a judge reads besides the store: Page use's visits by the day, for hours before page rows were kept. */
export interface JudgeInputs { visitDays?: (key: string) => Record<string, number> | undefined }

// An op, or a name real use counts that is no op (a session's Walnut mount: counters.ts RECORDED_NON_OPS,
// plain `word/word` names that need no escaping).
export const TARGET_RE = new RegExp(`^(op:(?:[a-z][a-z0-9_]{0,63}|${RECORDED_NON_OPS.join('|')})|route:(?:(?:GET|POST|PUT|PATCH|DELETE) )?\\/[A-Za-z0-9_\\-/:.*]{0,160}|page:[A-Za-z0-9_ .:/~-]{2,120})$`)

/** Why a target is not one the monitor can watch, or null. */
export function targetProblem(t: string): string | null {
  return TARGET_RE.test(t) ? null : `"${t.slice(0, 80)}" is not a target: use op:<op name>, route:<METHOD> <route template> (route:GET /api/tasks/:id), or page:<page> (page:home, page:session-panel, page:settings:<pane id>)`
}

/**
 * Whether a recorded name is covered by a watch target: what its verdict judges, whose alarm comes
 * to it, what its report shows. A page target covers only the page's own errors (normalize.ts
 * pageKindIsPagesOwn); a request that went wrong on its way is named in its verdict, not judged. A
 * route target covers only what its server recorded: a route that held a page until the page gave
 * up is there as a slow read (record.ts recordHttp), and a timeout its server answered in time or
 * never saw is neither's.
 */
export function targetCovers(target: string, kind: UsageKind, name: string): boolean {
  if (target.startsWith('op:')) return kind === 'op' && name === target.slice(3)
  if (target.startsWith('route:')) {
    if (kind !== 'http') return false
    const want = target.slice(6)
    return want.includes(' ') ? name === want : name.endsWith(` ${want}`)
  }
  // A page Walnut counts visits of is judged by its own rows (page-uses.ts); an older target's words
  // name page errors, as before.
  const key = visitKeyOfTarget(target)
  if (key && isCountedPlace(key)) return false
  return kind === 'page' && name.includes(target.slice(5)) && pageKindIsPagesOwn(name)
}

/** The page requests named like a page target that went wrong on their way, over [since, until). */
function pageRequestsOf(word: string, since: number, until: number): number {
  let n = 0
  for (const r of readHours(Math.floor(since / HOUR_MS) * HOUR_MS, { kind: 'page' })) {
    if (r.hour < until && r.name.includes(word) && pageRequestOf(r.name) !== null) n += r.agg.calls
  }
  return n
}

function row(r: Record<string, unknown>): Watch {
  const parse = <T>(v: unknown, d: T): T => { try { return v ? JSON.parse(String(v)) as T : d } catch { return d } }
  return {
    id: String(r.id), taskId: String(r.task_id), targets: parse(r.targets, []), checks: parse(r.checks, {}), who: String(r.who),
    ...(r.trigger_id ? { triggerId: String(r.trigger_id) } : {}),
    createdAt: Number(r.created_at), ...(r.ship_at != null ? { shipAt: Number(r.ship_at) } : {}),
    checkAt: Number(r.check_at), extended: Number(r.extended) === 1, state: String(r.state) as WatchState,
    ...(r.checked_at != null ? { checkedAt: Number(r.checked_at) } : {}),
    ...(r.result ? { result: parse(r.result, []) } : {}), ...(r.told ? { told: String(r.told) } : {}), ...(r.by ? { by: String(r.by) } : {}),
    ...(r.exempt ? { exempt: parse(r.exempt, { kind: 'copy', reason: '' }) } : {}),
  }
}

export function putWatch(w: Watch): void {
  usageDb(undefined, (d) => {
    d.prepare(`INSERT OR REPLACE INTO watches (id, task_id, targets, checks, who, trigger_id, created_at, ship_at, check_at, extended, state, checked_at, result, told, by, exempt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      w.id, w.taskId, JSON.stringify(w.targets), JSON.stringify(w.checks), w.who, w.triggerId ?? null, w.createdAt, w.shipAt ?? null,
      w.checkAt, w.extended ? 1 : 0, w.state, w.checkedAt ?? null, w.result ? JSON.stringify(w.result) : null, w.told ?? null, w.by ?? null,
      w.exempt ? JSON.stringify(w.exempt) : null,
    )
  })
}

export function newWatch(input: Omit<Watch, 'id' | 'state' | 'extended' | 'createdAt'> & { createdAt?: number; state?: WatchState }): Watch {
  return { ...input, id: `uw-${randomUUID().slice(0, 12)}`, state: input.state ?? 'watching', extended: false, createdAt: input.createdAt ?? Date.now() }
}

export function getWatch(id: string): Watch | null {
  return usageDb(null, (d) => {
    const r = d.prepare('SELECT * FROM watches WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? row(r) : null
  })
}

export function listWatches(filter: { taskId?: string; states?: WatchState[]; limit?: number } = {}): Watch[] {
  return usageDb([], (d) => {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.taskId) { where.push('task_id = ?'); args.push(filter.taskId) }
    if (filter.states?.length) { where.push(`state IN (${filter.states.map(() => '?').join(',')})`); args.push(...filter.states) }
    const sql = `SELECT * FROM watches ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`
    return (d.prepare(sql).all(...args, Math.min(filter.limit ?? 200, 1_000)) as Array<Record<string, unknown>>).map(row)
  })
}

/** Armed watches (state watching, inside their window) covering a recorded name, newest ship first. */
export function armedWatchesFor(kind: UsageKind, name: string, now = Date.now()): Watch[] {
  return listWatches({ states: ['watching'] })
    .filter((w) => w.createdAt <= now && now <= w.checkAt && w.targets.some((t) => targetCovers(t, kind, name)))
    .sort((a, b) => (b.shipAt ?? b.createdAt) - (a.shipAt ?? a.createdAt))
}

function mergedFor(target: string, since: number, until: number): Agg {
  const kind: UsageKind = target.startsWith('op:') ? 'op' : target.startsWith('route:') ? 'http' : 'page'
  let out = emptyAgg()
  // Use is kept by the hour. The hour a window starts in holds calls from before it (a watch armed
  // at 02:57 was failed for an answer of 02:10, before its fix was live), so a window starts at its
  // first whole hour; only one too short to hold a whole hour counts the hour it starts in.
  const next = Math.ceil(since / HOUR_MS) * HOUR_MS
  const from = next + HOUR_MS <= until ? next : Math.floor(since / HOUR_MS) * HOUR_MS
  for (const r of readHours(from, { kind })) {
    if (r.hour >= until || !targetCovers(target, r.kind, r.name)) continue
    out = mergeAgg(out, r.agg)
  }
  return out
}

/**
 * A page target over [since, until): its uses are the visits of the place it names, and only the
 * page's own errors on it fail it (page-uses.ts). An older target naming no place (a component, an
 * error's words) has no visits: only the page errors its words name, as before.
 */
function judgePageTarget(target: string, since: number, until: number, inputs: JudgeInputs): TargetResult {
  const key = visitKeyOfTarget(target)
  // A part was counted from the hour page rows began: by the day, before it, its page's visits stand for it.
  const host = key ? pageOfPart(key) : null
  const days = key ? inputs.visitDays?.(host ?? key) : undefined
  const place = key !== null && isCountedPlace(key, days)
  const use = key && place ? placeUseOf(key, since, until, days) : { visits: 0, errors: 0, byDay: 0 }
  const errors = use.errors + (place ? 0 : mergedFor(target, since, until).calls)
  const notes: string[] = []
  if (errors > 0) notes.push(`${errors} page error${errors === 1 ? '' : 's'}`)
  const ok = notes.length === 0
  // Its requests that went wrong on the way are named, never counted.
  const theirs = place ? 0 : pageRequestsOf(target.slice(5), since, until)
  if (theirs > 0) notes.push(`${theirs} request${theirs === 1 ? '' : 's'} that went wrong on the way (never reached the server, never sent, or timed out on its route or server; not counted)`)
  if (!place) notes.push('names no page Walnut counts visits of')
  else {
    // A name given before only counted places were taken, read as the place it is part of.
    if (Object.prototype.hasOwnProperty.call(PAGE_ALIASES, target.slice(5)) && key && targetOfVisitKey(key) !== target) notes.push(`counted as ${targetOfVisitKey(key)}`)
    if (use.byDay > 0) notes.push(`${use.byDay} of its visits counted by the day${host ? ` as its page's, ${host}'s` : ''} (whole days, the day it was set included: before visits were kept by the hour)`)
  }
  return { target, uses: use.visits, ok, notes, ...(use.byDay ? { byDay: use.byDay } : {}) }
}

/** Judges one target over [since, until): its uses and each check. */
export function judgeTarget(target: string, checks: WatchChecks, since: number, until: number, inputs: JudgeInputs = {}): TargetResult {
  if (target.startsWith('page:')) return judgePageTarget(target, since, until, inputs)
  const c = { ...DEFAULT_CHECKS, ...checks }
  const agg = mergedFor(target, since, until)
  const notes: string[] = []
  // Only Walnut's own faults make the failure rate; the caller's side is reported apart (agg.ts).
  const pct = (n: number) => (agg.calls ? Math.round((n / agg.calls) * 1000) / 10 : 0)
  const failPct = pct(ownFaults(agg))
  const out: TargetResult = { target, uses: agg.calls, ok: true, notes, failPct }
  const caller = callerSide(agg)
  // A route's 4xx answers stay out of both, as before: a route's caller side is its own client's.
  if (caller > 0 && target.startsWith('op:')) out.callerSide = { calls: caller, pct: pct(caller), badArgs: agg.badArgs, refused: agg.refused }
  if (target.startsWith('op:')) {
    out.largest = agg.charsMax
    out.cut = agg.cut
    if (agg.cut > 0) notes.push(`${agg.cut} answer${agg.cut === 1 ? '' : 's'} cut by the agent's harness`)
    if (agg.charsMax > c.max_answer_chars) notes.push(`largest answer ${agg.charsMax.toLocaleString('en-US')} over ${c.max_answer_chars.toLocaleString('en-US')}`)
  } else {
    const p95 = msPercentile(agg, 95)
    if (p95 !== null) out.p95Ms = p95
    if (p95 !== null && agg.calls >= c.min_uses && p95 > c.max_p95_ms) notes.push(`p95 ${p95} ms over ${c.max_p95_ms} ms`)
  }
  if (agg.calls > 0 && failPct > c.max_fail_pct) notes.push(`failures ${failPct}% over ${c.max_fail_pct}%`)
  if (c.no_new_codes) {
    const before = mergedFor(target, since - 7 * 24 * HOUR_MS, since)
    // A code new since the week before, of any class then. Only a new fault of Walnut's fails the
    // target; a new refusal or argument code is the caller's side, and a host away is neither.
    const freshOf = (codes: Record<string, number> | undefined) => Object.keys(codes ?? {}).filter((k) => !(k in before.codes) && !k.startsWith('http_4') && k !== 'unreachable' && k !== ASLEEP_CODE)
    const fresh = freshOf(agg.ownCodes)
    if (fresh.length) { out.newCodes = fresh.slice(0, 10); notes.push(`new error code${fresh.length === 1 ? '' : 's'}: ${fresh.slice(0, 5).join(', ')}`) }
    const callerFresh = freshOf(agg.callerCodes)
    if (callerFresh.length && out.callerSide) out.callerSide.newCodes = callerFresh.slice(0, 10)
  }
  out.ok = notes.length === 0
  return out
}

/** How far back a watch that ended Unknown, or passed on no use, is judged again (rejudgeEnded): the sleep ledger keeps a week. */
export const REJUDGE_UNKNOWN_MS = 7 * 86_400_000

/**
 * A watch that passed with a target of no use (judged before a page's visits were its uses), or ended
 * with too little use on a page target of no use (its name may be one a page now answers for: an alias,
 * every Settings pane, a part read by its page's days). 2026-11-25 and 26.
 */
export function passedOnNoUse(w: Watch): boolean {
  if (w.state === 'passed') return (w.result ?? []).some((r) => r.uses === 0)
  return w.state === 'too_little_use' && (w.result ?? []).some((r) => r.uses === 0 && r.target.startsWith('page:'))
}

/**
 * A watch that ended Unknown, or passed with a target of no use, judged again at its own check time with
 * what is known now, or null when it reads as before. Its time is over, so too little use is final,
 * never extended. For the watches judged before the machine's sleep was left out of the recorded share,
 * and before a page's visits were its uses (2026-11-25).
 */
export function rejudgeEnded(w: Watch, inputs: JudgeInputs = {}): (WatchVerdict & { state: Exclude<WatchState, 'watching' | 'dropped'> }) | null {
  if (!w.checkedAt || !(w.state === 'unknown' || passedOnNoUse(w))) return null
  const v = judgeWatch({ ...w, state: 'watching', extended: true }, w.checkAt, inputs)
  if (v.state === 'unknown' || v.state === 'extended') return null
  return { ...v, state: v.state }
}

/**
 * The share of the minutes in [since, until) this machine was awake that this server recorded (1 = all).
 *
 * A machine asleep runs no server and no one uses it: those minutes are left out, never "not recording"
 * (2026-11-25: 15 watches in three days ended Unknown, every one on the Mac's sleep: 205 minutes one night
 * and 47 in the day, while its 117 restarts cost 13 minutes; a restart's own minute is recorded twice, so
 * hours read 61 to 64). Sleep comes from the hours (store.ts addSlept, kept as long as they are) and the
 * sleep ledger (lib/sleep-ledger.ts, a week), whichever saw more of it.
 */
export function recordedShare(since: number, until: number, slept: (from: number, to: number) => number = sleptBetween): number {
  const first = Math.floor(since / HOUR_MS) * HOUR_MS
  const alive = readAlive(first)
  // The sleep each hour kept (store.ts addSlept: as long as the hours), and the ledger's (a week).
  const kept = readSlept(first)
  let want = 0
  let got = 0
  for (let h = first; h < until; h += HOUR_MS) {
    const from = Math.max(since, h)
    const to = Math.min(until, h + HOUR_MS)
    if (!(to > from)) continue
    const hourSlept = (kept.get(h) ?? 0) * 60_000 * ((to - from) / HOUR_MS)
    const awake = Math.max(0, to - from - Math.max(hourSlept, slept(from, to))) / 60_000
    want += awake
    got += Math.min(awake, alive.get(h) ?? 0)
  }
  return want ? got / want : 1
}

export interface WatchVerdict { state: Exclude<WatchState, 'watching' | 'dropped'> | 'extended'; results: TargetResult[]; summary: string }

/** The caller's side of a target, in the verdict's words: said, never counted as a failure. */
export function callerLine(r: TargetResult): string {
  const c = r.callerSide
  if (!c) return ''
  const parts = [c.badArgs ? `${c.badArgs} with bad arguments` : '', c.refused ? `${c.refused} refused by design` : ''].filter(Boolean).join(', ')
  return ` (not failures: ${parts}, ${c.pct}% of uses${c.newCodes?.length ? `; new codes ${c.newCodes.slice(0, 5).join(', ')}` : ''})`
}

/**
 * The least use a target needs for a verdict: the watch's min_uses, else 20 calls of an op or a route
 * and one visit of a page (a page is opened far less often than an op is called). Never less than one.
 */
export function leastUses(checks: WatchChecks, target: string): number {
  const set = checks.min_uses ?? (target.startsWith('page:') ? 1 : DEFAULT_CHECKS.min_uses)
  return Math.max(1, set)
}

/** The verdict on a watch at its check time. */
export function judgeWatch(w: Watch, now = Date.now(), inputs: JudgeInputs = {}): WatchVerdict {
  const until = Math.min(now, w.checkAt)
  const results = w.targets.map((t) => judgeTarget(t, w.checks, w.createdAt, until, inputs))
  const failed = results.filter((r) => !r.ok)
  const short = results.filter((r) => r.uses < leastUses(w.checks, r.target))
  const line = (r: TargetResult) => `${r.target}: ${r.uses} use${r.uses === 1 ? '' : 's'}${r.notes.length ? `, ${r.notes.join('; ')}` : ''}${callerLine(r)}`
  if (failed.length) return { state: 'failed', results, summary: `Failed: ${failed.map(line).join(' · ')}` }
  if (short.length) {
    // A target nobody used verified nothing: never a pass (2026-11-25: 31 watches passed on page targets of 0 uses).
    const none = short.some((r) => r.uses === 0)
    const words = short.map((r) => `${r.target}: ${r.uses} use${r.uses === 1 ? '' : 's'} (needs ${leastUses(w.checks, r.target)})${r.uses === 0 && r.notes.length ? `, ${r.notes.join('; ')}` : ''}`).join(' · ')
    const head = none ? 'No use, cannot judge' : 'Too little use'
    return w.extended ? { state: 'too_little_use', results, summary: `${head}: ${words}` } : { state: 'extended', results, summary: `${head} so far, checked again: ${words}` }
  }
  if (recordedShare(w.createdAt, until) < 0.9) return { state: 'unknown', results, summary: 'Unknown: the server was not recording for more than a tenth of the time' }
  return { state: 'passed', results, summary: `Passed: ${results.map(line).join(' · ')}` }
}
