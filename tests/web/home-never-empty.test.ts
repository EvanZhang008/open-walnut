/**
 * Home never draws nothing (home-panel-flags.ts homeTaskPanelShown). 2026-10-31: the
 * user's synced prefs said the task panel, the chat, the agenda and the scratchpad
 * were all hidden, so a fresh browser (and any window that adopted them with no
 * column open) showed an empty Home.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { homeTaskPanelShown, type HomeBesideTasks } from '../../web/src/pages/home-panel-flags';

const NOTHING: HomeBesideTasks = { chat: false, columns: 0, triage: false, calendar: false, scratchpad: false, routines: false };
const ROOT = path.resolve(__dirname, '../..');

describe('homeTaskPanelShown', () => {
  it('shows the task panel when nothing else is open, whatever its flag says', () => {
    expect(homeTaskPanelShown(false, false, NOTHING)).toBe(true);
  });
  it('honours a hidden flag while anything else is on Home', () => {
    for (const [key, on] of [['chat', true], ['columns', 1], ['triage', true], ['calendar', true], ['scratchpad', true], ['routines', true]] as const) {
      expect(homeTaskPanelShown(false, false, { ...NOTHING, [key]: on }), key).toBe(false);
    }
  });
  it('a shown flag and a phone always show it', () => {
    expect(homeTaskPanelShown(true, false, { ...NOTHING, chat: true })).toBe(true);
    expect(homeTaskPanelShown(false, true, { ...NOTHING, chat: true, columns: 3 })).toBe(true);
  });

  // The class: every Home panel MainPage keeps a visibility flag for is something "beside
  // the tasks". A new panel flag that is not an input here would let Home go empty again.
  it('every Home panel flag in MainPage is an input of the rule', () => {
    const page = fs.readFileSync(path.join(ROOT, 'web/src/pages/MainPage.tsx'), 'utf8');
    const flags = fs.readFileSync(path.join(ROOT, 'web/src/pages/home-panel-flags.ts'), 'utf8');
    const panels = new Set([...`${page}\n${flags}`.matchAll(/'open-walnut-home-([a-z]+)-visible'/g)].map((m) => m[1]));
    panels.delete('todo');
    expect(panels.size).toBeGreaterThanOrEqual(4);
    const iface = flags.slice(flags.indexOf('export interface HomeBesideTasks'), flags.indexOf('}', flags.indexOf('export interface HomeBesideTasks')));
    for (const p of panels) expect(iface, `Home panel "${p}" is missing from HomeBesideTasks`).toMatch(new RegExp(`\\b${p}:`));
  });
});
