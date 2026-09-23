import { describe, expect, it } from 'vitest';
import {
  arrangeSearchResults,
  INLINE_COMPLETED_HITS,
  queryTerms,
  serverRowShowsQuery,
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

describe('arrangeSearchResults', () => {
  // A row id reads: l = literal (quick lane) / s = server only; o = open / d = done;
  // a trailing x = no evidence of the query; digits after "d" = completion day; a "p"
  // = the query sits deep in a long title.
  const facts = {
    isOpen: (t: { id: string }) => t.id[1] === 'o',
    isLiteral: (t: { id: string }) => t.id.startsWith('l'),
    showsQuery: (t: { id: string }) => !t.id.endsWith('x'),
    titlePosition: (t: { id: string }) => (t.id.includes('p') ? 90 : 0),
    completedAt: (t: { id: string }) => (t.id[1] === 'd' ? `2026-09-${t.id.slice(2, 4)}` : undefined),
  };
  const ids = (list: { id: string }[]) => list.map((t) => t.id);
  const ranked = ['ld05', 'lo1', 'sd07', 'so2', 'sd08x', 'so3x', 'lo4'].map(row);

  it('shows open literal hits, then completed title hits, then open server hits; folds the rest', () => {
    const { primary, completed, related, looseDone } = arrangeSearchResults(ranked, facts, false);
    expect(ids(primary)).toEqual(['lo1', 'lo4', 'ld05', 'so2']);
    expect(ids(completed)).toEqual(['sd07']);
    expect(ids(related)).toEqual(['so3x']);
    expect(looseDone).toBe(1);
  });

  it('keeps the most recently completed title hits inline and folds the older ones', () => {
    const many = ['lo1', 'ld01', 'ld09', 'ld03', 'ld12', 'ld07'].map(row);
    const { primary, completed } = arrangeSearchResults(many, facts, false);
    expect(INLINE_COMPLETED_HITS).toBe(3);
    expect(ids(primary)).toEqual(['lo1', 'ld12', 'ld09', 'ld07']);
    expect(ids(completed)).toEqual(['ld03', 'ld01']);
  });

  it('ranks a completed title that starts with the query above a long one that merely contains it', () => {
    // Real data: dozens of auto-completed imports whose title is a pasted prompt.
    const noisy = ['ld20p', 'ld21p', 'ld22p', 'ld02', 'ld01'].map(row);
    const { primary, completed } = arrangeSearchResults(noisy, facts, false);
    expect(ids(primary)).toEqual(['ld02', 'ld01', 'ld22p']);
    expect(ids(completed)).toEqual(['ld21p', 'ld20p']);
  });

  it('never moves a literal row when server hits arrive', () => {
    const quick = ids(arrangeSearchResults(ranked.filter((t) => t.id.startsWith('l')), facts, false).primary);
    const settled = ids(arrangeSearchResults(ranked, facts, false).primary);
    expect(quick).toEqual(['lo1', 'lo4', 'ld05']);
    expect(settled.slice(0, quick.length)).toEqual(quick);
  });

  it('with the Done chip on, keeps pure rank order and sends every loose hit to related', () => {
    const { primary, completed, related, looseDone } = arrangeSearchResults(ranked, facts, true);
    expect(ids(primary)).toEqual(['ld05', 'lo1', 'sd07', 'so2', 'lo4']);
    expect(completed).toEqual([]);
    expect(ids(related)).toEqual(['sd08x', 'so3x']);
    expect(looseDone).toBe(1);
  });

  it('shows the first non-empty fold directly when nothing else is left', () => {
    const onlyDone = arrangeSearchResults(['sd07', 'so3x'].map(row), facts, false);
    expect(ids(onlyDone.primary)).toEqual(['sd07']);
    expect(ids(onlyDone.related)).toEqual(['so3x']);
    const onlyLoose = arrangeSearchResults(['so3x', 'so5x', 'sd08x'].map(row), facts, false);
    expect(ids(onlyLoose.primary)).toEqual(['so3x', 'so5x']);
    expect(onlyLoose.related).toEqual([]);
    expect(onlyLoose.looseDone).toBe(1);
  });
});
