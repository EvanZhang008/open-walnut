/**
 * Saving from the WYSIWYG editor keeps the file's own bytes on every line the user
 * did not edit. The 2026-11-07 review: one typed sentence in a 153-line note
 * changed 24 other lines (`|---|` became `| --- |`, `#` became `\#`, `~` became
 * `\~`, a blank line went, the final newline went). `normalized` below is what the
 * serializer makes of `original`; `current` is that plus the user's edit.
 */
import { describe, it, expect } from 'vitest';
import { keepUntouchedSource } from '../../web/src/utils/markdown-keep-source';

const original = [
  '# Ledger', '', '| # | Problem |', '|---|---|', '| 1 | `~/.codex/config` drift |', '',
  'Rule: a row is Proven only with a test.', '', '', '- one', '- two', '',
].join('\n');
const normalized = [
  '# Ledger', '', '| \\# | Problem |', '| --- | --- |', '| 1 | `~/.codex/config` drift |', '',
  'Rule: a row is Proven only with a test.', '', '- one', '- two',
].join('\n');

describe('keepUntouchedSource', () => {
  it('an untouched document is the original bytes', () => {
    expect(keepUntouchedSource(original, normalized, normalized)).toBe(original);
  });

  it('one typed sentence changes that line only', () => {
    const current = normalized.replace('only with a test.', 'only with a test. Checked by hand.');
    const kept = keepUntouchedSource(original, normalized, current);
    expect(kept).toBe(original.replace('only with a test.', 'only with a test. Checked by hand.'));
  });

  it('an edit inside a line the serializer also rewrote keeps the edit and the rest of the line', () => {
    const current = normalized.replace('| \\# | Problem |', '| \\# | Problems |');
    const kept = keepUntouchedSource(original, normalized, current);
    expect(kept.split('\n')[2]).toBe('| # | Problems |');
    expect(kept.split('\n')[3]).toBe('|---|---|');
  });

  it('a new block and a deleted block both land, the rest stays byte for byte', () => {
    const current = normalized.replace('- one\n- two', '- one\n- two\n- three').replace('# Ledger\n\n', '# Ledger\n\nIntro.\n\n');
    const kept = keepUntouchedSource(original, normalized, current);
    expect(kept).toContain('Intro.');
    expect(kept).toContain('- three');
    expect(kept).toContain('|---|---|');
    expect(kept.endsWith('\n')).toBe(true);
  });

  it('a file the serializer leaves alone is written as the editor has it', () => {
    expect(keepUntouchedSource('a\n', 'a\n', 'a b\n')).toBe('a b\n');
  });
});
