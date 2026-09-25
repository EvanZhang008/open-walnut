/**
 * HOME FOLDERS: what a bare word ("work") shows from the live `~/` listing.
 * Pure function tests, no IO.
 */
import { describe, it, expect } from 'vitest';
import {
  buildHomeFolderSections,
  homeSearchHostStates,
  HOME_FOLDERS_LABEL,
} from '../../../web/src/components/sessions/path-selector/home-folders';
import type { HostListingLite } from '../../../web/src/components/sessions/path-selector/input-model';
import type { WorkingDirEntry } from '../../../web/src/api/sessions';

const NOW = Date.parse('2026-09-24T12:00:00Z');

function done(parent: string, dirs: string[]): HostListingLite {
  return { status: 'done', parent, exists: true, dirs };
}

// A remote home where ~/workplace is a symlink to /workplace: the server lists the
// link under the home (never its target) and does not walk into it, so it has no
// depth-2 entries while the real ~/workspace does.
const DEVBOX_HOME = done('/home/alice/', [
  '/home/alice/workplace',
  '/home/alice/workspace',
  '/home/alice/workspace/api',
  '/home/alice/notes',
  '/home/alice/.work-cache',
  '/home/alice/homework',
]);

const base = {
  hostLabels: new Map([['devbox', 'Big dev box']]),
  history: new Map<string, WorkingDirEntry>(),
  shown: new Set<string>(),
  perHost: false,
  now: NOW,
};

describe('buildHomeFolderSections', () => {
  it('matches the word against home folder names: prefix first, then substring, direct children only', () => {
    const sections = buildHomeFolderSections({ ...base, word: 'work', byHost: new Map([['devbox', DEVBOX_HOME]]) });
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe(HOME_FOLDERS_LABEL);
    expect(sections[0].items.map(i => i.cwd)).toEqual([
      '/home/alice/workplace',
      '/home/alice/workspace',
      '/home/alice/homework',
    ]);
    const first = sections[0].items[0];
    expect(first).toMatchObject({ host: 'devbox', hostLabel: 'Big dev box', source: 'live', depth: 0 });
  });

  it('never matches through the home path itself, and hides dot folders unless the word starts with "."', () => {
    const byHost = new Map([['devbox', DEVBOX_HOME]]);
    expect(buildHomeFolderSections({ ...base, word: 'alice', byHost })).toEqual([]);
    expect(buildHomeFolderSections({ ...base, word: 'home', byHost })[0].items.map(i => i.cwd))
      .toEqual(['/home/alice/homework']);
    expect(buildHomeFolderSections({ ...base, word: '.work', byHost })[0].items.map(i => i.cwd))
      .toEqual(['/home/alice/.work-cache']);
  });

  it('skips rows the history section already shows, and a used folder leads its quality band', () => {
    const byHost = new Map([['devbox', DEVBOX_HOME]]);
    const used: WorkingDirEntry = { cwd: '/home/alice/workspace', host: 'devbox', project: '', count: 5, lastUsed: '2026-09-23T12:00:00Z' };
    const withHistory = buildHomeFolderSections({
      ...base, word: 'work', byHost,
      history: new Map([['devbox::/home/alice/workspace', used]]),
    });
    expect(withHistory[0].items.map(i => i.cwd).slice(0, 2)).toEqual(['/home/alice/workspace', '/home/alice/workplace']);
    const deduped = buildHomeFolderSections({
      ...base, word: 'work', byHost,
      shown: new Set(['devbox::/home/alice/workplace']),
    });
    expect(deduped[0].items.map(i => i.cwd)).not.toContain('/home/alice/workplace');
  });

  it('All tab: one section per host, local first, each heading names its host', () => {
    const byHost = new Map<string, HostListingLite>([
      ['devbox', DEVBOX_HOME],
      ['__local__', done('/Users/alice/', ['/Users/alice/workbench', '/Users/alice/Music'])],
    ]);
    const sections = buildHomeFolderSections({ ...base, word: 'work', byHost, perHost: true });
    expect(sections.map(s => s.id)).toEqual(['home:__local__', 'home:devbox']);
    expect(sections[0].label).toBe(`${HOME_FOLDERS_LABEL} · Local`);
    expect(sections[1].label).toBe(`${HOME_FOLDERS_LABEL} · Big dev box`);
    expect(sections[0].items[0]).toMatchObject({ cwd: '/Users/alice/workbench', host: null });
  });

  it('a host still loading, failed, or without a home adds no section', () => {
    const byHost = new Map<string, HostListingLite>([
      ['devbox', { status: 'loading', parent: '', exists: true, dirs: [] }],
      ['other', { status: 'error', parent: '', exists: true, dirs: [] }],
      ['gone', { status: 'done', parent: '/home/alice/', exists: false, dirs: [] }],
    ]);
    expect(buildHomeFolderSections({ ...base, word: 'work', byHost })).toEqual([]);
  });

  it('accepts a parent without a trailing slash', () => {
    const byHost = new Map([['devbox', done('/home/alice', ['/home/alice/workplace'])]]);
    expect(buildHomeFolderSections({ ...base, word: 'work', byHost })[0].items[0].cwd).toBe('/home/alice/workplace');
  });
});

describe('homeSearchHostStates', () => {
  it('keeps only the connecting and could-not-connect rows', () => {
    const connecting = { status: 'loading' as const, parent: '', exists: true, dirs: [], pending: { phase: 'ssh', label: 'x', elapsedMs: 0 } };
    const failed = { status: 'error' as const, parent: '', exists: true, dirs: [] };
    const plainLoading = { status: 'loading' as const, parent: '', exists: true, dirs: [] };
    const emptyHome = { status: 'done' as const, parent: '/home/alice/', exists: true, dirs: [] };
    const out = homeSearchHostStates(new Map<string, HostListingLite & { pending?: unknown }>([
      ['a', connecting], ['b', failed], ['c', plainLoading], ['d', emptyHome],
    ]));
    expect(Array.from(out.keys())).toEqual(['a', 'b']);
  });
});
