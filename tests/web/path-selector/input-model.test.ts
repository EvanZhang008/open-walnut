/**
 * Unit tests for the session path selector's four-state input classifier
 * and path editing helpers (pure functions, no IO).
 */
import { describe, it, expect } from 'vitest';
import {
  classifyInput,
  resolveSpaceAmbiguity,
  deleteLastSegment,
  parentDirOf,
  ghostSuffix,
  pathValidity,
} from '../../../web/src/components/sessions/path-selector/input-model';

describe('classifyInput — four states', () => {
  it('non-path input → browse', () => {
    expect(classifyInput('walnut')).toEqual({ kind: 'browse', query: 'walnut' });
    expect(classifyInput('')).toEqual({ kind: 'browse', query: '' });
    expect(classifyInput('some words here')).toEqual({ kind: 'browse', query: 'some words here' });
  });

  it('trailing slash → dir-browse', () => {
    expect(classifyInput('/a/b/c/')).toEqual({ kind: 'dir-browse', dir: '/a/b/c/' });
    expect(classifyInput('~/')).toEqual({ kind: 'dir-browse', dir: '~/' });
    expect(classifyInput('/')).toEqual({ kind: 'dir-browse', dir: '/' });
  });

  it('no trailing slash → segment completion', () => {
    expect(classifyInput('/a/b/c')).toEqual({ kind: 'segment', dir: '/a/b/', partial: 'c' });
    expect(classifyInput('~/.cl')).toEqual({ kind: 'segment', dir: '~/', partial: '.cl' });
    expect(classifyInput('/x')).toEqual({ kind: 'segment', dir: '/', partial: 'x' });
  });

  it('path + space + keyword → scoped-search', () => {
    expect(classifyInput('/a/b keyword')).toEqual({ kind: 'scoped-search', base: '/a/b/', keyword: 'keyword' });
    expect(classifyInput('/a/b/ keyword')).toEqual({ kind: 'scoped-search', base: '/a/b/', keyword: 'keyword' });
  });

  it('keyword containing / is NOT a keyword — whole string treated as path', () => {
    // "b c/d" — token after the last space contains '/', so path interpretation wins
    const state = classifyInput('/a/b c/d');
    expect(state.kind).toBe('segment');
  });

  it('trailing space alone does not create a scoped search', () => {
    const state = classifyInput('/a/b ');
    // empty keyword → not scoped-search
    expect(state.kind).not.toBe('scoped-search');
  });
});

describe('resolveSpaceAmbiguity', () => {
  it('literal child matching "b keyword" flips to dir-browse', () => {
    const state = classifyInput('/a/b my dir');
    expect(state.kind).toBe('scoped-search');
    const resolved = resolveSpaceAmbiguity(state, ['/a/b my dir']);
    expect(resolved.kind).toBe('dir-browse');
  });

  it('child extending the spaced string flips to segment (mid-typing)', () => {
    const state = classifyInput('/a/b my d');
    const resolved = resolveSpaceAmbiguity(state, ['/a/b my dir']);
    expect(resolved.kind).toBe('segment');
    if (resolved.kind === 'segment') {
      expect(resolved.partial).toBe('b my d');
    }
  });

  it('no matching child → stays scoped-search', () => {
    const state = classifyInput('/a/b keyword');
    const resolved = resolveSpaceAmbiguity(state, ['/a/b/other', '/a/b/thing']);
    expect(resolved).toBe(state);
  });

  it('non-scoped-search states pass through', () => {
    const state = classifyInput('/a/b/c');
    expect(resolveSpaceAmbiguity(state, ['/a/b/x'])).toBe(state);
  });
});

describe('deleteLastSegment (Cmd+Backspace)', () => {
  it('deletes the last segment keeping trailing slash', () => {
    expect(deleteLastSegment('/a/b/c')).toBe('/a/b/');
    expect(deleteLastSegment('/a/b/c/')).toBe('/a/b/');
  });
  it('edge cases: root, home, single segment', () => {
    expect(deleteLastSegment('/')).toBe('/');
    expect(deleteLastSegment('/a')).toBe('/');
    expect(deleteLastSegment('~/x')).toBe('~/');
    expect(deleteLastSegment('~')).toBe('');
    expect(deleteLastSegment('')).toBe('');
  });
});

describe('parentDirOf', () => {
  it('maps each state to its live-listing target', () => {
    expect(parentDirOf(classifyInput('walnut'))).toBeNull();
    expect(parentDirOf(classifyInput('/a/b/'))).toBe('/a/b/');
    expect(parentDirOf(classifyInput('/a/b/c'))).toBe('/a/b/');
    expect(parentDirOf(classifyInput('/a/b kw'))).toBe('/a/b/');
  });
});

describe('ghostSuffix', () => {
  it('returns the suffix when top candidate leaf prefix-extends the partial', () => {
    const state = classifyInput('/a/b/wal');
    expect(ghostSuffix(state, '/a/b/walnut')).toBe('nut');
  });
  it('case-insensitive prefix, original casing returned', () => {
    const state = classifyInput('/a/b/mar');
    expect(ghostSuffix(state, '/a/b/Marina')).toBe('ina');
  });
  it('no ghost when leaf does not prefix-extend (fuzzy-only hit)', () => {
    const state = classifyInput('/a/b/ina');
    expect(ghostSuffix(state, '/a/b/Marina')).toBeNull();
  });
  it('no ghost with empty partial or non-segment states', () => {
    expect(ghostSuffix(classifyInput('/a/b/'), '/a/b/walnut')).toBeNull();
    expect(ghostSuffix(classifyInput('walnut'), '/a/b/walnut')).toBeNull();
  });
  it('no ghost when candidate is null or leaf equals partial', () => {
    const state = classifyInput('/a/b/walnut');
    expect(ghostSuffix(state, null)).toBeNull();
    expect(ghostSuffix(state, '/a/b/walnut')).toBeNull();
  });
});

describe('pathValidity', () => {
  const done = (parent: string, dirs: string[], exists = true) =>
    ({ status: 'done' as const, parent, exists, dirs });
  const loading = { status: 'loading' as const, parent: '', exists: true, dirs: [] };
  const errored = { status: 'error' as const, parent: '', exists: true, dirs: [] };

  it('segment: exact child on a settled host → valid', () => {
    const state = classifyInput('/a/b/walnut');
    expect(pathValidity(state, [done('/a/b/', ['/a/b/walnut', '/a/b/wallets'])])).toBe('valid');
  });

  it('segment: all hosts settled, no exact child → missing (prefix sibling does not count)', () => {
    const state = classifyInput('/a/b/waln');
    expect(pathValidity(state, [done('/a/b/', ['/a/b/walnut'])])).toBe('missing');
  });

  it('segment: strict case compare — differently-cased child is missing', () => {
    const state = classifyInput('/a/b/Walnut');
    expect(pathValidity(state, [done('/a/b/', ['/a/b/walnut'])])).toBe('missing');
  });

  it('dir-browse: exists flag decides', () => {
    expect(pathValidity(classifyInput('/a/b/'), [done('/a/b/', [])])).toBe('valid');
    expect(pathValidity(classifyInput('/a/nope/'), [done('', [], false)])).toBe('missing');
  });

  it('any host still loading and no confirm yet → unknown (never block)', () => {
    const state = classifyInput('/a/b/walnut');
    expect(pathValidity(state, [loading])).toBe('unknown');
    expect(pathValidity(state, [loading, done('/a/b/', [])])).toBe('unknown');
  });

  it('one valid host wins even while others load or error', () => {
    const state = classifyInput('/a/b/walnut');
    expect(pathValidity(state, [loading, done('/a/b/', ['/a/b/walnut'])])).toBe('valid');
    expect(pathValidity(state, [errored, done('/a/b/', ['/a/b/walnut'])])).toBe('valid');
  });

  it('only errored hosts (host down) → unknown, not missing', () => {
    const state = classifyInput('/a/b/walnut');
    expect(pathValidity(state, [errored])).toBe('unknown');
    expect(pathValidity(state, [])).toBe('unknown');
  });

  it('browse and scoped-search have no path verdict', () => {
    expect(pathValidity(classifyInput('walnut'), [done('/', ['/x'])])).toBe('unknown');
    expect(pathValidity(classifyInput('/a/b kw'), [done('/a/b/', [])])).toBe('unknown');
  });
});
