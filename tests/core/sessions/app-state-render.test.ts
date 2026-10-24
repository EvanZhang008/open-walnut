import { describe, expect, it } from 'vitest';
import { inline, pathLabel, renderChanges, renderFull, textPatch } from '../../../src/core/sessions/app-state-render.js';

const code = (n: number, changed?: { line: number; text: string }) =>
  Array.from({ length: n }, (_, i) => (changed && changed.line === i ? changed.text : `line ${i}`)).join('\n');

describe('app state rendering', () => {
  it('names paths a model can read: dots for identifiers, quoted brackets for the rest', () => {
    expect(pathLabel(['lastRun', 'passed'])).toBe('lastRun.passed');
    expect(pathLabel(['files', 'solution.py'])).toBe('files["solution.py"]');
    expect(pathLabel(['a b', '1'])).toBe('["a b"]["1"]');
  });

  it('keeps a number-looking string a string, and cuts a long inline value', () => {
    expect(inline('3')).toBe('"3"');
    expect(inline(3)).toBe('3');
    expect(inline(null)).toBe('null');
    const long = inline(Array.from({ length: 200 }, (_, i) => i));
    expect(long.length).toBe(300);
    expect(long.endsWith('…')).toBe(true);
  });

  it('renders the whole object with nesting and text blocks', () => {
    const text = renderFull({ question: 'merge-intervals', level: 2, lastRun: { passed: 5, total: 7 }, files: { 'solution.py': 'def f():\n    return 1' }, empty: {} });
    expect(text).toBe([
      'question: "merge-intervals"',
      'level: 2',
      'lastRun:',
      '  passed: 5',
      '  total: 7',
      'files:',
      '  "solution.py": |',
      '    def f():',
      '        return 1',
      'empty: {}',
    ].join('\n'));
  });

  it('lists only what changed: changed, new and removed values, nothing for an unchanged one', () => {
    const changes = renderChanges(
      { level: 2, hints: 0, lastRun: { passed: 5, failing: ['touching'] }, draft: 'x' },
      { level: 3, hints: 0, lastRun: { passed: 7, failing: [] }, finished: true },
    );
    expect(changes.lines).toEqual([
      'level: 2 → 3',
      'lastRun.passed: 5 → 7',
      'lastRun.failing: ["touching"] → []',
      'finished: (new) true',
      'draft: (removed)',
    ]);
    expect(changes.count).toBe(5);
    expect(renderChanges({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } }).lines).toEqual([]);
  });

  it('a one-line edit in a long file costs a small patch, not the file', () => {
    const before = code(300);
    const after = code(300, { line: 150, text: '    if start <= last_end:' });
    const changes = renderChanges({ files: { 'solution.py': before } }, { files: { 'solution.py': after } });
    expect(changes.lines[0]).toBe('files["solution.py"]: changed');
    expect(changes.lines).toContain('  -line 150');
    expect(changes.lines).toContain('  +    if start <= last_end:');
    expect(changes.lines.length).toBeLessThan(10);
  });

  it('a rewrite too big to patch shows the new text instead', () => {
    const before = code(200);
    const after = Array.from({ length: 200 }, (_, i) => `other ${i}`).join('\n');
    expect(textPatch(before, after)).toBeNull();
    const changes = renderChanges({ t: before }, { t: after });
    expect(changes.lines[0]).toBe('t: now |');
    expect(changes.lines[1]).toBe('  other 0');
  });

  it('text that appears or turns from a scalar into text is shown whole', () => {
    expect(renderChanges({}, { t: 'a\nb' }).lines).toEqual(['t: (new) |', '  a', '  b']);
    expect(renderChanges({ t: 1 }, { t: 'a\nb' }).lines).toEqual(['t: now |', '  a', '  b']);
    expect(renderChanges({ t: 'a\nb' }, { t: 2 }).lines).toEqual(['t: (text) → 2']);
  });

  it('non-ASCII text survives both forms', () => {
    const name = 'caf\u00e9 \u4f60\u597d';
    expect(renderFull({ name })).toBe(`name: ${JSON.stringify(name)}`);
    expect(renderChanges({ name: 'x' }, { name }).lines).toEqual([`name: "x" → ${JSON.stringify(name)}`]);
  });
});
