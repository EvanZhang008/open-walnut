/**
 * Unit tests for src/core/session-search.ts — the pure filter behind the
 * sessions list `?q=` parameter and the home-page session finder.
 */
import { describe, it, expect } from 'vitest';
import { filterSessionsByQuery, sessionSearchFields, sessionSearchTaskName } from '../../src/core/session-search.js';

type S = Parameters<typeof filterSessionsByQuery>[0][number] & { id: string };

function s(id: string, fields: Partial<Omit<S, 'id'>> = {}): S {
  return { id, ...fields };
}

const sessions: S[] = [
  s('a', { title: 'Fix login bug', taskId: 't1', cwd: '/home/user/webapp', host: 'clouddev' }),
  s('b', { title: 'Refactor Search', cwd: '/Users/me/walnut' }),
  s('c', { taskId: 't2', cwd: '/tmp/scratch', host: 'devbox', hostname: 'devbox.example.com' }),
  s('d', {}), // no searchable fields at all
];

const taskTitles: Record<string, string> = { t1: 'Auth hardening', t2: 'Übung Grüße' };
const lookup = (id: string) => taskTitles[id];

describe('filterSessionsByQuery', () => {
  it('returns input unchanged for empty / whitespace / undefined query', () => {
    expect(filterSessionsByQuery(sessions, '')).toBe(sessions);
    expect(filterSessionsByQuery(sessions, '   ')).toBe(sessions);
    expect(filterSessionsByQuery(sessions, undefined)).toBe(sessions);
  });

  it('matches title case-insensitively', () => {
    expect(filterSessionsByQuery(sessions, 'LOGIN').map(x => x.id)).toEqual(['a']);
    expect(filterSessionsByQuery(sessions, 'search').map(x => x.id)).toEqual(['b']);
  });

  it('matches owning-task title through the lookup', () => {
    expect(filterSessionsByQuery(sessions, 'hardening', lookup).map(x => x.id)).toEqual(['a']);
    // Without a lookup the task title is invisible
    expect(filterSessionsByQuery(sessions, 'hardening')).toEqual([]);
  });

  it('matches cwd substrings', () => {
    expect(filterSessionsByQuery(sessions, 'walnut').map(x => x.id)).toEqual(['b']);
    expect(filterSessionsByQuery(sessions, '/home/').map(x => x.id)).toEqual(['a']);
  });

  it('matches host alias AND resolved hostname', () => {
    expect(filterSessionsByQuery(sessions, 'clouddev').map(x => x.id)).toEqual(['a']);
    expect(filterSessionsByQuery(sessions, 'example.com').map(x => x.id)).toEqual(['c']);
  });

  it('resolves alias→hostname through the resolver (real path shape: records carry only the alias)', () => {
    // Records straight from SQLite have host but NO hostname (enrichment runs
    // after filtering) — the resolver is the only way hostname search works.
    const hostnames: Record<string, string> = { clouddev: 'clouddev.example.net' };
    const resolveHost = (alias: string) => hostnames[alias];
    expect(filterSessionsByQuery(sessions, 'clouddev.example.net', undefined, resolveHost).map(x => x.id))
      .toEqual(['a']);
    // Without the resolver the same query finds nothing — documents the dead-field bug.
    expect(filterSessionsByQuery(sessions, 'clouddev.example.net')).toEqual([]);
    // A record that already carries hostname wins without the resolver…
    expect(filterSessionsByQuery(sessions, 'devbox.example.com', undefined, resolveHost).map(x => x.id))
      .toEqual(['c']);
    // …and its own hostname takes precedence over the resolver's answer.
    const clobber = (_alias: string) => 'other.example.org';
    expect(sessionSearchFields(s('c2', { host: 'devbox', hostname: 'devbox.example.com' }), undefined, clobber))
      .toContain('devbox.example.com');
  });

  it('requires ALL whitespace-separated terms to match (AND semantics)', () => {
    expect(filterSessionsByQuery(sessions, 'login clouddev').map(x => x.id)).toEqual(['a']);
    expect(filterSessionsByQuery(sessions, 'login devbox')).toEqual([]);
  });

  it('handles unicode queries (case fold beyond ASCII)', () => {
    expect(filterSessionsByQuery(sessions, 'übung', lookup).map(x => x.id)).toEqual(['c']);
    expect(filterSessionsByQuery(sessions, 'GRÜSSE', lookup)).toEqual([]); // ß≠SS in simple toLowerCase — documents behavior
    expect(filterSessionsByQuery(sessions, 'grüße', lookup).map(x => x.id)).toEqual(['c']);
  });

  it('never matches a session with no searchable fields', () => {
    expect(filterSessionsByQuery([s('x', {})], 'anything')).toEqual([]);
  });

  it('does not throw on regex-special characters in the query', () => {
    expect(() => filterSessionsByQuery(sessions, '(a[b].*+?')).not.toThrow();
    expect(filterSessionsByQuery(sessions, '(a[b].*+?')).toEqual([]);
  });
});

describe('sessionSearchFields', () => {
  it('lowercases every field and skips absent ones', () => {
    expect(sessionSearchFields(s('a', { title: 'ABC', host: 'DevBox' }))).toEqual(['abc', 'devbox']);
    expect(sessionSearchFields(s('d', {}))).toEqual([]);
  });
});

describe('sessionSearchTaskName', () => {
  const tasks = new Map([
    ['ask', sessionSearchTaskName({ title: 'Ask Walnut', project: 'Ask Walnut' })],
    ['ceo', sessionSearchTaskName({ title: 'CEO', project: '', org_role: 'main' })],
    ['old-main', sessionSearchTaskName({ title: 'Main', project: '', org_role: 'main' })],
    ['plain', sessionSearchTaskName({ title: 'Fix the build', project: 'Alpha' })],
  ]);
  const sessions = [...tasks.keys()].map((taskId) => s(taskId, { taskId, title: taskId === 'plain' ? 'Fix the build' : 'Main' }));
  const find = (q: string) => filterSessionsByQuery(sessions, q, (id) => tasks.get(id)).map((x) => x.id);

  it('finds a session by the name its task shows and by its stored title', () => {
    expect(find('quick question')).toEqual(['ask']);
    expect(find('ask walnut')).toEqual(['ask']);
    expect(find('ceo')).toEqual(['ceo', 'old-main']);
    expect(find('fix build')).toEqual(['plain']);
  });

  it('keeps one name for a task whose title is what it shows', () => {
    expect(sessionSearchTaskName({ title: 'Fix the build', project: 'Alpha' })).toBe('Fix the build');
  });
});
