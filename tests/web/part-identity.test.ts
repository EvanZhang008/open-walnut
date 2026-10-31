/**
 * PartIdentity keeps what the history-parts pass mints stable from pass to pass,
 * so a page of older rows re-renders only the new rows (part-identity.ts).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PartIdentity } from '../../web/src/components/sessions/part-identity';

describe('PartIdentity', () => {
  it('gives back what it derived for the same row, kind and inputs', () => {
    const ids = new PartIdentity();
    const row = { text: 'a' };
    const before = { thinking: 'b' };
    let made = 0;
    const make = () => { made++; return { ...row, thinking: before.thinking }; };
    const first = ids.derive(row, 'after-thinking', [before], make);
    expect(ids.derive(row, 'after-thinking', [before], make)).toBe(first);
    expect(made).toBe(1);
  });

  it('derives again when an input or the row is another object', () => {
    const ids = new PartIdentity();
    const row = { text: 'a' };
    const first = ids.derive(row, 'k', [{ v: 1 }], () => ({ n: 1 }));
    expect(ids.derive(row, 'k', [{ v: 1 }], () => ({ n: 2 }))).not.toBe(first);
    const other = ids.derive({ text: 'a' }, 'k', [], () => ({ n: 3 }));
    expect(other).toEqual({ n: 3 });
  });

  it('keeps kinds of one row apart', () => {
    const ids = new PartIdentity();
    const row = {};
    const a = ids.derive(row, 'reasoning', [], () => ({ a: 1 }));
    const b = ids.derive(row, 'answer', [], () => ({ b: 1 }));
    expect(a).not.toBe(b);
    expect(ids.derive(row, 'reasoning', [], () => ({ a: 2 }))).toBe(a);
  });

  it('shares a list only while every item is the same object, in order', () => {
    const ids = new PartIdentity();
    const r1 = {}; const r2 = {}; const r3 = {};
    const first = ids.list('run', [r1, r2]);
    expect(ids.list('run', [r1, r2])).toBe(first);
    expect(ids.list('run', [r1, r2, r3])).not.toBe(first);
    expect(ids.list('run', [r2, r1])).toEqual([r2, r1]);
    expect(ids.list('run', [])).toEqual([]);
  });

  it('a page of older rows leaves the runs already built untouched', () => {
    // The pass runs once per page; the rows below the new page are the same objects.
    const ids = new PartIdentity();
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: i }));
    const runsOf = (from: number) => {
      const out: object[][] = [];
      for (let i = from; i < rows.length; i += 2) out.push(ids.list('run', [rows[i], rows[i + 1]]));
      return out;
    };
    const tail = runsOf(2);
    const paged = runsOf(0);
    expect(paged.slice(1)).toEqual(tail);
    paged.slice(1).forEach((run, i) => expect(run).toBe(tail[i]));
  });
});

describe('the history-parts pass mints nothing outside PartIdentity', () => {
  // A new object or array a memoized row receives, minted in the pass without
  // PartIdentity, re-renders that row on every page (and every streaming frame).
  const src = fs.readFileSync(path.join(__dirname, '../../web/src/components/sessions/SessionChatHistory.tsx'), 'utf8');
  const start = src.indexOf('const { historyParts, hiddenCount } = useMemo(() => {');
  const end = src.indexOf('return { historyParts: parts, hiddenCount: visibleStart };', start);
  const body = src.slice(start, end);

  it('finds the pass', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it('every row clone goes through ids.derive', () => {
    // Each object spread in the pass (`{ ...x`, `{ a, ...x }`) sits inside an
    // `ids.derive(` call on its line, except a part wrapper pushed to `parts`:
    // the part itself is no row's prop, only its rows are.
    const spreads = body.split('\n').filter((line) => /[{,]\s*\.\.\.[\w(]/.test(line) && !line.includes('[...'));
    expect(spreads.length).toBeGreaterThan(0);
    for (const line of spreads) {
      if (/^\s*parts\.push\(\{ kind: '[a-z-]+', \.\.\./.test(line)) continue;
      expect(line, line.trim()).toMatch(/ids\.derive\(/);
    }
    expect(body, 'clone rows with a spread inside ids.derive').not.toMatch(/Object\.assign\(|structuredClone\(/);
  });

  it('every row helper that builds a new object goes through ids.derive', () => {
    for (const fn of ['mergeThinkingOnly(', 'systemGroupMemberFromHistory(']) {
      const lines = body.split('\n').filter((line) => line.includes(fn));
      expect(lines.length, fn).toBeGreaterThan(0);
      for (const line of lines) expect(line, line.trim()).toMatch(/ids\.derive\(/);
    }
  });

  it('every run and system group array is shared through ids.list', () => {
    expect(body).toMatch(/part\.memberMsgs = ids\.list\('run', part\.memberMsgs\)/);
    expect(body).toMatch(/systemMembers: ids\.list\('system', systemMembers\)/);
  });
});
