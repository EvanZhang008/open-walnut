/**
 * The Inbox became a real project (`Inbox`, src/core/inbox-project.ts) on 2026-11-21; before it a
 * task in the Inbox said `project: ''`. Everything a project name resolves to (where a task's
 * files live, whether it has a tracking note, the header it sends, how a session hears its place)
 * must answer the same for every spelling of the Inbox, or an Inbox task's files vanish from view
 * after the migration and old '' data reads differently from new `Inbox` data.
 *
 * One row per resolver: a new resolver of a project name belongs in this table.
 */
import { describe, expect, it } from 'vitest';
import { projectDirOf, vaultRules } from '../../src/core/artifacts/unify/layout.js';
import { projectNotesFolderFor, trackingNotePathFor } from '../../src/core/tracking-note.js';
import { INBOX_FOLDER, taskFolderFor } from '../../src/core/drawings/paths.js';
import { requestProjectValue } from '../../src/core/sessions/request-tag.js';
import { projectNamedIn, projectPlaceName, sameProject } from '../../src/core/sessions/caller-placement.js';
import { placeChanges, placeFromPrompt } from '../../src/core/sessions/place-notice.js';
import { isJunkProject } from '../../src/core/task-junk.js';
import { keptFromProviders } from '../../src/core/private-tasks/visibility.js';
import { createdMatches } from '../../src/replica/away-reads.js';

const INBOX_SPELLINGS = ['', '   ', 'Inbox', 'inbox', 'INBOX'];

const RESOLVERS: Record<string, (project: string) => unknown> = {
  'tree folder (artifacts/unify/layout.ts projectDirOf)': (p) => projectDirOf(p),
  'vault notes folder (tracking-note.ts projectNotesFolderFor)': (p) => projectNotesFolderFor(p),
  'tracking note path (tracking-note.ts trackingNotePathFor)': (p) => trackingNotePathFor(p),
  'drawings task folder (drawings/paths.ts taskFolderFor)': (p) => taskFolderFor({ id: 't-1', title: 'Plan', project: p }),
  'request project header (sessions/request-tag.ts)': (p) => requestProjectValue(p),
  'place wording (sessions/caller-placement.ts projectPlaceName)': (p) => projectPlaceName(p),
  'junk project (task-junk.ts)': (p) => isJunkProject(p),
  'kept from providers (private-tasks/visibility.ts)': (p) => keptFromProviders({ source: 'local', project: p }, { Inbox: { source: 'local' } as never }),
};

describe('every resolver of a project name reads each spelling of the Inbox alike', () => {
  for (const [name, resolve] of Object.entries(RESOLVERS)) {
    it(name, () => {
      const answers = INBOX_SPELLINGS.map((p) => resolve(p));
      for (const a of answers) expect(a).toEqual(answers[0]);
    });
  }

  it('keeps the Inbox where it always lived: the tree root, the vault inbox folder, no note, no header', () => {
    expect(projectDirOf('Inbox')).toBeNull();
    expect(projectNotesFolderFor('Inbox')).toBeNull();
    expect(trackingNotePathFor('Inbox')).toBeNull();
    expect(taskFolderFor({ id: 't-1', title: 'Plan', project: 'Inbox' })).toBe(`${INBOX_FOLDER}/Plan (t-1)`);
    expect(requestProjectValue('Inbox')).toBe('');
    expect(projectPlaceName('Inbox')).toBe('the Inbox');
    // An ordinary project still gets its own places.
    expect(projectDirOf('Marina')).toBe('projects/Marina');
    expect(trackingNotePathFor('Marina')).toBe('Projects/Marina/Tracking.md');
    expect(requestProjectValue('Marina')).toBe('Marina');
  });

  it('never moves a vault folder named Inbox into a project of its own', () => {
    const rules = vaultRules({ topFolders: ['Inbox', 'Marina'], projectsFolders: [], projects: ['Inbox', 'Marina'] });
    expect(rules.find((r) => r.from === 'Inbox/')).toBeUndefined();
    expect(rules.find((r) => r.from === 'Marina/')?.to).toBe('projects/Marina/notes/');
  });
});

describe('a session hears the Inbox as one place, however its prompt or task spells it', () => {
  it('treats the empty project and Inbox as the same project', () => {
    expect(sameProject('', 'Inbox')).toBe(true);
    expect(sameProject(undefined, 'inbox')).toBe(true);
    expect(sameProject('Inbox', 'Marina')).toBe(false);
  });

  it('finds the Inbox in the words that name it, for either spelling', () => {
    expect(projectNamedIn('put it in my inbox please', '')).toBe(true);
    expect(projectNamedIn('put it in my inbox please', 'Inbox')).toBe(true);
    expect(projectNamedIn('put it under marina', 'Inbox')).toBe(false);
  });

  it('reads back the old and the new prompt wording, and a task now saying Inbox is no move', () => {
    const old = placeFromPrompt('You are working on the task "T" (id mt-1, the Inbox (no project)).\n', 'mt-1');
    const now = placeFromPrompt('You are working on the task "T" (id mt-1, the Inbox).\n', 'mt-1');
    expect(old?.project).toBe('');
    expect(now?.project).toBe('');
    expect(placeChanges({ project: '' }, { project: 'Inbox' })).toEqual([]);
    expect(placeChanges({ project: '' }, { project: 'Marina' })).toEqual(['the Inbox became project "Marina"']);
  });
});

describe('a project filter of the Inbox matches a row that says either spelling', () => {
  const req = (project: string) => ({ query: { project } }) as never;
  it('a task made while the Mac was away (replica/away-reads.ts createdMatches)', () => {
    for (const filter of ['', 'Inbox']) {
      for (const row of ['', 'Inbox']) expect(createdMatches(req(filter), { id: 't', project: row })).toBe(true);
      expect(createdMatches(req(filter), { id: 't', project: 'Marina' })).toBe(false);
    }
    expect(createdMatches(req('Marina'), { id: 't', project: 'Marina' })).toBe(true);
    expect(createdMatches(req('Marina'), { id: 't', project: 'Inbox' })).toBe(false);
  });
});
