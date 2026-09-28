/**
 * The draft launch bar's Project chip and the More menu's provenance line, as
 * data (draft-project-chip.ts): when the row states the project at all, the
 * "New project:" wording for a project Start will create, what a click does per
 * draft kind, and the one-line "why" under the menu's Project row.
 */

import { describe, it, expect } from 'vitest';

const chip = await import('@/components/sessions/draft-project-chip');
type DraftColumn = import('@/components/sessions/draft-column').DraftColumn;

const KNOWN = new Set(['acme', 'marina']);
const isKnown = (n: string) => KNOWN.has(n.toLowerCase());
const AI = new Set(['project']) as DraftColumn['aiFields'];

function draft(over: Partial<DraftColumn> = {}): DraftColumn {
  return { id: 'draft:t-1', cwd: '', host: null, meta: {} as DraftColumn['meta'], ...over };
}

const plain = { isKnownProject: isKnown, hasMenu: true };

describe('draftProjectChip visibility', () => {
  it('a fresh draft states nothing about the project', () => {
    expect(chip.draftProjectChip(draft(), plain)).toBeNull();
  });

  it('an explicit Inbox pick stays visible', () => {
    const c = chip.draftProjectChip(draft({ project: '', projectSource: 'user' }), plain);
    expect(c).toMatchObject({ key: 'Project:', name: 'Inbox', isNew: false, action: 'menu' });
    expect(c?.title).toBe('Your pick: no project. Change it in More.');
  });

  it('Ask Walnut drafts never show it', () => {
    expect(chip.draftProjectChip(draft({ walnut: true, project: 'Ask Walnut', projectSource: 'seed' } as Partial<DraftColumn>), plain)).toBeNull();
  });
});

describe('draftProjectChip copy', () => {
  it('a folder-owned project reads Project: and says where it came from', () => {
    const c = chip.draftProjectChip(draft({ cwd: '/w/acme', project: 'Acme', projectSource: 'folder' }), plain);
    expect(c).toMatchObject({ key: 'Project:', name: 'Acme', isNew: false, ai: false });
    expect(c?.title).toBe('Tasks from this folder file under Acme. Change it in More.');
  });

  it('a project Start will create reads New project: with the create sentence', () => {
    const c = chip.draftProjectChip(draft({ cwd: '/w/notes-lab', project: 'notes-lab', projectSource: 'folder' }), plain);
    expect(c).toMatchObject({ key: 'New project:', name: 'notes-lab', isNew: true });
    expect(c?.title).toBe('Starting creates a new project named notes-lab. Change it in More.');
  });

  it('an AI pick carries the mark and says so', () => {
    const d = draft({ project: 'Marina', projectSource: 'ai', aiFields: AI });
    const c = chip.draftProjectChip(d, plain);
    expect(c).toMatchObject({ ai: true, isNew: false });
    expect(c?.title).toBe('Walnut picked Marina from what you typed. Change it in More.');
    const n = chip.draftProjectChip({ ...d, project: 'Orchard' }, plain);
    expect(n?.key).toBe('New project:');
    expect(n?.title).toContain('Starting creates it.');
  });

  it('a seeded project says it was set on open', () => {
    const c = chip.draftProjectChip(draft({ project: 'Acme', projectSource: 'seed' }), plain);
    expect(c?.title).toBe('Set when this draft opened. Change it in More.');
  });

  it('without More the hint points at the chip itself', () => {
    const c = chip.draftProjectChip(draft({ project: 'Acme', projectSource: 'user' }), { isKnownProject: isKnown, hasMenu: false });
    expect(c).toMatchObject({ action: 'flyout', title: 'Your pick. Click to change it.' });
  });
});

describe('draftProjectChip per draft kind', () => {
  it('a bound draft always shows its task project, never as new, and moves the task', () => {
    const c = chip.draftProjectChip(draft({ taskId: 't-1', project: 'Whatever' }), plain);
    expect(c).toMatchObject({ key: 'Project:', name: 'Whatever', isNew: false, action: 'flyout' });
    expect(c?.title).toBe('This task is filed under Whatever. Picking another project moves the task now.');
    expect(chip.draftProjectChip(draft({ taskId: 't-1' }), plain)?.name).toBe('Inbox');
  });

  it('a fork shows a disabled fact', () => {
    const d = draft({ forkOf: { sessionId: 's', taskId: 't', title: 'x' }, project: 'Unknown' } as Partial<DraftColumn>);
    expect(chip.draftProjectChip(d, plain)).toMatchObject({ action: 'none', isNew: false, name: 'Unknown' });
  });
});

describe('draftProjectProvenance', () => {
  const why = (over: Partial<DraftColumn>) => chip.draftProjectProvenance(draft(over), isKnown);
  it('covers every source', () => {
    expect(why({})).toBe('Inbox until you pick a folder or a project');
    expect(why({ cwd: '/w/web', project: 'Acme', projectSource: 'folder' })).toBe('Set by the folder web');
    expect(why({ cwd: '/w/notes-lab/', project: 'notes-lab', projectSource: 'folder' }))
      .toBe('New, created when you start (named after the folder)');
    expect(why({ project: 'Marina', projectSource: 'ai', aiFields: AI })).toBe("Walnut's pick from what you typed");
    expect(why({ project: 'Orchard', projectSource: 'ai', aiFields: AI }))
      .toBe("Walnut's pick from what you typed, created when you start");
    expect(why({ project: 'Acme', projectSource: 'seed' })).toBe('Set when this draft opened');
    expect(why({ project: 'Acme', projectSource: 'user' })).toBe('Your pick');
    expect(why({ project: '', projectSource: 'user' })).toBe('Your pick: no project');
  });
});
