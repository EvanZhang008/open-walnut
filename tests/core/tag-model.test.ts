/**
 * The tag model (src/core/tag-model.ts): every tag is key:value. A plain word from an older
 * client, an agent or a sync plugin keeps its meaning as a label; `created:` / `updated:` are
 * the task's own dates, worked out and never stored; a person typing a tag is told what a tag
 * is instead of having it rewritten.
 */
import { describe, expect, it } from 'vitest';
import {
  dateTags,
  effectiveTags,
  isDerivedTag,
  isNormalTag,
  localDay,
  namesDerivedTag,
  normalizeTag,
  normalizeTags,
  parseTag,
  tagInputProblem,
  tagsAreNormal,
} from '../../src/core/tag-model.js';

describe('normalizeTag', () => {
  it('keeps a key:value tag, lowercasing the key and folding spaces', () => {
    expect(normalizeTag('sev:2')).toBe('sev:2');
    expect(normalizeTag('ticket:V1234567890')).toBe('ticket:V1234567890');
    expect(normalizeTag('  Team : Marina  ')).toBe('team:Marina');
    expect(normalizeTag('note:two   words\there')).toBe('note:two words here');
    expect(normalizeTag('url:https://example.com/a')).toBe('url:https://example.com/a');
    expect(normalizeTag('a::b')).toBe('a::b');
  });

  it('turns a plain word, or text with no usable key, into a label', () => {
    expect(normalizeTag('oncall')).toBe('label:oncall');
    expect(normalizeTag('BAH')).toBe('label:BAH');
    expect(normalizeTag('my tag: x')).toBe('label:my tag: x');
    expect(normalizeTag('oncall:')).toBe('label:oncall');
    expect(normalizeTag(':oncall')).toBe('label:oncall');
    expect(normalizeTag('_project__Marina')).toBe('label:_project__Marina');
  });

  it('never stores a derived date tag: a write keeps the text as a label, a filter keeps it', () => {
    expect(normalizeTag('created:2026-10-01')).toBe('label:created:2026-10-01');
    expect(normalizeTag('Updated:2026-10-01')).toBe('label:Updated:2026-10-01');
    expect(normalizeTag('created:2026-10-01', { derived: true })).toBe('created:2026-10-01');
  });

  it('drops what has no text, and anything not a string', () => {
    expect(normalizeTag('')).toBeUndefined();
    expect(normalizeTag('   ')).toBeUndefined();
    expect(normalizeTag(':')).toBeUndefined();
    expect(normalizeTag(42)).toBeUndefined();
    expect(normalizeTag(null)).toBeUndefined();
  });

  it('keeps non-ASCII text as typed', () => {
    // A two-character CJK word (escaped), as a label and as a value.
    const cjk = '\u7d27\u6025';
    expect(normalizeTag(cjk)).toBe(`label:${cjk}`);
    expect(normalizeTag(`area:${cjk}`)).toBe(`area:${cjk}`);
  });

  it('is idempotent, the long cut included', () => {
    // The emoji (a surrogate pair, escaped) straddles the 200-character cut.
    const straddle = `k:${'z'.repeat(197)}\ud83d\ude00tail`;
    const samples = ['oncall', 'Team:Marina', 'x'.repeat(300), `k:${'y '.repeat(150)}`, 'created:2026', 'a: b  c ', '\u7d27', straddle];
    for (const raw of samples) {
      const once = normalizeTag(raw)!;
      expect(normalizeTag(once)).toBe(once);
      expect(once.length).toBeLessThanOrEqual(200);
      expect(isNormalTag(once)).toBe(true);
      expect(once).not.toMatch(/[\ud800-\udbff]$/);
    }
    expect(normalizeTag(straddle)).toBe(`k:${'z'.repeat(197)}`);
  });
});

describe('normalizeTags / tagsAreNormal / isNormalTag', () => {
  it('normalizes in order and drops duplicates the folding creates', () => {
    expect(normalizeTags(['oncall', 'label:oncall', 'Sev:2', 'sev:2', '', 7])).toEqual(['label:oncall', 'sev:2']);
    expect(normalizeTags(undefined)).toEqual([]);
  });

  it('says whether a stored list needs a rewrite', () => {
    expect(tagsAreNormal(['label:oncall', 'sev:2'])).toBe(true);
    expect(tagsAreNormal(undefined)).toBe(true);
    expect(tagsAreNormal(['oncall'])).toBe(false);
    expect(tagsAreNormal(['sev:2', 'sev:2'])).toBe(false);
    expect(tagsAreNormal(['Sev:2'])).toBe(false);
    expect(tagsAreNormal(['created:2026-10-01'])).toBe(false);
    expect(isNormalTag('label:\u7d27\u6025')).toBe(true);
    expect(isNormalTag('k:a  b')).toBe(false);
    expect(isNormalTag(3)).toBe(false);
  });
});

describe('parseTag / derived tags', () => {
  it('splits a stored tag at its first colon', () => {
    expect(parseTag('ticket:V1')).toEqual({ key: 'ticket', value: 'V1' });
    expect(parseTag('a:b:c')).toEqual({ key: 'a', value: 'b:c' });
    expect(parseTag('oncall')).toBeUndefined();
  });

  it('knows created:/updated: as the task\'s own dates', () => {
    expect(isDerivedTag('created:2026-10-01')).toBe(true);
    expect(isDerivedTag('updated:2026-10-01')).toBe(true);
    expect(isDerivedTag('label:created')).toBe(false);
    expect(namesDerivedTag(['sev:2', 'updated:2026-10-01'])).toBe(true);
    expect(namesDerivedTag(['sev:2'])).toBe(false);
    expect(namesDerivedTag(undefined)).toBe(false);
  });

  it('works the dates out in the given time zone, as YYYY-MM-DD', () => {
    const task = { tags: ['sev:2'], created_at: '2026-09-30T23:30:00.000Z', updated_at: '2026-10-01T08:00:00.000Z' };
    expect(dateTags(task, 'UTC')).toEqual(['created:2026-09-30', 'updated:2026-10-01']);
    // Los Angeles is UTC-7 in October: 23:30Z on 09-30 is still 09-30 there; 08:00Z is 01:00 on 10-01.
    expect(dateTags(task, 'America/Los_Angeles')).toEqual(['created:2026-09-30', 'updated:2026-10-01']);
    // Tokyo is UTC+9: 23:30Z on 09-30 is 08:30 on 10-01.
    expect(dateTags(task, 'Asia/Tokyo')[0]).toBe('created:2026-10-01');
    expect(effectiveTags(task, 'UTC')).toEqual(['sev:2', 'created:2026-09-30', 'updated:2026-10-01']);
    expect(dateTags({}, 'UTC')).toEqual([]);
    expect(localDay('not a date')).toBeUndefined();
  });
});

describe('tagInputProblem', () => {
  it('accepts a key:value tag', () => {
    expect(tagInputProblem('team:marina')).toBeUndefined();
    expect(tagInputProblem('Sev:2')).toBeUndefined();
    expect(tagInputProblem('')).toBeUndefined();
  });

  it('tells a person why text is not a tag, and how to write it', () => {
    expect(tagInputProblem('oncall')).toMatch(/key:value.*label:oncall/);
    expect(tagInputProblem('oncall:')).toMatch(/label:oncall/);
    expect(tagInputProblem('created:2026-10-01')).toMatch(/task's own date/);
    expect(tagInputProblem('my key:x')).toMatch(/letters, digits/);
  });
});
