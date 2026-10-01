/**
 * QUICK ACCESS: the starting rows a user with no history sees on `~/`.
 * Pure function tests, no IO.
 */
import { describe, it, expect } from 'vitest';
import {
  buildQuickAccessSections,
  quickAccessRows,
  QUICK_ACCESS_LABEL,
} from '../../../web/src/components/sessions/path-selector/quick-access';
import type { HostListingLite } from '../../../web/src/components/sessions/path-selector/input-model';

const HOME = '/Users/alice';
// A real home listing: direct children plus preloaded grandchildren (depth 2).
const LISTING = [
  `${HOME}/Library`, `${HOME}/Music`, `${HOME}/Movies`, `${HOME}/Desktop`, `${HOME}/Downloads`,
  `${HOME}/code`, `${HOME}/code/walnut`, `${HOME}/workplace`, `${HOME}/.config`,
  // Grandchildren named like quick-access folders must not count as home folders.
  `${HOME}/code/projects`, `${HOME}/Music/src`,
];

function done(parent: string, dirs: string[]): HostListingLite {
  return { status: 'done', parent, exists: true, dirs };
}

describe('quickAccessRows', () => {
  it('leads with the home folder, then the usual folders that exist, in a fixed order', () => {
    const rows = quickAccessRows(LISTING, HOME + '/');
    expect(rows.map(r => r.cwd)).toEqual([
      HOME, `${HOME}/Desktop`, `${HOME}/Downloads`, `${HOME}/code`, `${HOME}/workplace`,
    ]);
  });

  it('rows are ordinary live rows (click and Enter treat them like any listed folder)', () => {
    for (const r of quickAccessRows(LISTING, HOME)) {
      expect(r).toMatchObject({ source: 'live', host: null, depth: 0, leafHit: true, quality: 'prefix' });
      expect(r.history).toBeUndefined();
    }
  });

  it('ignores grandchildren, hidden and unrelated folders', () => {
    const cwds = quickAccessRows(LISTING, HOME).map(r => r.cwd);
    expect(cwds).not.toContain(`${HOME}/code/projects`);
    expect(cwds).not.toContain(`${HOME}/Music/src`);
    expect(cwds).not.toContain(`${HOME}/Library`);
    expect(cwds).not.toContain(`${HOME}/.config`);
  });

  it('keeps real casing and offers both spellings when a case-sensitive host has both', () => {
    const rows = quickAccessRows(['/home/bob/Code', '/home/bob/code', '/home/bob/CODE'], '/home/bob/');
    expect(rows.map(r => r.cwd)).toEqual(['/home/bob', '/home/bob/code', '/home/bob/Code']);
  });

  it('an empty home still offers the home row', () => {
    expect(quickAccessRows([], '/home/bob/').map(r => r.cwd)).toEqual(['/home/bob']);
  });

  it('a root home lists its children without a double slash', () => {
    expect(quickAccessRows(['/work', '/src', '/etc'], '/').map(r => r.cwd)).toEqual(['/', '/src', '/work']);
  });

  it('carries the host and its label on every row', () => {
    const rows = quickAccessRows(['/home/me/projects'], '/home/me/', { host: 'devbox', hostLabel: 'Big dev box' });
    expect(rows.map(r => [r.host, r.hostLabel])).toEqual([['devbox', 'Big dev box'], ['devbox', 'Big dev box']]);
  });
});

describe('buildQuickAccessSections', () => {
  const hostLabels = new Map([['__local__', 'Local'], ['devbox', 'Big dev box']]);

  it('shows on the unresolved ~/ (the All tab keeps the raw ~)', () => {
    const sections = buildQuickAccessSections({
      dir: '~/', byHost: new Map([['__local__', done(HOME + '/', LISTING)]]),
      homeByHost: new Map(), hostLabels, perHost: false,
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ id: 'quick:__local__', label: QUICK_ACCESS_LABEL, hostKey: '__local__' });
    expect(sections[0].items[0].cwd).toBe(HOME);
  });

  it('shows on the resolved home after the ~ rewrite, and on no other folder', () => {
    const byHost = new Map([['__local__', done(HOME + '/', LISTING)]]);
    const homeByHost = new Map([['__local__', HOME]]);
    expect(buildQuickAccessSections({ dir: HOME + '/', byHost, homeByHost, hostLabels, perHost: false })).toHaveLength(1);
    const code = new Map([['__local__', done(`${HOME}/code/`, [`${HOME}/code/walnut`])]]);
    expect(buildQuickAccessSections({ dir: `${HOME}/code/`, byHost: code, homeByHost, hostLabels, perHost: false })).toEqual([]);
    // Home not learned yet (the ~/ listing never landed): no guessing.
    expect(buildQuickAccessSections({ dir: HOME + '/', byHost, homeByHost: new Map(), hostLabels, perHost: false })).toEqual([]);
  });

  it('skips hosts still loading, failed or missing their home', () => {
    const byHost = new Map<string, HostListingLite>([
      ['__local__', { status: 'loading', parent: '', exists: true, dirs: [] }],
      ['devbox', { status: 'error', parent: '', exists: true, dirs: [] }],
    ]);
    expect(buildQuickAccessSections({ dir: '~/', byHost, homeByHost: new Map(), hostLabels, perHost: true })).toEqual([]);
    const gone = new Map([['__local__', { status: 'done' as const, parent: HOME, exists: false, dirs: [] }]]);
    expect(buildQuickAccessSections({ dir: '~/', byHost: gone, homeByHost: new Map(), hostLabels, perHost: false })).toEqual([]);
  });

  it('All tab over several hosts: one section per host, local first, each named', () => {
    const byHost = new Map([
      ['devbox', done('/home/me/', ['/home/me/projects'])],
      ['__local__', done(HOME + '/', LISTING)],
    ]);
    const sections = buildQuickAccessSections({ dir: '~/', byHost, homeByHost: new Map(), hostLabels, perHost: true });
    expect(sections.map(s => s.label)).toEqual([`${QUICK_ACCESS_LABEL} · Local`, `${QUICK_ACCESS_LABEL} · Big dev box`]);
    expect(sections[1].items.map(r => r.cwd)).toEqual(['/home/me', '/home/me/projects']);
    expect(sections[1].items.every(r => r.host === 'devbox')).toBe(true);
  });
});
