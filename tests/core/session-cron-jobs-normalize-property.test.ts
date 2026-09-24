/**
 * Property + fuzz coverage for `normalizeSessionCronJobs`, the ONE shape check
 * both the server store and the browser store run over daemon-reported cron job
 * details. Everything here is derived from the contract in src/core/types.ts:
 * `undefined` in → `undefined` out, anything malformed → `null` (so the caller
 * keeps the presence fields and drops only the details), otherwise a fresh array
 * of exactly the 10 known keys.
 *
 * Seeds are printed in every failure message so a red run is replayable.
 */
import { describe, expect, it } from 'vitest'
import {
  SESSION_CRON_JOB_LIMIT,
  SESSION_CRON_PROMPT_LIMIT,
  normalizeSessionCronJobs,
  type SessionCronJob,
} from '../../src/core/types.js'

/** Deterministic PRNG (mulberry32) — no dependency, replayable from the seed. */
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

const ID_LIMIT = 64
const CRON_LIMIT = 128
const SCHEDULE_LIMIT = 200

/** The exact key set and order `normalizeSessionCronJobs` writes. */
const JOB_KEYS = [
  'id', 'cron', 'schedule', 'prompt', 'promptTruncated',
  'recurring', 'durable', 'createdAt', 'nextRunAt', 'expiresAt',
] as const

// Non-ASCII only as \u escapes, and only as test data: one BMP accent, one CJK
// ideograph, one astral pair (2 UTF-16 code units — the unit the limits count).
const ASTRAL = '\uD83D\uDE80'
const TEXT_ATOMS = ['a', 'Z', '7', ' ', '*', '/', '-', ':', '\u00e9', '\u4efb', ASTRAL]
const FINITE_TIMES = [0, 1, -1, -0.5, 1.5, 1e15, -1e15, 1_757_000_000_000, Number.MAX_SAFE_INTEGER]

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!
}

/** A random string of at most `maxUnits` UTF-16 code units, never splitting a pair. */
function randomText(rng: () => number, maxUnits: number): string {
  const target = Math.floor(rng() * (Math.min(maxUnits, 24) + 1))
  let out = ''
  while (out.length < target) {
    const atom = pick(rng, TEXT_ATOMS)
    if (out.length + atom.length > maxUnits) break
    out += atom
  }
  return out
}

function randomJob(rng: () => number, index: number): SessionCronJob {
  // Canonical form: empty text is reported as null, so a generated '' becomes null.
  const maybeText = (limit: number): string | null =>
    rng() < 0.2 ? null : randomText(rng, limit) || null
  const maybeTime = (): number | null => (rng() < 0.25 ? null : pick(rng, FINITE_TIMES))
  // Long prompts are the expensive case; keep them rare but present.
  const prompt = rng() < 0.05
    ? ASTRAL.repeat(SESSION_CRON_PROMPT_LIMIT / 2)
    : maybeText(SESSION_CRON_PROMPT_LIMIT)
  return {
    id: `job-${index}-${randomText(rng, 12)}`.slice(0, ID_LIMIT),
    cron: maybeText(CRON_LIMIT),
    schedule: maybeText(SCHEDULE_LIMIT),
    prompt,
    promptTruncated: rng() < 0.3,
    recurring: rng() < 0.5,
    durable: rng() < 0.5,
    createdAt: maybeTime(),
    nextRunAt: maybeTime(),
    expiresAt: maybeTime(),
  }
}

function randomJobList(rng: () => number): SessionCronJob[] {
  const count = Math.floor(rng() * (SESSION_CRON_JOB_LIMIT + 1))
  return Array.from({ length: count }, (_, i) => randomJob(rng, i))
}

const validJob = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: 'j1', cron: '23 9 * * *', schedule: 'Every day at 9:23 AM', prompt: 'Daily disk inspection',
  promptTruncated: false, recurring: true, durable: false,
  createdAt: 1000, nextRunAt: 5000, expiresAt: 9000, ...over,
})

const SEEDS = [1, 7, 20260916, 99991]

describe('normalizeSessionCronJobs — valid lists round-trip', () => {
  it.each(SEEDS)('accepts generated lists verbatim and is idempotent (seed %i)', (seed) => {
    const rng = mulberry32(seed)
    for (let round = 0; round < 40; round++) {
      const jobs = randomJobList(rng)
      // Extra keys ride along on purpose: they must be stripped, not carried.
      const decorated = jobs.map((job, i) => (i % 3 === 0
        ? { ...job, hostExtra: 'ignored', nested: { a: 1 } }
        : { ...job }))
      const out = normalizeSessionCronJobs(decorated)
      const label = `seed ${seed} round ${round}`
      expect(out, label).toEqual(jobs)
      for (const job of out ?? []) {
        expect(Object.keys(job), `${label} key set`).toEqual([...JOB_KEYS])
      }
      expect(normalizeSessionCronJobs(out), `${label} idempotent`).toEqual(out)
      // A normalized job is a fresh object: mutating the input cannot reach it.
      if (out && out.length > 0) expect(out[0]).not.toBe(decorated[0])
    }
  })

  it('accepts the empty list and returns a distinct array', () => {
    const input: SessionCronJob[] = []
    const out = normalizeSessionCronJobs(input)
    expect(out).toEqual([])
    expect(out).not.toBe(input)
  })
})

/**
 * One bad value at a time, over every field. `accepts()` is written from the
 * contract, not copied from the implementation, so a semantic drift shows up
 * here rather than passing vacuously.
 */
type FieldKind = 'id' | 'text' | 'bool' | 'time'
const FIELD_SPEC: Record<(typeof JOB_KEYS)[number], { kind: FieldKind; limit: number }> = {
  id: { kind: 'id', limit: ID_LIMIT },
  cron: { kind: 'text', limit: CRON_LIMIT },
  schedule: { kind: 'text', limit: SCHEDULE_LIMIT },
  prompt: { kind: 'text', limit: SESSION_CRON_PROMPT_LIMIT },
  promptTruncated: { kind: 'bool', limit: 0 },
  recurring: { kind: 'bool', limit: 0 },
  durable: { kind: 'bool', limit: 0 },
  createdAt: { kind: 'time', limit: 0 },
  nextRunAt: { kind: 'time', limit: 0 },
  expiresAt: { kind: 'time', limit: 0 },
}

function accepts(kind: FieldKind, limit: number, value: unknown): boolean {
  if (kind === 'id') return typeof value === 'string' && value.length > 0 && value.length <= limit
  // The empty string is accepted for cron/schedule/prompt but canonicalized to
  // null ("not reported"); see `canonical` below. Only `id` rejects '' outright.
  if (kind === 'text') return value === null || (typeof value === 'string' && value.length <= limit)
  if (kind === 'bool') return typeof value === 'boolean'
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

describe('normalizeSessionCronJobs — single-field mutation matrix', () => {
  it.each([...JOB_KEYS])('decides every bad value for %s the way the type demands', (field) => {
    const spec = FIELD_SPEC[field]
    const textLimit = spec.kind === 'id' || spec.kind === 'text' ? spec.limit : ID_LIMIT
    const bad: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['empty string', ''],
      ['over-limit string', 'x'.repeat(textLimit + 1)],
      ['plain object', {}],
      ['array', []],
      ['true', true],
      ['false', false],
      ['one', 1],
      ['zero', 0],
      ['null', null],
    ]
    for (const [label, value] of bad) {
      const out = normalizeSessionCronJobs([validJob({ [field]: value })])
      const why = `${field} = ${label}`
      if (accepts(spec.kind, spec.limit, value)) {
        const canonical = spec.kind === 'text' && value === '' ? null : value
        expect(out, why).toEqual([validJob({ [field]: canonical })])
        expect(Object.keys(out![0]!), `${why} key set`).toEqual([...JOB_KEYS])
      } else {
        expect(out, why).toBeNull()
      }
    }
  })

  it('drops the whole list when a required key is simply missing', () => {
    for (const field of JOB_KEYS) {
      const job = validJob()
      delete job[field]
      expect(normalizeSessionCronJobs([job]), `missing ${field}`).toBeNull()
    }
  })
})

describe('normalizeSessionCronJobs — exact boundaries', () => {
  it.each([
    ['id', ID_LIMIT, (n: number) => validJob({ id: 'i'.repeat(n) })],
    ['cron', CRON_LIMIT, (n: number) => validJob({ cron: 'c'.repeat(n) })],
    ['schedule', SCHEDULE_LIMIT, (n: number) => validJob({ schedule: 's'.repeat(n) })],
    ['prompt', SESSION_CRON_PROMPT_LIMIT, (n: number) => validJob({ prompt: 'p'.repeat(n) })],
  ])('%s accepts the limit and rejects one code unit past it', (_field, limit, make) => {
    expect(normalizeSessionCronJobs([make(limit as number)])).toHaveLength(1)
    expect(normalizeSessionCronJobs([make((limit as number) + 1)])).toBeNull()
  })

  it('counts astral characters as the two UTF-16 code units they are', () => {
    const exact = ASTRAL.repeat(SESSION_CRON_PROMPT_LIMIT / 2)
    expect(exact).toHaveLength(SESSION_CRON_PROMPT_LIMIT)
    expect(normalizeSessionCronJobs([validJob({ prompt: exact })])?.[0]?.prompt).toBe(exact)
    expect(normalizeSessionCronJobs([validJob({ prompt: `${exact}x` })])).toBeNull()
    // A lone surrogate is still one code unit and still a string: accepted.
    expect(normalizeSessionCronJobs([validJob({ prompt: '\uD83D' })])?.[0]?.prompt).toBe('\uD83D')
  })

  it('accepts the job-count limit and rejects one job past it', () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => validJob({ id: `id-${i}` }))
    expect(normalizeSessionCronJobs(list(SESSION_CRON_JOB_LIMIT))).toHaveLength(SESSION_CRON_JOB_LIMIT)
    expect(normalizeSessionCronJobs(list(SESSION_CRON_JOB_LIMIT + 1))).toBeNull()
  })

  it('rejects duplicate ids, holes, and non-arrays; passes `undefined` straight through', () => {
    expect(normalizeSessionCronJobs([validJob(), validJob()])).toBeNull()
    // eslint-disable-next-line no-sparse-arrays
    expect(normalizeSessionCronJobs([validJob(), , validJob({ id: 'j2' })])).toBeNull()
    expect(normalizeSessionCronJobs(undefined)).toBeUndefined()
    for (const input of [
      null, {}, { length: 1, 0: validJob() }, 'jobs', 42, 0, true, false,
      new Set([validJob()]), [validJob(), null], [validJob(), 'j'], [validJob(), [validJob()]],
    ]) {
      expect(normalizeSessionCronJobs(input), `input ${JSON.stringify(input) ?? String(input)}`).toBeNull()
    }
  })
})

describe('normalizeSessionCronJobs — hostile object shapes', () => {
  it('does not let a JSON __proto__ key pollute Object.prototype', () => {
    const raw = JSON.parse(
      '[{"__proto__":{"polluted":1},"id":"a","cron":null,"schedule":null,"prompt":null,'
      + '"promptTruncated":false,"recurring":false,"durable":false,'
      + '"createdAt":null,"nextRunAt":null,"expiresAt":null}]',
    )
    const out = normalizeSessionCronJobs(raw)
    expect(out).toHaveLength(1)
    expect(Object.keys(out![0]!)).toEqual([...JOB_KEYS])
    expect('polluted' in out![0]!).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('normalizes a prototype-less job and a frozen input array', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, validJob())
    const frozen = Object.freeze([bare])
    expect(normalizeSessionCronJobs(frozen)).toEqual([validJob()])
    expect(Object.getPrototypeOf(normalizeSessionCronJobs(frozen)![0]!)).toBe(Object.prototype)
  })

  it('ignores accessor-shaped extras and keeps only the known keys', () => {
    const job = validJob()
    Object.defineProperty(job, 'extra', { get: () => 'nope', enumerable: true })
    expect(Object.keys(normalizeSessionCronJobs([job])![0]!)).toEqual([...JOB_KEYS])
  })
})

describe('normalizeSessionCronJobs — structural fuzz', () => {
  const KEY_POOL = [...JOB_KEYS, 'extra', '__proto__', 'length', 'toString', '0']
  const LEAVES: unknown[] = [
    undefined, null, true, false, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
    '', 'x', 'x'.repeat(300), ASTRAL, '\u4efb\u52a1', 1e15, -0,
  ]

  function randomValue(rng: () => number, depth: number): unknown {
    const r = rng()
    if (depth <= 0 || r < 0.45) return pick(rng, LEAVES)
    if (r < 0.6) return randomJob(rng, Math.floor(rng() * 5))
    if (r < 0.8) {
      return Array.from({ length: Math.floor(rng() * 4) }, () => randomValue(rng, depth - 1))
    }
    const out: Record<string, unknown> = {}
    const keys = Math.floor(rng() * 5)
    for (let i = 0; i < keys; i++) out[pick(rng, KEY_POOL)] = randomValue(rng, depth - 1)
    return out
  }

  it.each(SEEDS)('never throws and always answers in the contract (seed %i)', (seed) => {
    const rng = mulberry32(seed)
    for (let round = 0; round < 100; round++) {
      const input = rng() < 0.03 ? undefined : randomValue(rng, 3)
      const label = `seed ${seed} round ${round}: ${safeLabel(input)}`
      let out: SessionCronJob[] | null | undefined
      expect(() => { out = normalizeSessionCronJobs(input) }, label).not.toThrow()
      if (input === undefined) {
        expect(out, label).toBeUndefined()
        continue
      }
      expect(out, label).not.toBeUndefined()
      if (out === null) continue
      expect(Array.isArray(out), label).toBe(true)
      expect(normalizeSessionCronJobs(out), `${label} re-normalizes`).toEqual(out)
      for (const job of out!) expect(Object.keys(job), `${label} key set`).toEqual([...JOB_KEYS])
    }
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  function safeLabel(value: unknown): string {
    try {
      return JSON.stringify(value)?.slice(0, 200) ?? String(value)
    } catch {
      return '<unserializable>'
    }
  }
})
