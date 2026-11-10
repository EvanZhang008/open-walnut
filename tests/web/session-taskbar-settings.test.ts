/**
 * The taskbar's two switches in Settings > General (2026-11-10, the user: "this bar, if only has
 * the recent don;t sow", then "add a setting for this, also if we should have "recnet" side also
 * have a setting to contorl, liek before all the redne tor minized will all go to below, have 2
 * otpions I want to play around it"): no bar while it holds only Recent (default on), and where a
 * session leaving the strip without a Minimize goes, Recent (default) or a chip as before.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_TASKBAR_SETTINGS, taskbarAfterStripChange, taskbarSettingsOf, taskbarView, type TaskbarLeaving,
} from '../../web/src/pages/sessionTaskbar';
import { addSessionColumn, removeSessionColumn, trimUnlockedToMax, type SessionSlot } from '../../web/src/pages/sessionColumns';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const slot = (id: string): SessionSlot => ({ id, locked: false });
const none = new Set<string>();

describe('taskbarSettingsOf', () => {
  it('defaults: no bar with only Recent, sessions leaving go to Recent', () => {
    expect(DEFAULT_TASKBAR_SETTINGS).toEqual({ hideRecentOnly: true, leaving: 'recent' });
    expect(taskbarSettingsOf(undefined)).toEqual(DEFAULT_TASKBAR_SETTINGS);
    expect(taskbarSettingsOf({})).toEqual(DEFAULT_TASKBAR_SETTINGS);
    expect(taskbarSettingsOf({ hideRecentOnly: 'no', leaving: 'elsewhere' })).toEqual(DEFAULT_TASKBAR_SETTINGS);
  });
  it('reads each value', () => {
    expect(taskbarSettingsOf({ hideRecentOnly: false, leaving: 'chips' })).toEqual({ hideRecentOnly: false, leaving: 'chips' });
  });
});

describe('taskbarView: every state of the two switches and the two lists', () => {
  const cases: Array<[chips: number, recent: number, hide: boolean, leaving: TaskbarLeaving, shown: boolean, recentShown: boolean]> = [
    // Nothing: never a bar.
    [0, 0, true, 'recent', false, false],
    [0, 0, false, 'recent', false, false],
    [0, 0, true, 'chips', false, false],
    [0, 0, false, 'chips', false, false],
    // Only Recent: no bar while the switch is on (the default), the bar with Recent when off.
    [0, 3, true, 'recent', false, true],
    [0, 3, false, 'recent', true, true],
    // Leaving as chips: Recent is never drawn, so it alone draws no bar either way.
    [0, 3, true, 'chips', false, false],
    [0, 3, false, 'chips', false, false],
    // A minimized session: the bar, with Recent beside it when Recent is on.
    [1, 0, true, 'recent', true, false],
    [1, 3, true, 'recent', true, true],
    [1, 3, false, 'recent', true, true],
    [1, 3, true, 'chips', true, false],
    [1, 3, false, 'chips', true, false],
  ];
  it.each(cases)('chips %i, recent %i, hide %s, leaving %s', (c, r, hide, leaving, shown, recentShown) => {
    const lists = { chips: Array.from({ length: c }, (_, i) => `c${i}`), recent: Array.from({ length: r }, (_, i) => `r${i}`) };
    expect(taskbarView(lists, { hideRecentOnly: hide, leaving })).toEqual({ shown, recent: recentShown });
  });
});

describe("leaving: 'chips' puts every session that leaves the strip on the chips, as before", () => {
  const empty = { chips: [] as string[], recent: [] as string[] };
  it('a close with ×', () => {
    const before = [slot('a'), slot('b')];
    expect(taskbarAfterStripChange(empty, before, removeSessionColumn(before, 'a'), none, 'chips')).toEqual({ chips: ['a'], recent: [] });
  });
  it('a sixth open pushing a column out', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].map(slot);
    const next = addSessionColumn(before, 'f', false, 5);
    const evicted = before.find(s => !next.some(c => c.id === s.id))!;
    expect(taskbarAfterStripChange(empty, before, next, none, 'chips')).toEqual({ chips: [evicted.id], recent: [] });
  });
  it('a lower panel count, and a Minimize, in join order; a Recent entry that leaves becomes a chip', () => {
    const before = ['a', 'b', 'c'].map(slot);
    expect(taskbarAfterStripChange({ chips: ['x'], recent: ['c'] }, before, trimUnlockedToMax(before, 2), none, 'chips'))
      .toEqual({ chips: ['x', 'c'], recent: [] });
  });
  it("'recent' (the default) keeps them off the chips", () => {
    const before = [slot('a'), slot('b')];
    expect(taskbarAfterStripChange(empty, before, removeSessionColumn(before, 'a'), none)).toEqual({ chips: [], recent: ['a'] });
  });
});

describe('the switches reach every place that uses them', () => {
  it('the bar decides what it draws only through taskbarView', () => {
    const src = read('web/src/components/sessions/SessionTaskbar.tsx');
    expect(src).toContain('taskbarView(');
    expect(src).not.toMatch(/(chips|recent)\.length\s*(===|>)\s*0\s*(&&|\)|;)/);
    expect(read('web/src/components/sessions/AppTaskbar.tsx')).toMatch(/settings=\{settings\}/);
  });
  it('the strip rule reads the live leaving switch', () => {
    expect(read('web/src/pages/sessionTaskbarStore.ts')).toMatch(/taskbarAfterStripChange\([^)]*taskbarSettingsNow\(\)\.leaving\)/);
  });
  it('both are config ui keys, copied to a replica, with rows in Settings > General', () => {
    const types = read('src/core/types.ts');
    expect(types).toMatch(/taskbar_hide_recent_only\?: boolean;/);
    expect(types).toMatch(/taskbar_leaving\?: 'recent' \| 'chips';/);
    expect(read('src/core/replication/config-allowlist.ts')).toMatch(/taskbar_hide_recent_only: true, taskbar_leaving: true/);
    const general = read('web/src/components/settings/sections/GeneralSection.tsx');
    expect(general).toContain('settings-taskbar-hide-recent-only');
    expect(general).toContain('settings-taskbar-leaving');
  });
});
