/**
 * Property-based + fuzz coverage for the daemon-side cron metadata tracker.
 *
 * The example-based suite lives in daemon-cron-metadata.test.ts; this file
 * attacks the same tracker from two directions the examples cannot reach:
 *
 *  1. A reference model (`derive` over a plain job Map) is driven through the
 *     SAME seeded op stream as the real tracker, and every field the UI reads
 *     is compared after EVERY op. Interleavings nobody would hand-write (a
 *     delayed list landing after a delete that bumped the mutation counter,
 *     a malformed line between a call and its result, a rename in the middle
 *     of a replay) are exactly where a bookkeeping bug hides.
 *  2. Structural fuzzing of one stream line, to pin that a hostile/renamed
 *     CLI payload can never throw out of `observe` (a throw there kills the
 *     daemon's stream reader) and that a parse failure always degrades to
 *     'unknown' with no jobs.
 *
 * Randomness is a hand-rolled mulberry32 (no new dependency), and every
 * failure message carries `seed=<n> op=<i>` so a red run is replayable by
 * setting SEEDS to that single seed.
 */
import { describe, expect, it } from 'vitest'
import { CRON_PROMPT_LIMIT, createCronMetadataTracker, type CronMetadataProcess } from '../../src/providers/daemon-cron-metadata.js'
import { cliOneShotTime, nextCliCronMinute } from '../../src/providers/daemon-cron-schedule.js'
import { DEFAULT_CRON_RESTORE_CONFIG } from '../../src/providers/daemon-cron-transcript.js'
import { normalizeSessionCronJobs, SESSION_CRON_JOB_LIMIT, SESSION_CRON_PROMPT_LIMIT, type SessionCronJob, type SessionCronMetadata } from '../../src/core/types.js'

// -- shared fixture vocabulary (copied from daemon-cron-metadata.test.ts on
// purpose: a test file is not a helper module) --
const PROC: CronMetadataProcess = { identity: 'process-1', alive: true, version: '2.1.258' }
const AT = Date.UTC(2026, 8, 11, 12)
const LIMIT = CRON_PROMPT_LIMIT
const JOB_CAP = 32
type Cfg = { enabled: boolean; recurringMaxAgeMs: number }
const CONFIG: Cfg = { enabled: true, recurringMaxAgeMs: 604_800_000 }
const ZERO_AGE: Cfg = { enabled: true, recurringMaxAgeMs: 0 }
const call = (name: string, input: Record<string, unknown> = {}, id = 'call', timestamp?: number) => JSON.stringify({
  type: 'assistant',
  ...(timestamp === undefined ? {} : { timestamp: new Date(timestamp).toISOString() }),
  message: { content: [{ type: 'tool_use', id, name, input }] },
})
const result = (value: unknown, id = 'call', error = false, timestamp?: number | string) => JSON.stringify({
  type: 'user', tool_use_result: value,
  ...(timestamp === undefined ? {} : { timestamp: typeof timestamp === 'string' ? timestamp : new Date(timestamp).toISOString() }),
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error }] },
})
function fixture(options: { config?: Cfg | null; fresh?: boolean; process?: CronMetadataProcess } = {}) {
  let now = AT
  const proc = options.process ?? PROC
  const values: SessionCronMetadata[] = []
  const tracker = createCronMetadataTracker({
    epoch: 'daemon-1', clock: () => now, changed: (value) => values.push(value),
    nextRun: nextCliCronMinute,
    oneShotTime: (cron, createdAt, id) => cliOneShotTime(cron, createdAt, id, DEFAULT_CRON_RESTORE_CONFIG),
  })
  tracker.configure('session', proc, options.config === undefined ? CONFIG : options.config)
  if (options.fresh !== false) tracker.state('session', proc, false, true)
  return {
    tracker, values, advance: (ms: number) => { now += ms }, now: () => now,
    value: () => tracker.list().find((v) => v.sessionId === 'session')!,
  }
}

/** mulberry32: a 32-bit seeded PRNG, deterministic across platforms. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// -- the reference model --
type OJob = {
  until: number | null
  cron: string | null
  schedule: string | null
  prompt: string | null
  promptTruncated: boolean
  recurring: boolean
  durable: boolean
  createdAt: number | null
  next?: number | null
}
type OPending = { name: string; input: Record<string, unknown>; at: number; mutation: number; listSerial: number }
type OEntry = {
  jobs: Map<string, OJob>
  pending: Map<string, OPending>
  mutation: number
  listSerial: number
  lastListApplied: number
  known: boolean
  complete: boolean
  config: Cfg | null
  replaying: boolean
  /** A cron result the parser could not read; the session stays unknown after. */
  foreign: boolean
}
const freshEntry = (known: boolean): OEntry => ({
  jobs: new Map(), pending: new Map(), mutation: 0, listSerial: 0, lastListApplied: 0, foreign: false,
  known, complete: false, config: null, replaying: false,
})
// Mirrors the tracker's cut: bounded, and never ending on half a surrogate pair.
const otext = (value: unknown, limit: number): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '') : null
function odetails(input: Record<string, unknown> | null, row: Record<string, unknown> | null, previous: OJob | undefined) {
  const rawPrompt = typeof row?.prompt === 'string' ? row.prompt : typeof input?.prompt === 'string' ? input.prompt : null
  return {
    cron: otext(row?.cron, 128) ?? otext(input?.cron, 128) ?? previous?.cron ?? null,
    schedule: otext(row?.humanSchedule, 200) ?? previous?.schedule ?? null,
    prompt: rawPrompt === null ? previous?.prompt ?? null : otext(rawPrompt, LIMIT),
    promptTruncated: rawPrompt === null ? previous?.promptTruncated ?? false : rawPrompt.length > LIMIT,
    recurring: typeof row?.recurring === 'boolean' ? row.recurring : previous?.recurring ?? true,
    durable: row?.durable === true,
  }
}
/** The value the tracker must publish. The driver keeps the process supported
 *  and alive, so the version/liveness axes are pinned by their own test below. */
function derive(entry: OEntry, time: number) {
  const jobs = [...entry.jobs]
  const active = entry.replaying || entry.foreign ? [] : jobs.filter(([, job]) => job.until === null || job.until > time)
  const presence = active.length ? 'active'
    : entry.replaying || entry.foreign || jobs.length || !entry.complete ? 'unknown' : 'inactive'
  // Ids outside the wire contract count for presence but are never reported;
  // the cap keeps the 32 soonest runs after sorting.
  const reported = active.filter(([id]) => id.length > 0 && id.length <= 64).map(([id, job]) => {
    if (job.cron && (job.next === undefined || (job.next !== null && job.next <= time))) job.next = nextCliCronMinute(job.cron, time)
    return {
      id, cron: job.cron, schedule: job.schedule, prompt: job.prompt, promptTruncated: job.promptTruncated,
      recurring: job.recurring, durable: job.durable, createdAt: job.createdAt,
      nextRunAt: job.next ?? null,
      expiresAt: job.until !== null && job.until > 0 ? job.until : null,
    }
  }).sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, JOB_CAP)
  return {
    presence,
    source: jobs.length ? 'cron' : null,
    known: entry.known,
    stale: false,
    validUntil: active.some(([, job]) => job.until === null) ? null
      : active.length ? Math.max(...active.map(([, job]) => job.until!)) : null,
    jobs: reported,
  }
}
const snapshot = (value: SessionCronMetadata) => ({
  presence: value.presence, source: value.source, known: value.known, stale: value.stale,
  validUntil: value.validUntil, jobs: value.jobs ?? [],
})

// -- op vocabulary --
const IDS = ['job-a', 'job-b', 'c0ffee01-c', 'deadbeef-d', 'job-e'] as const
const CRONS = ['* * * * *', '*/5 * * * *', '30 * * * *', 'every 5 minutes'] as const
// Non-ASCII appears only as \u escapes, and only as test data.
const PROMPTS = ['', 'p', 'x'.repeat(LIMIT - 1), 'y'.repeat(LIMIT), 'z'.repeat(LIMIT + 1), '\u4e2d\u6587-\ud83d\ude00'] as const
const KINDS = ['recurring', 'oneshot', 'durable'] as const
const ADVANCES = [60_000, 5 * 60_000, 3_600_000, CONFIG.recurringMaxAgeMs + 1] as const
const LIST_VARIANTS = ['exact', 'extra', 'missing', 'bad-id', 'stale'] as const
const OP_TABLE: string[] = [
  ...Array(22).fill('create'), ...Array(12).fill('delete'), ...Array(16).fill('list'),
  ...Array(12).fill('advance'), ...Array(5).fill('refresh'), ...Array(4).fill('create-error'),
  ...Array(4).fill('create-bad-id'), ...Array(3).fill('ghost'), ...Array(4).fill('malformed'),
  ...Array(3).fill('sidechain'), ...Array(5).fill('configure'), ...Array(5).fill('state'),
  ...Array(3).fill('replay'), ...Array(1).fill('rename'), ...Array(1).fill('remove'),
]

type Violation = string
type Mismatch = string

/**
 * Drives tracker + model through `ops` random operations over `sids`,
 * comparing after every one and checking the emitted-value invariants.
 */
function runSeed(seed: number, sids: readonly string[], ops: number, out: { mismatches: Mismatch[]; violations: Violation[]; stats: Stats }) {
  const rnd = mulberry32(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
  let now = AT
  const oracle = new Map<string, OEntry>()
  // A value emitted while `renaming`, or the first value after remove()/rename()
  // reset an entry, deliberately bypasses the tracker's dedupe (the entry has no
  // previous value to compare against), so those are exempt from the dedupe rule.
  let renaming = false
  const exempt = new Set<string>()
  const last = new Map<string, string>()
  let revision = 0
  const tracker = createCronMetadataTracker({
    epoch: 'daemon-1', clock: () => now,
    nextRun: nextCliCronMinute,
    oneShotTime: (cron, createdAt, id) => cliOneShotTime(cron, createdAt, id, DEFAULT_CRON_RESTORE_CONFIG),
    changed: (value) => checkEmitted(value, renaming || exempt.delete(value.sessionId)),
  })
  const where = (op: number, extra = '') => `seed=${seed} op=${op} sids=${sids.length}${extra}`
  const fail = (op: number, message: string) => { if (out.violations.length < 4) out.violations.push(`${where(op)}: ${message}`) }
  let currentOp = -1
  function checkEmitted(value: SessionCronMetadata, dedupeExempt: boolean) {
    const op = currentOp
    const stats = out.stats
    stats.values++
    stats.presence.add(value.presence)
    if (!(value.revision > revision)) fail(op, `revision did not increase: ${value.revision} after ${revision}`)
    revision = value.revision
    const jobs = value.jobs
    if (!Array.isArray(jobs)) return fail(op, 'jobs is not an array')
    if (jobs.length > JOB_CAP) fail(op, `jobs.length ${jobs.length} > ${JOB_CAP}`)
    if ((value.presence === 'active') !== (jobs.length > 0)) {
      fail(op, `presence ${value.presence} with ${jobs.length} jobs`)
    }
    if (normalizeSessionCronJobs(jobs) === null) fail(op, `normalizeSessionCronJobs rejected ${JSON.stringify(jobs).slice(0, 300)}`)
    let previous: SessionCronJob | null = null
    for (const job of jobs) {
      if (typeof job.id !== 'string' || !job.id) fail(op, `job id ${JSON.stringify(job.id)}`)
      if (job.prompt !== null && job.prompt.length > LIMIT) fail(op, `prompt length ${job.prompt.length}`)
      if (job.promptTruncated && (job.prompt === null || job.prompt.length !== LIMIT)) {
        fail(op, `promptTruncated with prompt length ${job.prompt?.length ?? null}`)
      }
      if (job.expiresAt !== null && !(job.expiresAt > 0)) fail(op, `expiresAt ${job.expiresAt}`)
      if (job.nextRunAt !== null && !(job.nextRunAt > value.observedAt)) {
        fail(op, `nextRunAt ${job.nextRunAt} <= observedAt ${value.observedAt}`)
      }
      if (previous) {
        const a = previous.nextRunAt ?? Infinity
        const b = job.nextRunAt ?? Infinity
        if (a > b || (a === b && !(previous.id < job.id))) fail(op, `jobs out of order: ${previous.id}@${a} before ${job.id}@${b}`)
      }
      previous = job
    }
    const key = JSON.stringify({ ...value, revision: 0, observedAt: 0 })
    if (!dedupeExempt && last.get(value.sessionId) === key) fail(op, `duplicate value republished for ${value.sessionId}`)
    else if (dedupeExempt) stats.exempt++
    last.set(value.sessionId, key)
  }
  const ensure = (sid: string) => {
    let entry = oracle.get(sid)
    if (!entry) oracle.set(sid, entry = freshEntry(false))
    return entry
  }
  // Rows drop fields at random so the `previous ?? null` fallbacks in details()
  // become load-bearing (a full row would never consult the remembered job).
  const rows = (entry: OEntry) => [...entry.jobs].map(([id, job]) => {
    const row: Record<string, unknown> = { id }
    if (rnd() < 0.8 && job.cron !== null) row.cron = job.cron
    if (rnd() < 0.7 && job.schedule !== null) row.humanSchedule = job.schedule
    if (rnd() < 0.7 && job.prompt !== null) row.prompt = job.prompt
    if (rnd() < 0.8) row.recurring = job.recurring
    if (rnd() < 0.8) row.durable = job.durable
    return row
  })
  const applyList = (entry: OEntry, callId: string, listed: Array<Record<string, unknown>>, at: number) => {
    const pending = entry.pending.get(callId)
    entry.pending.delete(callId)
    if (!pending || pending.mutation !== entry.mutation || pending.listSerial <= entry.lastListApplied) return
    if (listed.some((row) => typeof row.id !== 'string')) return
    const next = new Map<string, OJob>()
    for (const row of listed) {
      const id = row.id as string
      const previous = entry.jobs.get(id)
      next.set(id, {
        until: row.durable === true ? 0 : previous ? previous.until : at,
        createdAt: previous?.createdAt ?? null,
        ...odetails(null, row, previous),
      })
    }
    entry.jobs = next
    entry.lastListApplied = pending.listSerial
    entry.complete = true
    if (listed.length) entry.known = true
  }
  const oracleRename = (from: string, to: string) => {
    const previous = oracle.get(from)
    if (!previous) return
    oracle.delete(from)
    if (!previous.replaying) oracle.set(to, previous)
    const entry = ensure(to)
    entry.known ||= previous.known
  }

  for (let i = 0; i < ops; i++) {
    currentOp = i
    const kind = pick(OP_TABLE)
    out.stats.ops.add(kind)
    const sid = pick(sids)
    const callId = `t${i}`
    if (kind === 'advance') {
      now += pick(ADVANCES)
    } else if (kind === 'refresh') {
      tracker.refresh()
    } else if (kind === 'remove') {
      tracker.remove(sid)
      oracle.delete(sid)
      exempt.add(sid)
    } else if (kind === 'rename') {
      const alt = `${sid}#alt`
      renaming = true
      // Out and back: each direction emits a synthetic 'cleared' value for the
      // key it leaves, which is unconditional by design, hence the exemption.
      tracker.rename(sid, alt, PROC)
      oracleRename(sid, alt)
      tracker.rename(alt, sid, PROC)
      oracleRename(alt, sid)
      renaming = false
    } else if (kind === 'configure') {
      const config = pick([CONFIG, ZERO_AGE, null] as const)
      tracker.configure(sid, PROC, config)
      ensure(sid).config = config
    } else if (kind === 'state') {
      const known = rnd() < 0.5
      const fresh = rnd() < 0.5
      tracker.state(sid, PROC, known, fresh)
      const entry = ensure(sid)
      entry.known ||= known
      if (fresh) entry.complete = true
    } else if (kind === 'replay') {
      const loading = rnd() < 0.5
      const failed = !loading && rnd() < 0.5
      tracker.replay(sid, PROC, loading, failed)
      const entry = ensure(sid)
      entry.replaying = loading
      if (failed) { entry.jobs.clear(); entry.pending.clear(); entry.complete = false }
    } else if (kind === 'malformed') {
      tracker.observe(sid, PROC, '{"type":"user","tool_use_result":"CronDelete"')
      const entry = ensure(sid)
      entry.jobs.clear(); entry.pending.clear(); entry.complete = false
    } else if (kind === 'sidechain') {
      const line = JSON.parse(call('CronCreate', { cron: '* * * * *', prompt: 'ignored' }, callId)) as Record<string, unknown>
      tracker.observe(sid, PROC, JSON.stringify(rnd() < 0.5 ? { ...line, isSidechain: true } : { ...line, parent_tool_use_id: 'agent' }))
      ensure(sid)
    } else if (kind === 'ghost') {
      // A result for a tool_use nobody issued. The id carries a Cron word so the
      // line clears the relevance gate and actually reaches the block loop.
      tracker.observe(sid, PROC, result({ id: 'CronCreate-ghost' }, 'ghost'))
      ensure(sid)
    } else if (kind === 'delete') {
      const id = pick(IDS)
      const entry = ensure(sid)
      tracker.observe(sid, PROC, call('CronDelete', { id }, callId))
      entry.pending.set(callId, { name: 'CronDelete', input: { id }, at: now, mutation: entry.mutation, listSerial: 0 })
      tracker.observe(sid, PROC, result({}, callId))
      if (entry.pending.delete(callId)) { entry.jobs.delete(id); entry.mutation++ }
    } else if (kind === 'list') {
      const variant = pick(LIST_VARIANTS)
      const entry = ensure(sid)
      tracker.observe(sid, PROC, call('CronList', {}, callId))
      entry.listSerial++
      entry.pending.set(callId, { name: 'CronList', input: {}, at: now, mutation: entry.mutation, listSerial: entry.listSerial })
      let listed: Array<Record<string, unknown>> = rows(entry)
      if (variant === 'extra') listed = [...listed, { id: `ghost-${i}`, cron: '* * * * *', recurring: true, durable: false }]
      if (variant === 'missing') listed = listed.slice(1)
      if (variant === 'bad-id') listed = [...listed, { id: i }]
      if (variant === 'stale') {
        // A mutation lands between the call and its reply, so the list must be
        // dropped. The rows deliberately omit a job AND the intervening op adds
        // or removes one, so wrongly applying the list changes the reported list
        // (a stale list that happens to agree with reality proves nothing).
        if (listed.length > 1) listed = listed.slice(1)
        const inner = `${callId}-x`
        if (rnd() < 0.5) {
          const victim = pick(IDS)
          tracker.observe(sid, PROC, call('CronDelete', { id: victim }, inner))
          entry.pending.set(inner, { name: 'CronDelete', input: { id: victim }, at: now, mutation: entry.mutation, listSerial: 0 })
          tracker.observe(sid, PROC, result({}, inner))
          if (entry.pending.delete(inner)) { entry.jobs.delete(victim); entry.mutation++ }
        } else {
          const born = `stale-${i}`
          tracker.observe(sid, PROC, call('CronCreate', { cron: '* * * * *', prompt: 'born mid-list' }, inner))
          entry.pending.set(inner, { name: 'CronCreate', input: { id: undefined, cron: '* * * * *', prompt: 'born mid-list' }, at: now, mutation: entry.mutation, listSerial: 0 })
          const row = { id: born, humanSchedule: 'Every minute', recurring: true, durable: false }
          tracker.observe(sid, PROC, result(row, inner))
          entry.foreign = false
          const pending = entry.pending.get(inner)
          entry.pending.delete(inner)
          if (pending) {
            entry.known = true
            const maxAge = entry.config?.recurringMaxAgeMs
            entry.jobs.set(born, {
              until: maxAge === 0 ? null : typeof maxAge === 'number' ? pending.at + maxAge : 0,
              createdAt: pending.at, ...odetails(pending.input, row, entry.jobs.get(born)),
            })
            entry.mutation++
          }
        }
      }
      tracker.observe(sid, PROC, result({ jobs: listed }, callId))
      // A list whose rows ARE an array is readable, whatever is inside them, so
      // it clears any earlier shape doubt even when the list is dropped as stale.
      entry.foreign = false
      applyList(entry, callId, listed, now)
    } else {
      const id = pick(IDS)
      const cron = pick(CRONS)
      const shape = pick(KINDS)
      const entry = ensure(sid)
      // A sparse call/result is the interesting one: the tracker must fall back
      // to what it already remembers for the job instead of inventing a value.
      const input: Record<string, unknown> = { cron, ...(rnd() < 0.75 ? { prompt: pick(PROMPTS) } : {}) }
      tracker.observe(sid, PROC, call('CronCreate', input, callId))
      entry.pending.set(callId, { name: 'CronCreate', input: { id: input.id, cron: input.cron, prompt: input.prompt }, at: now, mutation: entry.mutation, listSerial: 0 })
      const row: Record<string, unknown> = { id: kind === 'create-bad-id' ? i : id }
      if (rnd() < 0.7) row.humanSchedule = `schedule ${cron}`
      if (rnd() < 0.8) row.recurring = shape !== 'oneshot'
      if (shape === 'durable') row.durable = true
      else if (rnd() < 0.8) row.durable = false
      tracker.observe(sid, PROC, result(row, callId, kind === 'create-error'))
      const pending = entry.pending.get(callId)
      entry.pending.delete(callId)
      // A create result whose id is not a string means the CLI contract may have
      // moved, so the session reports `unknown` until a readable result arrives.
      if (pending && (kind === 'create' || kind === 'create-bad-id')) entry.foreign = kind === 'create-bad-id'
      if (pending && kind === 'create') {
        entry.known = true
        const maxAge = entry.config?.recurringMaxAgeMs
        // `until` follows the DECLARED recurrence (an omitted flag means
        // recurring), and the reported flag is that same declaration.
        const recurring = row.recurring !== false
        const oneShot = recurring ? null : cliOneShotTime(cron, pending.at, id, DEFAULT_CRON_RESTORE_CONFIG)
        const until = row.durable === true ? 0
          : recurring && maxAge === 0 ? null
            : recurring && typeof maxAge === 'number' ? pending.at + maxAge : oneShot ?? 0
        entry.jobs.set(id, { until, createdAt: pending.at, ...odetails(pending.input, row, entry.jobs.get(id)), recurring })
        entry.mutation++
      }
    }

    // Compare every published field after every op. `list()` re-emits whatever
    // the clock changed, so the invariant checker sees those values too.
    const expected: Record<string, string> = {}
    for (const [key, entry] of oracle) expected[key] = JSON.stringify(derive(entry, now))
    const actual: Record<string, string> = {}
    for (const value of tracker.list()) actual[value.sessionId] = JSON.stringify(snapshot(value))
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (expected[key] === actual[key]) continue
      if (out.mismatches.length < 3) {
        // Clipped: a job carries a 2000-char prompt, and vitest's diff of two
        // multi-megabyte strings takes minutes to render.
        const clip = (text: string | undefined) => text === undefined ? '<absent>' : text.length > 600 ? `${text.slice(0, 600)}...(${text.length})` : text
        out.mismatches.push(`${where(i, ` kind=${kind} sid=${key}`)}\n  model:   ${clip(expected[key])}\n  tracker: ${clip(actual[key])}`)
      }
      return
    }
    out.stats.compares++
  }
}

type Stats = { values: number; compares: number; exempt: number; presence: Set<string>; ops: Set<string> }
const newStats = (): Stats => ({ values: 0, compares: 0, exempt: 0, presence: new Set(), ops: new Set() })

function sweep(seeds: number, sids: readonly string[], ops: number) {
  const out = { mismatches: [] as Mismatch[], violations: [] as Violation[], stats: newStats() }
  for (let seed = 1; seed <= seeds; seed++) runSeed(seed, sids, ops, out)
  return out
}
let singleCache: ReturnType<typeof sweep> | null = null
const single = () => (singleCache ??= sweep(150, ['session'], 40))
let multiCache: ReturnType<typeof sweep> | null = null
const multi = () => (multiCache ??= sweep(60, ['s-1', 's-2', 's-3', 's-4'], 40))

describe('cron metadata tracker properties', () => {
  it('matches a reference model over 150 seeded op interleavings', () => {
    const run = single()
    expect(run.mismatches).toEqual([])
    expect(run.stats.compares).toBeGreaterThan(5_000)
    // Every op kind must actually have fired, or the sweep proves nothing.
    expect([...run.stats.ops].sort()).toEqual([...new Set(OP_TABLE)].sort())
  })

  it('holds the published-value invariants for every emitted value', () => {
    const run = single()
    expect(run.violations).toEqual([])
    expect(run.stats.values).toBeGreaterThan(1_000)
    expect([...run.stats.presence].sort()).toEqual(['active', 'inactive', 'unknown'])
    // Dedupe is only waived for entries the tracker just reset; if that count
    // ever approaches the emitted count the exemption has swallowed the rule.
    expect(run.stats.exempt).toBeLessThan(run.stats.values / 2)
  })

  it('keeps four sessions independent under interleaved ops and renames', () => {
    const run = multi()
    expect(run.mismatches).toEqual([])
    expect(run.violations).toEqual([])
    expect(run.stats.compares).toBeGreaterThan(2_000)
  })

  it('never lets one session see another session job and lists each live sid once', () => {
    // Same driver, but assert the cross-session shape directly rather than
    // through the per-sid model: ids are namespaced per session here.
    const rnd = mulberry32(99)
    let now = AT
    const seen = new Map<string, Set<string>>()
    const tracker = createCronMetadataTracker({
      epoch: 'daemon-1', clock: () => now, nextRun: nextCliCronMinute,
      changed: (value) => {
        const ids = seen.get(value.sessionId) ?? new Set<string>()
        for (const job of value.jobs ?? []) ids.add(job.id)
        seen.set(value.sessionId, ids)
      },
    })
    const sids = ['s-1', 's-2', 's-3', 's-4']
    for (const sid of sids) { tracker.configure(sid, PROC, CONFIG); tracker.state(sid, PROC, false, true) }
    for (let i = 0; i < 200; i++) {
      const sid = sids[Math.floor(rnd() * sids.length)]!
      const id = `${sid}-job-${Math.floor(rnd() * 3)}`
      if (rnd() < 0.7) {
        tracker.observe(sid, PROC, call('CronCreate', { cron: '* * * * *', prompt: id }, `c${i}`))
        tracker.observe(sid, PROC, result({ id, recurring: true, durable: false }, `c${i}`))
      } else {
        tracker.observe(sid, PROC, call('CronDelete', { id }, `d${i}`))
        tracker.observe(sid, PROC, result({}, `d${i}`))
      }
      if (rnd() < 0.05) now += 60_000
    }
    for (const [sid, ids] of seen) {
      for (const id of ids) expect(id.startsWith(`${sid}-job-`), `${sid} reported ${id}`).toBe(true)
    }
    // Non-vacuity: every session published jobs, so the loop above judged something.
    expect(seen.size).toBe(sids.length)
    expect([...seen.values()].reduce((total, ids) => total + ids.size, 0)).toBeGreaterThan(6)
    const listed = tracker.list().map((v) => v.sessionId)
    expect(listed.sort()).toEqual(sids)
    expect(new Set(listed).size).toBe(sids.length)
  })

  it('never throws on a fuzzed stream line and resets to unknown when the line is not JSON', () => {
    const BASE: Record<string, unknown> = {
      type: 'user',
      tool_use_result: { id: 'job', cron: '* * * * *', humanSchedule: 'Every minute', prompt: 'p', recurring: true, durable: false },
      message: { content: [{ type: 'tool_result', tool_use_id: 'fuzz', is_error: false }] },
    }
    const LIST_BASE: Record<string, unknown> = {
      type: 'user',
      tool_use_result: { jobs: [{ id: 'job', cron: '* * * * *', humanSchedule: 'Every minute', prompt: 'p', recurring: true, durable: false }] },
      message: { content: [{ type: 'tool_result', tool_use_id: 'fuzz', is_error: false }] },
    }
    // The call side matters too: it is the shape whose truncated prefixes still
    // carry a Cron word, so a torn line reaches the parse-failure reset path.
    const CALL_BASE: Record<string, unknown> = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'fuzz', name: 'CronList', input: { id: 'job' } }] },
    }
    const RETYPES: unknown[] = [
      0, -1, 1e308, true, null, [], [[]], [{ id: 'job' }], {}, { nested: { deep: [1, 2] } },
      'x'.repeat(40_000), '\u0000\u0001\u001f', '\ud800', '\udfff\ud800', '__proto__', { id: { id: 'job' } },
    ]
    const violations: string[] = []
    const gate = /CronCreate|CronDelete|CronList|"init"/
    let unparsable = 0
    let reset = 0
    let mutated = 0
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = mulberry32(seed * 7919)
      const template = [BASE, LIST_BASE, CALL_BASE][Math.floor(rnd() * 3)]!
      const base = JSON.parse(JSON.stringify(template)) as Record<string, unknown>
      const paths: string[][] = [[], ['tool_use_result'], ['message'], ['message', 'content', '0'], ['message', 'content', '0', 'input']]
      const path = paths[Math.floor(rnd() * paths.length)]!
      let node: any = base
      for (const step of path) node = node?.[step]
      if (node && typeof node === 'object') {
        const keys = Object.keys(node)
        const key = keys[Math.floor(rnd() * keys.length)]
        if (key !== undefined) {
          if (rnd() < 0.35) delete node[key]
          else node[key] = RETYPES[Math.floor(rnd() * RETYPES.length)]
        }
      }
      let line = JSON.stringify(base)
      if (line !== JSON.stringify(template)) mutated++
      const roll = rnd()
      if (roll < 0.25) line = line.slice(0, Math.max(1, Math.floor(rnd() * line.length)))
      else if (roll < 0.5) {
        // A bare control char is illegal inside a JSON string; a lone surrogate
        // is legal text the tracker must carry without choking.
        const cut = Math.floor(rnd() * line.length)
        line = `${line.slice(0, cut)}${rnd() < 0.5 ? '\u0007' : '\ud800'}${line.slice(cut)}`
      } else if (roll < 0.6) {
        // A real `__proto__` KEY only exists at the text level: writing
        // `obj.__proto__ = x` in JS retargets the prototype and serialises to
        // nothing, so the interesting payload would never reach the tracker.
        line = `{"__proto__":{"polluted":true},"constructor":{"polluted":true},${line.slice(1)}`
      }
      // Fresh tracker per mutation: one confirmed job plus one pending call, so
      // a reset is observable and the result line has something to pair with.
      const f = fixture()
      f.tracker.observe('session', PROC, call('CronCreate', { cron: '* * * * *', prompt: 'seed' }, 'seeded'))
      f.tracker.observe('session', PROC, result({ id: 'seed-job', recurring: true, durable: false }, 'seeded'))
      f.tracker.observe('session', PROC, call('CronList', {}, 'fuzz'))
      let threw: unknown
      try { f.tracker.observe('session', PROC, line) } catch (error) { threw = error }
      if (threw) violations.push(`seed=${seed} threw ${String(threw)} for ${line.slice(0, 160)}`)
      const value = f.value()
      if (!['active', 'inactive', 'unknown'].includes(value.presence)) violations.push(`seed=${seed} presence ${value.presence}`)
      if (normalizeSessionCronJobs(value.jobs) === null) violations.push(`seed=${seed} unusable jobs ${JSON.stringify(value.jobs).slice(0, 200)}`)
      let parses = true
      try { JSON.parse(line) } catch { parses = false }
      // Both arms of the tracker's own relevance gate: a Cron word, or a result
      // naming a call it is still waiting on ('fuzz' is pending here).
      const gated = gate.test(line) || (line.includes('tool_result') && line.includes('"fuzz"'))
      if (!parses && gated) {
        unparsable++
        if (value.presence !== 'unknown' || (value.jobs ?? []).length !== 0) {
          violations.push(`seed=${seed} unparsable line left presence=${value.presence} jobs=${(value.jobs ?? []).length}`)
        } else reset++
      }
      if (violations.length > 4) break
    }
    expect(violations).toEqual([])
    // Non-vacuity: the generator must really be mutating lines, and the
    // parse-failure reset path must really have been walked.
    expect(mutated).toBeGreaterThan(150)
    // Measured 33 of 300 seeds at the time of writing; the floor is a canary,
    // not a target, and the seeds are fixed so it cannot drift on its own.
    expect(unparsable).toBeGreaterThan(20)
    expect(reset).toBe(unparsable)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).id).toBeUndefined()
  })

  it('cuts a surrogate pair at the prompt limit by dropping the orphaned half', () => {
    const f = fixture()
    // 1999 BMP chars + one astral emoji = 2001 UTF-16 units, so slice(0, 2000)
    // lands between the surrogates; the lone high surrogate must not be shipped.
    const prompt = 'a'.repeat(LIMIT - 1) + '\ud83d\ude00'
    expect(prompt.length).toBe(LIMIT + 1)
    f.tracker.observe('session', PROC, call('CronCreate', { cron: '* * * * *', prompt }))
    f.tracker.observe('session', PROC, result({ id: 'job', recurring: true, durable: false }))
    const value = f.value()
    const job = value.jobs![0]!
    expect(job.prompt).toBe('a'.repeat(LIMIT - 1))
    expect(job.promptTruncated).toBe(true)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(job.prompt!)).toBe(false)
    const wire = JSON.stringify(value)
    expect(wire).not.toContain('\\ud83d')
    expect(JSON.parse(wire).jobs[0].prompt).toHaveLength(LIMIT - 1)
    expect(normalizeSessionCronJobs(value.jobs)).not.toBeNull()
    // A pair that fits whole at the limit is kept whole.
    const g = fixture()
    g.tracker.observe('session', PROC, call('CronCreate', { cron: '* * * * *', prompt: 'a'.repeat(LIMIT - 2) + '\ud83d\ude00' + 'tail' }))
    g.tracker.observe('session', PROC, result({ id: 'job', recurring: true, durable: false }))
    expect(g.value().jobs![0]!.prompt).toBe('a'.repeat(LIMIT - 2) + '\ud83d\ude00')
  })

  it('arms only on a verified CLI version, across the alive axis', () => {
    // Verified band: 2.1.224 and up, read off real transcripts (2.1.224, 2.1.258,
    // 2.1.265 all share the cron contract). Anything else stays unknown.
    for (const version of ['2.1.223', '2.1.224', '2.1.258', '2.1.268', '2.2.0', undefined]) {
      for (const alive of [true, false]) {
        const proc: CronMetadataProcess = { identity: 'p', alive, version }
        const f = fixture({ process: proc })
        const supported = version !== undefined && /^2\.1\.(\d+)/.test(version) && Number(/^2\.1\.(\d+)/.exec(version)![1]) >= 224
        const label = `version=${version} alive=${alive}`
        expect(f.value(), `${label} empty`).toMatchObject({
          presence: supported ? 'inactive' : 'unknown', stale: !alive, jobs: [],
        })
        f.tracker.observe('session', proc, call('CronCreate', { cron: '* * * * *', prompt: 'p' }))
        f.tracker.observe('session', proc, result({ id: 'job', recurring: true, durable: false }))
        const value = f.value()
        expect(value.presence, `${label} created`).toBe(supported && alive ? 'active' : 'unknown')
        expect(value.jobs, `${label} jobs`).toHaveLength(supported && alive ? 1 : 0)
        expect(value.known, `${label} known`).toBe(true)
        expect(value.source, `${label} source`).toBe('cron')
      }
    }
  })

  it('adopts the version from an init line and republishes on the upgrade', () => {
    const proc: CronMetadataProcess = { identity: 'p', alive: true, version: undefined }
    const f = fixture({ process: proc })
    expect(f.value().presence).toBe('unknown')
    const before = f.values.length
    f.tracker.observe('session', proc, JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '2.1.258' }))
    expect(f.values.length).toBe(before + 1)
    expect(f.value().presence).toBe('inactive')
    f.tracker.observe('session', proc, call('CronCreate', { cron: '* * * * *', prompt: 'p' }))
    f.tracker.observe('session', proc, result({ id: 'job', recurring: true, durable: false }))
    expect(f.value().presence).toBe('active')
    // A newer patch in the verified band keeps reporting; a different minor does not.
    f.tracker.observe('session', proc, JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '2.1.268' }))
    expect(f.value().presence).toBe('active')
    f.tracker.observe('session', proc, JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '2.2.0' }))
    expect(f.value().presence).toBe('unknown')
  })

  it('accepts a result stamp inside the clock-skew window and ignores the rest', () => {
    const cases: Array<[string, number | string | undefined, number]> = [
      ['no stamp', undefined, AT],
      ['59s ahead', AT + 59_000, AT + 59_000],
      ['61s ahead', AT + 61_000, AT],
      ['exactly 60s ahead', AT + 60_000, AT + 60_000],
      ['epoch zero', '1970-01-01T00:00:00.000Z', AT],
      ['unparsable', 'not-a-date', AT],
      ['in the past', AT - 3_600_000, AT - 3_600_000],
    ]
    for (const [label, stamp, createdAt] of cases) {
      const f = fixture()
      f.tracker.observe('session', PROC, call('CronCreate', { cron: '* * * * *', prompt: 'p' }))
      f.tracker.observe('session', PROC, result({ id: 'job', recurring: true, durable: false }, 'call', false, stamp))
      expect(f.value().jobs![0], label).toMatchObject({ createdAt, expiresAt: createdAt + CONFIG.recurringMaxAgeMs })
    }
    // A numeric timestamp is not an ISO string, so it is ignored outright.
    const f = fixture()
    f.tracker.observe('session', PROC, call('CronCreate', { cron: '* * * * *', prompt: 'p' }))
    f.tracker.observe('session', PROC, JSON.stringify({
      type: 'user', timestamp: AT - 3_600_000, tool_use_result: { id: 'job', recurring: true, durable: false },
      message: { content: [{ type: 'tool_result', tool_use_id: 'call', is_error: false }] },
    }))
    expect(f.value().jobs![0]).toMatchObject({ createdAt: AT })
  })

  it('treats a zero max age as an endless job and a missing config as unknown', () => {
    const zero = fixture({ config: ZERO_AGE })
    zero.tracker.observe('session', PROC, call('CronCreate', { cron: '* * * * *', prompt: 'p' }))
    zero.tracker.observe('session', PROC, result({ id: 'job', recurring: true, durable: false }))
    expect(zero.value()).toMatchObject({ presence: 'active', validUntil: null })
    expect(zero.value().jobs![0]).toMatchObject({ expiresAt: null })
    zero.advance(CONFIG.recurringMaxAgeMs * 10)
    expect(zero.value()).toMatchObject({ presence: 'active', validUntil: null })

    const none = fixture({ config: null })
    none.tracker.observe('session', PROC, call('CronCreate', { cron: '* * * * *', prompt: 'p' }, 'first'))
    none.tracker.observe('session', PROC, result({ id: 'first', recurring: true, durable: false }, 'first'))
    expect(none.value()).toMatchObject({ presence: 'unknown', known: true, source: 'cron', jobs: [] })
    // Learning the config later does NOT revive the job created without one:
    // `until` is stamped at creation, so configure() emits but publishes nothing
    // new. Only a create made after the config arrives can go active.
    const before = none.values.length
    none.tracker.configure('session', PROC, CONFIG)
    expect(none.values.length).toBe(before)
    expect(none.value().presence).toBe('unknown')
    none.tracker.observe('session', PROC, call('CronCreate', { cron: '* * * * *', prompt: 'p' }, 'second'))
    none.tracker.observe('session', PROC, result({ id: 'second', recurring: true, durable: false }, 'second'))
    expect(none.value()).toMatchObject({ presence: 'active' })
    expect(none.value().jobs!.map((job) => job.id)).toEqual(['second'])
  })

  it('caps the report at the 32 soonest runs and keeps validUntil over every active job', () => {
    const f = fixture()
    // Created newest-id-last so insertion order and id order disagree; with no
    // nextRun the sort falls back to id, so job-00..job-31 must be the survivors.
    for (let i = 39; i >= 0; i--) {
      const id = `job-${String(i).padStart(2, '0')}`
      f.tracker.observe('session', PROC, call('CronCreate', { cron: '* * * * *', prompt: id }, id))
      f.tracker.observe('session', PROC, result({ id, recurring: true, durable: false }, id))
      f.advance(1_000)
    }
    const value = f.value()
    expect(value.presence).toBe('active')
    expect(value.jobs).toHaveLength(JOB_CAP)
    expect(value.jobs!.map((job) => job.id)).toEqual(
      Array.from({ length: JOB_CAP }, (_, i) => `job-${String(i).padStart(2, '0')}`),
    )
    // validUntil spans ALL 40 active jobs; here the last-created (job-00) holds it.
    const lastCreated = AT + 39 * 1_000
    expect(value.validUntil).toBe(lastCreated + CONFIG.recurringMaxAgeMs)
    expect(normalizeSessionCronJobs(value.jobs)).not.toBeNull()

    // With a real nextRun the cap follows the schedule, not the id.
    const g = fixture()
    for (let i = 0; i < JOB_CAP + 3; i++) {
      const id = `job-${String(i).padStart(2, '0')}`
      // Later ids run sooner: minute (59 - i) of the current hour or the next.
      g.tracker.observe('session', PROC, call('CronCreate', { cron: `${59 - i} * * * *`, prompt: id }, id))
      g.tracker.observe('session', PROC, result({ id, recurring: true, durable: false }, id))
    }
    const soonest = g.value().jobs!
    expect(soonest).toHaveLength(JOB_CAP)
    for (let i = 1; i < soonest.length; i++) expect(soonest[i]!.nextRunAt!).toBeGreaterThanOrEqual(soonest[i - 1]!.nextRunAt!)
    const all = Array.from({ length: JOB_CAP + 3 }, (_, i) => nextCliCronMinute(`${59 - i} * * * *`, AT)!).sort((a, b) => a - b)
    expect(soonest.map((job) => job.nextRunAt)).toEqual(all.slice(0, JOB_CAP))
  })

  it('starts a fresh unknown entry after remove() and keeps no evidence', () => {
    const f = fixture()
    f.tracker.observe('session', PROC, call('CronCreate', { cron: '* * * * *', prompt: 'p' }))
    f.tracker.observe('session', PROC, result({ id: 'job', recurring: true, durable: false }))
    expect(f.value()).toMatchObject({ presence: 'active', known: true })
    f.tracker.remove('session')
    expect(f.tracker.list()).toEqual([])
    // A fresh entry: no jobs, no `known`, and no `complete`, so presence is
    // 'unknown' until a list or a fresh-start marker proves the inventory.
    f.tracker.state('session', PROC)
    expect(f.value()).toMatchObject({ presence: 'unknown', known: false, source: null, jobs: [] })
    f.tracker.state('session', PROC, false, true)
    expect(f.value()).toMatchObject({ presence: 'inactive', known: false })
  })

  // An id outside the shared contract (empty or over 64 chars) would make
  // normalizeSessionCronJobs reject the WHOLE list downstream, so the tracker
  // keeps such a job for presence but leaves it out of the reported details.
  it('keeps reported jobs within the shared id contract', () => {
    for (const id of ['', 'z'.repeat(65)]) {
      const f = fixture()
      f.tracker.observe('session', PROC, call('CronCreate', { cron: '* * * * *', prompt: 'x' }, 'good'))
      f.tracker.observe('session', PROC, result({ id: 'good-job', recurring: true, durable: false }, 'good'))
      f.tracker.observe('session', PROC, call('CronCreate', { cron: '* * * * *', prompt: 'x' }, 'bad'))
      f.tracker.observe('session', PROC, result({ id, recurring: true, durable: false }, 'bad'))
      const value = f.value()
      expect(value.presence, `id=${JSON.stringify(id)}`).toBe('active')
      expect(normalizeSessionCronJobs(value.jobs), `id=${JSON.stringify(id)}`).not.toBeNull()
      expect(value.jobs!.map((job) => job.id)).toEqual(['good-job'])
      // Presence still follows the odd job: deleting the good one leaves it armed but detail-less.
      f.tracker.observe('session', PROC, call('CronDelete', { id: 'good-job' }, 'del'))
      f.tracker.observe('session', PROC, result({}, 'del'))
      expect(f.value()).toMatchObject({ presence: 'active', jobs: [] })
    }
  })

  it('pins the limits the tracker shares with the core contract', () => {
    expect(CRON_PROMPT_LIMIT).toBe(SESSION_CRON_PROMPT_LIMIT)
    expect(JOB_CAP).toBe(SESSION_CRON_JOB_LIMIT)
  })

  /**
   * The adopted-session rule, against its own small oracle: with
   * `attributeByTime` the byte offset means nothing and BOTH lines of a create
   * (the tool_use and its result) must be stamped at or after the process start
   * for the job to count. Offsets are generated to contradict the verdict on
   * purpose, so a regression that reads them again shows up as a mismatch.
   */
  it('replays an adopted session by process start time, whatever the offsets say', () => {
    const START = AT - 6 * 3_600_000
    const STAMPS = [undefined, START - 60_000, START - 1, START, START + 1000, START + 3_600_000] as const
    const mismatches: string[] = []
    let activeSeen = 0
    let historicalSeen = 0
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = mulberry32(seed)
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
      const adopted: CronMetadataProcess = {
        ...PROC, identity: `adopted-${seed}`, startedAt: START,
        startOffset: Math.floor(rnd() * 5000), attributeByTime: true,
      }
      // No replay(loading) here: a loading entry answers 'unknown' by design, so
      // the attribution rule under test would never show. `replay: true` on each
      // observe is the flag that selects it, and it is independent of that state.
      const f = fixture({ process: adopted, fresh: false })
      // Oracle: id → what the CLI's own rules make of the job.
      const model = new Map<string, { until: number | null; createdAt: number | null }>()
      let calls = 0
      for (let op = 0; op < 30; op++) {
        const kind = rnd() < 0.62 ? 'create' : rnd() < 0.5 ? 'delete' : 'advance'
        const offset = Math.floor(rnd() * 10_000)
        if (kind === 'create') {
          const id = pick(IDS)
          const useId = `use-${calls++}`
          const callStamp = pick(STAMPS)
          const resStamp = rnd() < 0.8 ? callStamp : pick(STAMPS)
          const recurring = rnd() < 0.8
          const durable = rnd() < 0.15
          f.tracker.observe('session', adopted, JSON.stringify({
            type: 'assistant',
            ...(callStamp === undefined ? {} : { timestamp: new Date(callStamp).toISOString() }),
            message: { content: [{ type: 'tool_use', id: useId, name: 'CronCreate', input: { cron: '*/10 * * * *', prompt: 'p' } }] },
          }), true, offset)
          f.tracker.observe('session', adopted, result({ id, recurring, durable }, useId, false, resStamp), true, offset + 1)
          const live = callStamp !== undefined && callStamp >= START && resStamp !== undefined && resStamp >= START
          if (live) activeSeen++
          else historicalSeen++
          // A one-shot needs the CLI's fire-time rule, which this oracle does not
          // model; recurring and durable are the two it can state exactly.
          const at = resStamp ?? START
          if (recurring) {
            model.set(id, live && !durable
              ? { until: at + CONFIG.recurringMaxAgeMs, createdAt: at }
              : { until: 0, createdAt: live ? at : null })
          } else model.delete(id)
          if (!recurring) {
            // Drop the id from BOTH sides: the tracker keeps a one-shot job whose
            // fire time this oracle cannot predict, so the seed continues without it.
            f.tracker.observe('session', adopted, call('CronDelete', { id }, `drop-${useId}`, START + 1000), true, offset + 2)
            f.tracker.observe('session', adopted, result({}, `drop-${useId}`, false, START + 1000), true, offset + 3)
          }
        } else if (kind === 'delete') {
          const id = pick(IDS)
          const useId = `del-${calls++}`
          f.tracker.observe('session', adopted, call('CronDelete', { id }, useId, START + 1000), true, offset)
          f.tracker.observe('session', adopted, result({}, useId, false, START + 1000), true, offset + 1)
          model.delete(id)
        } else {
          f.advance(pick(ADVANCES))
          f.tracker.refresh()
        }
        const value = f.value()
        const expectedActive = [...model].filter(([, job]) => job.until === null || job.until > f.now())
        const expectedPresence = expectedActive.length ? 'active' : 'unknown'
        if (value.presence !== expectedPresence && mismatches.length < 4) {
          mismatches.push(`seed=${seed} op=${op}: presence ${value.presence} != ${expectedPresence}`)
        }
        const gotIds = (value.jobs ?? []).map((job) => job.id).sort()
        const wantIds = expectedActive.map(([id]) => id).sort()
        if (JSON.stringify(gotIds) !== JSON.stringify(wantIds) && mismatches.length < 4) {
          mismatches.push(`seed=${seed} op=${op}: ids ${JSON.stringify(gotIds)} != ${JSON.stringify(wantIds)}`)
        }
        for (const job of value.jobs ?? []) {
          const want = model.get(job.id)!
          if (job.createdAt !== want.createdAt && mismatches.length < 4) {
            mismatches.push(`seed=${seed} op=${op}: ${job.id} createdAt ${job.createdAt} != ${want.createdAt}`)
          }
          if (job.expiresAt !== (want.until === 0 ? null : want.until) && mismatches.length < 4) {
            mismatches.push(`seed=${seed} op=${op}: ${job.id} expiresAt ${job.expiresAt} != ${want.until}`)
          }
        }
      }
    }
    expect(mismatches).toEqual([])
    // Both verdicts must actually occur, or the property proved nothing.
    expect(activeSeen).toBeGreaterThan(20)
    expect(historicalSeen).toBeGreaterThan(20)
  })
})
