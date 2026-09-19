/**
 * The recap tip's server half, as pure logic: the OVERVIEW / RECAP labels in the
 * self-report prompt, the language directive that follows config.agent.language,
 * and the record patch read back out of a report.
 *
 * Why it exists: the tip is the ONE part of the self-report the user reads, and
 * it shipped in English for a `language: zh` user because the prompt's section
 * contract says "English" for every label and RECAP had no language rule of its
 * own. The note keeps that contract; only the two tip fields follow the setting.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSelfReportPrompt,
  readRecapTipFields,
  extractField,
} from '../../src/core/session-hooks/builtins.js';
import { nonEnglishUiLanguage, uiLanguageName } from '../../src/core/ui-language.js';

const TIP_DIRECTIVE = 'OVERVIEW and RECAP are shown to the user in the UI: write BOTH in';

describe('buildSelfReportPrompt: recap tip labels and language', () => {
  it('asks for OVERVIEW (whole session) and RECAP (latest turn), both mandatory', () => {
    const prompt = buildSelfReportPrompt('', 'Some title');
    expect(prompt).toMatch(/\nOVERVIEW: .*WHOLE session/);
    expect(prompt).toMatch(/\nRECAP: ONE line/);
    // OVERVIEW comes right before RECAP, after the TITLE directive.
    expect(prompt.indexOf('\nTITLE:')).toBeLessThan(prompt.indexOf('\nOVERVIEW:'));
    expect(prompt.indexOf('\nOVERVIEW:')).toBeLessThan(prompt.indexOf('\nRECAP:'));
  });

  it('English (or no) display language adds no directive: the default prompt is unchanged', () => {
    for (const uiLanguage of [undefined, '', 'en', 'EN-US', 'en_GB', '!!']) {
      const prompt = buildSelfReportPrompt('', '', { uiLanguage });
      expect(prompt, `uiLanguage=${JSON.stringify(uiLanguage)}`).not.toContain(TIP_DIRECTIVE);
    }
    expect(buildSelfReportPrompt('', '', { uiLanguage: 'en' })).toBe(buildSelfReportPrompt('', ''));
  });

  it('a non-English display language scopes the directive to the two tip fields only', () => {
    const prompt = buildSelfReportPrompt('## Executive Summary\nx', 'T', { uiLanguage: 'zh-CN' });
    expect(prompt).toContain(`${TIP_DIRECTIVE} Simplified Chinese (\u7b80\u4f53\u4e2d\u6587)`);
    expect(prompt).toContain('Every other field stays English.');
    // The note contract still says English: the directive did not rewrite it.
    expect(prompt).toContain('Section contract (plain text under each label, English');
    // Placed with the tip fields, before the workflow fields.
    expect(prompt.indexOf(TIP_DIRECTIVE)).toBeGreaterThan(prompt.indexOf('\nRECAP:'));
    expect(prompt.indexOf(TIP_DIRECTIVE)).toBeLessThan(prompt.indexOf('\nPHASE_SIGNAL:'));
  });

  it('an unknown code still gets a usable directive', () => {
    expect(buildSelfReportPrompt('', '', { uiLanguage: 'tlh' }))
      .toContain("write BOTH in the language with ISO 639-1 code 'tlh'");
  });
});

// normalizeLang itself is covered in tests/core/diff-summary.test.ts.
describe('ui-language helpers', () => {
  it('nonEnglishUiLanguage answers only for a set, non-English language', () => {
    expect(nonEnglishUiLanguage('zh')).toBe('zh');
    expect(nonEnglishUiLanguage('en-US')).toBeUndefined();
    expect(nonEnglishUiLanguage('')).toBeUndefined();
    expect(nonEnglishUiLanguage(undefined)).toBeUndefined();
  });
  it('uiLanguageName names the known codes and describes the rest', () => {
    expect(uiLanguageName('zh')).toBe('Simplified Chinese (\u7b80\u4f53\u4e2d\u6587)');
    expect(uiLanguageName('xx')).toBe("the language with ISO 639-1 code 'xx'");
  });
});

const REPORT = `EXEC_SUMMARY: Reworking the composer.
OVERVIEW: \u91cd\u505a composer \u5e03\u5c40\uff0c\u8ba9\u6eda\u52a8\u6761\u6b62\u4e8e\u6700\u540e\u4e00\u884c\uff1b\u4fee\u590d\u5df2\u63d0\u4ea4\u3002
RECAP: \u5df2\u90e8\u7f72\u5230 3456\uff0cWebKit \u4e0e Chromium \u9a8c\u8bc1\u901a\u8fc7\u3002
PHASE_SIGNAL: committed(abc)
STATUS: succeeded`;

describe('readRecapTipFields', () => {
  const now = new Date('2026-09-18T10:00:00.000Z');

  it('reads both fields with one timestamp each, in whatever language they arrive', () => {
    expect(readRecapTipFields(REPORT, now)).toEqual({
      overview: '\u91cd\u505a composer \u5e03\u5c40\uff0c\u8ba9\u6eda\u52a8\u6761\u6b62\u4e8e\u6700\u540e\u4e00\u884c\uff1b\u4fee\u590d\u5df2\u63d0\u4ea4\u3002',
      overviewAt: now.toISOString(),
      recap: '\u5df2\u90e8\u7f72\u5230 3456\uff0cWebKit \u4e0e Chromium \u9a8c\u8bc1\u901a\u8fc7\u3002',
      recapAt: now.toISOString(),
    });
  });

  it('OVERVIEW does not swallow RECAP (RECAP is a field terminator) and vice versa', () => {
    expect(extractField(REPORT, 'OVERVIEW')).not.toContain('RECAP');
    expect(extractField(REPORT, 'RECAP')).not.toContain('PHASE_SIGNAL');
    // A multi-line overview still stops at the next label.
    const wrapped = 'OVERVIEW: line one\nline two\nRECAP: just now';
    expect(readRecapTipFields(wrapped, now)).toMatchObject({ overview: 'line one line two', recap: 'just now' });
  });

  it('a report from before OVERVIEW existed refreshes the recap alone', () => {
    const old = 'EXEC_SUMMARY: x\nRECAP: Fixed the timeout bug.\nPHASE_SIGNAL: implement-done';
    const patch = readRecapTipFields(old, now);
    expect(patch).toEqual({ recap: 'Fixed the timeout bug.', recapAt: now.toISOString() });
    expect(patch).not.toHaveProperty('overview');
  });

  it('`unchanged` (which the prompt forbids), bare or hedged, never overwrites stored text; nothing usable gives null', () => {
    expect(readRecapTipFields('OVERVIEW: unchanged\nRECAP: New text.', now))
      .toEqual({ recap: 'New text.', recapAt: now.toISOString() });
    expect(readRecapTipFields('OVERVIEW: unchanged.\nRECAP: Unchanged', now)).toBeNull();
    expect(readRecapTipFields('OVERVIEW: Unchanged from last turn.\nRECAP: unchanged - still the scrollbar work', now)).toBeNull();
    // A sentence that merely starts with the letters is not the sentinel.
    expect(readRecapTipFields('RECAP: Unchangedness is not a word, but this is a recap.', now))
      .toEqual({ recap: 'Unchangedness is not a word, but this is a recap.', recapAt: now.toISOString() });
    expect(readRecapTipFields('RECAP: The unchanged files were skipped.', now))
      .toEqual({ recap: 'The unchanged files were skipped.', recapAt: now.toISOString() });
    expect(readRecapTipFields('EXEC_SUMMARY: only the note', now)).toBeNull();
    expect(readRecapTipFields('', now)).toBeNull();
  });

  it('collapses whitespace and caps each field at 300 chars without splitting a surrogate pair', () => {
    const long = 'x'.repeat(400);
    const patch = readRecapTipFields(`OVERVIEW:   a\n\n  b \t c\nRECAP: ${long}`, now)!;
    expect(patch.overview).toBe('a b c');
    expect(patch.recap).toHaveLength(300);
    // 299 ASCII chars then an astral emoji (two UTF-16 units): a blind slice(0, 300)
    // would keep only its high half.
    const rocket = '\u{1F680}';
    const edge = readRecapTipFields(`RECAP: ${'y'.repeat(299)}${rocket}tail`, now)!;
    expect(edge.recap).toBe('y'.repeat(299));
    expect(edge.recap.length).toBeLessThanOrEqual(300);
  });
});
