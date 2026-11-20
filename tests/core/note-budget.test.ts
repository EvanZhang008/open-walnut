/**
 * The NOTE budget (src/core/note-budget.ts): the reorganize must be able to land, must
 * be pointed at where the note's bulk is, and one fire that comes back longer is not
 * a warn. 2026-11-19 health alarm: "REORGANIZE fire did not shrink the note" ran at
 * 37 an hour, because about half of all reorganize fires come back longer and each
 * was a warn; one legacy note (115k chars, all in Progress) was frozen because the
 * shrink guard rejected every reorganize of it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  NOTE_REORG_CAP, REORG_SECTION_FLOOR, REORG_SECTION_CEILING, REORG_MISS_STREAK, SHRINK_PROTECTED_SECTIONS,
  noteShrinkRejected, noteSectionSizes, recordReorgOutcome, sectionFloor, __resetReorgMisses,
} from '../../src/core/note-budget.js';
import { NOTE_SECTIONS } from '../../src/core/note-sections.js';
import { buildSelfReportPrompt } from '../../src/core/session-hooks/builtins.js';

const fill = (word: string, n: number) => `${word} `.repeat(Math.ceil(n / (word.length + 1))).slice(0, n - 1) + '.';

/** A note with every section at the given body length. */
function note(sizes: Partial<Record<(typeof NOTE_SECTIONS)[number], number>>): string {
  return NOTE_SECTIONS.filter((s) => sizes[s])
    .map((s) => `## ${s}\n${fill(s.toLowerCase().replace(' ', '-'), sizes[s]!)}`)
    .join('\n\n');
}

describe('shrink guard on a reorganize fire', () => {
  it('accepts the reorganize of a legacy note whose bulk parsed into one section (the frozen 115k note)', () => {
    const legacy = `## Goal\n${fill('goal', 259)}\n\n## Progress\n${fill('- done item', 2000)}\n## Launch notes\n${fill('history', 113000)}`;
    expect(legacy.length).toBeGreaterThan(100_000);
    const reorganized = note({ 'Executive Summary': 700, 'User Request': 400, Context: 900, Progress: 2200, References: 1200, 'Work Log': 900 });
    expect(noteShrinkRejected(legacy, reorganized)).toBe(false);
  });

  // Class guard: every protected section, enumerated from the guard's own list, may be
  // consolidated down to its reorganize floor on an over-cap note and not below it, and
  // a new protected section joins this check by itself.
  it.each(SHRINK_PROTECTED_SECTIONS.map((s) => [s]))('%s: consolidating to its floor lands; below it does not (bar References)', (section) => {
    const sizes = { 'Executive Summary': 800, 'User Request': 800, Context: 800, Progress: 800, References: 800, 'Work Log': 800, [section]: 5000 };
    const old = note(sizes);
    expect(old.length).toBeGreaterThan(NOTE_REORG_CAP);
    const floor = Math.ceil(sectionFloor(5000, old.length, section));
    expect(floor).toBe(section === 'References' ? 0 : REORG_SECTION_CEILING);
    expect(noteShrinkRejected(old, note({ ...sizes, [section]: Math.max(floor, 150) }))).toBe(false);
    if (floor) expect(noteShrinkRejected(old, note({ ...sizes, [section]: floor - 1 }))).toBe(true);
    // Emptying any protected section is always a loss.
    expect(noteShrinkRejected(old, note({ ...sizes, [section]: 0 }))).toBe(true);
  });

  it('a note just over the cap keeps nearly the ordinary floor: a big section cannot be cut to 600', () => {
    const sizes = { 'Executive Summary': 500, 'User Request': 600, Context: 3000, Progress: 800, References: 600, 'Work Log': 700 };
    const old = note(sizes);
    expect(old.length).toBeGreaterThan(NOTE_REORG_CAP);
    expect(old.length).toBeLessThan(NOTE_REORG_CAP * 1.1);
    const floor = sectionFloor(3000, old.length, 'Context');
    expect(floor).toBeGreaterThan(3000 * 0.4 * 0.9);
    expect(noteShrinkRejected(old, note({ ...sizes, Context: REORG_SECTION_FLOOR + 1 }))).toBe(true);
    expect(noteShrinkRejected(old, note({ ...sizes, Context: Math.ceil(floor) }))).toBe(false);
  });

  it('under the cap the proportional floor still holds', () => {
    const old = note({ 'Executive Summary': 300, Context: 2500, 'Work Log': 1000 });
    expect(old.length).toBeLessThan(NOTE_REORG_CAP);
    expect(noteShrinkRejected(old, note({ 'Executive Summary': 300, Context: REORG_SECTION_FLOOR, 'Work Log': 1000 }))).toBe(true);
  });
});

describe('the reorganize prompt names where the bulk is', () => {
  it('lists every non-empty section with its size, largest first', () => {
    const sizes = { 'Executive Summary': 1246, 'User Request': 2349, Context: 1205, Progress: 1397, References: 2081, 'Work Log': 1857 };
    const existing = note(sizes);
    const line = noteSectionSizes(existing);
    const order = line.split(', ').map((r) => r.replace(/ \d+$/, ''));
    expect(order).toEqual([...NOTE_SECTIONS].sort((a, b) => sizes[b] - sizes[a]));
    for (const s of NOTE_SECTIONS) expect(line).toContain(`${s} ${sizes[s]}`);
    const prompt = buildSelfReportPrompt(existing);
    expect(prompt).toContain(`Section sizes now, largest first: ${line}`);
    expect(prompt).toContain('Cut the LARGEST sections first');
  });

  it('counts free text above the first section, and the prompt under the cap has no sizes', () => {
    expect(noteSectionSizes(`old free text\n\n${note({ Progress: 50 })}`)).toBe('Progress 50, text above the first section 13');
    expect(buildSelfReportPrompt(note({ Progress: 500 }))).not.toContain('Section sizes now');
  });
});

describe('reorganize misses are counted per task', () => {
  beforeEach(() => __resetReorgMisses());

  it('a single miss is info; the warn comes when the note is longer after a streak than before it', () => {
    const verdicts = [9000, 9300, 9500].map((len, i) => recordReorgOutcome('t1', len, len + 200).verdict);
    expect(verdicts).toEqual([...Array(REORG_MISS_STREAK - 1).fill('missed'), 'stuck']);
    expect(recordReorgOutcome('t1', 9700, 9600).verdict).toBe('shrank');
    expect(recordReorgOutcome('t1', 9600, 9600)).toMatchObject({ verdict: 'missed', misses: 1, startLen: 9600 });
  });

  it('a streak that ends where it began is no warn; tasks are counted apart', () => {
    for (let i = 1; i < REORG_MISS_STREAK; i++) recordReorgOutcome('t1', 9000, 9000);
    recordReorgOutcome('t2', 8000, 8100);
    expect(recordReorgOutcome('t1', 9000, 9000).verdict).toBe('missed');
    expect(recordReorgOutcome('t2', 8100, 8200).misses).toBe(2);
  });

  it('keeps at most 1000 tasks, dropping the least recently touched', () => {
    for (let i = 0; i < 1001; i++) recordReorgOutcome(`t${i}`, 7000, 7100);
    expect(recordReorgOutcome('t0', 7000, 7100).misses).toBe(1); // t0 was dropped
    expect(recordReorgOutcome('t1000', 7100, 7200).misses).toBe(2);
  });
});
