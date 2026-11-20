/**
 * The Work in pill (experiment project_first_start, draft-work-in.ts) as data: what a start
 * from a source makes (one helper for the pill and the rows), each project row's line, the
 * pill's words, which project a folder belongs to (detectProjectForFolder), and the "start in a
 * fresh workspace instead?" suggestion after a folder of a project with a source. The class
 * every case guards: a folder names a project only when its code is unmistakably that project's.
 */

import { describe, it, expect } from 'vitest';
import { draft, git, plugin } from './helpers/project-start';

const wi = await import('@/components/sessions/draft-work-in');

describe('sourceMakes and the Work in project line (one helper for both)', () => {
  it('names each kind of start once, never "workspace workspace"', () => {
    expect(wi.sourceMakes(null)).toBe('workspace');
    expect(wi.sourceMakes({ ...git, provider: 'auto', provider_name: undefined })).toBe('workspace');
    expect(wi.sourceMakes(git)).toBe('git worktree');
    expect(wi.sourceMakes(plugin)).toBe('Fake multi-repo workspace');
    // A provider whose own name already ends in workspace / worktree (2026-11-20, real data).
    for (const name of ['Monorepo workspace', 'Team Workspaces', 'Sparse worktree']) {
      expect(wi.sourceMakes({ ...plugin, provider_name: name })).toBe(name);
    }
    expect(wi.sourceMakes({ ...plugin, provider_name: undefined, provider: 'fake-multirepo' })).toBe('fake-multirepo workspace');
  });

  it('says what a pick gives: a fresh workspace on its host, its own folder, or a folder to pick', () => {
    expect(wi.workInProjectLine({ startSource: git }, { hostLabel: 'Big box' })).toBe('Fresh git worktree on Big box');
    expect(wi.workInProjectLine({ startSource: plugin }, { hostLabel: 'Local' })).toBe('Fresh Fake multi-repo workspace on Local · Alpha, Beta');
    const many = { ...plugin, inputs: { packages: ['A', 'B', 'C', 'D', 'E'] } };
    expect(wi.workInProjectLine({ startSource: many }, { hostLabel: 'Local' })).toBe('Fresh Fake multi-repo workspace on Local · A, B, C +2');
    expect(wi.workInProjectLine({ startSource: { ...plugin, provider_name: 'Monorepo workspace', inputs: {} } }, { hostLabel: 'Local' }))
      .toBe('Fresh Monorepo workspace on Local');
    expect(wi.workInProjectLine({ defaultCwd: '/home/u/notes' }, { hostLabel: 'Local', folderName: 'notes' })).toBe('Works in its folder notes · Local');
    expect(wi.workInProjectLine({}, { hostLabel: 'Local' })).toBe('Works in a folder you pick');
  });

  it('orders the Projects tab: favourites, then with a source, then the rest; a search matches the shown name', () => {
    const rows = [{ name: 'Zed' }, { name: 'Acme', startSource: plugin }, { name: 'Life' }, { name: 'Marina', startSource: git }];
    expect(wi.workInProjectOrder(rows, (n) => n === 'Zed', '').map((r) => r.name)).toEqual(['Zed', 'Acme', 'Marina', 'Life']);
    expect(wi.workInProjectOrder(rows, () => false, 'MAR').map((r) => r.name)).toEqual(['Marina']);
    expect(wi.workInProjectOrder(rows, () => false, 'bay', (n) => (n === 'Life' ? 'Life bay' : n)).map((r) => r.name)).toEqual(['Life']);
  });
});

describe('the Work in pill\'s words', () => {
  const ctx = { mode: 'pick' as const, project: '', source: null, folderName: 'app', detected: null };

  it('a project with a code source: its name and what a start makes', () => {
    const face = wi.workInFace(draft({ project: 'Marina' }), { ...ctx, mode: 'source', project: 'Marina', source: git });
    expect(face).toEqual({ kind: 'source', project: 'Marina', makes: 'git worktree' });
    expect(wi.workInWords(face, 'Big box')).toBe('Work in: Marina · fresh git worktree · Big box');
    expect(wi.workInWords(wi.workInFace(draft(), { ...ctx, mode: 'source', project: 'Acme', source: plugin }))).toBe('Work in: Acme · fresh Fake multi-repo workspace');
    // A hand pick whose source this tab lost still says a fresh workspace (the Start asks the server).
    expect(wi.workInFace(draft(), { ...ctx, mode: 'source', project: 'Gone', source: null })).toMatchObject({ makes: 'workspace' });
  });

  it('a folder: its name, and its project as a tag (the draft\'s, else the detected one)', () => {
    expect(wi.workInFace(draft({ cwd: '/repos/app' }), ctx)).toEqual({ kind: 'folder', folder: 'app' });
    const detected = { project: 'Marina', hasSource: true };
    expect(wi.workInFace(draft({ cwd: '/repos/app' }), { ...ctx, detected })).toEqual({ kind: 'folder', folder: 'app', tag: 'Marina' });
    expect(wi.workInFace(draft({ cwd: '/repos/app', project: 'Life' }), { ...ctx, project: 'Life', detected })).toMatchObject({ tag: 'Life' });
    expect(wi.workInWords({ kind: 'folder', folder: 'app', tag: 'Marina' }, 'Big box')).toBe('Work in: app (Marina) · Big box');
  });

  it('a folder start that isolates says so, between the project and the host', () => {
    const face = wi.workInFace(draft({ cwd: '/repos/app' }), { ...ctx, detected: { project: 'Marina', hasSource: true }, isolated: true });
    expect(face).toEqual({ kind: 'folder', folder: 'app', tag: 'Marina', isolated: true });
    expect(wi.workInWords(face, 'Big box')).toBe(`Work in: app (Marina) · ${wi.ISOLATED_WORDS} · Big box`);
    // Never on an empty pill (nothing to isolate) nor on a start from a source (its own fresh copy).
    expect(wi.workInFace(draft({ cwd: '' }), { ...ctx, isolated: true })).toEqual({ kind: 'empty' });
  });

  it('nothing yet: one question', () => {
    expect(wi.workInFace(draft({ cwd: '' }), ctx)).toEqual({ kind: 'empty' });
    expect(wi.workInWords({ kind: 'empty' })).toBe('Work in: Choose a project or folder…');
    expect(wi.workInFace(draft({ cwd: '', project: 'Life' }), { ...ctx, project: 'Life' })).toEqual({ kind: 'empty', tag: 'Life' });
    // The project first, then what is still to choose.
    expect(wi.workInWords({ kind: 'empty', tag: 'Marina' })).toBe('Work in: Marina · choose a folder…');
  });
});

describe('detectProjectForFolder: the project whose code lives at a folder', () => {
  const rows = [
    { name: 'Marina', startSource: git },                                   // /repos/marina on big-box
    { name: 'Marina web', defaultCwd: '/repos/marina/web', defaultHost: 'big-box' },
    { name: 'Marina docs', startSource: { ...git, anchor: '/repos/marina/docs' } },
    { name: 'Acme', startSource: plugin, defaultCwd: '/ws/multi' },         // this computer
    { name: 'Life', defaultCwd: '/home/u/life/' },
    { name: 'Everything', defaultCwd: '/home/u' },
    { name: 'Root', defaultCwd: '/' },
  ];

  it('a source\'s folder or one under it, a default folder only itself, on the same host', () => {
    expect(wi.detectProjectForFolder('/repos/marina', 'big-box', rows)).toEqual({ project: 'Marina', hasSource: true });
    expect(wi.detectProjectForFolder('/repos/marina/src/lib/', 'big-box', rows)).toEqual({ project: 'Marina', hasSource: true });
    expect(wi.detectProjectForFolder('/home/u/life', null, rows)).toEqual({ project: 'Life', hasSource: false });
    expect(wi.detectProjectForFolder('/repos/marina/web', 'big-box', rows)).toEqual({ project: 'Marina web', hasSource: false });
    // A default folder is where a project starts, not its code: a folder under it is not its own.
    expect(wi.detectProjectForFolder('/home/u/life/notes', '', rows)).toBeNull();
    expect(wi.detectProjectForFolder('/repos/marina/web/src', 'big-box', rows)).toEqual({ project: 'Marina', hasSource: true });
    // A sibling whose name starts the same is not under it.
    expect(wi.detectProjectForFolder('/repos/marina-old', 'big-box', rows)).toBeNull();
  });

  it('the longest match wins', () => {
    expect(wi.detectProjectForFolder('/repos/marina/docs/guide', 'big-box', rows)).toEqual({ project: 'Marina docs', hasSource: true });
  });

  it('a parent folder that is many projects\' default never claims a new folder under it', () => {
    const shared = [{ name: 'Scratch', defaultCwd: '/srv/code' }];
    expect(wi.detectProjectForFolder('/srv/code/newrepo', null, shared)).toBeNull();
    expect(wi.detectProjectForFolder('/srv/code', null, shared)).toEqual({ project: 'Scratch', hasSource: false });
  });

  it('two or more different projects at the best length name none', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ name: `P${i}`, defaultCwd: '/srv/code' }));
    expect(wi.detectProjectForFolder('/srv/code', null, many)).toBeNull();
    const twoSources = [{ name: 'Marina', startSource: git }, { name: 'Marina copy', startSource: git }];
    expect(wi.detectProjectForFolder('/repos/marina/src', 'big-box', twoSources)).toBeNull();
    // One project matched twice (its source and its default folder) is still one.
    expect(wi.detectProjectForFolder('/ws/multi', null, rows)).toEqual({ project: 'Acme', hasSource: true });
  });

  it('another host never matches; this computer is null, \'\' or __local__', () => {
    expect(wi.detectProjectForFolder('/repos/marina', null, rows)).toBeNull();
    expect(wi.detectProjectForFolder('/repos/marina', 'other-box', rows)).toBeNull();
    expect(wi.detectProjectForFolder('/ws/multi/alpha', '__local__', rows)).toEqual({ project: 'Acme', hasSource: true });
    expect(wi.detectProjectForFolder('/ws/multi/alpha', 'big-box', rows)).toBeNull();
  });

  it('a home folder (or the root) never matches, on either side', () => {
    // "Everything" lives at /home/u and "Root" at /: neither claims the folders under them.
    expect(wi.detectProjectForFolder('/home/u/scratch', null, rows)).toBeNull();
    expect(wi.detectProjectForFolder('/opt/tmp', null, rows)).toBeNull();
    for (const home of ['~', '/home/u', '/Users/sam', '/']) expect(wi.detectProjectForFolder(home, null, rows)).toBeNull();
    // A known home that is not account-shaped.
    const own = [{ name: 'Mine', startSource: { ...git, anchor: '/data/me', host: '__local__' } }];
    expect(wi.detectProjectForFolder('/data/me/x', null, own)).toEqual({ project: 'Mine', hasSource: true });
    expect(wi.detectProjectForFolder('/data/me/x', null, own, { home: '/data/me' })).toBeNull();
  });

  it('a worktree Walnut made belongs to the project whose git source\'s folder has its repo name', () => {
    const wt = '/home/u/.open-walnut-worktrees/marina/task-1/src';
    expect(wi.detectProjectForFolder(wt, 'big-box', rows)).toEqual({ project: 'Marina', hasSource: true });
    // The folder that only holds the repo's worktrees is none of them (the phone's twin reads it the same).
    expect(wi.detectProjectForFolder('/home/u/.open-walnut-worktrees/marina', 'big-box', rows)).toBeNull();
    expect(wi.detectProjectForFolder(wt, null, rows)).toBeNull();
    expect(wi.detectProjectForFolder('/home/u/.open-walnut-worktrees/other/t', 'big-box', rows)).toBeNull();
  });

  it('the worktree rule reads every source kind by its anchor\'s name: the legacy "auto" and a plugin too', () => {
    // A plugin's anchor (/ws/multi on this computer) named like the repo.
    expect(wi.detectProjectForFolder('/x/.open-walnut-worktrees/multi/t', null, rows)).toEqual({ project: 'Acme', hasSource: true });
    const auto = [{ name: 'Life', startSource: { ...git, provider: 'auto', anchor: '/home/u/life', host: '__local__' } }];
    expect(wi.detectProjectForFolder('/home/u/.open-walnut-worktrees/life/t-2', null, auto)).toEqual({ project: 'Life', hasSource: true });
    // Two projects whose anchors share the repo name: no guess.
    const twins = [...auto, { name: 'Life old', startSource: { ...git, anchor: '/old/life', host: '__local__' } }];
    expect(wi.detectProjectForFolder('/home/u/.open-walnut-worktrees/life/t-2', null, twins)).toBeNull();
  });

  it('a folder pick takes the detected project unless the person picked one; the registry owner still comes first', () => {
    const forDir = (cwd: string) => (cwd === '/repos/owned' ? 'Owner' : '');
    const on = { on: true, rows };
    const look = wi.withDetectedOwner(forDir, draft(), 'big-box', on);
    expect(look('/repos/marina/src')).toBe('Marina');
    expect(look('/repos/owned')).toBe('Owner');
    expect(look('/elsewhere')).toBe('');
    // A name the registry would make up from the folder (a new project) loses to the project whose code is there.
    const invents = (cwd: string) => (cwd === '/repos/owned' ? 'Owner' : `new-${cwd.split('/').pop()}`);
    const look2 = wi.withDetectedOwner(invents, draft(), 'big-box', on);
    expect(look2('/repos/marina/src')).toBe('Marina');
    expect(look2('/elsewhere')).toBe('new-elsewhere');
    // The person's own project pick, the experiment off, or a bound draft: the registry alone.
    expect(wi.withDetectedOwner(forDir, draft({ projectSource: 'user' }), 'big-box', on)).toBe(forDir);
    expect(wi.withDetectedOwner(forDir, draft({ projectSource: 'seed' }), 'big-box', on)).toBe(forDir);
    expect(wi.withDetectedOwner(forDir, draft(), 'big-box', { ...on, on: false })).toBe(forDir);
    expect(wi.withDetectedOwner(forDir, draft({ taskId: 't1' }), 'big-box', on)).toBe(forDir);
  });
});

describe('the "fresh workspace instead?" suggestion', () => {
  const rows = [{ name: 'Marina', startSource: git }, { name: 'Life', defaultCwd: '/home/u/life' }];
  const marina = { project: 'Marina', hasSource: true };

  it('shows on a folder of a project with a source, says what it makes, and stays away once kept', () => {
    const d = draft({ cwd: '/repos/marina/src', host: 'big-box' });
    expect(wi.workInSuggestion(d, { mode: 'pick', detected: marina, rows })).toEqual({ project: 'Marina', makes: 'git worktree' });
    const kept = wi.keepWorkInFolder(d);
    expect(kept.workInKept).toBe('big-box::/repos/marina/src');
    // And the draft stays on the folder: no seed or parse moves it onto the source.
    expect(kept.fromProject).toBe(false);
    expect(wi.workInSuggestion(kept, { mode: 'pick', detected: marina, rows })).toBeNull();
    // Another folder asks again.
    expect(wi.workInSuggestion({ ...kept, cwd: '/repos/marina' }, { mode: 'pick', detected: marina, rows })).not.toBeNull();
  });

  it('never on a start from a source, a folder without a project with a source, or no folder', () => {
    const d = draft({ cwd: '/repos/marina', host: 'big-box' });
    expect(wi.workInSuggestion(d, { mode: 'source', detected: marina, rows })).toBeNull();
    expect(wi.workInSuggestion(d, { mode: 'pick', detected: { project: 'Life', hasSource: false }, rows })).toBeNull();
    expect(wi.workInSuggestion(d, { mode: 'pick', detected: null, rows })).toBeNull();
    expect(wi.workInSuggestion(draft({ cwd: '' }), { mode: 'pick', detected: marina, rows })).toBeNull();
  });
});
