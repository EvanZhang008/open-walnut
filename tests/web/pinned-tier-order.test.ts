/**
 * The phone's pinned board follows the WEB console's pinned-tier order.
 *
 * The home TodoPanel orders each pinned tier with `orderPinnedTier`
 * (web/src/utils/pinned-tier-order.ts). The iOS board runs a Swift twin
 * (ios-native/Walnut/Views/Tasks/PinnedTierOrder.swift) inside
 * `BoardModel.assemble`. A past parity bug here came from porting a rule by
 * reading it instead of running it, so the expected orders below are PRODUCED
 * by the web function over one shared neutral fixture, and the Swift suite
 * (ios-native/WalnutTests/PinnedTierOrderTests.swift) replays the same fixture
 * against the same expected file, through the twin AND through the real board
 * assembly.
 *
 * If the web rule changes on purpose, regenerate with
 *   UPDATE_PINNED_TIER_ORDER=1 ./node_modules/.bin/vitest run tests/web/pinned-tier-order.test.ts
 * and then make the Swift suite pass again: that is the point of the file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { orderPinnedTier, type PinnedTierMode, type PinnedTierRow } from '../../web/src/utils/pinned-tier-order';

const DIR = path.resolve(import.meta.dirname, '../fixtures/pinned-tier-order');
const CASES = path.join(DIR, 'cases.json');
const EXPECTED = path.join(DIR, 'expected.json');
const TODO_PANEL = path.resolve(import.meta.dirname, '../../web/src/components/tasks/TodoPanel.tsx');

interface FixtureTask extends PinnedTierRow {
  title: string;
  status: string;
  phase: string;
  project: string;
  pinned?: boolean;
  pin_order?: number;
  focus_tier?: string;
  start_date?: string;
  parent_task_id?: string;
}

interface Fixture {
  cases: Array<{ name: string; mode: PinnedTierMode; projectOrder: string[]; rows: PinnedTierRow[] }>;
  board: {
    now: string;
    customTiers: Array<{ id: string; label: string }>;
    projectOrder: string[];
    tasks: FixtureTask[];
  };
}

interface Run { project: string; folder: string | null; ids: string[] }
interface View { ids: string[]; runs: Run[]; showDone: string[] }

const fixture = JSON.parse(fs.readFileSync(CASES, 'utf8')) as Fixture;
const BUILTIN = ['focus', 'satellite', 'backlog', 'wait'];

const isDone = (t: FixtureTask) => t.status === 'done' || t.phase === 'COMPLETE';

/** The server's splitTiers (src/core/task-manager.ts): pinned rows, pin_order ascending
 *  (stable, a missing order reads as 0), bucketed by focus_tier; satellite is everything
 *  not in a built-in or REGISTERED custom tier. This is what the phone's split carries. */
function serverSplit(tasks: FixtureTask[], customIds: Set<string>) {
  const pinned = tasks.filter((t) => t.pinned).sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
  const inTier = (tier: string) => pinned.filter((t) => t.focus_tier === tier).map((t) => t.id);
  const custom: Record<string, string[]> = {};
  for (const id of customIds) custom[id] = inTier(id);
  return {
    pinned_tasks: pinned.map((t) => t.id),
    focus_tasks: inTier('focus'),
    satellite_tasks: pinned
      .filter((t) => !(t.focus_tier && (['focus', 'backlog', 'wait'].includes(t.focus_tier) || customIds.has(t.focus_tier))))
      .map((t) => t.id),
    backlog_tasks: inTier('backlog'),
    wait_tasks: inTier('wait'),
    custom_tier_tasks: custom,
  };
}

/** The web's "Now" filter (TodoPanel matchesDateFilter): hidden while the effective
 *  start date, inherited from the parent chain, is still in the future. */
function deferred(task: FixtureTask, all: FixtureTask[], nowMs: number): boolean {
  let current: FixtureTask | undefined = task;
  let start = task.start_date;
  for (let i = 0; !start && current?.parent_task_id && i < 10; i++) {
    current = all.find((t) => t.id.startsWith(current!.parent_task_id!));
    start = current?.start_date;
  }
  if (!start) return false;
  const at = start.includes('T') ? new Date(start) : (() => {
    const [y, m, d] = start.split('-').map(Number);
    return new Date(y, m - 1, d);
  })();
  return at.getTime() > nowMs;
}

function runsOf(ids: string[], byId: Map<string, FixtureTask>, mode: PinnedTierMode): Run[] {
  const runs: Run[] = [];
  for (const id of ids) {
    const t = byId.get(id)!;
    const project = t.project || '';
    const folder = mode === 'project' ? (t.group_id || null) : null;
    const last = runs[runs.length - 1];
    if (last && last.project === project && last.folder === folder) last.ids.push(id);
    else runs.push({ project, folder, ids: [id] });
  }
  return runs;
}

/** The phone's `show done (N)` expansion of one tier (the console shows no completed pin
 *  outside search, so this half is the phone's own). The open rows keep exactly the
 *  console's order; a done row keeps its pin place.
 *   - custom: a done row follows the open row it follows when every row takes part;
 *   - project: the open rows alone place every group (then the groups only done rows
 *     have), and each group lists its rows, done ones included, in pin order. */
function phoneShowDone(
  rows: FixtureTask[], mode: PinnedTierMode, projectOrder: string[], visible: (t: FixtureTask) => boolean,
): string[] {
  const open = rows.filter((t) => !isDone(t));
  const shown = (t: FixtureTask) => isDone(t) || visible(t);
  if (mode === 'custom') {
    const following = new Map<string, string[]>();
    const leading: string[] = [];
    let lastOpen: string | null = null;
    for (const id of orderPinnedTier(rows, 'custom')) {
      const t = rows.find((r) => r.id === id)!;
      if (!isDone(t)) { lastOpen = id; continue; }
      if (lastOpen) following.set(lastOpen, [...(following.get(lastOpen) ?? []), id]);
      else leading.push(id);
    }
    const merged = [...leading, ...orderPinnedTier(open, 'custom').flatMap((id) => [id, ...(following.get(id) ?? [])])];
    return merged.filter((id) => shown(rows.find((r) => r.id === id)!));
  }
  const layout = [
    ...orderPinnedTier(open, 'project', projectOrder),
    ...orderPinnedTier(rows, 'project', projectOrder).filter((id) => isDone(rows.find((r) => r.id === id)!)),
  ];
  const folderProject = new Map<string, string>();
  const place = new Map<string, number>();
  layout.forEach((id, index) => {
    const t = rows.find((r) => r.id === id)!;
    const folder = t.group_id || '';
    if (folder && !folderProject.has(folder)) folderProject.set(folder, t.project || '');
    const project = folderProject.get(folder) ?? (t.project || '');
    if (!place.has(`p:${project}`)) place.set(`p:${project}`, index);
    if (folder && !place.has(`f:${folder}`)) place.set(`f:${folder}`, index);
  });
  const groups = new Map<string, Map<string, string[]>>();
  for (const t of rows.filter(shown)) {
    const folder = t.group_id || '';
    const project = folderProject.get(folder) ?? (t.project || '');
    if (!groups.has(project)) groups.set(project, new Map());
    const inProject = groups.get(project)!;
    inProject.set(folder, [...(inProject.get(folder) ?? []), t.id]);
  }
  const byPlace = (key: (k: string) => string) => (a: string, b: string) => place.get(key(a))! - place.get(key(b))!;
  return [...groups.keys()].sort(byPlace((p) => `p:${p}`)).flatMap((project) => {
    const inProject = groups.get(project)!;
    const folderIds = [...inProject.keys()].filter((f) => f !== '').sort(byPlace((f) => `f:${f}`));
    return ['', ...folderIds].flatMap((f) => inProject.get(f) ?? []);
  });
}

function computeExpected() {
  const cases: Record<string, string[]> = {};
  for (const c of fixture.cases) cases[c.name] = orderPinnedTier(c.rows, c.mode, c.projectOrder);

  const { board } = fixture;
  const customIds = new Set(board.customTiers.map((t) => t.id));
  const tiers = [...BUILTIN, ...board.customTiers.map((t) => t.id)];
  const byId = new Map(board.tasks.map((t) => [t.id, t]));
  const nowMs = Date.parse(board.now);
  // useFocusBar: pinned rows by pin_order, tier from focus_tier (unregistered → satellite).
  const orderedPinned = board.tasks.filter((t) => t.pinned).sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
  const tierOf = (t: FixtureTask) => (t.focus_tier && (['focus', 'backlog', 'wait'].includes(t.focus_tier) || customIds.has(t.focus_tier)))
    ? t.focus_tier : 'satellite';
  const views: Record<string, View> = {};
  for (const scope of [...tiers, 'all']) {
    const scoped = orderedPinned.filter((t) => scope === 'all' || tierOf(t) === scope);
    for (const mode of ['project', 'custom'] as PinnedTierMode[]) {
      // The console orders each tier on its own. The phone's `All` scope has no console
      // twin: its custom view is the tiers in turn, its project view runs the same rule
      // over every tier's rows in tier order (Focus, Satellite, …).
      const tierRows = (want: (t: FixtureTask) => boolean) => (scope === 'all' && mode === 'custom'
        ? tiers.flatMap((tier) => orderPinnedTier(orderedPinned.filter((t) => tierOf(t) === tier && want(t)), mode, board.projectOrder))
        : orderPinnedTier(
          (scope === 'all' ? tiers.flatMap((tier) => orderedPinned.filter((t) => tierOf(t) === tier)) : scoped).filter(want),
          mode, board.projectOrder,
        ));
      const open = tierRows((t) => !isDone(t));
      // The phone's `All` scope: its custom view is the tiers in turn, its project view
      // the tiers' rows concatenated in tier order (see above).
      const rowsOf = (tier: string) => orderedPinned.filter((t) => tierOf(t) === tier);
      for (const date of ['all', 'now']) {
        const visibleTask = (t: FixtureTask) => date === 'all' || !deferred(t, board.tasks, nowMs);
        const ids = open.filter((id) => visibleTask(byId.get(id)!));
        // A completed row is never hidden by the date filter (web and phone alike).
        const showDone = scope !== 'all'
          ? phoneShowDone(scoped, mode, board.projectOrder, visibleTask)
          : mode === 'custom'
            ? tiers.flatMap((tier) => phoneShowDone(rowsOf(tier), mode, board.projectOrder, visibleTask))
            : phoneShowDone(tiers.flatMap(rowsOf), mode, board.projectOrder, visibleTask);
        views[`${scope}/${mode}/${date}`] = { ids, runs: runsOf(ids, byId, mode), showDone };
      }
    }
  }
  return { cases, board: { split: serverSplit(board.tasks, customIds), views } };
}

describe('pinned tier order (web ⇄ iOS parity fixture)', () => {
  const expected = computeExpected();

  it('the expected file is what the web code produces', () => {
    if (process.env.UPDATE_PINNED_TIER_ORDER === '1') {
      fs.writeFileSync(EXPECTED, `${JSON.stringify(expected, null, 1)}\n`);
    }
    const onDisk = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
    expect(onDisk).toEqual(expected);
  });

  it('covers the board at the density of a real one', () => {
    const pinned = fixture.board.tasks.filter((t) => t.pinned);
    expect(pinned.length).toBeGreaterThanOrEqual(60);
    expect(pinned.some(isDone)).toBe(true);
    expect(pinned.some((t) => t.group_id)).toBe(true);
    expect(pinned.some((t) => t.pin_order === undefined)).toBe(true);
    expect(new Set(pinned.map((t) => t.pin_order)).size).toBeLessThan(pinned.length);
  });

  it('the useFocusBar tier derivation and the server split agree on the fixture', () => {
    const split = expected.board.split;
    const customIds = new Set(fixture.board.customTiers.map((t) => t.id));
    const orderedPinned = fixture.board.tasks.filter((t) => t.pinned).sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
    expect(orderedPinned.filter((t) => t.focus_tier === 'focus').map((t) => t.id)).toEqual(split.focus_tasks);
    expect(split.satellite_tasks).toContain('t98');
    expect([...customIds]).toEqual(Object.keys(split.custom_tier_tasks));
  });

  it('a new pin lands at the foot of its project group, not at the top', () => {
    const focus = expected.board.views['focus/project/all'];
    const run = focus.runs.find((r) => r.project === 'Orchard' && r.folder === null)!;
    expect(run.ids[run.ids.length - 1]).toBe('t99');
    expect(focus.ids[0]).not.toBe('t99');
  });

  it('a hidden row still anchors its folder: the Now filter never reorders what stays', () => {
    for (const [key, view] of Object.entries(expected.board.views)) {
      if (!key.endsWith('/now')) continue;
      const all = expected.board.views[key.replace(/\/now$/, '/all')].ids;
      expect(view.ids).toEqual(all.filter((id) => view.ids.includes(id)));
    }
  });

  it('show done never moves an open row, and the fixture has done rows that would', () => {
    for (const [key, view] of Object.entries(expected.board.views)) {
      const open = new Set(view.ids);
      expect(view.showDone.filter((id) => open.has(id)), key).toEqual(view.ids);
    }
    // A done row that leads its folder (or its project) orders the tier differently when
    // it takes part, which is exactly why the open rows are ordered on their own.
    const { board } = fixture;
    const pinned = board.tasks.filter((t) => t.pinned).sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
    const differs = (mode: PinnedTierMode) => BUILTIN.concat(board.customTiers.map((t) => t.id)).some((tier) => {
      const rows = pinned.filter((t) => (t.focus_tier ?? 'satellite') === tier);
      const openIds = new Set(rows.filter((t) => !isDone(t)).map((t) => t.id));
      const together = orderPinnedTier(rows, mode, board.projectOrder).filter((id) => openIds.has(id));
      return together.join() !== orderPinnedTier(rows.filter((t) => !isDone(t)), mode, board.projectOrder).join();
    });
    expect(differs('custom')).toBe(true);
    expect(differs('project')).toBe(true);
  });

  it('the home panel orders its tiers with this function and no private copy', () => {
    const source = fs.readFileSync(TODO_PANEL, 'utf8');
    expect(source).toContain("from '@/utils/pinned-tier-order'");
    expect(source).toMatch(/orderPinnedTier\(tierTasks, isCustom \? 'custom' : 'project', ordering\?\.projectOrder\)/);
    expect(source).not.toMatch(/function clusterTierBy(Group|Project)\(/);
  });
});
