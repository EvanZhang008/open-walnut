/**
 * Section "last location" memory (web/src/utils/last-location.ts) — the sidebar and
 * Settings nav link back to where the user last was inside a section.
 * Pure logic against a Map-backed store.
 */
import { describe, it, expect } from 'vitest';
import {
  LS_LAST_LOCATION,
  sectionFor,
  rememberLocation,
  linkTargetFor,
  type KeyStore,
} from '../../web/src/utils/last-location';

function fakeStore(seed: Record<string, string> = {}): KeyStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
}

const at = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

describe('sectionFor', () => {
  it('a section root is its own key; home and deeper paths are not remembered', () => {
    expect(sectionFor('/calendar')).toBe('/calendar');
    expect(sectionFor('/settings')).toBe('/settings');
    expect(sectionFor('/')).toBeNull();
    expect(sectionFor('/tasks/abc123')).toBeNull();   // a task detail is not "the tasks list"
    expect(sectionFor('/plugins/new')).toBeNull();
    expect(sectionFor('relative')).toBeNull();
  });

  it('plugin apps own their subtree: /apps/<id>/… keys on the app', () => {
    expect(sectionFor('/apps/walnut-time~main')).toBe('/apps/walnut-time~main');
    expect(sectionFor('/apps/walnut-time~main/week/2026-09')).toBe('/apps/walnut-time~main');
    expect(sectionFor('/apps')).toBeNull();
  });
});

describe('rememberLocation + linkTargetFor', () => {
  it('a link falls back to the bare path until something is remembered', () => {
    expect(linkTargetFor('/calendar', fakeStore())).toBe('/calendar');
  });

  it('remembers search and hash, per section, and hands them back to the link', () => {
    const s = fakeStore();
    rememberLocation(at('/calendar', '?view=month&d=2026-09-01'), s);
    rememberLocation(at('/settings', '', '#usage'), s);
    rememberLocation(at('/memory', '?path=knowledge%2Fa.md'), s);
    expect(linkTargetFor('/calendar', s)).toBe('/calendar?view=month&d=2026-09-01');
    expect(linkTargetFor('/settings', s)).toBe('/settings#usage');
    expect(linkTargetFor('/memory', s)).toBe('/memory?path=knowledge%2Fa.md');
    // Sections do not leak into one another.
    expect(linkTargetFor('/tasks', s)).toBe('/tasks');
  });

  it('a later visit with NO state overwrites the remembered one (the user cleared it)', () => {
    const s = fakeStore();
    rememberLocation(at('/calendar', '?view=month'), s);
    rememberLocation(at('/calendar'), s);
    expect(linkTargetFor('/calendar', s)).toBe('/calendar');
  });

  it('a deeper path neither overwrites nor is returned', () => {
    const s = fakeStore();
    rememberLocation(at('/tasks', '?x=1'), s);
    rememberLocation(at('/tasks/abc'), s);
    expect(linkTargetFor('/tasks', s)).toBe('/tasks?x=1');
  });

  it('home is never recorded', () => {
    const s = fakeStore();
    rememberLocation(at('/', '?s1=abc&proj=_inbox'), s);
    expect(s.map.has(LS_LAST_LOCATION)).toBe(false);
    expect(linkTargetFor('/', s)).toBe('/');
  });

  it('a plugin app sub-path is returned for the app root link', () => {
    const s = fakeStore();
    rememberLocation(at('/apps/walnut-time~main/week/2026-09'), s);
    expect(linkTargetFor('/apps/walnut-time~main', s)).toBe('/apps/walnut-time~main/week/2026-09');
  });

  it('does not rewrite storage when the location is unchanged', () => {
    const s = fakeStore();
    rememberLocation(at('/calendar', '?view=day'), s);
    const before = s.map.get(LS_LAST_LOCATION);
    let writes = 0;
    const counting: KeyStore = { getItem: s.getItem, setItem: (k, v) => { writes++; s.setItem(k, v); } };
    rememberLocation(at('/calendar', '?view=day'), counting);
    expect(writes).toBe(0);
    expect(s.map.get(LS_LAST_LOCATION)).toBe(before);
  });

  it('corrupt storage reads as nothing remembered, and entries that do not start with their key are dropped', () => {
    expect(linkTargetFor('/calendar', fakeStore({ [LS_LAST_LOCATION]: '{oops' }))).toBe('/calendar');
    expect(linkTargetFor('/calendar', fakeStore({ [LS_LAST_LOCATION]: '[1,2]' }))).toBe('/calendar');
    // A value that would send the Calendar link somewhere else entirely is refused.
    const hostile = fakeStore({ [LS_LAST_LOCATION]: JSON.stringify({ '/calendar': '/settings#danger' }) });
    expect(linkTargetFor('/calendar', hostile)).toBe('/calendar');
  });

  it('a throwing store never propagates', () => {
    const broken: KeyStore = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(() => rememberLocation(at('/calendar'), broken)).not.toThrow();
    expect(linkTargetFor('/calendar', broken)).toBe('/calendar');
  });
});
