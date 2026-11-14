/**
 * The Home task panel's folds are the user's (2026-11-10 review, U15): a fold the user opened or
 * closed stays that way across a reload, and nothing writes a fold without the user except a
 * locate that reveals a row nothing draws, in the one place that draws it.
 *
 * The reported cases:
 *   - a Completed group opened 51 s before a reload showed open, then folded 9 s after it (the
 *     60 s no-action clock ran from the opening, across the reload);
 *   - opening a completed task opened the project run the user had folded in Pinned (the task is
 *     a pin, but Completed draws it, not its tier) and pushed the list 260 px under the pointer.
 *
 * The class, enumerated from the source: every effect a load drives (`loading`, `tasks`) that
 * writes a fold, and every fold write in the locate effect.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clockFoldChanges,
  FOLD_AUTO_CLOSE_MS,
  foldIsDue,
  foldIsOpen,
  keepLastActions,
  mergeFoldChanges,
  projectFoldKind,
  pruneFolds,
  restartShownFolds,
  setFold,
  statusSectionFoldKind,
} from '../../web/src/components/tasks/section-fold-rule';
import { parentsToAutoOpen, recordAutoOpened } from '../../web/src/components/tasks/auto-open-parents';

const T0 = 1_800_000_000_000;
const SRC = readFileSync(join(__dirname, '../../web/src/components/tasks/TodoPanel.tsx'), 'utf8');
const STORE_SRC = readFileSync(join(__dirname, '../../web/src/components/tasks/useFoldStore.ts'), 'utf8');

/** What a load does to a stored fold store (useFoldStore's initializer). */
const load = (store: Parameters<typeof pruneFolds>[0], kind = statusSectionFoldKind, at = T0) =>
  restartShownFolds(pruneFolds(store, kind, at), kind, at);

describe('a fold the user opened stays open across a reload', () => {
  it('the reported case: Completed opened 51 s before a reload does not fold seconds after it', () => {
    const opened = setFold({}, 'done', true, statusSectionFoldKind, T0);
    const reloadAt = T0 + 51_000;
    const after = load(opened, statusSectionFoldKind, reloadAt);
    expect(foldIsOpen(after, 'done', statusSectionFoldKind)).toBe(true);
    // 9 s after the reload it folded before; now it has its full time from the load.
    expect(foldIsDue(after, 'done', statusSectionFoldKind, reloadAt + 9_000)).toBe(false);
    expect(foldIsDue(after, 'done', statusSectionFoldKind, reloadAt + FOLD_AUTO_CLOSE_MS - 1)).toBe(false);
    // The 60 s no-action rule still holds from there.
    expect(foldIsDue(after, 'done', statusSectionFoldKind, reloadAt + FOLD_AUTO_CLOSE_MS)).toBe(true);
  });

  it('the same for a By project fold', () => {
    const opened = setFold({}, 'list:demo:waiting', true, projectFoldKind, T0);
    const after = load(opened, projectFoldKind, T0 + 58_000);
    expect(foldIsDue(after, 'list:demo:waiting', projectFoldKind, T0 + 58_000 + 30_000)).toBe(false);
  });

  it('a fold whose time ran out while the page was away loads folded', () => {
    const opened = setFold({}, 'done', true, statusSectionFoldKind, T0);
    const after = load(opened, statusSectionFoldKind, T0 + 2 * FOLD_AUTO_CLOSE_MS);
    expect(foldIsOpen(after, 'done', statusSectionFoldKind)).toBe(false);
  });

  it('the user acting in the panel until the page went away keeps it open at the next load', () => {
    const opened = setFold({}, 'done', true, statusSectionFoldKind, T0);
    // Scrolled in the panel 100 s after opening it, then reloaded 30 s later.
    const kept = keepLastActions(opened, opened, statusSectionFoldKind, () => T0 + 100_000);
    expect(foldIsOpen(load(kept, statusSectionFoldKind, T0 + 130_000), 'done', statusSectionFoldKind)).toBe(true);
    // Without it the load would have folded it under the user's hand.
    expect(foldIsOpen(load(opened, statusSectionFoldKind, T0 + 130_000), 'done', statusSectionFoldKind)).toBe(false);
  });

  it('a sticky fold is the user\'s boolean: a load never changes it', () => {
    const folded = setFold({}, 'needs', false, statusSectionFoldKind, T0);
    const open = setFold({}, 'needs', true, statusSectionFoldKind, T0);
    expect(load(folded, statusSectionFoldKind, T0 + 7 * 86_400_000)).toEqual(folded);
    expect(load(open, statusSectionFoldKind, T0 + 7 * 86_400_000)).toEqual(open);
  });

  it('useFoldStore restarts the shown folds at load and writes the last action before the page goes away', () => {
    expect(STORE_SRC).toMatch(/restartShownFolds\(pruneFolds\(parsed, kind, t\), kind, t\)/);
    expect(STORE_SRC).toMatch(/window\.addEventListener\('pagehide', keep\)/);
    expect(STORE_SRC).toMatch(/keepLastActions\(stored, storeRef\.current, kind, lastActionOf\)/);
  });
});

describe('a tab going away never reopens a fold another tab closed', () => {
  it('the reported case: this tab shows Completed open, another tab folded it; the keep leaves it folded', () => {
    const mine = setFold({}, 'done', true, statusSectionFoldKind, T0);
    const stored = {}; // the other tab's fold dropped it
    const kept = keepLastActions(stored, mine, statusSectionFoldKind, () => T0 + 30_000);
    expect(kept).toBe(stored);
    expect(foldIsOpen(kept, 'done', statusSectionFoldKind)).toBe(false);
  });

  it('a fold this tab already folded is not extended from another tab\'s open copy either', () => {
    const stored = setFold({}, 'done', true, statusSectionFoldKind, T0);
    expect(keepLastActions(stored, {}, statusSectionFoldKind, () => T0 + 30_000)).toBe(stored);
  });

  it('an open fold both hold gets the later action, and storage\'s other folds stay as they are', () => {
    const stored = { ...setFold({}, 'done', true, statusSectionFoldKind, T0 + 5_000), needs: true };
    const mine = setFold({}, 'done', true, statusSectionFoldKind, T0);
    expect(keepLastActions(stored, mine, statusSectionFoldKind, () => T0 + 30_000)).toEqual({ done: T0 + 30_000, needs: true });
    // An action older than storage's own time moves nothing.
    expect(keepLastActions(stored, mine, statusSectionFoldKind, () => T0 + 1_000)).toBe(stored);
  });

  it('the clock never folds an opening another tab made after this tab\'s', () => {
    const mine = setFold({}, 'done', true, statusSectionFoldKind, T0);
    const reopened = setFold({}, 'done', true, statusSectionFoldKind, T0 + 50_000);
    expect(mergeFoldChanges(reopened, clockFoldChanges(reopened, mine, { done: undefined }))).toEqual(reopened);
    // The same opening this tab saw run out folds.
    expect(mergeFoldChanges(mine, clockFoldChanges(mine, mine, { done: undefined }))).toEqual({});
  });

  it('guard: storage is written only by the load, a change through write (the clock one filtered) and the keep', () => {
    const persists = [...STORE_SRC.matchAll(/\bpersist\(lsKey, ([^;]*)\);/g)].map((m) => m[1]);
    expect(persists).toEqual([
      'pruned', // the load: read and written at the same moment
      'mergeFoldChanges(stored, clock ? clockFoldChanges(stored, prev, changes) : changes)',
      'next', // the keep: keepLastActions over what storage holds now
    ]);
    // Every clock fold goes through write(.., true); a user's fold through write(..) alone.
    const fold = STORE_SRC.slice(STORE_SRC.indexOf('const foldDue = useCallback('), STORE_SRC.indexOf('}, [kind, now, write]);', STORE_SRC.indexOf('const foldDue = useCallback(')));
    expect(fold.match(/\bwrite\([^)]*\)/g)).toEqual(['write(next, true)']);
    expect(STORE_SRC).not.toMatch(/write\(keepLastActions/);
  });
});

describe('the load-time parent auto-expand opens a parent once, never over the user\'s fold', () => {
  const tasks = [
    { id: 'p1' }, { id: 'c1', parent_task_id: 'p1' },
    { id: 'p2' }, { id: 'c2', parent_task_id: 'p2', status: 'done' },
  ];
  it('a parent with an open subtask opens the first time', () => {
    expect(parentsToAutoOpen(tasks, new Set(), new Set())).toEqual(['p1']);
  });
  it('a parent it opened before, which the user folded since, stays folded', () => {
    expect(parentsToAutoOpen(tasks, new Set(), new Set(['p1']))).toEqual([]);
  });
  it('the panel keeps the record and reads it before opening', () => {
    expect(SRC).toMatch(/const opened = readSetFromStorage\(LS_AUTO_OPENED_PARENTS_KEY\);/);
    expect(SRC).toMatch(/parentsToAutoOpen\(tasks, expandedParents, opened\)/);
  });
  it('a parent archived (not in the loaded tasks) stays in the record, so it is not opened again when it shows', () => {
    const opened = new Set(['archived-parent', 'p1']);
    const kept = recordAutoOpened(opened, []);
    expect(kept).toBe(opened);
    // It comes back (unarchived, or the archive fetched) with an open subtask: not opened again.
    expect(parentsToAutoOpen([{ id: 'archived-parent' }, { id: 'c', parent_task_id: 'archived-parent' }], new Set(), kept)).toEqual([]);
  });
  it('the record adds what a load opened and drops only the oldest past its cap', () => {
    expect([...recordAutoOpened(new Set(['a']), ['b', 'a'])]).toEqual(['a', 'b']);
    expect([...recordAutoOpened(new Set(['a', 'b', 'c']), ['d'], 3)]).toEqual(['b', 'c', 'd']);
  });
  it('guard: no fold or open record in the panel is pruned against the loaded tasks', () => {
    // `tasks` leaves out the archive; a record filtered by it forgets the user's fold of an archived row.
    const prunes = SRC.split('\n').map((l, i) => ({ l, i: i + 1 }))
      .filter(({ l }) => /new Set\(tasks\.map\(/.test(l) || /persistSet\(LS_(AUTO_OPENED_PARENTS|EXPANDED_PARENTS)_KEY, [^)]*filter/.test(l));
    expect(prunes.map(({ l, i }) => `TodoPanel.tsx:${i}: ${l.trim()}`)).toEqual([]);
  });
});

/** Every call that opens or folds something in the panel without a chevron of its own. */
const FOLD_WRITE = /\b(setCollapsedSections|setRunFolds|setFolderFolds|setListOpen|setExpandedParents|setRevealedProjects|expandProject|openStatusSection|toggleProjectFold|setSectionOpenTo|setSectionFold|openJumpFolds|setQueryFoldedProjects|saveListOpen|saveFolds|toggleFolder|toggleFold|toggleJumpFold|closeRunFolds|setAllTiersFolded)\(|\b[a-zA-Z]*Folds\.(setOpen|toggle)\(|revealAncestorsRef\.current\(/;

/** Every `useEffect(` / `useLayoutEffect(` body in TodoPanel, with its dependency list. */
function effects(): Array<{ line: number; body: string; deps: string }> {
  const out: Array<{ line: number; body: string; deps: string }> = [];
  const re = /use(?:Layout)?Effect\(\(\) => \{/g;
  for (let m = re.exec(SRC); m; m = re.exec(SRC)) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') depth++;
      else if (SRC[i] === '}' && --depth === 0) break;
    }
    const deps = /^\s*,\s*\[([^\]]*)\]/.exec(SRC.slice(i + 1, i + 400))?.[1] ?? '';
    out.push({ line: SRC.slice(0, m.index).split('\n').length, body: SRC.slice(m.index, i + 1), deps });
  }
  return out;
}

/** The load-driven effects allowed to write a fold, each with why it never undoes the user's choice. */
const LOAD_WRITERS: Array<{ marker: string; why: string }> = [
  { marker: 'if (loading || !customTiersLoaded || firstVisitDecided.current) return;', why: 'first visit only: returns when the user\'s record exists' },
  { marker: 'const opened = readSetFromStorage(LS_AUTO_OPENED_PARENTS_KEY);', why: 'once per parent, recorded: never over a later fold' },
  { marker: 'const next = pruneFolds(prev, (key) => liveGroupKeys.has(foldedId(key)));', why: 'drops the folds of projects that no longer exist' },
  { marker: 'const stale = [...prev].filter((id) => id.startsWith(\'ct_\') && !live.has(id));', why: 'drops the folds of deleted custom tiers' },
  // Runs on `tasks` (a folded worker's leader is found in them), but only installs the locate
  // callback: each fold it writes sits under `if (locate)`, so only a locate (a click on a task
  // reference) opens anything, never the load.
  { marker: 'revealInSectionRef.current = (t, locate) => {', why: 'installs the locate callback; it opens folds only when a locate calls it' },
];

describe('guard: no load writes a fold the user set', () => {
  it('the scan finds the effects', () => {
    expect(effects().length).toBeGreaterThan(20);
  });

  it('every effect a load drives that writes a fold is listed here with why', () => {
    const loadDriven = effects().filter((e) => /\bloading\b|\btasks\b|\btasks\.length\b|customTiersLoaded|liveGroupKeys/.test(e.deps) && FOLD_WRITE.test(e.body));
    // The locate effect depends on `tasks` (its retry when the task arrives late); it is held
    // to `reveal` by the test below.
    const unlisted = loadDriven.filter((e) => !e.body.includes('// Expand groups and scroll to the task when focusedTaskId changes')
      && !e.body.includes('const isNewFocus = focusedTaskId !== prevFocusedRef.current;')
      && !LOAD_WRITERS.some((w) => e.body.includes(w.marker)));
    expect(unlisted.map((e) => `TodoPanel.tsx:${e.line}`), 'a load-driven effect writes a fold: make it never override a stored user choice and list it in LOAD_WRITERS').toEqual([]);
  });

  it('the locate callback writes a fold only under a locate', () => {
    const body = effects().find((e) => e.body.includes('revealInSectionRef.current = (t, locate) => {'))!.body;
    const lines = body.split('\n');
    const unguarded = lines.map((l, i) => ({ l, i })).filter(({ l, i }) => FOLD_WRITE.test(l)
      && !/\blocate\b/.test(l)
      && !lines.slice(Math.max(0, i - 3), i).some((p) => /if \(locate\) \{/.test(p)));
    expect(unguarded.map(({ l }) => l.trim())).toEqual([]);
  });

  it('every listed writer still exists', () => {
    expect(LOAD_WRITERS.filter((w) => !SRC.includes(w.marker)).map((w) => w.marker)).toEqual([]);
  });
});

describe('guard: a locate writes folds only to reveal a row nothing draws', () => {
  const start = SRC.indexOf('// Expand groups and scroll to the task when focusedTaskId changes');
  const end = SRC.indexOf('}, [focusedTaskId, focusNonce, ', start);
  const effect = SRC.slice(start, end);
  const lines = effect.split('\n');

  it('the effect decides `reveal` from whether the panel already draws the row', () => {
    expect(effect).toContain('const reveal = isUserLocate && !rowShownInPanel(focusedTaskId);');
    expect(effect).toContain('revealInSectionRef.current(task, reveal)');
  });

  it('every fold write in it is gated on `reveal` (never on isUserLocate alone)', () => {
    const ungated: string[] = [];
    lines.forEach((line, i) => {
      if (!FOLD_WRITE.test(line)) return;
      const indent = line.search(/\S/);
      // The guard: this line's own `if (`, else the nearest `if (` opened at a smaller indent.
      let guard = /\bif \(/.test(line) ? line : '';
      for (let j = i - 1; !guard && j >= 0; j--) {
        const l = lines[j];
        if (/^\s*(\} else )?if \(/.test(l) && l.search(/\S/) < indent) guard = l;
      }
      if (!/\breveal\b/.test(guard)) ungated.push(`${line.trim()}  (guard: ${guard.trim() || 'none'})`);
    });
    expect(ungated).toEqual([]);
  });

  it('a pinned row opens its tier and run only when that tier draws it', () => {
    expect(effect).toMatch(/const tierShowsIt = pinnedOnly \|\| wouldBeHidden \|\| tierDrawsRef\.current\(focusedTaskId, tierKey\);/);
    expect(effect).toMatch(/if \(reveal && tierShowsIt\) expandProject\(proj, \{ tier: tierKey \}\);/);
  });

  it('a row a flat status section draws opens only that section', () => {
    expect(effect).toMatch(/if \(reveal && !pinnedOnly && !inStatusSection\) \{\s*setRevealedProjects/);
    expect(effect).toMatch(/if \(reveal && !inStatusSection\) revealAncestorsRef\.current\(task\);/);
  });
});
