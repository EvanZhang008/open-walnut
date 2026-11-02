/**
 * The user's private words (src/core/private-tasks/private-words.ts) and the model's verdict parse
 * (privacy-judge.ts), and where a new task starts (birth.ts).
 */
import { describe, it, expect } from 'vitest';
import { compilePrivateWords, invalidPrivateWords, matchPrivateWords } from '../../../src/core/private-tasks/private-words.js';
import { parseVerdict } from '../../../src/core/private-tasks/privacy-judge.js';
import { decideBirth } from '../../../src/core/private-tasks/birth.js';

describe('private words', () => {
  it('a plain entry matches a whole word, case-insensitively', () => {
    expect(matchPrivateWords(['pay'], ['Pay review for Q3'])).toBe('pay');
    expect(matchPrivateWords(['pay'], ['repay the loan'])).toBeNull();
    expect(matchPrivateWords(['pay'], ['payment page bug'])).toBeNull();
    expect(matchPrivateWords(['Marigold'], ['the marigold case'])).toBe('Marigold');
  });

  it('a phrase matches across any run of spaces', () => {
    expect(matchPrivateWords(['performance review'], ['Write my performance\n  review'])).toBe('performance review');
  });

  it('an entry holding CJK text matches anywhere (no word breaks)', () => {
    // A CJK word inside a longer run ("my marigold plan"); the entry is the first two characters of the word.
    expect(matchPrivateWords(['\u91d1\u76de'], ['\u6211\u7684\u91d1\u76de\u82b1\u8ba1\u5212'])).toBe('\u91d1\u76de');
  });

  it('a /pattern/ is a regular expression, case-insensitive when it names no flags', () => {
    expect(matchPrivateWords(['/\\bmarigold\\b/'], ['Plan the MARIGOLD launch'])).toBe('/\\bmarigold\\b/');
    expect(matchPrivateWords(['/Marigold/g'], ['marigold talk'])).toBeNull(); // flags given are used as given
    expect(matchPrivateWords(['/Marigold/gi'], ['marigold talk'])).toBe('/Marigold/gi');
  });

  it('an entry that does not compile, or an empty one, is skipped and reported', () => {
    expect(compilePrivateWords(['/(unclosed/', '', '   ', 'ok'])).toHaveLength(1);
    expect(invalidPrivateWords(['/(unclosed/', 'fine'])).toEqual(['/(unclosed/']);
    expect(matchPrivateWords(['/(unclosed/'], ['(unclosed'])).toBeNull();
  });

  it('checks every text given and none when the list is empty', () => {
    expect(matchPrivateWords(['health'], ['Fix login', undefined, 'my health check'])).toBe('health');
    expect(matchPrivateWords([], ['anything'])).toBeNull();
    expect(matchPrivateWords(undefined, ['anything'])).toBeNull();
  });
});

describe('the model verdict', () => {
  it('reads pass or fail, with a reason (and the earlier private form)', () => {
    expect(parseVerdict('{"pass": false, "reason": "own promotion"}')).toEqual({ private: true, reason: 'own promotion' });
    expect(parseVerdict('{"pass": true, "reason": "team work"}')).toEqual({ private: false, reason: 'team work' });
    expect(parseVerdict('{"private": true, "reason": "health"}')).toEqual({ private: true, reason: 'health' });
  });

  it('reads the JSON asked for, also inside prose', () => {
    expect(parseVerdict('{"private": true, "reason": "own marigold"}')).toEqual({ private: true, reason: 'own marigold' });
    expect(parseVerdict('Sure: {"private": false, "reason": "team bug fix"}')).toEqual({ private: false, reason: 'team bug fix' });
  });

  it('throws on anything else, so a push never goes out unjudged', () => {
    expect(() => parseVerdict('')).toThrow();
    expect(() => parseVerdict('private')).toThrow();
    expect(() => parseVerdict('{"private": "yes"}')).toThrow();
    expect(() => parseVerdict('{"reason": "x"}')).toThrow();
  });
});

describe('where a new task starts', () => {
  const ON = { check: true, words: [] as string[] };
  const now = '2026-11-01T00:00:00.000Z';
  it('a task with no outside service is plain local', () => {
    expect(decideBirth('local', { title: 'x' }, ON, { canJudge: true, now })).toEqual({ source: 'local' });
  });

  it('a creator\'s Local choice holds it as chosen', () => {
    expect(decideBirth('svc', { title: 'x' }, ON, { explicitLocal: true, canJudge: true, now }))
      .toEqual({ source: 'local', hold: { target: 'svc', state: 'chosen', by: 'user', reason: 'Kept local when it was created', at: now } });
  });

  it('a hard rule keeps it local before any model is asked', () => {
    const d = decideBirth('svc', { title: 'Q3', description: 'my marigold packet' }, { check: true, words: ['marigold'] }, { canJudge: true, now });
    expect(d.source).toBe('local');
    expect(d.hold).toMatchObject({ target: 'svc', state: 'private', by: 'words' });
  });

  it('with the AI rule it is born local and checking; without it, the service at once', () => {
    expect(decideBirth('svc', { title: 'Fix login' }, ON, { canJudge: true, now })).toMatchObject({ source: 'local', hold: { state: 'checking', target: 'svc' } });
    expect(decideBirth('svc', { title: 'Fix login' }, ON, { canJudge: false, now })).toEqual({ source: 'svc' });
  });

  it('a provider whose check is off sends it at once, hard rules or not; the Local choice still holds', () => {
    const off = { check: false, words: ['marigold'] };
    expect(decideBirth('svc', { title: 'my marigold packet' }, off, { canJudge: true, now })).toEqual({ source: 'svc' });
    expect(decideBirth('svc', { title: 'x' }, off, { explicitLocal: true, canJudge: true, now }).source).toBe('local');
  });
});

describe('a /pattern/ that could freeze the server is not used', () => {
  it('nested quantifiers and back-references are refused; ordinary patterns are kept', async () => {
    const { slowPattern } = await import('../../../src/core/private-tasks/private-words.js');
    for (const p of ['(a+)+', '(\\w+\\s?)*$', '((a+))+', '(?:x*y)+', '(a|b+){2,}', '(a)\\1']) expect(slowPattern(p), p).toBe(true);
    for (const p of ['\\bmarigold\\b', 'pay(roll)?', '(alpha|beta) review', '[a-z]+ case', '\\(x+\\)+']) expect(slowPattern(p), p).toBe(false);
    expect(invalidPrivateWords(['/(\\w+\\s?)+$/', '/marigold/'])).toEqual(['/(\\w+\\s?)+$/']);
  });

  it('a pattern reads at most the first 20,000 characters of a field; a plain word reads more', () => {
    const long = `${'x '.repeat(15_000)}secret`;
    expect(matchPrivateWords(['/secret/'], [long])).toBeNull();
    expect(matchPrivateWords(['secret'], [long])).toBe('secret');
  });
});
