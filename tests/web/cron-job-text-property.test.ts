import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionCronJob } from '../../src/core/types';
import { cronPillTitle, cronPromptPreview, formatCronClock, formatCronDistance } from '../../web/src/utils/cron-job-text';

/**
 * Property + timezone coverage for the browser's cron text helpers, alongside the
 * example-based `cron-job-text.test.ts`. Every random case is generated from a named
 * seed and every failure message repeats that seed, so a red line here replays exactly.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** mulberry32 — a 32-bit seeded PRNG, hand-rolled so the cases never depend on a dep. */
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

const DISTANCE_SEED = 20260916;
const CLOCK_SEED = 987654321;
const PREVIEW_SEED = 424242;

afterEach(() => { vi.unstubAllEnvs(); });

// ---------------------------------------------------------------------------
// formatCronDistance
// ---------------------------------------------------------------------------

/** Read a span back out of the rendered text, in minutes, at the shown granularity. */
const parseSpanMinutes = (text: string): number => {
  if (text === 'in under a minute' || text === 'due now') return 0;
  const span = text.startsWith('in ') ? text.slice(3) : text.slice(0, -' ago'.length);
  const dh = /^(\d+)d (\d+)h$/.exec(span);
  if (dh) return (Number(dh[1]) * 24 + Number(dh[2])) * 60;
  const hm = /^(\d+)h (\d+)m$/.exec(span);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const m = /^(\d+)m$/.exec(span);
  if (m) return Number(m[1]);
  throw new Error(`unparsable distance text: ${JSON.stringify(text)}`);
};

/** The coarsest unit the text shows, as minutes of resolution. */
const shownGranularity = (text: string): number => (/\d+d /.test(text) ? 60 : 1);

describe('formatCronDistance thresholds', () => {
  const now = 1_800_000_000_000;

  // Every unit threshold, one millisecond either side, in both directions.
  const cases: Array<[number, string]> = [
    [0, 'in under a minute'],
    [1, 'in under a minute'],
    [MINUTE - 1, 'in under a minute'],
    [MINUTE, 'in 1m'],
    [MINUTE + 1, 'in 1m'],
    [-1, 'due now'],
    [-(MINUTE - 1), 'due now'],
    [-MINUTE, '1m ago'],
    [-(MINUTE + 1), '1m ago'],
    [59 * MINUTE, 'in 59m'],
    [HOUR - 1, 'in 59m'],
    [HOUR, 'in 1h 0m'],
    [HOUR + 1, 'in 1h 0m'],
    [-(HOUR - 1), '59m ago'],
    [-HOUR, '1h 0m ago'],
    [-(HOUR + 1), '1h 0m ago'],
    [23 * HOUR + 59 * MINUTE, 'in 23h 59m'],
    [DAY - 1, 'in 23h 59m'],
    [DAY, 'in 1d 0h'],
    [DAY + 1, 'in 1d 0h'],
    [DAY + 59 * MINUTE + 59_999, 'in 1d 0h'],
    [-(DAY - 1), '23h 59m ago'],
    [-DAY, '1d 0h ago'],
    [-(DAY + 1), '1d 0h ago'],
    [400 * DAY, 'in 400d 0h'],
    [-(400 * DAY + 12 * HOUR), '400d 12h ago'],
  ];

  it('names every unit threshold and its neighbour on both sides', () => {
    for (const [diff, expected] of cases) {
      expect(formatCronDistance(now + diff, now), `diff=${diff}ms`).toBe(expected);
    }
  });

  it('stays well-formed and directional over 500 seeded random gaps', () => {
    const random = mulberry32(DISTANCE_SEED);
    for (let i = 0; i < 500; i++) {
      const diff = Math.round((random() * 2 - 1) * 400 * DAY);
      const text = formatCronDistance(now + diff, now);
      const where = `seed=${DISTANCE_SEED} case=${i} diff=${diff}ms text=${JSON.stringify(text)}`;
      expect(text, where).not.toContain('NaN');
      expect(text, where).not.toContain('undefined');
      expect(text, where).not.toContain('-');
      // A future gap always reads "in …"; a past one is either "due now" or "… ago".
      if (diff >= 0) expect(text.startsWith('in '), where).toBe(true);
      else expect(text === 'due now' || text.endsWith(' ago'), where).toBe(true);
    }
  });

  it('reproduces the elapsed minutes within the coarsest unit it shows', () => {
    const random = mulberry32(DISTANCE_SEED);
    for (let i = 0; i < 500; i++) {
      const diff = Math.round((random() * 2 - 1) * 400 * DAY);
      const text = formatCronDistance(now + diff, now);
      const truth = Math.floor(Math.abs(diff) / MINUTE);
      const parsed = parseSpanMinutes(text);
      const where = `seed=${DISTANCE_SEED} case=${i} diff=${diff}ms text=${JSON.stringify(text)} truth=${truth}m`;
      // Never overstates, and never loses more than the unit on display.
      expect(parsed, where).toBeLessThanOrEqual(truth);
      expect(truth - parsed, where).toBeLessThan(shownGranularity(text));
    }
  });

  it('never shrinks the reported span as the gap grows', () => {
    const random = mulberry32(DISTANCE_SEED + 1);
    const gaps = Array.from({ length: 500 }, () => Math.round(random() * 400 * DAY)).sort((a, b) => a - b);
    let previous = -1;
    for (const gap of gaps) {
      const text = formatCronDistance(now + gap, now);
      const minutes = parseSpanMinutes(text);
      expect(minutes, `seed=${DISTANCE_SEED + 1} gap=${gap}ms text=${JSON.stringify(text)} previous=${previous}m`)
        .toBeGreaterThanOrEqual(previous);
      previous = minutes;
    }
    // The same sweep run backwards is the mirror image, so check the past wording once.
    expect(formatCronDistance(now - gaps[gaps.length - 1], now).endsWith(' ago')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatCronClock — timezones
// ---------------------------------------------------------------------------

const ZONES = [
  'UTC', 'America/Los_Angeles', 'Europe/London', 'Australia/Sydney', 'Asia/Kolkata',
  'Pacific/Chatham', 'America/St_Johns', 'Pacific/Kiritimati', 'Etc/GMT+12',
] as const;

const localDay = (value: number): [number, number, number] => {
  const d = new Date(value);
  return [d.getFullYear(), d.getMonth(), d.getDate()];
};
const sameDay = (a: [number, number, number], b: [number, number, number]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
/** Ground truth for "one calendar day later", stepped at local noon so a DST gap cannot move it. */
const shiftDay = (value: number, delta: number): [number, number, number] => {
  const [y, m, d] = localDay(value);
  return localDay(new Date(y, m, d + delta, 12).getTime());
};
const timeText = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** The prefix the calendar says it should be, computed without the helper's day math. */
const expectedPrefix = (at: number, now: number): 'Today' | 'Tomorrow' | 'Yesterday' | 'dated' => {
  const day = localDay(at);
  if (sameDay(day, localDay(now))) return 'Today';
  if (sameDay(day, shiftDay(now, 1))) return 'Tomorrow';
  if (sameDay(day, shiftDay(now, -1))) return 'Yesterday';
  return 'dated';
};

const assertClock = (at: number, now: number, where: string) => {
  const out = formatCronClock(at, now);
  const time = timeText(at);
  expect(out.endsWith(time), `${where} out=${JSON.stringify(out)} time=${JSON.stringify(time)}`).toBe(true);
  const prefix = expectedPrefix(at, now);
  const detail = `${where} out=${JSON.stringify(out)} expected=${prefix}`;
  if (prefix === 'dated') {
    // Deliberately no year in the dated form (see formatCronClock) — weekday, month, day only.
    const weekday = new Date(at).toLocaleDateString(undefined, { weekday: 'short' });
    expect(out.startsWith(weekday), `${detail} weekday=${weekday}`).toBe(true);
    expect(out, detail).toBe(`${new Date(at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`);
  } else {
    expect(out, detail).toBe(`${prefix} ${time}`);
  }
  return out;
};

describe('formatCronClock across timezones', () => {
  it('takes a stubbed TZ into account (guards the rest of this block)', () => {
    vi.stubEnv('TZ', 'UTC');
    const utc = new Date(0).getTimezoneOffset();
    vi.stubEnv('TZ', 'Asia/Kolkata');
    const kolkata = new Date(0).getTimezoneOffset();
    // Node re-reads process.env.TZ on assignment, so the stub must move the local calendar.
    expect(utc, 'TZ=UTC did not take effect; the zone cases below are meaningless').toBe(0);
    expect(kolkata, 'TZ=Asia/Kolkata did not take effect').toBe(-330);
    expect(kolkata).not.toBe(utc);
  });

  it.each(ZONES)('classifies 200 seeded random pairs in %s', (zone) => {
    vi.stubEnv('TZ', zone);
    const random = mulberry32(CLOCK_SEED);
    const yearStart = new Date(2026, 0, 1, 0, 0).getTime();
    let today = 0; let tomorrow = 0; let yesterday = 0; let dated = 0;
    for (let i = 0; i < 200; i++) {
      const now = yearStart + Math.floor(random() * 365 * DAY);
      const at = now + Math.round((random() * 2 - 1) * 10 * DAY);
      const out = assertClock(at, now, `seed=${CLOCK_SEED} zone=${zone} case=${i} at=${at} now=${now}`);
      if (out.startsWith('Today')) today++;
      else if (out.startsWith('Tomorrow')) tomorrow++;
      else if (out.startsWith('Yesterday')) yesterday++;
      else dated++;
    }
    // All four branches must actually be exercised, or the sweep proved nothing.
    expect({ zone, today: today > 0, tomorrow: tomorrow > 0, yesterday: yesterday > 0, dated: dated > 0 })
      .toEqual({ zone, today: true, tomorrow: true, yesterday: true, dated: true });
  });

  // A 23-hour and a 25-hour local day in each DST zone: formatCronClock divides the gap
  // between local midnights by 86_400_000 and rounds, so a short/long day must not shift
  // the label. 23/24 rounds to 1 and 25/24 rounds to 1 — this pins that.
  const dstDays: Array<[string, string, number, number, number, number]> = [
    ['America/Los_Angeles', 'spring forward (23h)', 2026, 2, 8, 23],
    ['America/Los_Angeles', 'fall back (25h)', 2026, 10, 1, 25],
    ['Australia/Sydney', 'DST start (23h)', 2026, 9, 4, 23],
    ['Australia/Sydney', 'DST end (25h)', 2026, 3, 5, 25],
  ];

  it.each(dstDays)('keeps the day math honest in %s on a %s day', (zone, _label, year, month, day, hours) => {
    vi.stubEnv('TZ', zone);
    const midnight = new Date(year, month, day, 0, 0, 0, 0).getTime();
    const nextMidnight = new Date(year, month, day + 1, 0, 0, 0, 0).getTime();
    // Confirm the fixture really is the irregular day before trusting the assertions.
    expect((nextMidnight - midnight) / HOUR, `${zone} ${year}-${month + 1}-${day} is not a ${hours}h day`).toBe(hours);

    const noon = midnight + 12 * HOUR;
    assertClock(noon, noon, `${zone} same-instant`);
    // Across the irregular day, in both directions, and spanning it.
    assertClock(nextMidnight + 12 * HOUR, noon, `${zone} next-day-noon`);
    assertClock(noon, nextMidnight + 12 * HOUR, `${zone} prev-day-noon`);
    assertClock(midnight - 12 * HOUR, noon, `${zone} yesterday-noon`);
    assertClock(nextMidnight + 36 * HOUR, noon, `${zone} two-days-out`);
    // The transition hour itself, and the last/first minute of the irregular day.
    assertClock(midnight + 2 * HOUR + 30 * MINUTE, noon, `${zone} transition-hour`);
    assertClock(nextMidnight - 1, midnight, `${zone} end-of-day`);
    assertClock(nextMidnight, nextMidnight - 1, `${zone} rollover`);
    expect(formatCronClock(nextMidnight, nextMidnight - 1).startsWith('Tomorrow'), `${zone} rollover label`).toBe(true);
  });

  it('resolves midnight, year and far-future edges', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const lastMs = new Date(2026, 8, 15, 23, 59, 59, 999).getTime();
    const nextMidnight = new Date(2026, 8, 16, 0, 0, 0, 0).getTime();
    expect(formatCronClock(nextMidnight, lastMs)).toBe(`Tomorrow ${timeText(nextMidnight)}`);
    expect(formatCronClock(lastMs, new Date(2026, 8, 15, 0, 0, 0, 0).getTime())).toBe(`Today ${timeText(lastMs)}`);
    expect(formatCronClock(new Date(2026, 8, 15, 0, 0, 0, 0).getTime(), lastMs)).toMatch(/^Today /);

    const newYearsEve = new Date(2026, 11, 31, 22, 0).getTime();
    const newYearsDay = new Date(2027, 0, 1, 1, 0).getTime();
    expect(formatCronClock(newYearsDay, newYearsEve)).toBe(`Tomorrow ${timeText(newYearsDay)}`);
    expect(formatCronClock(newYearsEve, newYearsDay)).toBe(`Yesterday ${timeText(newYearsEve)}`);

    // 366 days out falls through to the dated form. The year is NOT shown, as designed:
    // "Wed, Sep 15" for a run over a year away. Cron jobs expire in days, so this is fine.
    const nextYear = new Date(2027, 8, 16, 9, 23).getTime();
    const farOut = formatCronClock(nextYear, new Date(2026, 8, 15, 9, 23).getTime());
    expect(farOut).toBe(`${new Date(nextYear).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${timeText(nextYear)}`);
    expect(farOut).not.toContain('2027');
  });
});

// ---------------------------------------------------------------------------
// cronPromptPreview
// ---------------------------------------------------------------------------

// Non-ASCII lives here as code points only: CJK (U+4E2D U+6587 U+6D4B U+8BD5) and an
// astral emoji (U+1F4C4 PAGE FACING UP), which is where code-unit slicing gets interesting.
const CJK_SHORT = String.fromCodePoint(0x4e2d, 0x6587);
const CJK_WORDS = String.fromCodePoint(0x4e2d, 0x6587, 0x6d4b, 0x8bd5);
const CJK_LONG = String.fromCodePoint(0x4e2d).repeat(25);
const VOCABULARY = [
  ' ', '   ', '\t', '\t\t', '\r\n', '\n', '\n\n', '\r\n\r\n',
  'deploy', 'inspect', 'disk', 'daily', 'report',
  CJK_SHORT, CJK_WORDS, '\u{1F4C4}', '\u{1F4C4}\u{1F4C4}',
  'x'.repeat(30), 'long word '.repeat(12), CJK_LONG,
];

describe('cronPromptPreview properties', () => {
  it('keeps 500 seeded random prompts single-line, trimmed and bounded', () => {
    const random = mulberry32(PREVIEW_SEED);
    const limits = [1, 2, 3, 8, 20, 40, 96];
    let truncated = 0; let whole = 0;
    for (let i = 0; i < 500; i++) {
      const pieces = 1 + Math.floor(random() * 8);
      let prompt = '';
      for (let p = 0; p < pieces; p++) prompt += VOCABULARY[Math.floor(random() * VOCABULARY.length)];
      const limit = limits[Math.floor(random() * limits.length)];
      const out = cronPromptPreview(prompt, limit);
      const where = `seed=${PREVIEW_SEED} case=${i} limit=${limit} prompt=${JSON.stringify(prompt)} out=${JSON.stringify(out)}`;

      expect(out, where).not.toContain('\n');
      expect(out, where).not.toContain('\r');
      expect(out, where).toBe(out.trim());
      expect(out.length, where).toBeLessThanOrEqual(limit);

      // Independent reconstruction of the line the preview is supposed to describe.
      const line = prompt.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0) ?? '';
      if (line.length > limit) {
        truncated++;
        expect(out.endsWith('…'), where).toBe(true);
        // What survives is a genuine prefix of that line (whitespace trimmed off the cut),
        // and never ends on half a surrogate pair (9 of these 281 truncations cut inside one).
        expect(line.startsWith(out.slice(0, -1)), where).toBe(true);
        expect(out.length, where).toBeGreaterThanOrEqual(1);
        expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), `${where} lone high surrogate`).toBe(false);
      } else {
        whole++;
        expect(out, where).toBe(line);
      }
    }
    // Both halves of the branch were reached.
    expect({ truncated: truncated > 0, whole: whole > 0 }).toEqual({ truncated: true, whole: true });
  });

  it('documents the smallest limits, the ellipsis budget and the empty inputs', () => {
    expect(cronPromptPreview(null)).toBe('');
    expect(cronPromptPreview('')).toBe('');
    expect(cronPromptPreview('\n\n\t ')).toBe('');
    expect(cronPromptPreview('\r\n\r\n  second line wins  \r\nthird')).toBe('second line wins');

    // limit 1 leaves no room for content: the ellipsis IS the whole preview.
    expect(cronPromptPreview('hello', 1)).toBe('…');
    // limit 2 keeps exactly one code unit.
    expect(cronPromptPreview('hello', 2)).toBe('h…');
    // A line at the limit is returned whole; one code unit over is cut.
    expect(cronPromptPreview('hello', 5)).toBe('hello');
    expect(cronPromptPreview('hello!', 5)).toBe('hell…');

    // The cut is `slice(0, limit - 1).trimEnd()`, so a cut landing on a space gives a
    // SHORTER result than the limit — deliberate (no "word …"), hence "<= limit", not "== limit".
    expect(cronPromptPreview(`aaaaa ${'b'.repeat(50)}`, 7)).toBe('aaaaa…');
    expect(cronPromptPreview('word '.repeat(40), 40)).toHaveLength(40);
  });

  it('never cuts an astral character in half', () => {
    // The cut is by UTF-16 code units; one landing inside a surrogate pair used to keep
    // the lone high surrogate, which the DOM paints as U+FFFD. Cut index 2 here lands
    // between D83D and DCC4, so the orphaned half must be dropped, not shown.
    const preview = cronPromptPreview(`a${'\u{1F4C4}'.repeat(10)}`, 3);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(preview)).toBe(false);
    expect(preview).toBe('a…');
    // A cut that lands cleanly after a whole emoji keeps it.
    expect(cronPromptPreview(`a${'\u{1F4C4}'.repeat(10)}`, 4)).toBe('a\u{1F4C4}…');
  });
});

// ---------------------------------------------------------------------------
// cronPillTitle
// ---------------------------------------------------------------------------

describe('cronPillTitle matrix', () => {
  // UTC keeps the expected clock text identical whatever zone the runner is in.
  const fixture = () => {
    vi.stubEnv('TZ', 'UTC');
    const now = new Date(2026, 8, 15, 12, 0).getTime();
    const nextRunAt = new Date(2026, 8, 16, 9, 23).getTime();
    const job = (over: Partial<SessionCronJob> = {}): SessionCronJob => ({
      id: '41935620', cron: '23 9 * * *', schedule: 'Every day at 9:23 AM', prompt: 'Daily disk inspection',
      promptTruncated: false, recurring: true, durable: false, createdAt: now - HOUR, nextRunAt, expiresAt: now + 6 * DAY, ...over,
    });
    const jobs = (count: number, first: Partial<SessionCronJob>) => Array.from({ length: count }, (_, i) => (
      i === 0 ? job({ ...first, id: 'first' }) : job({ id: `job-${i}` })
    ));
    return { now, nextRunAt, job, jobs };
  };

  const labels: Array<[string, Partial<SessionCronJob>, string]> = [
    ['schedule', {}, 'Every day at 9:23 AM'],
    ['cron only', { schedule: null }, '23 9 * * *'],
    ['neither', { schedule: null, cron: null }, 'first'],
  ];
  const runs: Array<[string, number | null]> = [['a next run', 1], ['no next run', null]];
  const counts = [1, 2, 3, 32];

  it.each(labels.flatMap(([name, over, label]) => runs.map(([runName, run]) => [name, runName, over, label, run] as const)))(
    'renders %s with %s exactly, at every job count',
    (_name, _runName, over, label, run) => {
      const { now, nextRunAt, jobs } = fixture();
      const tail = run === null ? '' : ` Next run Tomorrow 9:23 AM (in 21h 23m).`;
      for (const count of counts) {
        const rest = count - 1;
        const more = rest === 0 ? '' : ` ${rest} more job${rest === 1 ? '' : 's'}.`;
        const title = cronPillTitle(jobs(count, { ...over, nextRunAt: run === null ? null : nextRunAt }), now);
        expect(title, `count=${count}`).toBe(`Cron job: ${label}.${tail}${more}`);
      }
    },
  );

  it('has no empty, doubled or dangling punctuation in any cell of the matrix', () => {
    const { now, nextRunAt, jobs } = fixture();
    const titles = [cronPillTitle(undefined, now), cronPillTitle([], now)];
    for (const [, over] of labels) {
      for (const [, run] of runs) {
        for (const count of counts) titles.push(cronPillTitle(jobs(count, { ...over, nextRunAt: run === null ? null : nextRunAt }), now));
      }
    }
    for (const title of titles) {
      const where = JSON.stringify(title);
      expect(title, where).not.toContain('  ');
      expect(title, where).toBe(title.trim());
      expect(title.endsWith('.'), where).toBe(true);
      expect(title, where).not.toContain('NaN');
      expect(title, where).not.toContain('undefined');
      expect(title, where).not.toContain('null');
      expect(title, where).not.toContain('Invalid Date');
    }
    expect(titles).toHaveLength(2 + 3 * 2 * 4);
  });

  it('says the daemon must update for an unknown job list, and stays terse for an empty one', () => {
    const { now } = fixture();
    expect(cronPillTitle(undefined, now)).toBe("Confirmed cron job. Details need this host's daemon to update.");
    expect(cronPillTitle([], now)).toBe('Confirmed cron job.');
    // 32 jobs is the wording check for a plural remainder; 2 is the singular one.
    const { jobs } = fixture();
    expect(cronPillTitle(jobs(2, {}), now)).toContain('1 more job.');
    expect(cronPillTitle(jobs(32, {}), now)).toContain('31 more jobs.');
  });

  it('falls back past a schedule reported as an empty string', () => {
    // The normalizer turns '' into null before it reaches the pill, and the label chain
    // is falsy-based as a second line of defence, so no job ever renders as "Cron job: .".
    const { now, job } = fixture();
    expect(cronPillTitle([job({ schedule: '', nextRunAt: null })], now)).toBe('Cron job: 23 9 * * *.');
    expect(cronPillTitle([job({ schedule: '', cron: '', nextRunAt: null })], now)).toBe('Cron job: 41935620.');
  });
});
