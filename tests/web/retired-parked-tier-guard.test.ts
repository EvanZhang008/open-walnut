/**
 * Guard: the retired Parked tier (`wait`) is offered nowhere on the web, and a task still stored
 * in it draws in Satellite (2026-11-11, the user: "just have 2 focus, satellite, remove park",
 * "make it backward compatible"; custom tiers, a plugin's included, stay as they are).
 *
 * The server still stores and accepts `wait` (older clients, the phone app, plugins and agents
 * keep writing it), so the web keeps the stored value and folds it on read (`shownTier`,
 * RETIRED_TIERS in web/src/api/focus.ts). Nothing here touches the WAITING phase, which is a
 * status, not a tier.
 *
 * The class, enumerated from the source: every literal tier list in web/src (an array naming
 * both 'focus' and 'satellite', or an object keyed by both), every tier offer entry
 * (`id|value|tier|key: 'wait'`), every reader that draws `wait` as its own tier
 * (`tier === 'wait'`), and the Parked label and icon. A new list or reader that brings Parked
 * back fails here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Task } from '@open-walnut/core';
import {
  BOARD_TIER_POLICY, BUILTIN_TIERS, RETIRED_TIERS, isBuiltinTier, isRetiredTier, shownTier,
} from '../../web/src/api/focus';
import { TIER_OPTIONS, tierColor, tierLabelOf } from '../../web/src/components/sessions/task-meta-constants';
import { builtinTierKnown } from '../../web/src/components/sessions/draft-parse-rules';
import { launchMetaFor } from '../../web/src/components/sessions/draft-ownership';
import { draftTierLabel } from '../../web/src/components/sessions/draft-decisions';
import { allViews, DEFAULT_HIDDEN_TABS, tabBarTabs, wideHidden } from '../../web/src/components/tasks/tab-bar-model';
import { buildHomeBoard, homeBoardTier, pinBoardColumns } from '../../web/src/components/tasks/home-board-model';
import { ageTags } from '../../web/src/components/tasks/quick-sort-model';
import { footerStatusScope } from '../../web/src/components/tasks/footer-scope';

const WEB_SRC = join(__dirname, '../../web/src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Code only: block and line comments go (a lost line of code only weakens the scan). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const FILES = sourceFiles(WEB_SRC).map((p) => ({ rel: relative(WEB_SRC, p), src: code(readFileSync(p, 'utf8')) }));

/** A literal list of tiers: an array naming both built-ins, or an object keyed by both. */
const TIER_ARRAY = /\[[^[\]]*['"]focus['"][^[\]]*['"]satellite['"][^[\]]*\]/g;
const TIER_OBJECT = /\{[^{}]*\bfocus:[^{}]*\bsatellite:[^{}]*\}/g;
const NAMES_WAIT = /['"]wait['"]|\bwait:/;

const OFFER_ENTRY = /\b(id|value|tier|key)\s*:\s*['"]wait['"]/;
const WAIT_READER = /\b(focus_tier|tier|tierKey|pinTier|pinnedTier|section|effectiveSection|activeSection)\s*[!=]==?\s*['"]wait['"]/;
const PARKED_LABEL = /(['"`])Parked\1/;

describe('every literal tier list on the web leaves Parked out', () => {
  const members: string[] = [];
  const offenders: string[] = [];
  for (const { rel, src } of FILES) {
    for (const re of [TIER_ARRAY, TIER_OBJECT]) {
      for (const m of src.matchAll(re)) {
        members.push(rel);
        if (NAMES_WAIT.test(m[0])) offenders.push(`${rel}: ${m[0].replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
  }

  it('finds the known lists (the scan reaches them)', () => {
    for (const known of [
      'api/focus.ts', 'components/tasks/tab-bar-model.ts', 'components/tasks/TodoSectionTabs.tsx',
      'components/tasks/home-board-model.ts', 'components/sessions/task-meta-constants.ts',
      'components/settings/sections/FocusTiersSection.tsx',
    ]) expect(members, known).toContain(known);
  });

  it('no list names wait', () => {
    expect(offenders).toEqual([]);
  });
});

describe('no surface offers, labels or draws Parked as a tier', () => {
  const hits = (re: RegExp) => FILES.flatMap(({ rel, src }) =>
    src.split('\n').flatMap((line, i) => (re.test(line) ? [`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`] : [])));

  it('no tier offer entry is wait', () => {
    expect(hits(OFFER_ENTRY)).toEqual([]);
  });

  it('no reader draws wait as its own tier (it folds through shownTier / Satellite)', () => {
    expect(hits(WAIT_READER)).toEqual([]);
    expect(hits(/\bcase\s+['"]wait['"]\s*:/)).toEqual([]);
  });

  it('no "Parked" label and no Parked icon', () => {
    expect(hits(PARKED_LABEL)).toEqual([]);
    expect(hits(/\bICON_TIER_WAIT\b/)).toEqual([]);
  });
});

function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id, title: id, project: 'Alpha', phase: 'TODO', status: 'todo', source: 'local', priority: 'none',
    created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...fields,
  } as Task;
}

describe('the tier models offer Focus, Satellite and the custom tiers only', () => {
  const custom = [{ id: 'ct_vt000001', label: 'Virtual Teammate' }];

  it('the built-ins and every list built from them', () => {
    expect([...BUILTIN_TIERS]).toEqual(['focus', 'satellite']);
    expect(BOARD_TIER_POLICY.map((p) => p.tier)).toEqual(['focus', 'satellite']);
    expect(TIER_OPTIONS.map((t) => t.value)).toEqual(['focus', 'satellite']);
    for (const id of RETIRED_TIERS) {
      expect(isBuiltinTier(id)).toBe(false);
      expect(builtinTierKnown(id)).toBe(false);
      expect(tabBarTabs(custom).map((t) => t.id)).not.toContain(id);
      expect(allViews(custom).map((t) => t.id)).not.toContain(id);
      expect(DEFAULT_HIDDEN_TABS).not.toContain(id);
      expect(wideHidden([])).not.toContain(id);
      expect(pinBoardColumns(custom).map((c) => c.id)).not.toContain(id);
    }
  });

  it('a custom tier (a plugin\'s) is untouched', () => {
    expect(isRetiredTier('ct_vt000001')).toBe(false);
    expect(shownTier('ct_vt000001')).toBe('ct_vt000001');
    expect(tabBarTabs(custom).map((t) => t.id)).toContain('ct_vt000001');
    expect(pinBoardColumns(custom).map((c) => c.id)).toEqual(['focus', 'satellite', 'ct_vt000001', 'unpinned']);
    expect(homeBoardTier(task('v', { pinned: true, focus_tier: 'ct_vt000001' }), custom)).toBe('ct_vt000001');
  });
});

describe('a task stored in the retired tier draws in Satellite', () => {
  const parked = task('p', { pinned: true, focus_tier: 'wait' });

  it('folds every retired id, and only those', () => {
    expect(shownTier('wait')).toBe('satellite');
    expect(shownTier('backlog')).toBe('satellite');
    expect(shownTier('focus')).toBe('focus');
    expect(shownTier(undefined)).toBe(undefined);
  });

  it('the pin board puts it in the Satellite column', () => {
    expect(homeBoardTier(parked, [])).toBe('satellite');
    const satellite = buildHomeBoard([parked, task('s', { pinned: true })], [], 'pin').find((c) => c.id === 'satellite')!;
    expect(satellite.count).toBe(2);
  });

  it('labels, colors and the Sort card read Satellite', () => {
    expect(tierLabelOf('wait')).toBe('Satellite');
    expect(tierColor('wait')).toBe(tierColor('satellite'));
    expect(draftTierLabel('wait', { tierLabel: () => undefined })).toBe('Satellite');
    expect(ageTags(homeBoardTier(parked, []), 'Satellite', { idle: 3, inTier: 3 })[0]!.text).toBe('In Satellite, no action for 3 days');
  });

  it('the footer counts it under Satellite', () => {
    const scope = footerStatusScope({
      section: 'satellite', tasks: [parked], activeProject: '', pinnedTaskIds: new Set(['p']),
      focusTaskIds: new Set(), customMemberIds: new Set(), showCompleted: false, waitingRevealed: false,
      recentSortMode: 'updated',
    });
    expect(scope.scope.map((t) => t.id)).toEqual(['p']);
  });

  it('a draft still carrying it launches into Satellite', () => {
    const draft = { meta: { pinTier: 'wait' } } as unknown as Parameters<typeof launchMetaFor>[0];
    expect(launchMetaFor(draft, () => true).pinTier).toBe('satellite');
  });
});
