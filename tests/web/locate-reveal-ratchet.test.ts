/**
 * Ratchet: every fold the home task panel keeps is opened by a locate.
 *
 * 2026-11-02 (mail-ask-drawer S4-11): Find on Home left its task in a folded status section. The
 * class is every place that hides a row from above: a status section, a project's status fold, a
 * tier, a project run in a tier, a project in the list, the list itself, a project folded for the
 * active filter, a folder, a collapsed parent. Each one is a piece of state in TodoPanel, and each
 * one a locate must open (the focus effect, `revealAncestorsRef`, `revealInSectionRef`), or the
 * located row stays hidden in it.
 *
 * This test lists every fold-like state TodoPanel declares, read from the source. A new one fails
 * here until it is entered below with the call the locate code makes to open it (checked to be in
 * that code), or with why it hides no row. The browser half of the guard, one case per place, is
 * tests/e2e/browser/locate-keeps-task-shown.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(join(__dirname, '../../web/src/components/tasks/TodoPanel.tsx'), 'utf8');

/** The source between two markers (the first marker included), failing loudly when one moved. */
function region(from: string, to: string): string {
  const start = SRC.indexOf(from);
  expect(start, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  const end = SRC.indexOf(to, start + from.length);
  expect(end, `end marker not found after: ${from}`).toBeGreaterThan(start);
  return SRC.slice(start, end + to.length);
}

/** Everything a locate runs: the focus effect, the ancestor/folder reveal, the section reveal, and
 *  the override's section opener. */
const LOCATE_CODE = [
  region('// Expand groups and scroll to the task when focusedTaskId changes', '}, [focusedTaskId, focusNonce, tasks, favorites, holdMoveTick]);'),
  region('revealAncestorsRef.current = (task: Task) => {', '\n  };\n'),
  region('revealInSectionRef.current = (t, locate) => {', '\n    };\n'),
  region('// Only for a locate: a page-load restore never opens (and saves) a section the user folded.', '}, [overrideId, overrideSection]);'),
].join('\n');

type Entry = { opens: string } | { hidesNoRow: string };

/** Every fold-like state of TodoPanel, and how a locate opens it. */
const KNOWN: Record<string, Entry> = {
  collapsedSections: { opens: 'setCollapsedSections(' },        // Pinned, a tier, the list under Tasks
  runFolds: { opens: 'expandProject(' },                         // a project's run in a tier
  listOpen: { opens: 'setRevealedProjects(' },                   // a list project: opened for the visit
  revealedProjects: { opens: 'setRevealedProjects(' },
  queryFoldedProjects: { opens: 'setQueryFoldedProjects(' },     // a list project folded for the active filter
  expandedParents: { opens: 'setExpandedParents(' },             // every collapsed parent up the chain
  folderFolds: { opens: 'setFolderFolds(' },                     // a folder, in its tier or the list
  sectionFolds: { opens: 'openStatusSection(' },                 // a status section (the jump's own fold while a project jump is on)
  openProjectFolds: { opens: 'toggleProjectFold(' },             // a project's Waiting / Completed fold
  listBatch: { hidesNoRow: 'cutRows always draws the focused row past the batch' },
  folderTargetId: { hidesNoRow: 'the folder a drag hovers, not a fold' },
  newProjectOpen: { hidesNoRow: 'the new-project name row' },
  open: { hidesNoRow: 'InlineAdd\'s own input, not a place rows sit in' },
};

const FOLD_LIKE = /fold|collaps|expand|open|reveal|hidden|shown|batch/i;

function declaredFoldStates(): string[] {
  const names = new Set<string>();
  for (const m of SRC.matchAll(/const \[(\w+), (\w+)\] = (use\w+)/g)) if (FOLD_LIKE.test(m[1])) names.add(m[1]);
  // A fold kept in a fold store (useFoldStore, the one fold rule) rather than a useState pair.
  for (const m of SRC.matchAll(/const (\w+) = useFoldStore\(/g)) names.add(m[1]);
  return [...names].sort();
}

describe('locate reveal ratchet', () => {
  it('finds the fold states (the scan still reads the source)', () => {
    expect(declaredFoldStates()).toEqual(expect.arrayContaining(['collapsedSections', 'expandedParents', 'folderFolds', 'sectionFolds']));
  });

  it('every fold-like state of TodoPanel is listed with how a locate opens it', () => {
    const unlisted = declaredFoldStates().filter((name) => !(name in KNOWN));
    expect(unlisted, 'a new fold state: open it in the locate code (TodoPanel focus effect / revealAncestorsRef) and list it here').toEqual([]);
  });

  it('the locate code really makes each opening call', () => {
    const missing = Object.entries(KNOWN)
      .filter(([, e]) => 'opens' in e && !LOCATE_CODE.includes(e.opens))
      .map(([name, e]) => `${name}: ${(e as { opens: string }).opens}`);
    expect(missing).toEqual([]);
  });

  it('no listed state is gone from the source (keep the list honest)', () => {
    const stale = Object.keys(KNOWN).filter((name) => !declaredFoldStates().includes(name));
    expect(stale).toEqual([]);
  });

  it('a locate holds its task while it moves, and a person\'s gesture in the panel lets go', () => {
    expect(LOCATE_CODE).toContain('locateHoldRef.current = pendingHoldRef.current ?');
    expect(SRC).toMatch(/onPointerDownCapture=\{endLocateHold\}/);
    expect(SRC).toMatch(/setHoldMoveTick\(/);
  });
});
