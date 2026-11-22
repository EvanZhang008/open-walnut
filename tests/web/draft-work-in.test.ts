/**
 * The new task draft's Project + Where row (experiment project_first_start, v6; draft-work-in.ts
 * and draft-where-menu.ts) as data: what a start from a source makes, which project a folder
 * belongs to (detectProjectForFolder), what Auto makes and whether a host can make it (autoOn, the
 * phone's rule too), the crumbs a folder collapses to, what a project pick restores (derivedPlace:
 * from the folders Walnut already records), the one line under the row, the Recent chips and the
 * Where menu's rows. The class every case guards: a folder names a project only when its code is
 * unmistakably that project's, and the row never claims a place the host cannot run.
 */

import { describe, it, expect } from 'vitest';
import type { WorkingDirEntry } from '@/api/sessions';
import { draft, git, plugin } from './helpers/project-start';

const wi = await import('@/components/sessions/draft-work-in');
const menu = await import('@/components/sessions/draft-where-menu');
const { pathCrumbItems } = await import('@/utils/home-folder');

const dir = (cwd: string, host: string | null, project: string, lastUsed: string, extra: Partial<WorkingDirEntry> = {}): WorkingDirEntry =>
  ({ cwd, host, project, count: 1, lastUsed, ...extra });

describe('sourceMakes and the Project menu order', () => {
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

  it('orders the Project menu: favourites, then with a source, then the rest; a search matches the shown name', () => {
    const rows = [{ name: 'Zed' }, { name: 'Acme', startSource: plugin }, { name: 'Life' }, { name: 'Marina', startSource: git }];
    expect(wi.projectMenuOrder(rows, (n) => n === 'Zed', '').map((r) => r.name)).toEqual(['Zed', 'Acme', 'Marina', 'Life']);
    expect(wi.projectMenuOrder(rows, () => false, 'MAR').map((r) => r.name)).toEqual(['Marina']);
    expect(wi.projectMenuOrder(rows, () => false, 'bay', (n) => (n === 'Life' ? 'Life bay' : n)).map((r) => r.name)).toEqual(['Life']);
  });
});

describe('sendsFolderProject: only a name taken from the folder goes to the server\'s folder rule', () => {
  // 2026-11-21: a folder start in a project's checkout, its project detected, was filed under a
  // new project named after the folder ("app"), because the client asked the server to decide.
  // Review round 1 (M5): the decision is recorded on the draft when the folder sets the project
  // (stampFolderDetection), so a Start right after a reload, the registry not loaded, sends the same.
  const rows = [{ name: 'Marina', startSource: git }, { name: 'Life', defaultCwd: '/home/u/life' }];
  const ctx = { on: true, rows };
  const stamped = (over: Parameters<typeof draft>[0]) => wi.stampFolderDetection(draft(over), ctx);

  it('a project detected by its code, or its own default folder, is recorded and goes as it is', () => {
    for (const d of [
      stamped({ project: 'Marina', projectSource: 'folder', cwd: '/repos/marina', host: 'big-box' }),
      stamped({ project: 'marina', projectSource: 'folder', cwd: '/repos/marina/pkg', host: 'big-box' }),
      stamped({ project: 'Life', projectSource: 'folder', cwd: '/home/u/life' }),
    ]) {
      expect(d.detectedProject?.toLowerCase()).toBe(d.project?.toLowerCase());
      expect(wi.sendsFolderProject(d, true)).toBe(false);
    }
  });

  it('reads the draft only: the registry empty at Start (a reload) changes nothing', () => {
    const d = stamped({ project: 'Marina', projectSource: 'folder', cwd: '/repos/marina', host: 'big-box' });
    // The function takes no registry at all; a stamp an empty registry would make is not applied at Start.
    expect(wi.sendsFolderProject.length).toBe(2);
    expect(wi.sendsFolderProject(d, true)).toBe(false);
    // A refresh against an empty list (the registry not loaded) clears it; MainPage refreshes only once loaded.
    expect(wi.stampFolderDetection(d, { on: true, rows: [] }).detectedProject).toBeUndefined();
  });

  it('a name made from the folder, a project not found there, or the experiment off: the server decides', () => {
    expect(wi.sendsFolderProject(stamped({ project: 'notes', projectSource: 'folder', cwd: '/home/u/notes' }), true)).toBe(true);
    expect(wi.sendsFolderProject(stamped({ project: 'Marina', projectSource: 'folder', cwd: '/home/u/notes' }), true)).toBe(true);
    expect(wi.sendsFolderProject(stamped({ project: 'Marina', projectSource: 'folder', cwd: '/repos/marina', host: null }), true)).toBe(true);
    const off = wi.stampFolderDetection(draft({ project: 'Marina', projectSource: 'folder', cwd: '/repos/marina', host: 'big-box' }), { ...ctx, on: false });
    expect(wi.sendsFolderProject(off, true)).toBe(true);
    // Review round 2: with the experiment off a recorded detection is ignored (today's rule exactly).
    const recorded = stamped({ project: 'Marina', projectSource: 'folder', cwd: '/repos/marina', host: 'big-box' });
    expect(recorded.detectedProject).toBe('Marina');
    expect(wi.sendsFolderProject(recorded, false)).toBe(true);
  });

  it('a stamp names one project: a later project on the row is not covered by it', () => {
    const d = stamped({ project: 'Marina', projectSource: 'folder', cwd: '/repos/marina', host: 'big-box' });
    expect(wi.sendsFolderProject({ ...d, project: 'marina-app' }, true)).toBe(true);
    // The same row back when nothing changed (no re-render loop in the registry effect).
    expect(wi.stampFolderDetection(d, ctx)).toBe(d);
  });

  it('a project the person or a seed chose never goes to the folder rule', () => {
    for (const projectSource of ['user', 'seed', 'ai', undefined] as const) {
      expect(wi.sendsFolderProject(stamped({ project: 'notes', projectSource, cwd: '/home/u/notes' }), true)).toBe(false);
    }
    expect(wi.sendsFolderProject(stamped({ project: '', projectSource: 'folder', cwd: '/home/u/notes' }), true)).toBe(false);
  });
});

describe('workspaceRootsKey and derivedPlace: a cleaned-up Walnut workspace still restores Auto', () => {
  // Review round 1 (H2): a removed workspace under a custom root (or a plugin's) restored a pinned
  // folder that no longer exists.
  it('counts every task workspace, removed ones too', () => {
    const tasks = [
      { workspace: { root: '/scratch/ws/t-1', host: 'big-box', state: 'removed' } },
      { workspace: { root: '/scratch/ws/t-2', host: null, state: 'ready' } },
      { workspace: null },
      {},
    ];
    expect(wi.workspaceRootsKey(tasks)).toBe('__local__\t/scratch/ws/t-2\t\t\nbig-box\t/scratch/ws/t-1\t\t');
    const roots = [{ host: 'big-box', root: '/scratch/ws/t-1' }];
    const dirs = [dir('/scratch/ws/t-1/pkg', 'big-box', 'Marina', '2026-11-20T00:00:00Z')];
    expect(wi.derivedPlace('Marina', dirs, roots)).toEqual({ auto: true, host: 'big-box', at: '2026-11-20T00:00:00Z' });
  });

  it('a task just started from the source is the project\'s place before its session records a folder', () => {
    // Real data, 2026-11-22: a Walnut task started on Auto, then a new draft picking Walnut still
    // said "First time": the session records its folder only once the workspace is ready.
    const key = wi.workspaceRootsKey([
      { project: 'Walnut', created_at: '2026-11-22T06:56:00Z', workspace: { root: '/w/wt/proof-1', host: 'big-box' } },
      { project: 'Life', created_at: '2026-11-22T07:00:00Z', workspace: { root: '/w/wt/life-1', host: null } },
    ]);
    const roots = wi.parseWorkspaceRoots(key);
    expect(wi.derivedPlace('Walnut', [], roots)).toEqual({ auto: true, host: 'big-box', at: '2026-11-22T06:56:00Z' });
    // A folder used later still wins; an older one does not.
    expect(wi.derivedPlace('Walnut', [dir('/code/mine', null, 'Walnut', '2026-11-22T07:10:00Z')], roots)?.cwd).toBe('/code/mine');
    expect(wi.derivedPlace('Walnut', [dir('/code/mine', null, 'Walnut', '2026-11-21T07:10:00Z')], roots)).toEqual({ auto: true, host: 'big-box', at: '2026-11-22T06:56:00Z' });
  });

  it('a folder record with no time never wins over a dated one, and never makes NaN', () => {
    const dirs = [
      dir('/work/undated', null, 'Life', ''),
      dir('/work/dated', null, 'Life', '2026-11-01T00:00:00Z'),
    ];
    expect(wi.derivedPlace('Life', dirs, [])?.cwd).toBe('/work/dated');
    expect(wi.recentPlaces([dir('/a', null, '', ''), dir('/b', null, '', '2026-11-01T00:00:00Z')], () => null).map((p) => p.kind === 'folder' && p.cwd)).toEqual(['/b', '/a']);
  });
});

describe('startReadsDraftWorkspace: the isolated workspace choice is read exactly where its row is mounted', () => {
  // Review round 1 (H1): a folder's isolation default, carried into a project's Auto home folder
  // (no code source), asked for a git worktree of ~ at Start while the row showed nothing.
  it('every start but one from a code source reads it', async () => {
    const ps = await import('@/components/sessions/draft-project-start');
    expect(ps.startReadsDraftWorkspace({ mode: 'source' })).toBe(false);
    for (const mode of ['off', 'pick'] as const) expect(ps.startReadsDraftWorkspace({ mode })).toBe(true);
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

describe('Auto: what it makes, and whether a host can make it', () => {
  const marina = { name: 'Marina', startSource: git };
  const acme = { name: 'Acme', startSource: plugin };
  const life = { name: 'Life', defaultCwd: '/home/u/life', defaultHost: 'big-box' };
  const inbox = { name: 'Notes' };
  const ctx = (knownDirs: WorkingDirEntry[] = []) => ({ hostName: (k: string) => (k === '__local__' ? 'This Mac' : k === 'big-box' ? 'Big box' : k), knownDirs });

  it('says what Auto makes in two or three words', () => {
    expect(wi.autoWhat(marina)).toEqual({ kind: 'git', words: 'New worktree' });
    expect(wi.autoWhat(acme)).toEqual({ kind: 'box', words: 'New Fake multi-repo workspace' });
    expect(wi.autoWhat(life, 'life')).toEqual({ kind: 'folder', words: 'Its folder life' });
    expect(wi.autoWhat(inbox)).toEqual({ kind: 'home', words: 'Home folder' });
    expect(wi.autoWhat(undefined)).toEqual({ kind: 'home', words: 'Home folder' });
  });

  it('runs on the project\'s own host; no project never', () => {
    expect(wi.ownHostOf(marina)).toBe('big-box');
    expect(wi.ownHostOf(acme)).toBe('__local__');
    expect(wi.autoOn(marina, 'big-box', ctx())).toEqual({ ok: true, moved: false });
    expect(wi.autoOn(acme, null, ctx())).toEqual({ ok: true, moved: false });
    expect(wi.autoOn(undefined, null, ctx())).toEqual({ ok: false, reason: wi.NO_PROJECT_REASON, noProject: true });
  });

  it('another host makes a source only where Walnut knows the anchor (or a folder in it) there', () => {
    expect(wi.autoOn(marina, null, ctx())).toEqual({ ok: false, reason: 'This Mac has no Marina checkout.' });
    expect(wi.autoOn(marina, '__local__', ctx([dir('/repos/marina/src', null, 'Marina', '2026-11-20T00:00:00Z')]))).toEqual({ ok: true, moved: true });
    // A sibling whose name only starts the same is not inside it.
    expect(wi.autoOn(marina, null, ctx([dir('/repos/marina-old', null, '', '2026-11-20T00:00:00Z')])).ok).toBe(false);
    expect(wi.autoOn(acme, 'big-box', ctx())).toEqual({ ok: false, reason: 'Big box cannot make a Fake multi-repo workspace.' });
    // The project's own folder lives on its host; the home folder exists everywhere.
    expect(wi.autoOn(life, null, ctx())).toEqual({ ok: false, reason: 'life is on Big box, not on This Mac.' });
    expect(wi.autoOn(inbox, 'big-box', ctx())).toEqual({ ok: true, moved: false });
  });

  it('the Auto row\'s second line: what a pick gives, or the reason in full', () => {
    expect(wi.autoNote(marina, { ok: true, moved: false })).toBe('Fresh copy of the default branch, removed when merged');
    expect(wi.autoNote(marina, { ok: true, moved: true }, { anchorShown: '~/repos/marina' })).toBe('From ~/repos/marina, removed when merged');
    expect(wi.autoNote(acme, { ok: true, moved: false })).toBe('2 packages · A fresh Fake multi-repo workspace, removed when merged');
    expect(wi.autoNote(acme, { ok: true, moved: false }, { picked: { packages: ['Alpha'] } })).toBe('1 package · A fresh Fake multi-repo workspace, removed when merged');
    expect(wi.autoNote(life, { ok: true, moved: false }, { folderShown: '~/life' })).toBe('Works in ~/life');
    expect(wi.autoNote(inbox, { ok: true, moved: false })).toBe('Works in your home folder');
    expect(wi.autoNote(marina, { ok: false, reason: 'This Mac has no Marina checkout.' })).toBe('This Mac has no Marina checkout.');
    expect(wi.autoNote(undefined, { ok: false, reason: wi.NO_PROJECT_REASON, noProject: true })).toBe('Pick a project first: Auto follows the project');
  });
});

describe('the Where field\'s crumbs: the last three parts, then two, then the name; never half a part', () => {
  it('collapses the middle into one ellipsis and keeps each crumb\'s folder for a click', () => {
    const labels = (p: string, keep: number) => pathCrumbItems(p, keep).map((c) => c.label);
    expect(labels('/projects/u/open-walnut', 3)).toEqual(['projects', 'u', 'open-walnut']);
    expect(labels('/a/projects/u/open-walnut', 3)).toEqual(['…', 'projects', 'u', 'open-walnut']);
    expect(labels('/a/projects/u/open-walnut', 2)).toEqual(['…', 'u', 'open-walnut']);
    expect(labels('/a/projects/u/open-walnut', 1)).toEqual(['…', 'open-walnut']);
    expect(labels('~/a/b/c/d', 2)).toEqual(['~', '…', 'c', 'd']);
    expect(labels('/', 3)).toEqual(['/']);
    expect(pathCrumbItems('/a/projects/u/x', 2).map((c) => c.dir)).toEqual(['', '/a/projects/u', '/a/projects/u/x']);
    expect(pathCrumbItems('~/code/app', 3).map((c) => c.dir)).toEqual(['~', '~/code', '~/code/app']);
  });

  it('a menu row\'s path keeps whole parts and the home as ~', () => {
    expect(menu.shownPath('/projects/u/open-walnut')).toBe('/projects/u/open-walnut');
    expect(menu.shownPath('/srv/team/x/y/marina-dupfix')).toBe('…/x/y/marina-dupfix');
    expect(menu.shownPath('/home/u/Downloads', '/home/u')).toBe('~/Downloads');
    expect(menu.shownPath('/home/u', '/home/u')).toBe('~');
  });
});

describe('per-project memory, derived from the folders Walnut records', () => {
  const dirs = [
    dir('/repos/marina', 'big-box', 'Marina', '2026-11-18T00:00:00Z'),
    dir('/home/u/.open-walnut-worktrees/marina/fix-1', 'big-box', 'Marina', '2026-11-20T00:00:00Z'),
    dir('/work/es-dupfix', 'big-box', 'Acme', '2026-11-19T00:00:00Z', { hostLabel: 'Big box' }),
    dir('/ws/acme-123', null, 'Acme', '2026-11-10T00:00:00Z'),
    dir('/tmp/plugin-ws/t-9', null, 'Life', '2026-11-21T00:00:00Z'),
  ];
  const roots = [{ root: '/tmp/plugin-ws/t-9', host: '__local__' }];

  it('the newest folder of the project wins; a worktree or a task workspace there reads as Auto on its host', () => {
    expect(wi.derivedPlace('marina', dirs, roots)).toEqual({ auto: true, host: 'big-box', at: '2026-11-20T00:00:00Z' });
    expect(wi.derivedPlace('Acme', dirs, roots)).toEqual({ auto: false, host: 'big-box', cwd: '/work/es-dupfix', hostLabel: 'Big box', at: '2026-11-19T00:00:00Z' });
    expect(wi.derivedPlace('Life', dirs, roots)).toEqual({ auto: true, host: '__local__', at: '2026-11-21T00:00:00Z' });
    expect(wi.derivedPlace('Never', dirs, roots)).toBeNull();
    expect(wi.derivedPlace('', dirs, roots)).toBeNull();
  });

  it('a change made in this draft wins; a project never used starts on Auto on its usual host', () => {
    const local = { auto: false, host: '__local__', cwd: '/x' };
    expect(wi.placeFor({ name: 'Marina', startSource: git }, local, wi.derivedPlace('Marina', dirs, roots))).toBe(local);
    expect(wi.placeFor({ name: 'Marina', startSource: git }, undefined, null)).toEqual({ auto: true, host: 'big-box', first: true });
    expect(wi.placeKey({ auto: true, host: 'big-box' })).toBe('auto::big-box');
    expect(wi.placeKey({ auto: false, host: 'big-box', cwd: '/a/' })).toBe('big-box::/a');
  });

  it('a folder known only on another host says which; the home folder is everywhere', () => {
    const known = [dir('/repos/marina', 'big-box', '', '2026-11-18T00:00:00Z'), dir('/both', null, '', '2026-11-18T00:00:00Z'), dir('/both', 'big-box', '', '2026-11-18T00:00:00Z')];
    expect(wi.folderElsewhere('/repos/marina', null, known)).toBe('big-box');
    expect(wi.folderElsewhere('/repos/marina', 'big-box', known)).toBeNull();
    expect(wi.folderElsewhere('/both', null, known)).toBeNull();
    expect(wi.folderElsewhere('/never/seen', null, known)).toBeNull();
    expect(wi.folderElsewhere('~', 'big-box', known)).toBeNull();
  });
});

describe('the line under the row: one slot, first match wins', () => {
  const none = { offHost: null, cannot: null, projectHost: 'big-box', restored: null, suggestion: null, moved: false };
  const restored = { project: 'Marina', place: { auto: true, host: 'big-box', at: '2026-11-21T00:00:00Z' } };

  it('a folder on another host, then Auto that cannot run, then Last used, then the suggestion, then Auto moved', () => {
    const all = { ...none, offHost: 'big-box', cannot: 'x', restored, suggestion: { project: 'Marina', makes: 'git worktree' }, moved: true };
    expect(wi.whereLine(all)).toEqual({ kind: 'off-host', other: 'big-box' });
    expect(wi.whereLine({ ...all, offHost: null })).toEqual({ kind: 'cannot', reason: 'x', projectHost: 'big-box' });
    expect(wi.whereLine({ ...all, offHost: null, cannot: null })).toMatchObject({ kind: 'last-used', project: 'Marina' });
    expect(wi.whereLine({ ...all, offHost: null, cannot: null, restored: null })).toMatchObject({ kind: 'suggest' });
    expect(wi.whereLine({ ...none, moved: true })).toEqual({ kind: 'moved', projectHost: 'big-box' });
    expect(wi.whereLine(none)).toBeNull();
  });

  it('Last used reads the folder, Auto or a first time; narrow drops the project', () => {
    const ctx = { hostName: (k: string) => (k === 'big-box' ? 'Big box' : 'This Mac'), folderName: (c: string) => c.split('/').pop()!, ago: () => 'yesterday' };
    const text = (parts: Array<{ text: string }>) => parts.map((p) => p.text).join('');
    expect(text(wi.lastUsedParts({ project: 'Acme', place: { auto: false, host: 'big-box', cwd: '/work/es-dupfix', at: 'x' } }, ctx)))
      .toBe('Last used for Acme: es-dupfix on Big box, yesterday.');
    expect(text(wi.lastUsedParts({ project: 'Acme', place: { auto: false, host: 'big-box', cwd: '/work/es-dupfix', at: 'x' } }, { ...ctx, narrow: true })))
      .toBe('Last used: es-dupfix on Big box, yesterday.');
    expect(text(wi.lastUsedParts(restored, ctx))).toBe('Last used for Marina: Auto on Big box, yesterday.');
    expect(text(wi.lastUsedParts({ project: 'Life', place: { auto: true, host: '__local__', first: true } }, ctx)))
      .toBe('First time with Life: Auto on This Mac, its usual host.');
    expect(wi.lastUsedParts(restored, ctx)[0]).toEqual({ text: 'Last used for Marina:', style: 'b' });
  });
});

describe('Recent chips and the Host menu\'s words', () => {
  it('newest first: a folder of a known project is that project, any other folder itself, never a worktree', () => {
    const dirs = [
      dir('/repos/a', null, 'Marina', '2026-11-19T00:00:00Z'),
      dir('/repos/b', null, 'Marina', '2026-11-21T00:00:00Z'),
      dir('/home/u/notes', null, '', '2026-11-20T00:00:00Z'),
      dir('/home/u/.open-walnut-worktrees/app/x', null, '', '2026-11-22T00:00:00Z'),
      dir('/srv/thing', 'big-box', 'Ghost', '2026-11-18T00:00:00Z'),
    ];
    const known = (n: string) => (n.toLowerCase() === 'marina' ? 'Marina' : null);
    expect(wi.recentPlaces(dirs, known)).toEqual([
      { kind: 'project', project: 'Marina', at: '2026-11-21T00:00:00Z' },
      { kind: 'folder', cwd: '/home/u/notes', host: '__local__', at: '2026-11-20T00:00:00Z' },
      { kind: 'folder', cwd: '/srv/thing', host: 'big-box', at: '2026-11-18T00:00:00Z' },
    ]);
  });

  it('the Host menu\'s second line never repeats the name', () => {
    expect(wi.hostLine(true, true)).toBe('This computer · online');
    expect(wi.hostLine(false, true)).toBe('Remote host · online');
    expect(wi.hostLine(false, false)).toBe('Remote host · offline');
  });
});

describe('the Where menu\'s rows', () => {
  const rows = [{ name: 'Marina', startSource: git }];
  const dirs = [
    dir('/repos/marina/src', 'big-box', 'Marina', '2026-11-21T00:00:00Z'),
    dir('/home/u/Downloads', null, '', '2026-11-01T00:00:00Z'),
    dir('/srv/notes', 'big-box', '', '2026-11-20T00:00:00Z'),
    dir('/home/u/.open-walnut-worktrees/app/x', null, '', '2026-11-22T00:00:00Z'),
  ];
  const ctx = { hostKey: 'big-box', hostName: (k: string) => (k === 'big-box' ? 'Big box' : 'This Mac'), homeOf: (k: string) => (k === '__local__' ? '/home/u' : undefined), rows, current: { cwd: '/srv/notes', host: 'big-box' } };

  it('an empty search: recent folders by host, the draft\'s host first, its project as a tag, the current one marked', () => {
    const s = menu.folderSections(dirs, { ...ctx, query: '' });
    expect(s.map((x) => x.title)).toEqual(['Recent on Big box', 'Recent on This Mac']);
    expect(s[0].rows.map((r) => [r.name, r.project ?? '', r.current])).toEqual([['src', 'Marina', false], ['notes', '', true]]);
    expect(s[1].rows.map((r) => r.path)).toEqual(['~/Downloads']);
  });

  it('a word searches every host, grouped by host with its count', () => {
    expect(menu.folderSections(dirs, { ...ctx, query: 'down' }).map((x) => x.title)).toEqual(['1 on This Mac']);
    expect(menu.folderSections(dirs, { ...ctx, query: 'zzz' })).toEqual([]);
    // The draft's host leads an empty search even with no folder there yet (review: "Recent on
    // This computer" first while the draft ran on Dev box).
    const none = menu.folderSections(dirs, { ...ctx, hostKey: 'devbox', hostName: (k: string) => (k === 'devbox' ? 'Dev box' : k), query: '' });
    expect(none[0]).toEqual({ title: 'Recent on Dev box', rows: [] });
    expect(none.length).toBeGreaterThan(1);
  });

  it('a typed path: its crumbs, "Use this path" and whether the host has it, the level\'s folders', () => {
    expect(menu.isPathQuery('/a')).toBe(true);
    expect(menu.isPathQuery('~')).toBe(true);
    expect(menu.isPathQuery('notes')).toBe(false);
    const listing = { status: 'done' as const, parent: '/repos', exists: true, dirs: ['/repos/marina', '/repos/mail', '/repos/zed'] };
    const seg = menu.typedPathView('/repos/ma', listing);
    expect(seg.crumbs.map((c) => c.label)).toEqual(['repos']);
    expect(seg.use).toEqual({ path: '/repos/ma', validity: 'missing' });
    expect(seg.children).toEqual(['/repos/mail', '/repos/marina']);
    const level = menu.typedPathView('/repos/', listing);
    expect(level.use).toEqual({ path: '/repos', validity: 'valid' });
    expect(level.children).toHaveLength(3);
    expect(menu.typedPathView('/repos/x', undefined).use?.validity).toBe('unknown');
  });
});
