import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  RECENT_MAX, minimizeOffStrip, moveChip, parseChips, parseRecent, removeChip, restoreTaskbar, taskbarAfterStripChange, type TaskbarLists,
} from '../../web/src/pages/sessionTaskbar';
import { addSessionColumn, removeSessionColumn, replaceSessionColumn, trimUnlockedToMax, type SessionSlot } from '../../web/src/pages/sessionColumns';

const slot = (id: string, locked = false): SessionSlot => ({ id, locked });
const none = new Set<string>();
const empty: TaskbarLists = { chips: [], recent: [] };
const after = (lists: TaskbarLists, before: SessionSlot[], next: SessionSlot[], minimized = none) =>
  taskbarAfterStripChange(lists, before, next, minimized);

describe('sessionTaskbar: only an explicit Minimize makes a chip (2026-11-07, the user)', () => {
  it('a Minimize makes a chip', () => {
    const before = [slot('a'), slot('b')];
    expect(after(empty, before, removeSessionColumn(before, 'a'), new Set(['a']))).toEqual({ chips: ['a'], recent: [] });
  });

  it('a close with × goes to Recent, never to a chip', () => {
    const before = [slot('a'), slot('b')];
    expect(after({ chips: ['x'], recent: [] }, before, removeSessionColumn(before, 'a'))).toEqual({ chips: ['x'], recent: ['a'] });
  });

  it('a sixth open pushing a column out sends it to Recent, never to a chip', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].map(id => slot(id));
    const next = addSessionColumn(before, 'f', false, 5);
    const evicted = before.find(s => !next.some(c => c.id === s.id))!;
    expect(after(empty, before, next)).toEqual({ chips: [], recent: [evicted.id] });
  });

  it('a lower panel count trims to Recent, never to a chip', () => {
    const before = ['a', 'b', 'c'].map(id => slot(id));
    expect(after(empty, before, trimUnlockedToMax(before, 2))).toEqual({ chips: [], recent: ['c'] });
  });

  it('no strip change without a Minimize ever adds a chip (every way the strip moves)', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    let strip: SessionSlot[] = [];
    let lists: TaskbarLists = { chips: ['z'], recent: [] };
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let step = 0; step < 400; step++) {
      const id = ids[rand(ids.length)]!;
      const move = rand(4);
      const next = move === 0 ? addSessionColumn(strip, id, rand(2) === 0, 5)
        : move === 1 ? removeSessionColumn(strip, id)
          : move === 2 ? trimUnlockedToMax(strip, 1 + rand(4))
            : strip.length ? replaceSessionColumn(strip, strip[0]!.id, id) : strip;
      lists = after(lists, strip, next);
      strip = next;
      expect(lists.chips).toEqual(['z']);
      expect(lists.recent.length).toBeLessThanOrEqual(RECENT_MAX);
      for (const r of lists.recent) expect(strip.some(c => c.id === r)).toBe(false);
    }
  });

  it('Recent is newest first, without repeats, and keeps at most RECENT_MAX', () => {
    let lists = empty;
    let strip = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => slot(id));
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      const next = removeSessionColumn(strip, id);
      lists = after(lists, strip, next);
      strip = next;
    }
    expect(lists.recent).toEqual(['e', 'd', 'c', 'b'].slice(0, RECENT_MAX));
    const back = addSessionColumn(strip, 'c', false, 5);
    lists = after(lists, strip, back);
    expect(lists.recent).not.toContain('c');
  });

  it('a minimized session leaves Recent, and a chip is never also in Recent', () => {
    const before = [slot('a'), slot('b')];
    expect(after({ chips: [], recent: ['a'] }, before, removeSessionColumn(before, 'a'), new Set(['a']))).toEqual({ chips: ['a'], recent: [] });
    expect(minimizeOffStrip({ chips: [], recent: ['q'] }, 'q')).toEqual({ chips: ['q'], recent: [] });
    expect(minimizeOffStrip({ chips: [], recent: [] }, 'draft:1')).toEqual({ chips: [], recent: [] });
  });

  it('a swap in place (plan -> exec, prefix -> full id) is not a session leaving', () => {
    const before = [slot('plan'), slot('b')];
    expect(after(empty, before, replaceSessionColumn(before, 'plan', 'exec'))).toBe(empty);
  });

  it('a collapse onto an id already open is a swap too', () => {
    const before = [slot('abc'), slot('abcdef')];
    expect(after(empty, before, replaceSessionColumn(before, 'abc', 'abcdef'))).toBe(empty);
  });

  it('an old swap does not hide a later minimize of the id it replaced', () => {
    const swapped = replaceSessionColumn([slot('p')], 'p', 'e1');
    const before = [slot('p'), ...swapped];
    expect(after(empty, before, removeSessionColumn(before, 'p'), new Set(['p'])).chips).toEqual(['p']);
  });

  it('an older Walnut\'s mixed taskbar field is read into Recent, never into chips', () => {
    expect(restoreTaskbar(null, null, ['old1', 'old2'])).toEqual({ chips: [], recent: ['old2', 'old1'] });
    expect(restoreTaskbar(undefined, ['r'], ['old1'])).toEqual({ chips: [], recent: ['r', 'old1'] });
    // Once the chips' own field exists (an empty list included), the old field is ignored.
    expect(restoreTaskbar([], null, ['old1'])).toEqual({ chips: [], recent: [] });
    expect(restoreTaskbar(['m'], ['m', 'r'], ['old1'])).toEqual({ chips: ['m'], recent: ['r'] });
  });

  it('drafts and launches on their way never become chips nor Recent', () => {
    const before = [slot('draft:1'), slot('pending:qs'), slot('pending:ws-t1'), slot('a')];
    expect(after(empty, before, [slot('a')], new Set(['draft:1', 'pending:qs']))).toBe(empty);
  });
});

describe('sessionTaskbar: the one way onto the chips (guard)', () => {
  const web = path.resolve(__dirname, '../../web/src');
  const read = (rel: string) => fs.readFileSync(path.join(web, rel), 'utf8');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);

  it('Home marks a session minimized only inside handleMinimizeSession', () => {
    const src = read('pages/MainPage.tsx');
    const marks = [...src.matchAll(/minimizedIdsRef\.current\.add\(/g)];
    expect(marks.length, 'a new path marks a session minimized: only the Minimize click may').toBe(1);
    const fn = src.slice(src.indexOf('const handleMinimizeSession = useCallback'));
    expect(fn.slice(0, fn.indexOf('}, [])'))).toContain('minimizedIdsRef.current.add(');
  });

  it('only Home hands a panel its own Minimize, and only the panel default asks the taskbar', () => {
    const found = { onMinimize: new Set<string>(), request: new Set<string>() };
    for (const file of walk(web)) {
      const rel = path.relative(web, file).split(path.sep).join('/');
      const src = fs.readFileSync(file, 'utf8');
      if (rel === 'utils/taskbar-minimize.ts') continue;
      if (/<SessionPanel\b/.test(src) && /\bonMinimize[=:]/.test(src) && rel !== 'components/sessions/SessionPanel.tsx') found.onMinimize.add(rel);
      if (/requestMinimizeToTaskbar\(/.test(src)) found.request.add(rel);
    }
    expect([...found.onMinimize], "a new host takes Minimize over: list it with the click it is").toEqual(['pages/MainPage.tsx']);
    expect([...found.request], 'a new place puts sessions on the taskbar chips without the Minimize click').toEqual(['components/sessions/panel-minimize.ts']);
  });
});

describe('the taskbar is global (2026-11-08, the user: "this should be global")', () => {
  const web = path.resolve(__dirname, '../../web/src');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx$/.test(e.name) ? [path.join(dir, e.name)] : []);

  /** Every place a session panel renders, by its viewPlace, and whether it draws Minimize. */
  const PLACES: Record<string, { minimize: boolean; why: string }> = {
    'home-column': { minimize: true, why: "Home's columns: the column leaves the strip" },
    'ask-slot': { minimize: true, why: 'the Ask slot hides' },
    'ask-object': { minimize: true, why: 'an Ask drawer closes' },
    'org-side': { minimize: true, why: 'the Org side panel closes' },
    'org-node': { minimize: true, why: "the Org node's chat (it stays: the page has no other)" },
    'notes': { minimize: true, why: 'the Notes chat' },
    'plugin:${pluginId}': { minimize: true, why: "a plugin page's session view" },
    'org-node-card': { minimize: false, why: 'inset: a card inside the node page, not a window of its own' },
    'popout': { minimize: false, why: "a pop-out window: the taskbar is the main window's" },
  };

  it('every session panel render is listed, and draws Minimize unless it is inset or a pop-out', async () => {
    const { minimizeHandler } = await import('../../web/src/components/sessions/panel-minimize');
    const seen = new Set<string>();
    for (const file of walk(web)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<SessionPanel\b([\s\S]*?)\/>/g)) {
        const props = m[1]!;
        const place = /viewPlace=(?:"([^"]+)"|\{`([^`]+)`\})/.exec(props);
        if (!place) continue; // a pass-through (<SessionPanel {...props} />)
        const name = place[1] ?? place[2]!;
        seen.add(name);
        const known = PLACES[name];
        expect(known, `${path.relative(web, file)}: a new session panel place "${name}": list it in PLACES`).toBeDefined();
        const inset = /\binset\b/.test(props);
        const handler = minimizeHandler({ phone: false, viewPlace: name, inset, onClose: () => {} });
        expect(!!handler, `${name}: ${known!.why}`).toBe(known!.minimize);
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(PLACES).sort());
  });

  it('no Minimize on a phone, where there is no taskbar', async () => {
    const { minimizeHandler } = await import('../../web/src/components/sessions/panel-minimize');
    expect(minimizeHandler({ phone: true, viewPlace: 'home-column', inset: false, onMinimize: () => {} })).toBeNull();
  });

  it('the bar is drawn once, by the app shell, under every page', () => {
    const drawers: string[] = [];
    for (const file of walk(web)) {
      const rel = path.relative(web, file).split(path.sep).join('/');
      const src = fs.readFileSync(file, 'utf8');
      if (/<SessionTaskbar\b/.test(src)) drawers.push(`SessionTaskbar:${rel}`);
      if (/<AppTaskbar\b/.test(src)) drawers.push(`AppTaskbar:${rel}`);
    }
    expect(drawers.sort()).toEqual(['AppTaskbar:components/layout/AppShell.tsx', 'SessionTaskbar:components/sessions/AppTaskbar.tsx']);
    const shell = fs.readFileSync(path.join(web, 'components/layout/AppShell.tsx'), 'utf8');
    // Outside the page area and every route, so no page can leave it out.
    expect(shell.indexOf('<AppTaskbar')).toBeGreaterThan(shell.indexOf('{children}'));
  });
});

describe('sessionTaskbar: the chip list', () => {
  it('a chip opened back onto the strip leaves the taskbar', () => {
    const before = [slot('b')];
    expect(after({ chips: ['a', 'c'], recent: [] }, before, addSessionColumn(before, 'a', false, 5)).chips).toEqual(['c']);
  });

  it('keeps join order and adds new chips at the end, once', () => {
    const before = [slot('a'), slot('b')];
    expect(after({ chips: ['z', 'a'], recent: [] }, before, [], new Set(['a', 'b'])).chips).toEqual(['z', 'a', 'b']);
  });

  it('returns the same lists when nothing changed', () => {
    const lists = { chips: ['a'], recent: ['c'] };
    const cols = [slot('b')];
    expect(after(lists, cols, cols)).toBe(lists);
  });

  it('× removes a chip; a drag moves it', () => {
    expect(removeChip(['a', 'b'], 'a')).toEqual(['b']);
    expect(moveChip(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(moveChip(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a']);
  });

  it('reads only real session ids back from storage, deduplicated', () => {
    expect(parseChips(['a', 'a', 'draft:1', 'pending:x', 3, null, 'b'])).toEqual(['a', 'b']);
    expect(parseChips('nope')).toEqual([]);
    expect(parseRecent(['a', 'b', 'c', 'd', 'e', 'f'], ['b'])).toEqual(['a', 'c', 'd', 'e'].slice(0, RECENT_MAX));
  });
});
