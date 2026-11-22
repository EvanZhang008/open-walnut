/**
 * Start a new task from a project (experiment project_first_start), as data
 * (draft-project-start.ts): the row's shape per draft (the flag off keeps today's
 * row), what a project pick writes and what leaving a source gives back (a folder
 * pick included), the value chips of a source's array inputs, the "+ Add" rows, and
 * what Start sends, and the v6 Where field's host and restore writes. The row's own words are
 * draft-work-in.test.ts. The one
 * class every case guards: the row says "fresh workspace" only when Start sends
 * `fromProject`, and a draft off a source never runs in that source's folder.
 */

import { describe, it, expect } from 'vitest';
import { draft, git, plugin } from './helpers/project-start';

const ps = await import('@/components/sessions/draft-project-start');
type DraftColumn = import('@/components/sessions/draft-column').DraftColumn;

describe('projectStartMode', () => {
  const on = { flagOn: true, eligible: true };

  it('the flag off keeps today\'s row, whatever the draft holds', () => {
    for (const d of [draft(), draft({ project: 'Marina', fromProject: true, projectSource: 'user' })]) {
      expect(ps.projectStartMode(d, { ...on, flagOn: false, source: git })).toBe('off');
    }
  });

  it('a draft that cannot start from a project, or chose a folder, keeps today\'s row', () => {
    expect(ps.projectStartMode(draft({ project: 'Marina', fromProject: true }), { ...on, eligible: false, source: git })).toBe('off');
    expect(ps.projectStartMode(draft({ project: 'Marina', fromProject: false }), { ...on, source: git })).toBe('off');
  });

  it('leads with the Project pill until a project with a source is picked', () => {
    expect(ps.projectStartMode(draft(), { ...on, source: null })).toBe('pick');
    // A project without a source keeps the folder flow.
    expect(ps.projectStartMode(draft({ project: 'Life', projectSource: 'user' }), { ...on, source: null })).toBe('pick');
    // A project picked through the folder (not the project) does not start from it.
    expect(ps.projectStartMode(draft({ project: 'Marina', projectSource: 'folder' }), { ...on, source: git })).toBe('pick');
  });

  it('a pick, a project "+" seed, or the parse\'s project, of a project with a source starts from it', () => {
    expect(ps.projectStartMode(draft({ project: 'Marina', projectSource: 'user', fromProject: true }), { ...on, source: git })).toBe('source');
    expect(ps.projectStartMode(draft({ project: 'Marina', projectSource: 'seed' }), { ...on, source: git })).toBe('source');
    expect(ps.projectStartMode(draft({ project: 'Marina', projectSource: 'ai' }), { ...on, source: git })).toBe('source');
    expect(ps.projectStartMode(draft({ project: 'Life', projectSource: 'ai' }), { ...on, source: null })).toBe('pick');
  });

  it('a hand pick whose source this tab lost still starts from the project: the server says why it cannot', () => {
    expect(ps.projectStartMode(draft({ project: 'Marina', fromProject: true }), { ...on, source: null })).toBe('source');
  });
});

describe('pickProjectForStart', () => {
  it('a project with a source puts the draft on its folder and host, keeps the old folder, and resets the chips to the favourites', () => {
    const before = draft({ fromProjectInputs: { packages: ['Zeta'] }, aiFields: new Set(['project', 'cwd']) as DraftColumn['aiFields'] });
    const next = ps.pickProjectForStart(before, 'Marina', git);
    expect(next).toMatchObject({
      project: 'Marina', projectSource: 'user', fromProject: true, cwd: '/repos/marina', host: 'big-box', hostLabel: 'Big box', cwdPinned: true, userTouched: true,
      fromProjectPrev: { cwd: '/home/u', host: null },
    });
    expect(next.fromProjectInputs).toBeUndefined();
    expect(next.aiFields?.has('project')).toBeFalsy();
    expect(next.aiFields?.has('cwd')).toBeFalsy();
  });

  it('this machine is the draft\'s null host', () => {
    expect(ps.pickProjectForStart(draft({ host: 'big-box' }), 'Acme', plugin).host).toBeNull();
  });

  it('a project without a source is today\'s project pick and leaves the folder alone', () => {
    const next = ps.pickProjectForStart(draft({ fromProject: true, cwd: '/home/u/notes' }), 'Life', null);
    expect(next).toMatchObject({ project: 'Life', projectSource: 'user', cwd: '/home/u/notes' });
    expect('fromProject' in next).toBe(false);
  });

  it('a folder pick leaves project-first mode, on the picked folder', () => {
    const on = ps.setSourceValues(ps.pickProjectForStart(draft({ cwd: '/home/u/notes' }), 'Acme', plugin), 'packages', ['Alpha']);
    const next = ps.leaveForFolderPick({ ...on, cwd: '/home/u/other', host: null });
    expect(next).toMatchObject({ fromProject: false, cwd: '/home/u/other', host: null });
    expect(next.fromProjectInputs).toBeUndefined();
    expect(next.fromProjectPrev).toBeUndefined();
  });

  it('after a folder pick, a project with a source puts the draft back on it; one without keeps the folder', () => {
    const off = ps.leaveForFolderPick({ ...ps.pickProjectForStart(draft(), 'Marina', git), cwd: '/home/u', host: null });
    expect(ps.pickProjectForStart(off, 'Marina', git)).toMatchObject({ fromProject: true, cwd: '/repos/marina', host: 'big-box' });
    expect(ps.pickProjectForStart(off, 'Life', null)).toMatchObject({ fromProject: false, cwd: '/home/u', project: 'Life' });
  });

  it('a Work in row of a project without a source brings its own folder and host; More\'s pick keeps the folder', () => {
    const home = { cwd: '/home/u/life', host: 'life-box' };
    expect(ps.pickProjectForStart(draft({ cwd: '/home/u/notes' }), 'Life', null, home, { toHome: true }))
      .toMatchObject({ project: 'Life', cwd: '/home/u/life', host: 'life-box', cwdPinned: false });
    expect(ps.pickProjectForStart(draft({ cwd: '/home/u/notes' }), 'Life', null, home)).toMatchObject({ cwd: '/home/u/notes', host: null });
    // A project with a source starts from it, whatever its default folder.
    expect(ps.pickProjectForStart(draft(), 'Marina', git, home, { toHome: true })).toMatchObject({ cwd: '/repos/marina', host: 'big-box' });
  });
});

describe('leaving a source (the draft never runs in the other project\'s checkout)', () => {
  const onMarina = () => ps.pickStartHost(ps.pickProjectForStart(draft({ cwd: '/home/u/notes', host: null }), 'Marina', git), 'other-box', 'Other box');

  it('source -> no source: back on the folder the draft stood on, nothing pinned', () => {
    const next = ps.pickProjectForStart(onMarina(), 'Life', null);
    expect(next).toMatchObject({ project: 'Life', cwd: '/home/u/notes', host: null, cwdPinned: false, createCwd: false });
    expect(next.hostLabel).toBeUndefined();
    for (const k of ['fromProject', 'fromProjectPrev', 'fromProjectHostPicked', 'fromProjectInputs'] as const) expect(next[k]).toBeUndefined();
    // And its Start is today's folder start.
    expect(ps.draftProjectStart(next, { flagOn: true, eligible: true, rows: [{ name: 'Marina', startSource: git }, { name: 'Life' }] }).mode).toBe('pick');
  });

  it('source -> no source with a default folder: that project\'s own folder and host, as its "+" does', () => {
    const next = ps.pickProjectForStart(onMarina(), 'Life', null, { cwd: '/home/u/life', host: 'life-box' });
    expect(next).toMatchObject({ cwd: '/home/u/life', host: 'life-box', cwdPinned: false });
  });

  it('source -> Inbox: back on the draft\'s own folder', () => {
    expect(ps.pickProjectForStart(onMarina(), '', null)).toMatchObject({ project: '', cwd: '/home/u/notes', host: null, cwdPinned: false });
  });

  it('source A -> source B: B\'s folder and host, the host picked for A dropped, the first folder still kept', () => {
    const next = ps.pickProjectForStart(onMarina(), 'Acme', plugin);
    expect(next).toMatchObject({ project: 'Acme', fromProject: true, cwd: '/ws/multi', host: null, fromProjectPrev: { cwd: '/home/u/notes', host: null } });
    expect(next.fromProjectHostPicked).toBeUndefined();
    expect(ps.projectStartRequest(next, { source: plugin, project: 'Acme' })).toEqual({ project: 'Acme', workspaceInputs: { packages: ['Alpha', 'Beta'] } });
    // And back out of B to a project without a source: the first folder, not A's checkout.
    expect(ps.pickProjectForStart(next, 'Life', null)).toMatchObject({ cwd: '/home/u/notes', host: null });
  });

  it('a folder picked by hand keeps that folder and leaves the source', () => {
    const picked = { ...onMarina(), cwd: '/home/u/other', host: null };
    const next = ps.leaveForFolderPick(picked);
    expect(next).toMatchObject({ fromProject: false, cwd: '/home/u/other' });
    expect(next.fromProjectPrev).toBeUndefined();
    expect(next.fromProjectHostPicked).toBeUndefined();
    const plain = draft();
    expect(ps.leaveForFolderPick(plain)).toBe(plain);
  });

  it('with the Work in pill, a folder pick leaves a source whoever chose it: a "+" seed and the parse too', () => {
    const rows = [{ name: 'Marina', startSource: git }];
    const ctx = { flagOn: true, eligible: true, rows };
    for (const projectSource of ['seed', 'ai'] as const) {
      const d = draft({ project: 'Marina', projectSource });
      expect(ps.draftProjectStart(d, ctx).mode).toBe('source');
      const picked = ps.leaveForFolderPick({ ...d, cwd: '/home/u/other', host: null }, true);
      expect(picked).toMatchObject({ fromProject: false, project: 'Marina', cwd: '/home/u/other' });
      expect(ps.draftProjectStart(picked, ctx).mode).not.toBe('source');
    }
    // A plain folder pick says the same once, and the flag off writes nothing.
    expect(ps.leaveForFolderPick(draft(), true).fromProject).toBe(false);
    const plain = draft();
    expect(ps.leaveForFolderPick(plain, false)).toBe(plain);
  });
});

describe('settleProjectStart (the parse and the "+" seed)', () => {
  it('the parse\'s project with a source puts the draft on it; the parse taking it back gives the folder back', () => {
    const before = draft({ cwd: '/home/u/notes' });
    const ai = { ...before, project: 'Marina', projectSource: 'ai' as const };
    const on = ps.settleProjectStart(before, ai, { active: true, source: git });
    expect(on).toMatchObject({ cwd: '/repos/marina', host: 'big-box', fromProjectPrev: { cwd: '/home/u/notes' } });
    const cleared = { ...on, project: undefined, projectSource: undefined };
    expect(ps.settleProjectStart(on, cleared, { active: true, source: null })).toMatchObject({ cwd: '/home/u/notes', host: null });
  });

  it('a "+" seed of a project with a source starts from it; Start names no host', () => {
    const seed = draft({ project: 'Marina', projectSource: 'seed', cwd: '/home/u' });
    const on = ps.settleProjectStart(seed, seed, { active: true, source: git });
    expect(on).toMatchObject({ cwd: '/repos/marina', host: 'big-box' });
    expect(ps.projectStartRequest(on, { source: git, project: 'Marina' })).toEqual({ project: 'Marina', workspaceInputs: {} });
  });

  it('nothing to do returns the same draft', () => {
    const d = draft({ project: 'Life', projectSource: 'user' });
    expect(ps.settleProjectStart(d, d, { active: true, source: null })).toBe(d);
    const on = ps.pickProjectForStart(draft(), 'Marina', git);
    expect(ps.settleProjectStart(on, on, { active: true, source: git })).toBe(on);
  });

  it('the experiment off leaves a draft on a source back on its folder', () => {
    const on = ps.pickProjectForStart(draft({ cwd: '/home/u/notes' }), 'Marina', git);
    expect(ps.settleProjectStart(on, on, { active: false, source: git })).toMatchObject({ cwd: '/home/u/notes', host: null });
  });
});

describe('value chips', () => {
  it('reads the array fields from the schema, favourites ticked', () => {
    const [f, ...rest] = ps.sourceArrayFields(plugin);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ key: 'packages', title: 'Packages', required: true, values: ['Alpha', 'Beta'], favourites: ['Alpha', 'Beta'] });
  });

  it('a start\'s own list wins over the favourites, an empty one included', () => {
    expect(ps.sourceArrayFields(plugin, { packages: ['Beta', 'Gamma'] })[0].values).toEqual(['Beta', 'Gamma']);
    expect(ps.sourceArrayFields(plugin, { packages: [] })[0].values).toEqual([]);
  });

  it('with no schema, the fields come from the inputs and the suggestions', () => {
    const noSchema = { ...plugin, input_schema: undefined, inputs: { packages: ['Alpha'] }, suggestions: { packages: ['Alpha'], tools: ['Hammer'] } };
    expect(ps.sourceArrayFields(noSchema).map((f) => f.key)).toEqual(['packages', 'tools']);
  });

  it('a git source has no chips', () => {
    expect(ps.sourceArrayFields(git)).toEqual([]);
  });

  it('"+ Add" lists the unchosen suggestions matching the text, then the typed text', () => {
    const f = ps.sourceArrayFields(plugin)[0];
    expect(ps.addOptions(f, '')).toEqual({ suggestions: ['Gamma', 'Delta'], freeText: null });
    expect(ps.addOptions(f, 'ga')).toEqual({ suggestions: ['Gamma'], freeText: 'ga' });
    // A name that is already a row or chosen offers no second "Add".
    expect(ps.addOptions(f, 'gamma').freeText).toBeNull();
    expect(ps.addOptions(f, 'alpha')).toEqual({ suggestions: [], freeText: null });
  });

  it('a chip edit is this start\'s own list, de-duplicated', () => {
    const next = ps.setSourceValues(draft(), 'packages', ['Alpha', 'Alpha', ' Gamma ']);
    expect(next.fromProjectInputs).toEqual({ packages: ['Alpha', 'Gamma'] });
  });
});


describe('projectStartRequest', () => {
  const acme = { source: plugin, project: 'Acme' };

  it('sends the project and the chips; a host only when the person picked one for this start', () => {
    const d = ps.pickProjectForStart(draft(), 'Acme', plugin);
    expect(ps.projectStartRequest(d, acme)).toEqual({ project: 'Acme', workspaceInputs: { packages: ['Alpha', 'Beta'] } });
    const edited = ps.setSourceValues(ps.pickStartHost(d, 'big-box', 'Big box'), 'packages', ['Gamma']);
    expect(ps.projectStartRequest(edited, acme)).toEqual({ project: 'Acme', host: 'big-box', workspaceInputs: { packages: ['Gamma'] } });
    // This machine picked over a remote project host is named, so it wins.
    const local = ps.pickStartHost(ps.pickProjectForStart(draft(), 'Marina', git), null);
    expect(ps.projectStartRequest(local, { source: git, project: 'Marina' })).toMatchObject({ host: '__local__' });
  });

  it('a remote project host is never overridden by the draft\'s own host', () => {
    const d = ps.pickProjectForStart(draft(), 'Marina', git);
    expect(d.host).toBe('big-box');
    expect('host' in (ps.projectStartRequest(d, { source: git, project: 'Marina' }) as object)).toBe(false);
  });

  it('waits when a required list is empty', () => {
    const d = ps.setSourceValues(ps.pickProjectForStart(draft(), 'Acme', plugin), 'packages', []);
    expect(ps.projectStartRequest(d, acme)).toEqual({ error: 'Add at least one of Packages to start' });
  });

  it('a git source sends no inputs', () => {
    expect(ps.projectStartRequest(ps.pickProjectForStart(draft(), 'Marina', git), { source: git, project: 'Marina' })).toEqual({ project: 'Marina', workspaceInputs: {} });
  });

  it('with no source in sight it still sends fromProject\'s project (the server answers), with this start\'s own lists', () => {
    const d = ps.setSourceValues(ps.pickProjectForStart(draft(), 'Acme', plugin), 'packages', ['Beta']);
    expect(ps.projectStartRequest(d, { source: null, project: 'Acme' })).toEqual({ project: 'Acme', workspaceInputs: { packages: ['Beta'] } });
  });
});

describe('draftProjectStart: the one decision the row and the Start share', () => {
  const rows = [{ name: 'Marina', startSource: git }, { name: 'Life' }];
  const ctx = { flagOn: true, eligible: true, rows };

  it('follows a rename: the source, and the project Start sends, are the current name\'s', () => {
    const d = ps.pickProjectForStart(draft(), 'Marina Old', git);
    const renamed = [{ name: 'Marina Bay', startSource: git }, { name: 'Life' }];
    const resolve = (n: string) => (n.toLowerCase() === 'marina old' ? 'Marina Bay' : n);
    const state = ps.draftProjectStart(d, { ...ctx, rows: renamed, resolve });
    expect(state).toMatchObject({ mode: 'source', source: git, project: 'Marina Bay' });
    expect(ps.projectStartRequest(d, state)).toMatchObject({ project: 'Marina Bay' });
  });

  it('a seed or a parse of a renamed project finds its source too', () => {
    const resolve = (n: string) => (n === 'Old' ? 'Marina' : n);
    expect(ps.draftProjectStart(draft({ project: 'Old', projectSource: 'seed' }), { ...ctx, resolve })).toMatchObject({ mode: 'source', source: git, project: 'Marina' });
    // Without the rename followed, the same draft would read as the folder flow.
    expect(ps.draftProjectStart(draft({ project: 'Old', projectSource: 'seed' }), ctx).mode).toBe('pick');
  });

  it('canPick holds after "Choose a folder instead", so a project pick can bring the source back', () => {
    const state = ps.draftProjectStart(draft({ fromProject: false, project: 'Marina' }), ctx);
    expect(state).toMatchObject({ mode: 'off', canPick: true, source: null });
    expect(ps.draftProjectStart(draft(), { ...ctx, flagOn: false }).canPick).toBe(false);
  });
});

describe('startSourceOf and eligibility', () => {
  it('finds a row case-insensitively, by its own name; the Inbox has none', () => {
    const rows = [{ name: 'Marina', startSource: git }, { name: 'Life' }];
    expect(ps.startSourceOf(rows, 'marina')).toEqual({ project: 'Marina', source: git });
    expect(ps.startSourceOf(rows, 'Life').source).toBeNull();
    expect(ps.startSourceOf(rows, '')).toEqual({ project: '', source: null });
  });

  it('bound, fork, Ask Walnut and repair drafts never start from a project', () => {
    expect(ps.projectStartEligible(draft())).toBe(true);
    expect(ps.projectStartEligible(draft({ taskId: 't1' }))).toBe(false);
    expect(ps.projectStartEligible(draft({ forkOf: { sessionId: 's' } }))).toBe(false);
    expect(ps.projectStartEligible(draft({ walnut: true }))).toBe(false);
    expect(ps.projectStartEligible(draft({ intent: 'fix-walnut' }))).toBe(false);
  });
});

describe('the v6 Where field\'s writes: another host, a restored folder', () => {
  it('a folder start on another host keeps its folder; the home folder follows the host', () => {
    const d = draft({ cwd: '/repos/app', host: null, cwdPinned: true });
    expect(ps.moveDraftHost(d, 'big-box', 'Big box', { home: false })).toMatchObject({ cwd: '/repos/app', host: 'big-box', hostLabel: 'Big box', cwdPinned: true, userTouched: true });
    const home = ps.moveDraftHost(draft({ cwd: '/home/u', host: null }), 'big-box', 'Big box', { home: true });
    expect(home).toMatchObject({ cwd: '~', host: 'big-box', cwdPinned: false });
    // Back on this computer: a label never rides a local host.
    expect(ps.moveDraftHost(home, null, 'ignored', { home: false })).toMatchObject({ host: null, hostLabel: undefined });
    expect(ps.homeFolderOn('big-box')).toBe('~');
  });

  it('a start from a source on another host is that start\'s own pick, sent with it', () => {
    const picked = ps.pickStartHost(ps.pickProjectForStart(draft(), 'Marina', git), null);
    expect(picked).toMatchObject({ fromProject: true, host: null, fromProjectHostPicked: true });
    expect(ps.projectStartRequest(picked, { source: git, project: 'Marina' })).toMatchObject({ project: 'Marina', host: '__local__' });
  });

  it('a restored folder leaves the source, is pinned, and is marked kept (it never asks for a fresh workspace)', () => {
    const onSource = ps.pickProjectForStart(draft(), 'Marina', git);
    const back = ps.restoreFolderPlace(ps.pickProjectForStart(onSource, 'Marina', null), '/work/dupfix/', 'big-box', 'Big box');
    expect(back).toMatchObject({ project: 'Marina', projectSource: 'user', fromProject: false, cwd: '/work/dupfix/', host: 'big-box', hostLabel: 'Big box', cwdPinned: true });
    expect(back.fromProjectPrev).toBeUndefined();
    expect(back.workInKept).toBe('big-box::/work/dupfix');
    expect(ps.workInFolderKey({ cwd: '/', host: 'local' })).toBe('__local__::/');
    expect(ps.draftProjectStart(back, { flagOn: true, eligible: true, rows: [{ name: 'Marina', startSource: git }] }).mode).toBe('off');
  });
});

describe('projectStartRefusalWords', () => {
  // Review round 2: the line cut the server's long sentence mid-way.
  it('a project with no code source says it short; any other refusal keeps the server\'s words', () => {
    expect(ps.projectStartRefusalWords({ message: 'Project "Acme" has no code source: set one in its settings (Code source), or pick a folder.', body: { error: 'x', code: 'no-project-source' } }))
      .toBe('No code source: set one in the project\'s settings.');
    expect(ps.projectStartRefusalWords({ message: 'Unknown project "Zed".', body: { code: 'unknown-project' } })).toBe('Unknown project "Zed".');
    expect(ps.projectStartRefusalWords({ message: 'Bad inputs.' })).toBe('Bad inputs.');
  });
});
