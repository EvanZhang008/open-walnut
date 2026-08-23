/**
 * Dragging a task into another project (TodoPanel).
 *
 * Two pure decisions back that gesture: does the move cross a provider boundary
 * (so the user gets the destructive-archival confirm), and which project run did
 * the card land in. Both are tested without React — the on-screen half lives in
 * the browser specs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveMoveMigration,
  inferTierDropProject,
  sourceDisplayName,
} from '../../web/src/components/tasks/task-move-project';

const registry = new Map<string, string>([
  ['todoproj', 'ms-todo'],
  ['othertodo', 'ms-todo'],
  ['trackerproj', 'tracker'],
  ['localproj', 'local'],
  ['myproj', 'ms-todo'],
]);

describe('resolveMoveMigration', () => {
  it('does not migrate a same-provider move', () => {
    expect(resolveMoveMigration('ms-todo', 'OtherTodo', registry))
      .toEqual({ migrates: false, from: 'ms-todo', to: 'ms-todo' });
  });

  it('does not migrate a local task into a provider-claimed project (folder only)', () => {
    expect(resolveMoveMigration('local', 'TodoProj', registry))
      .toEqual({ migrates: false, from: 'local', to: 'ms-todo' });
  });

  it('migrates provider → a different provider', () => {
    expect(resolveMoveMigration('ms-todo', 'TrackerProj', registry))
      .toEqual({ migrates: true, from: 'ms-todo', to: 'tracker' });
  });

  it('migrates provider → a local-claimed project', () => {
    expect(resolveMoveMigration('ms-todo', 'LocalProj', registry))
      .toEqual({ migrates: true, from: 'ms-todo', to: 'local' });
  });

  it("migrates provider → Inbox ('')", () => {
    expect(resolveMoveMigration('ms-todo', '', registry))
      .toEqual({ migrates: true, from: 'ms-todo', to: 'local' });
  });

  it('does not migrate into a project the registry has never seen', () => {
    // The backend auto-creates the row claimed by the task's own source.
    expect(resolveMoveMigration('ms-todo', 'BrandNew', registry))
      .toEqual({ migrates: false, from: 'ms-todo', to: 'ms-todo' });
  });

  it('treats an undefined source as local', () => {
    expect(resolveMoveMigration(undefined, 'TodoProj', registry))
      .toEqual({ migrates: false, from: 'local', to: 'ms-todo' });
  });

  it('trims the target name before the lookup, like the backend does', () => {
    // An untrimmed miss would silently read as "unknown project → no confirm".
    expect(resolveMoveMigration('ms-todo', '  TrackerProj  ', registry))
      .toEqual({ migrates: true, from: 'ms-todo', to: 'tracker' });
    expect(resolveMoveMigration('ms-todo', '   ', registry))
      .toEqual({ migrates: true, from: 'ms-todo', to: 'local' }); // whitespace-only = Inbox
  });

  it('looks the target project up case-insensitively', () => {
    expect(resolveMoveMigration('tracker', 'MyProj', registry))
      .toEqual({ migrates: true, from: 'tracker', to: 'ms-todo' });
  });
});

describe('inferTierDropProject', () => {
  // 'a'/'b' = project A, 'c'/'d' = project B, 's*' = a group chip sentinel,
  // 'i1'/'i2' = Inbox (''), 'x' = the dragged card (no project of its own here).
  const projects: Record<string, string> = { a: 'A', b: 'A', c: 'B', d: 'B', i1: '', i2: '' };
  const projectOf = (id: string) => projects[id];

  it('returns the run a card landed in the middle of', () => {
    expect(inferTierDropProject(['a', 'x', 'b', 'c', 'd'], 'x', projectOf)).toBe('A');
  });

  it('gives the previous run the boundary between two runs', () => {
    // The next run's folder label renders BELOW the drop point, so visually the
    // card sits at the bottom of run A.
    expect(inferTierDropProject(['a', 'b', 'x', 'c', 'd'], 'x', projectOf)).toBe('A');
  });

  it('uses the next card at the top of a tier', () => {
    expect(inferTierDropProject(['x', 'c', 'd'], 'x', projectOf)).toBe('B');
  });

  it('uses the previous card at the bottom of a tier', () => {
    expect(inferTierDropProject(['a', 'b', 'x'], 'x', projectOf)).toBe('A');
  });

  it('walks past sentinels with no project', () => {
    expect(inferTierDropProject(['a', 's1', 'x', 's2', 'c'], 'x', projectOf)).toBe('A');
    expect(inferTierDropProject(['s1', 's2', 'x', 's3', 'c', 'd'], 'x', projectOf)).toBe('B');
  });

  it('returns null when the tier holds only the dragged card', () => {
    expect(inferTierDropProject(['x'], 'x', projectOf)).toBeNull();
  });

  it('returns null when the dragged id is not in the tier', () => {
    expect(inferTierDropProject(['a', 'b', 'c'], 'x', projectOf)).toBeNull();
  });

  it("returns Inbox ('') as a real value", () => {
    expect(inferTierDropProject(['i1', 'i2', 'x', 'c'], 'x', projectOf)).toBe('');
    expect(inferTierDropProject(['x', 'i1', 'i2'], 'x', projectOf)).toBe('');
  });

  it('takes the NEAREST neighbour, not the farthest (mutation killers)', () => {
    // In a tier rendering runs A A B B, a card dropped at the very bottom is in
    // B; a farthest-prev walk would file it back into A (and vice versa at the
    // top). Both directions once survived mutation testing — keep these.
    expect(inferTierDropProject(['a', 'b', 'c', 'd', 'x'], 'x', projectOf)).toBe('B');
    expect(inferTierDropProject(['x', 'a', 'b', 'c', 'd'], 'x', projectOf)).toBe('A');
  });
});

describe('sourceDisplayName', () => {
  it('maps known provider ids to human names and passes unknowns through', () => {
    expect(sourceDisplayName('ms-todo')).toBe('Microsoft To Do');
    expect(sourceDisplayName('local')).toBe('Local');
    expect(sourceDisplayName('some-plugin')).toBe('some-plugin');
  });
});

describe('every project move funnels through the confirm gate (ratchet)', () => {
  it('TodoPanel invokes onMoveTask in exactly two authorized places', () => {
    // 1. requestMoveTask (single-task gate)  2. batchMoveToProject (batch gate,
    // one dialog for the whole selection). Any new direct call bypasses the
    // cross-provider confirm — route it through requestMoveTask instead.
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../web/src/components/tasks/TodoPanel.tsx'), 'utf8');
    const calls = src.match(/onMoveTask(\?\.)?\(/g) ?? [];
    expect(calls).toHaveLength(2);
  });
});
