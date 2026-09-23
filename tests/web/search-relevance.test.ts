import { describe, expect, it } from 'vitest';
import {
  queryTerms,
  serverRowShowsQuery,
  splitRelatedMatches,
  taskMatchesLiterally,
} from '../../web/src/components/tasks/search-relevance';

const row = (id: string) => ({ id });

describe('taskMatchesLiterally', () => {
  it('matches a substring of the title, project or a tag, case-insensitively', () => {
    expect(taskMatchesLiterally({ title: 'Release Gate QX2 review' }, 'qx2')).toBe(true);
    expect(taskMatchesLiterally({ title: 'Plain', project: 'Marina QX2' }, 'qx2')).toBe(true);
    expect(taskMatchesLiterally({ title: 'Plain', tags: ['ops', 'QX2-gate'] }, 'qx2')).toBe(true);
    expect(taskMatchesLiterally({ title: 'Plain', project: 'Marina', tags: ['ops'] }, 'qx2')).toBe(false);
  });
});

describe('queryTerms', () => {
  it('splits on whitespace, lowercases, and drops one-character noise', () => {
    expect(queryTerms('  Dock  Gate a ')).toEqual(['dock', 'gate']);
    expect(queryTerms('QX2')).toEqual(['qx2']);
  });
  it('keeps short terms when nothing else is left (and CJK stays one term)', () => {
    expect(queryTerms('a b')).toEqual(['a', 'b']);
    // A CJK query has no spaces: it stays one term (test data, escaped).
    expect(queryTerms('\u6e2f\u53e3\u8c03\u5ea6')).toEqual(['\u6e2f\u53e3\u8c03\u5ea6']);
    expect(queryTerms('   ')).toEqual([]);
  });
});

describe('serverRowShowsQuery', () => {
  it('is evidence when every term appears in the title or the snippet', () => {
    expect(serverRowShowsQuery({ title: 'Nightly job', snippet: '...then QX2 waits for the gate...' }, ['qx2'])).toBe(true);
    expect(serverRowShowsQuery({ title: 'Dock gate review', snippet: '' }, ['dock', 'gate'])).toBe(true);
    expect(serverRowShowsQuery({ title: 'Dock', snippet: '...the gate opened...' }, ['dock', 'gate'])).toBe(true);
  });
  it('is not evidence for a look-alike (the reported noise)', () => {
    // A semantic neighbour: shares letters and a digit, never the typed token.
    expect(serverRowShowsQuery({ title: 'QX v2 pipeline readiness', snippet: 'QX v2 pipeline readiness' }, ['qx2'])).toBe(false);
    expect(serverRowShowsQuery({ title: 'Dock only', snippet: '' }, ['dock', 'gate'])).toBe(false);
    expect(serverRowShowsQuery({}, ['qx2'])).toBe(false);
    expect(serverRowShowsQuery({ title: 'anything' }, [])).toBe(false);
  });
  it('treats an identifier hit as evidence whatever its text', () => {
    for (const matchField of ['id', 'session_id', 'commit_sha', 'external_url']) {
      expect(serverRowShowsQuery({ title: 'Unrelated', matchField }, ['abc123'])).toBe(true);
    }
    expect(serverRowShowsQuery({ title: 'Unrelated', matchField: 'child' }, ['abc123'])).toBe(false);
  });
});

describe('splitRelatedMatches', () => {
  it('keeps order inside both parts', () => {
    const list = ['lit1', 'lit2', 'strong', 'weak1', 'weak2'].map(row);
    const { primary, related } = splitRelatedMatches(list, new Set(['weak2', 'weak1']));
    expect(primary.map((t) => t.id)).toEqual(['lit1', 'lit2', 'strong']);
    expect(related.map((t) => t.id)).toEqual(['weak1', 'weak2']);
  });

  it('shows the weak hits directly when nothing strong is left', () => {
    const { primary, related } = splitRelatedMatches(['w1', 'w2'].map(row), new Set(['w1', 'w2']));
    expect(primary.map((t) => t.id)).toEqual(['w1', 'w2']);
    expect(related).toEqual([]);
  });

  it('is a copy when nothing is weak', () => {
    const list = [row('a')];
    const { primary } = splitRelatedMatches(list, new Set());
    expect(primary).toEqual(list);
    expect(primary).not.toBe(list);
  });
});
