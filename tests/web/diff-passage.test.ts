/**
 * The Changed tab's Ask here takes only passages that are in the current file
 * (utils/diff-passage.ts). The DOM half runs in the browser specs
 * (files-changed-ask-here.spec.ts); this is the pure check behind it.
 */
import { describe, it, expect } from 'vitest';
import { DIFF_ASK_OFF_REASON, DIFF_CHROME_SKIP, DIFF_FILE_TEXT_SKIP, occursInFile } from '@/utils/diff-passage';

describe('occursInFile', () => {
  const file = 'package marina\n\n// registerResources wires the informers.\nfunc run() {\n\treturn\n}\n';
  it('finds a passage across lines: the diff index joins lines without their breaks', () => {
    expect(occursInFile('// registerResources wires the informers.func run() {', file)).toBe(true);
    expect(occursInFile('wires the informers.', file)).toBe(true);
  });
  it('refuses text that is not in the file (a removed line, lines joined across hidden ones)', () => {
    expect(occursInFile('wires informers.', file)).toBe(false);
    expect(occursInFile('package marinafunc run()', file)).toBe(false);
  });
  it('refuses a blank passage', () => {
    expect(occursInFile('  \n\t', file)).toBe(false);
  });
});

describe('what the diff index skips', () => {
  it('the file index skips all the chrome search skips, plus removed lines and the old copy of a split line', () => {
    const skip = DIFF_FILE_TEXT_SKIP as { selector: string; text?: unknown }
    for (const sel of DIFF_CHROME_SKIP.split(',').map((x) => x.trim())) expect(skip.selector).toContain(sel);
    expect(skip.selector).toContain('.diff-code-delete');
    expect(skip.selector).toContain('.diff-line-normal > td.diff-code:not(:last-child)');
    // ...and a blank line's one-space filler, which no selector can name.
    expect(typeof skip.text).toBe('function');
  });
  it('every reason a selection has no Ask here says to quote it instead', () => {
    for (const text of Object.values(DIFF_ASK_OFF_REASON)) expect(text).toMatch(/quote/);
  });
});
