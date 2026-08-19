/**
 * Parsing a path REFERENCE as written — decoration off, position out.
 *
 * Every case here is a shape a real path arrives in (prose, grep output, a compiler
 * error, a GitHub link, a Windows paste). Before this parser existed each one made
 * the resolver search for the DECORATED string and miss a file that was right
 * there, so these are regression pins, not hypotheticals.
 */
import { describe, it, expect } from 'vitest';

const { parsePathRef, isUnsafePathRef } = await import('../../src/providers/path-ref-parse.js');

describe('position suffixes', () => {
  it.each([
    ['src/a.ts:42', 'src/a.ts', { line: 42 }],
    ['src/a.ts:42:7', 'src/a.ts', { line: 42, column: 7 }],
    ['src/a.ts:L42', 'src/a.ts', { line: 42 }],
    ['src/a.ts#L42', 'src/a.ts', { line: 42 }],
    ['src/a.ts#42', 'src/a.ts', { line: 42 }],
    ['src/a.ts:10-20', 'src/a.ts', { line: 10, endLine: 20 }],
    ['src/a.ts#L10-L20', 'src/a.ts', { line: 10, endLine: 20 }],
    ['src/a.ts#L10-20', 'src/a.ts', { line: 10, endLine: 20 }],
    ['src/a.ts(42)', 'src/a.ts', { line: 42 }],
    ['src/a.ts(42,7)', 'src/a.ts', { line: 42, column: 7 }],
    ['src/a.ts, line 42', 'src/a.ts', { line: 42 }],
  ])('%j → %j', (raw, wantPath, wantPos) => {
    const got = parsePathRef(raw);
    expect(got.path).toBe(wantPath);
    expect({ line: got.line, column: got.column, endLine: got.endLine })
      .toMatchObject(wantPos);
  });

  it('leaves a path with no position alone', () => {
    const got = parsePathRef('src/a.ts');
    expect(got).toEqual({ path: 'src/a.ts' });
  });

  it('does not mistake a version-ish segment for a line number', () => {
    // The digits are not at the very end, so no position pattern applies.
    expect(parsePathRef('pkg/v2/mod.go').path).toBe('pkg/v2/mod.go');
  });
});

describe('wrappers and prose noise', () => {
  it.each([
    ['`src/a.ts`', 'src/a.ts'],
    ['"src/a.ts"', 'src/a.ts'],
    ["'src/a.ts'", 'src/a.ts'],
    ['<src/a.ts>', 'src/a.ts'],
    ['(src/a.ts)', 'src/a.ts'],
    ['[src/a.ts]', 'src/a.ts'],
    ['`"src/a.ts"`', 'src/a.ts'],
    ['src/a.ts.', 'src/a.ts'],
    ['src/a.ts,', 'src/a.ts'],
    ['src/a.ts;', 'src/a.ts'],
    ['src/a.ts?', 'src/a.ts'],
    ['- src/a.ts', 'src/a.ts'],
    ['* src/a.ts', 'src/a.ts'],
    ['  src/a.ts  ', 'src/a.ts'],
    ['`src/a.ts:42`', 'src/a.ts'],
  ])('%j → %j', (raw, want) => {
    expect(parsePathRef(raw).path).toBe(want);
  });

  it('keeps a position found inside wrappers', () => {
    expect(parsePathRef('`src/a.ts:42`')).toMatchObject({ path: 'src/a.ts', line: 42 });
  });

  it('does not strip a lone leading quote that has no partner', () => {
    // Unbalanced: stripping would corrupt a legitimately odd filename.
    expect(parsePathRef('"src/a.ts').path).toBe('"src/a.ts');
  });
});

describe('separators', () => {
  it('converts Windows separators', () => {
    expect(parsePathRef('src\\web\\a.ts').path).toBe('src/web/a.ts');
  });

  it('collapses duplicate slashes', () => {
    expect(parsePathRef('src//web///a.ts').path).toBe('src/web/a.ts');
  });

  it('drops a trailing slash but keeps root', () => {
    expect(parsePathRef('src/web/').path).toBe('src/web');
    expect(parsePathRef('/').path).toBe('/');
  });

  it('preserves a leading ./ (explicitly cwd-relative)', () => {
    expect(parsePathRef('./src/a.ts').path).toBe('./src/a.ts');
  });
});

describe('names that only LOOK dangerous', () => {
  it('accepts a segment containing dots that is not traversal', () => {
    // The old substring check rejected this outright, making the file unreachable.
    expect(isUnsafePathRef('pkg/mod..old/thing.ts')).toBe(false);
    expect(isUnsafePathRef('a/...hidden/b.ts')).toBe(false);
    expect(isUnsafePathRef('a/..b/c.ts')).toBe(false);
  });

  it('still rejects a real traversal segment anywhere in the path', () => {
    expect(isUnsafePathRef('../escape.ts')).toBe(true);
    expect(isUnsafePathRef('a/../b.ts')).toBe(true);
    expect(isUnsafePathRef('a/b/..')).toBe(true);
    expect(isUnsafePathRef('..')).toBe(true);
  });

  it('rejects shell metacharacters, NUL, empty, and absurd length', () => {
    for (const bad of ['a/$(id)/b', 'a/`id`/b', 'a;rm -rf /', 'a|b', 'a&b', 'a\nb', 'a\0b', '']) {
      expect(isUnsafePathRef(bad)).toBe(true);
    }
    expect(isUnsafePathRef('a'.repeat(5000))).toBe(true);
  });
});

describe('degenerate input', () => {
  it.each([['', ''], ['   ', ''], ['``', ''], ['.', ''], ['...', '']])(
    'survives %j', (raw, want) => {
      // Never throws; the resolver's safety check decides what to do next.
      expect(parsePathRef(raw).path).toBe(want);
    },
  );

  it('returns an empty path for a non-string', () => {
    expect(parsePathRef(undefined as unknown as string).path).toBe('');
  });
});

describe('parsing can never LAUNDER an unsafe reference', () => {
  /**
   * The invariant: if the raw reference is unsafe, the parsed one must be too.
   *
   * Parsing exists to remove decoration, and decoration removal is exactly the
   * mechanism by which a dangerous reference could be made to look clean. `a/b/..`
   * was a real instance: trailing-noise trimming ate the dots, the safety check
   * then saw `a/b` and passed it. Asserted over a generated matrix rather than a
   * hand-list, because the next instance will be a shape nobody thought of.
   */
  const SEGMENTS = ['..', '...', 'a', '.env', 'mod..old', '.', ''];
  const DECORATIONS = [
    (s: string) => s,
    (s: string) => '`' + s + '`',
    (s: string) => '"' + s + '"',
    (s: string) => '(' + s + ')',
    (s: string) => '<' + s + '>',
    (s: string) => s + '.',
    (s: string) => s + ',',
    (s: string) => s + ':42',
    (s: string) => s + '#L42',
    (s: string) => s + '/',
    (s: string) => s + '//',
    (s: string) => '- ' + s,
    (s: string) => '  ' + s + '  ',
    (s: string) => s.replace(/\//g, '\\'),
    (s: string) => s.replace(/\//g, '//'),
  ];

  // Every 1- to 3-segment combination, wrapped every way.
  const refs: string[] = [];
  for (const a of SEGMENTS) {
    refs.push(a);
    for (const b of SEGMENTS) {
      refs.push(`${a}/${b}`);
      for (const c of SEGMENTS) refs.push(`${a}/${b}/${c}`);
    }
  }

  it('holds over the generated matrix', () => {
    // The property is about ESCAPE, not about decoration. A wrapper character is
    // itself harmless — `isUnsafePathRef` bans metacharacters as defense in depth,
    // so a raw string containing a backtick is "unsafe" while its unwrapped form is
    // legitimately fine. Laundering only matters for the one thing parsing must
    // never dissolve: a `..` segment that escapes the tree.
    const escapes = (s: string) => s.split(/[/\\]/).some((seg) => seg === '..');
    const leaks: string[] = [];
    for (const base of refs) {
      for (const decorate of DECORATIONS) {
        const raw = decorate(base);
        if (!escapes(raw)) continue;            // nothing to launder
        const parsed = parsePathRef(raw).path;
        if (parsed === '') continue;            // nothing to resolve
        if (!isUnsafePathRef(parsed)) leaks.push(`${JSON.stringify(raw)} -> ${JSON.stringify(parsed)}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('rejects a traversal that only appears after separator collapsing', () => {
    // `a/..//b` and `a\..\b` must be as unsafe as `a/../b`.
    for (const raw of ['a/..//b.ts', 'a\\..\\b.ts', 'a//../b.ts', './../b.ts']) {
      const parsed = parsePathRef(raw).path;
      expect(isUnsafePathRef(parsed), `${raw} → ${parsed}`).toBe(true);
    }
  });
});
