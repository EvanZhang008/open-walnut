// Property tests for the CLI cron schedule math. Four independent angles, all seeded:
// a naive minute-by-minute reference model vs. the field-skipping walk, parser fuzzing,
// per-zone result invariants, and the one-shot jitter window. Every failure message
// carries its seed, so a red line is reproducible from one case.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cliCronRestoreConfig, cliOneShotTime, nextCliCronMinute, parseCliCron } from '../../src/providers/daemon-cron-schedule.js'
import type { CronRestoreConfig } from '../../src/providers/daemon-cron-transcript.js'
import { DEFAULT_CRON_RESTORE_CONFIG as DEFAULTS } from '../../src/providers/daemon-cron-transcript.js'

afterEach(() => { vi.unstubAllEnvs() })

// mulberry32 — hand-rolled seeded PRNG, never Math.random, so a rerun and CI agree.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rng = () => number
const int = (rng: Rng, min: number, max: number) => min + Math.floor(rng() * (max - min + 1))
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[int(rng, 0, xs.length - 1)]
const seq = (from: number, to: number, step: number) => {
  const out: number[] = []
  for (let n = from; n <= to; n += step) out.push(n)
  return out
}
const iso = (t: number | null) => (t === null ? 'null' : new Date(t).toISOString())
const local = (year: number, month: number, day: number, hour = 0, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime()
const noThrow = <T>(run: () => T, context: string): T => {
  try { return run() } catch (error) { throw new Error(`${context} threw ${String(error)}`) }
}

const BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const
const DOW = 4
// Day-of-week is the only field that accepts a seventh value, and it means Sunday.
const foldDow = (index: number, n: number) => (index === DOW && n === 7 ? 0 : n)

/** One comma term of one field, with the value set it must parse to. */
function genTerm(rng: Rng, index: number): { text: string; values: number[] } {
  const [min, max] = BOUNDS[index]
  const hi = index === DOW ? 7 : max
  const digits = (n: number) => (rng() < 0.2 ? String(n).padStart(2, '0') : String(n))
  const shape = pick(rng, ['wild', 'wildStep', 'value', 'range', 'rangeStep'] as const)
  if (shape === 'wild') return { text: '*', values: seq(min, max, 1) }
  if (shape === 'wildStep') {
    const step = int(rng, 2, max - min + 1)
    return { text: `*/${step}`, values: seq(min, max, step) }
  }
  if (shape === 'value') {
    const v = int(rng, min, hi)
    return { text: digits(v), values: [foldDow(index, v)] }
  }
  const a = int(rng, min, hi)
  const b = int(rng, a, hi)
  const step = shape === 'rangeStep' ? int(rng, 1, b - a + 1) : 1
  const suffix = shape === 'rangeStep' ? `/${step}` : ''
  return { text: `${digits(a)}-${digits(b)}${suffix}`, values: seq(a, b, step).map((n) => foldDow(index, n)) }
}

function genField(rng: Rng, index: number): { text: string; values: number[] } {
  const terms = rng() < 0.35 ? int(rng, 2, 4) : 1
  const parts: string[] = []
  const all = new Set<number>()
  for (let i = 0; i < terms; i++) {
    const term = genTerm(rng, index)
    parts.push(term.text)
    for (const v of term.values) all.add(v)
  }
  return { text: parts.join(','), values: [...all].sort((x, y) => x - y) }
}

/** A whole expression plus the five value sets it must parse to, computed by the generator. */
function genCron(rng: Rng, stars: readonly number[] = []): { text: string; fields: number[][] } {
  const texts: string[] = []
  const fields: number[][] = []
  for (let i = 0; i < 5; i++) {
    if (stars.includes(i)) {
      texts.push('*')
      fields.push(seq(BOUNDS[i][0], BOUNDS[i][1], 1))
      continue
    }
    const field = genField(rng, i)
    texts.push(field.text)
    fields.push(field.values)
  }
  return { text: texts.join(' '), fields }
}

const WINDOW_START = Date.UTC(2026, 0, 1)
const WINDOW_MINUTES = Math.floor((Date.UTC(2028, 11, 31) - WINDOW_START) / 60_000)
const randomAfter = (rng: Rng) => WINDOW_START + int(rng, 0, WINDOW_MINUTES) * 60_000 + int(rng, 0, 59) * 1000 + int(rng, 0, 999)

// ---- reference model: a naive scan, one local minute at a time, no field skipping ----

function masksOf(fields: number[][]) {
  const mask = (values: number[], size: number) => {
    const bits = new Uint8Array(size)
    for (const v of values) bits[v] = 1
    return bits
  }
  return {
    minute: mask(fields[0], 60), hour: mask(fields[1], 24), dom: mask(fields[2], 32),
    month: mask(fields[3], 13), dow: mask(fields[4], 7),
    // "Unrestricted" is decided by set SIZE, not by the literal '*' the user typed.
    everyDom: fields[2].length === 31, everyDow: fields[4].length === 7,
  }
}
type Masks = ReturnType<typeof masksOf>

function dayAllowed(m: Masks, d: Date): boolean {
  const dom = m.dom[d.getDate()] === 1
  const dow = m.dow[d.getDay()] === 1
  if (m.everyDom && m.everyDow) return true
  if (m.everyDom) return dow // one side unrestricted: the other side alone decides
  if (m.everyDow) return dom
  return dom || dow // both restricted: OR, the crontab rule
}

const minuteAllowed = (m: Masks, d: Date) => m.minute[d.getMinutes()] === 1 && m.hour[d.getHours()] === 1
  && m.month[d.getMonth() + 1] === 1 && dayAllowed(m, d)

const ITERATION_CAP = 527040

/**
 * Brute-force twin of nextCliCronMinute: same start (floor to the minute, then +1 local
 * minute) and the same local-calendar stepping, but it examines EVERY minute instead of
 * skipping whole months, days and hours. `horizonMinutes` is bounded per caller so the
 * bulk loops stay cheap; `lastExamined` lets a caller assert "no earlier than my window".
 */
function referenceNext(fields: number[][], after: number, horizonMinutes = ITERATION_CAP): { minute: number | null; lastExamined: number } {
  const m = masksOf(fields)
  const d = new Date(after)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  let lastExamined = d.getTime()
  for (let i = 0; i < horizonMinutes; i++) {
    lastExamined = d.getTime()
    if (minuteAllowed(m, d)) return { minute: lastExamined, lastExamined }
    d.setMinutes(d.getMinutes() + 1)
  }
  return { minute: null, lastExamined }
}

describe('CLI cron next-minute equals a brute-force local scan', () => {
  it('agrees with the naive scan on 400 random expressions', () => {
    vi.stubEnv('TZ', 'UTC')
    let compared = 0
    for (let i = 0; i < 400; i++) {
      const seed = 0x5C1E0000 + i
      const rng = mulberry32(seed)
      const { text, fields } = genCron(rng)
      const after = randomAfter(rng)
      const context = `seed=${seed} cron=${JSON.stringify(text)} after=${iso(after)}`
      const actual = nextCliCronMinute(text, after)
      const reference = referenceNext(fields, after, 2 * 1440)
      if (reference.minute !== null) {
        expect(actual, `${context} expected ${iso(reference.minute)}`).toBe(reference.minute)
        compared++
        continue
      }
      // Nothing fires inside the scanned window, so the real answer must be later than it.
      expect(actual === null || actual > reference.lastExamined,
        `${context} fired at ${iso(actual)} though the naive scan found nothing through ${iso(reference.lastExamined)}`).toBe(true)
    }
    expect(compared, 'too few cases produced a comparable hit — the generator degenerated').toBeGreaterThan(80)
  })

  it('agrees with the naive scan across daylight-saving transition days', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    // Local 02:00 at each transition, as an instant, so cases cluster where the walk is hardest.
    const transitions = ['2026-03-08T10:00:00Z', '2026-11-01T09:00:00Z', '2027-03-14T10:00:00Z',
      '2027-11-07T09:00:00Z', '2028-03-12T10:00:00Z', '2028-11-05T09:00:00Z'].map((t) => Date.parse(t))
    for (let i = 0; i < 240; i++) {
      const seed = 0xD57D0000 + i
      const rng = mulberry32(seed)
      // Month, day and weekday unrestricted, so a hit always lands inside a three-day window.
      const { text, fields } = genCron(rng, [2, 3, 4])
      const after = transitions[i % transitions.length] + int(rng, -36 * 60, 36 * 60) * 60_000 + int(rng, 0, 59_999)
      const context = `seed=${seed} cron=${JSON.stringify(text)} after=${iso(after)}`
      const reference = referenceNext(fields, after, 3 * 1440)
      expect(reference.minute, `${context} the generator produced no hit in three days`).not.toBeNull()
      expect(nextCliCronMinute(text, after), `${context} expected ${iso(reference.minute)}`).toBe(reference.minute)
    }
  })
})

describe('CLI cron parser properties', () => {
  it('parses every generated expression into five sorted, duplicate-free, in-bounds fields', () => {
    for (let i = 0; i < 500; i++) {
      const seed = 0x9A250000 + i
      const rng = mulberry32(seed)
      const { text, fields } = genCron(rng)
      const context = `seed=${seed} cron=${JSON.stringify(text)}`
      const parsed = parseCliCron(text)
      expect(parsed, context).not.toBeNull()
      expect(parsed!.length, context).toBe(5)
      parsed!.forEach((values, index) => {
        const [min, max] = BOUNDS[index]
        expect(values.length, `${context} field ${index} came back empty`).toBeGreaterThan(0)
        for (let k = 0; k < values.length; k++) {
          expect(Number.isInteger(values[k]), `${context} field ${index} value ${values[k]} is not an integer`).toBe(true)
          expect(values[k] >= min && values[k] <= max, `${context} field ${index} value ${values[k]} escapes [${min},${max}]`).toBe(true)
          if (k > 0) expect(values[k] > values[k - 1], `${context} field ${index} is not strictly ascending: ${values}`).toBe(true)
        }
      })
      expect(parsed, `${context} disagrees with the generator's own value sets`).toEqual(fields)
      // Re-serializing the parsed sets as plain comma lists is a fixed point.
      const reserialized = parsed!.map((values) => values.join(',')).join(' ')
      expect(parseCliCron(reserialized), `${context} round-trip ${reserialized}`).toEqual(parsed)
    }
  })

  it('folds a day-of-week seven onto Sunday wherever it can appear', () => {
    for (const field of ['7', '07', '0,7', '7,7', '5-7', '0-7', '7-7', '6-7/1', '1,7']) {
      const parsed = parseCliCron(`0 0 * * ${field}`)
      expect(parsed, `dow=${field}`).not.toBeNull()
      expect(parsed![4].includes(7), `dow=${field} kept a literal 7`).toBe(false)
      expect(parsed![4].includes(0), `dow=${field} lost Sunday`).toBe(true)
    }
    // '*/7' never sees a 7 at all: it walks 0..6 by seven and stops at Sunday.
    expect(parseCliCron('0 0 * * */7')?.[4]).toEqual([0])
    for (let i = 0; i < 300; i++) {
      const seed = 0x50D70000 + i
      const rng = mulberry32(seed)
      const field = genField(rng, DOW)
      const context = `seed=${seed} dow=${JSON.stringify(field.text)}`
      const parsed = parseCliCron(`0 0 * * ${field.text}`)
      expect(parsed, context).not.toBeNull()
      expect(parsed![4], context).toEqual(field.values)
      expect(parsed![4].includes(7), `${context} kept a literal 7`).toBe(false)
    }
  })

  it('ignores tabs, repeated spaces and surrounding whitespace', () => {
    for (let i = 0; i < 300; i++) {
      const seed = 0x0FF50000 + i
      const rng = mulberry32(seed)
      const { text } = genCron(rng)
      const canonical = parseCliCron(text)
      const parts = text.split(' ')
      const variants = [parts.join('\t'), parts.join('   '), `  ${text}  `, `\t${parts.join(' \t ')}\n`,
        parts.join(pick(rng, [' ', '\t', '  ', ' \t', '\n']))]
      for (const variant of variants) {
        expect(parseCliCron(variant), `seed=${seed} variant=${JSON.stringify(variant)}`).toEqual(canonical)
      }
    }
  })

  it('never throws on random garbage and round-trips whatever it accepts', () => {
    const printable = [...'0123456789*/,- \t\nabcefgxzJANMONL?@#$%^&()[]{}<>|\\\'";:.=+_~!']
    const randomChars = (rng: Rng) => {
      let text = ''
      for (let k = int(rng, 0, 40); k > 0; k--) text += pick(rng, printable)
      return text
    }
    // Pure noise almost never parses, so half the cases are mutations of a valid
    // expression: that is what actually exercises the accept-and-round-trip half.
    const mutated = (rng: Rng) => {
      let text = genCron(rng).text
      for (let m = int(rng, 1, 3); m > 0; m--) {
        const at = int(rng, 0, Math.max(0, text.length - 1))
        const how = int(rng, 0, 3)
        if (how === 0) text = text.slice(0, at) + pick(rng, printable) + text.slice(at + 1)
        else if (how === 1) text = text.slice(0, at) + text.slice(at + 1)
        else if (how === 2) text = text.slice(0, at) + pick(rng, printable) + text.slice(at)
        else text = text.split(' ').slice(int(rng, 0, 1)).join(' ')
      }
      return text
    }
    let accepted = 0
    for (let i = 0; i < 500; i++) {
      const seed = 0x6A460000 + i
      const rng = mulberry32(seed)
      const text = i < 300 ? randomChars(rng) : mutated(rng)
      const context = `seed=${seed} garbage=${JSON.stringify(text)}`
      const parsed = noThrow(() => parseCliCron(text), context)
      if (parsed === null) continue
      accepted++
      expect(parsed.length, context).toBe(5)
      parsed.forEach((values, index) => {
        const [min, max] = BOUNDS[index]
        expect(values.every((v) => Number.isInteger(v) && v >= min && v <= max), `${context} field ${index} = ${values}`).toBe(true)
      })
      const reserialized = parsed.map((values) => values.join(',')).join(' ')
      expect(parseCliCron(reserialized), `${context} round-trip ${reserialized}`).toEqual(parsed)
    }
    expect(accepted, 'no garbage string ever parsed — the round-trip half proved nothing').toBeGreaterThan(20)
  })
})

const ZONES = ['UTC', 'America/Los_Angeles', 'Europe/London', 'Australia/Sydney', 'Asia/Kolkata', 'Pacific/Chatham', 'America/St_Johns'] as const

describe('CLI cron result invariants in every zone', () => {
  it.each(ZONES)('returns the first aligned local minute after the instant (%s)', (zone) => {
    vi.stubEnv('TZ', zone)
    let hits = 0
    for (let i = 0; i < 40; i++) {
      const seed = 0x20E00000 + ZONES.indexOf(zone) * 1000 + i
      const rng = mulberry32(seed)
      const { text, fields } = genCron(rng)
      const after = randomAfter(rng)
      const context = `zone=${zone} seed=${seed} cron=${JSON.stringify(text)} after=${iso(after)}`
      const result = nextCliCronMinute(text, after)
      const reference = referenceNext(fields, after, 2 * 1440)
      if (result === null) {
        expect(reference.minute, `${context} gave up although the naive scan found ${iso(reference.minute)}`).toBeNull()
        continue
      }
      expect(result, `${context} is not strictly after the instant`).toBeGreaterThan(after)
      const at = new Date(result)
      expect(at.getSeconds(), `${context} landed on ${iso(result)} with seconds`).toBe(0)
      expect(at.getMilliseconds(), `${context} landed on ${iso(result)} with milliseconds`).toBe(0)
      expect(result % 60_000, `${context} landed on ${iso(result)}, off the minute grid`).toBe(0)
      const m = masksOf(fields)
      expect(m.minute[at.getMinutes()], `${context} minute ${at.getMinutes()} is outside the set`).toBe(1)
      expect(m.hour[at.getHours()], `${context} hour ${at.getHours()} is outside the set`).toBe(1)
      expect(m.month[at.getMonth() + 1], `${context} month ${at.getMonth() + 1} is outside the set`).toBe(1)
      expect(dayAllowed(m, at), `${context} day ${at.getDate()} / weekday ${at.getDay()} fails the OR rule`).toBe(true)
      // The previous local minute must not match. Skipped when the decrement leaves the
      // interval: one minute before the first minute after a spring-forward gap is a local
      // time that never existed, and the engine resolves that FORWARD (03:00 -> 03:59).
      const previous = new Date(result)
      previous.setMinutes(previous.getMinutes() - 1)
      if (previous.getTime() > after && previous.getTime() < result) {
        expect(minuteAllowed(m, previous), `${context} the earlier minute ${iso(previous.getTime())} matches too`).toBe(false)
      }
      if (reference.minute !== null) {
        expect(result, `${context} expected ${iso(reference.minute)}`).toBe(reference.minute)
        hits++
      } else {
        expect(result > reference.lastExamined, `${context} fired inside the naive scan's empty window`).toBe(true)
      }
    }
    expect(hits, `zone=${zone} produced no reference comparison`).toBeGreaterThan(0)
  })
})

describe('CLI cron daylight-saving edges', () => {
  it('lands on the first existing minute after the hour spring-forward removes (Australia/Sydney)', () => {
    vi.stubEnv('TZ', 'Australia/Sydney')
    const beforeGap = Date.parse('2026-10-04T01:59:00+10:00') // 02:00-02:59 does not exist
    expect(nextCliCronMinute('* * * * *', beforeGap)).toBe(Date.parse('2026-10-04T03:00:00+11:00'))
    // A job inside the removed hour does not run that day at all; it waits for the next one.
    expect(nextCliCronMinute('30 2 * * *', beforeGap)).toBe(Date.parse('2026-10-05T02:30:00+11:00'))
    expect(nextCliCronMinute('0 2 * * *', beforeGap)).toBe(Date.parse('2026-10-05T02:00:00+11:00'))
  })

  it('fires once, on the first pass, through the hour fall-back repeats (Australia/Sydney)', () => {
    vi.stubEnv('TZ', 'Australia/Sydney')
    const firstPass = Date.parse('2027-04-04T02:00:00+11:00') // still daylight time
    const secondPass = Date.parse('2027-04-04T02:00:00+10:00') // the repeat, one hour later
    const beforeRepeat = Date.parse('2027-04-04T01:59:00+11:00')
    expect(nextCliCronMinute('* * * * *', beforeRepeat)).toBe(firstPass)
    // The daily 02:00 job resolves to the FIRST occurrence: an ambiguous local time takes
    // the offset in force before the transition.
    expect(nextCliCronMinute('0 2 * * *', beforeRepeat)).toBe(firstPass)
    // The local-calendar walk never revisits the repeated hour, so the second occurrence is
    // unreachable and the next fire is the following day, not one hour later.
    expect(nextCliCronMinute('0 2 * * *', firstPass)).not.toBe(secondPass)
    expect(nextCliCronMinute('0 2 * * *', firstPass)).toBe(Date.parse('2027-04-05T02:00:00+10:00'))
    // Minute stepping jumps the whole repeated hour: 02:59 first pass goes straight to 03:00.
    expect(nextCliCronMinute('* * * * *', Date.parse('2027-04-04T02:59:00+11:00'))).toBe(Date.parse('2027-04-04T03:00:00+10:00'))
  })

  it('lands on the first existing minute after the hour spring-forward removes (Europe/London)', () => {
    vi.stubEnv('TZ', 'Europe/London')
    const beforeGap = Date.parse('2026-03-29T00:59:00Z') // 01:00-01:59 does not exist
    expect(nextCliCronMinute('* * * * *', beforeGap)).toBe(Date.parse('2026-03-29T02:00:00+01:00'))
    expect(nextCliCronMinute('30 1 * * *', beforeGap)).toBe(Date.parse('2026-03-30T01:30:00+01:00'))
  })

  it('fires once, on the first pass, through the hour fall-back repeats (Europe/London)', () => {
    vi.stubEnv('TZ', 'Europe/London')
    const firstPass = Date.parse('2026-10-25T01:00:00+01:00') // still summer time
    const secondPass = Date.parse('2026-10-25T01:00:00Z') // the repeat, one hour later
    const beforeRepeat = Date.parse('2026-10-25T00:59:00+01:00')
    expect(nextCliCronMinute('* * * * *', beforeRepeat)).toBe(firstPass)
    // FIRST occurrence again, for the same ambiguity rule.
    expect(nextCliCronMinute('0 1 * * *', beforeRepeat)).toBe(firstPass)
    expect(nextCliCronMinute('0 1 * * *', firstPass)).not.toBe(secondPass)
    expect(nextCliCronMinute('0 1 * * *', firstPass)).toBe(Date.parse('2026-10-26T01:00:00Z'))
    expect(nextCliCronMinute('* * * * *', Date.parse('2026-10-25T01:59:00+01:00'))).toBe(Date.parse('2026-10-25T02:00:00Z'))
  })
})

describe('CLI cron impossible and rare calendar dates', () => {
  it.each(['0 0 30 2 *', '0 0 31 2 *', '0 0 31 4 *', '0 0 31 4,6,9,11 *'])('never fires: %s', (cron) => {
    vi.stubEnv('TZ', 'UTC')
    expect(nextCliCronMinute(cron, local(2026, 5, 1))).toBeNull()
  })

  it('agrees with a full-horizon naive scan that February 30 never arrives', () => {
    vi.stubEnv('TZ', 'UTC')
    // The naive scan's cap really is 366 days of minutes; the skipping walk's identical cap
    // counts ITERATIONS, so it reaches far further (see the leap-day case below).
    expect(referenceNext(parseCliCron('0 0 30 2 *')!, local(2026, 5, 1), ITERATION_CAP).minute).toBeNull()
    expect(nextCliCronMinute('0 0 30 2 *', local(2026, 5, 1))).toBeNull()
  })

  it('reaches years ahead for leap-day jobs because the cap counts iterations, not minutes', () => {
    vi.stubEnv('TZ', 'UTC')
    // A non-matching month or day costs ONE iteration of the 527040 budget, so a sparse
    // expression is scanned decades out. A leap-day job does not fall off once Feb 29 passes.
    expect(nextCliCronMinute('0 0 29 2 *', local(2028, 3, 1))).toBe(local(2032, 2, 29))
    expect(nextCliCronMinute('0 0 29 2 *', local(2096, 3, 1))).toBe(local(2104, 2, 29)) // 2100 is not a leap year
    // The naive scan, bounded in minutes, cannot see any of that.
    expect(referenceNext(parseCliCron('0 0 29 2 *')!, local(2028, 3, 1), 8 * 1440).minute).toBeNull()
  })

  it('treats a full 1-31 day-of-month list as unrestricted, so the weekday decides alone', () => {
    vi.stubEnv('TZ', 'UTC')
    // The OR rule keys off set SIZE, not the literal '*': '1-31' fills all 31 values and so
    // counts as unrestricted, leaving Mondays only. Classic crontab keys off the literal '*'
    // and would OR here, firing every day. 2026-08-01 is a Saturday.
    expect(nextCliCronMinute('0 0 1-31 * 1', local(2026, 8, 1))).toBe(local(2026, 8, 3))
    expect(nextCliCronMinute('0 0 1-30 * 1', local(2026, 8, 1))).toBe(local(2026, 8, 2))
  })
})

describe('CLI one-shot jitter properties', () => {
  const CRONS = ['* * * * *', '0 * * * *', '*/5 * * * *', '30 * * * *', '0,30 8-18 * * 1-5', '15 3 * * *', '0 0 1 * *', '*/10 * * * 0'] as const
  const HEX = '0123456789abcdef'
  const randomConfig = (rng: Rng): CronRestoreConfig => {
    const floor = int(rng, 0, 900_000)
    return {
      enabled: true, recurringMaxAgeMs: int(rng, 0, 2_592_000_000),
      oneShotMaxMs: int(rng, floor, 1_800_000), oneShotFloorMs: floor, oneShotMinuteMod: int(rng, 1, 60),
    }
  }
  // Ids are hex in practice. A leading sign character is deliberately never generated: it
  // would make the parsed fraction negative and push the fire time a fraction of a
  // millisecond PAST the scheduled minute.
  const randomId = (rng: Rng) => {
    const roll = rng()
    const letters = [...'ghijklmnopqrstuvwxyz']
    if (roll < 0.2) {
      let id = pick(rng, letters)
      for (let i = 0; i < 7; i++) id += pick(rng, [...letters, ...HEX])
      return id
    }
    let id = ''
    for (let i = roll < 0.35 ? int(rng, 1, 7) : 32; i > 0; i--) id += pick(rng, [...HEX])
    return id
  }

  it('stays inside the configured early window and only fires early on minute multiples', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    let jittered = 0
    let exact = 0
    for (let i = 0; i < 300; i++) {
      const seed = 0x15030000 + i
      const rng = mulberry32(seed)
      const cron = pick(rng, CRONS)
      const createdAt = randomAfter(rng)
      const config = rng() < 0.3 ? DEFAULTS : randomConfig(rng)
      const id = randomId(rng)
      const context = `seed=${seed} cron=${cron} id=${id} createdAt=${iso(createdAt)} config=${JSON.stringify(config)}`
      const next = nextCliCronMinute(cron, createdAt)
      expect(next, context).not.toBeNull()
      const fire = cliOneShotTime(cron, createdAt, id, config)
      expect(fire, context).not.toBeNull()
      expect(fire!, `${context} fires after the scheduled minute ${iso(next)}`).toBeLessThanOrEqual(next!)
      expect(fire!, `${context} fires earlier than the window allows`).toBeGreaterThanOrEqual(Math.max(next! - config.oneShotMaxMs, createdAt))
      if (new Date(next!).getMinutes() % config.oneShotMinuteMod !== 0) {
        expect(fire, `${context} jittered a minute that is no multiple of ${config.oneShotMinuteMod}`).toBe(next)
        exact++
        continue
      }
      jittered++
      if (!HEX.includes(id[0])) {
        expect(fire, `${context} a non-hex id must fall back to the floor`).toBe(Math.max(next! - config.oneShotFloorMs, createdAt))
      }
    }
    expect(jittered, 'no case exercised the jitter branch').toBeGreaterThan(20)
    expect(exact, 'no case exercised the exact-minute branch').toBeGreaterThan(20)
  })

  it('is monotonic in the leading eight hex digits of the id', () => {
    vi.stubEnv('TZ', 'Europe/London')
    for (let i = 0; i < 40; i++) {
      const seed = 0x3D010000 + i
      const rng = mulberry32(seed)
      const config = randomConfig(rng)
      // Minute 0 is a multiple of every modulus, and :05 leaves at least 55 minutes of head
      // room, so the createdAt clamp (window caps at 30 minutes) cannot mask the ordering.
      const created = new Date(randomAfter(rng))
      created.setMinutes(5, int(rng, 0, 59), int(rng, 0, 999))
      const createdAt = created.getTime()
      const prefixes = Array.from({ length: 6 }, () => Math.floor(rng() * 4294967296)).sort((a, b) => a - b)
      let previous = Number.POSITIVE_INFINITY
      for (const prefix of prefixes) {
        const id = `${prefix.toString(16).padStart(8, '0')}deadbeef`
        const context = `seed=${seed} id=${id} createdAt=${iso(createdAt)} config=${JSON.stringify(config)}`
        const fire = cliOneShotTime('0 * * * *', createdAt, id, config)
        expect(fire, context).not.toBeNull()
        expect(fire!, `${context} a larger id fraction fired later, not earlier`).toBeLessThanOrEqual(previous)
        previous = fire!
      }
    }
  })

  it('pins both ends of the id space, the short id and the non-hex fallback', () => {
    vi.stubEnv('TZ', 'UTC')
    const config: CronRestoreConfig = { ...DEFAULTS, oneShotFloorMs: 15_000, oneShotMaxMs: 600_000, oneShotMinuteMod: 30 }
    const createdAt = local(2026, 8, 1, 12, 5)
    const next = local(2026, 8, 1, 12, 30)
    expect(nextCliCronMinute('30 * * * *', createdAt)).toBe(next)
    expect(cliOneShotTime('30 * * * *', createdAt, '00000000', config)).toBe(next - config.oneShotFloorMs)
    expect(Math.abs(cliOneShotTime('30 * * * *', createdAt, 'ffffffff', config)! - (next - config.oneShotMaxMs))).toBeLessThan(1)
    expect(cliOneShotTime('30 * * * *', createdAt, 'zzzzzzzz', config)).toBe(next - config.oneShotFloorMs)
    expect(cliOneShotTime('30 * * * *', createdAt, '80000000', config))
      .toBe(next - (config.oneShotFloorMs + (config.oneShotMaxMs - config.oneShotFloorMs) / 2))
    // Under the default floor of 0 the low end of the id space is the scheduled minute itself.
    expect(cliOneShotTime('30 * * * *', createdAt, '00000000', DEFAULTS)).toBe(next)
    // Fewer than eight hex digits reads as a tiny fraction, so the fire barely moves.
    expect(Math.abs(cliOneShotTime('30 * * * *', createdAt, 'ff', config)! - (next - config.oneShotFloorMs))).toBeLessThan(1)
    // The createdAt clamp wins for a job created inside the window.
    expect(cliOneShotTime('30 * * * *', next - 5_000, 'ffffffff', config)).toBe(next - 5_000)
  })
})

describe('CLI cached cron configuration fuzz', () => {
  const WEIRD = [undefined, null, true, false, 0, -1, 1.5, NaN, Number.POSITIVE_INFINITY, 'x', '10', [], {},
    1_800_001, 2_592_000_001, 60_001, 61, -0.5, 1e21] as const
  const REQUIRED = ['recurringFrac', 'recurringCapMs', 'oneShotMaxMs', 'oneShotFloorMs', 'oneShotMinuteMod'] as const
  const OPTIONAL = ['recurringMaxAgeMs', 'cacheLeadMs'] as const

  it('always yields a schema-valid config for 300 random feature objects', () => {
    let accepted = 0
    for (let i = 0; i < 300; i++) {
      const seed = 0xC0F10000 + i
      const rng = mulberry32(seed)
      const floor = int(rng, 0, 900_000)
      const base: Record<string, unknown> = {
        recurringFrac: rng(), recurringCapMs: int(rng, 0, 1_800_000),
        oneShotFloorMs: floor, oneShotMaxMs: int(rng, floor, 1_800_000), oneShotMinuteMod: int(rng, 1, 60),
      }
      let raw: unknown = base
      const mode = int(rng, 0, 5)
      if (mode === 0) { // an object of pure junk, random keys and random types
        const junk: Record<string, unknown> = {}
        for (let k = int(rng, 0, 5); k > 0; k--) junk[pick(rng, [...REQUIRED, ...OPTIONAL, 'extra', 'enabled'])] = pick(rng, WEIRD)
        raw = junk
      } else if (mode === 1) { // one otherwise valid key corrupted
        base[pick(rng, [...REQUIRED, ...OPTIONAL])] = pick(rng, WEIRD)
      } else if (mode === 2) { // floor above max
        base.oneShotFloorMs = (base.oneShotMaxMs as number) + int(rng, 1, 1000)
      } else if (mode === 3) { // valid, plus the optional keys and an unknown extra
        if (rng() < 0.5) base.recurringMaxAgeMs = int(rng, 0, 2_592_000_000)
        if (rng() < 0.5) base.cacheLeadMs = int(rng, 0, 60_000)
        base.unknownKey = 'ignored'
      } else if (mode === 4) { // a required key missing
        delete base[pick(rng, REQUIRED)]
      } else { // not an object at all
        raw = pick(rng, [null, undefined, 'config', 42, [1, 2, 3], true] as const)
      }
      const features: Record<string, unknown> = { tengu_kairos_cron_config: raw }
      if (rng() < 0.7) features.tengu_kairos_cron = pick(rng, [undefined, null, true, false, 0, 1, 'yes'] as const)
      const disabled = rng() < 0.5
      const context = `seed=${seed} features=${JSON.stringify(features)} disabled=${disabled}`
      const config = noThrow(() => cliCronRestoreConfig(features, disabled), context)
      const flag = features.tengu_kairos_cron
      const expectedEnabled = disabled ? false : flag === undefined || flag === null ? true : Boolean(flag)
      expect(config.enabled, `${context} enabled`).toBe(expectedEnabled)
      expect(Number.isInteger(config.recurringMaxAgeMs) && config.recurringMaxAgeMs >= 0 && config.recurringMaxAgeMs <= 2_592_000_000,
        `${context} recurringMaxAgeMs=${config.recurringMaxAgeMs}`).toBe(true)
      for (const key of ['oneShotMaxMs', 'oneShotFloorMs'] as const) {
        expect(Number.isInteger(config[key]) && config[key] >= 0 && config[key] <= 1_800_000, `${context} ${key}=${config[key]}`).toBe(true)
      }
      expect(config.oneShotFloorMs <= config.oneShotMaxMs, `${context} floor ${config.oneShotFloorMs} above max ${config.oneShotMaxMs}`).toBe(true)
      expect(Number.isInteger(config.oneShotMinuteMod) && config.oneShotMinuteMod >= 1 && config.oneShotMinuteMod <= 60,
        `${context} oneShotMinuteMod=${config.oneShotMinuteMod}`).toBe(true)
      if (config.oneShotMaxMs !== DEFAULTS.oneShotMaxMs || config.oneShotFloorMs !== DEFAULTS.oneShotFloorMs
        || config.oneShotMinuteMod !== DEFAULTS.oneShotMinuteMod) accepted++
    }
    expect(accepted, 'every fuzzed config was rejected — the accept path proved nothing').toBeGreaterThan(10)
  })
})
