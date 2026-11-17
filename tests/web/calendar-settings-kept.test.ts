/**
 * Every calendar setting is kept, and a new one cannot ship unkept (2026-11-17, the user:
 * "also all settings is remembered"). The storage keys are read from the calendar's own
 * source (every `usePageView('calendar', …)` and every `open-walnut-…` / `walnut-…` string
 * literal there); each must be listed below with how it is kept:
 *   - 'synced': kept on this device and mirrored to the server's ui-prefs, so it holds after a
 *     reload, an app restart and on another device. Checked against ui-prefs-sync's own
 *     `syncable`, and the spec named must change it and read it back after a reload.
 *   - 'device': kept on this device only, with why.
 * Settings the server stores itself (which calendars and events are hidden, the default
 * calendar) are not in storage and so not here: they hold everywhere by construction.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { syncable } from '../../web/src/utils/ui-prefs-sync';
import { viewKey } from '../../web/src/utils/view-memory';

const ROOT = path.resolve(__dirname, '../..');
const SOURCES = [
  'web/src/pages/CalendarPage.tsx',
  ...fs.readdirSync(path.join(ROOT, 'web/src/components/calendar'))
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => `web/src/components/calendar/${f}`),
];

type Kept = { what: string; kept: 'synced'; spec: string } | { what: string; kept: 'device'; why: string };

const SETTINGS: Record<string, Kept> = {
  [viewKey('calendar', 'view')]: { what: 'Day / Week / Month on a desktop', kept: 'synced', spec: 'calendar-settings-kept.spec.ts' },
  [viewKey('calendar', 'phoneView')]: { what: 'Day / Week / Month on a phone (it opens on one day)', kept: 'synced', spec: 'calendar-settings-kept.spec.ts' },
  [viewKey('calendar', 'createKind')]: { what: 'a new item is an Event or a Task', kept: 'synced', spec: 'calendar-settings-kept.spec.ts' },
  'open-walnut-calendar-rail-open': { what: 'the task list beside the grid shown or hidden', kept: 'synced', spec: 'calendar-settings-kept.spec.ts' },
  'open-walnut-calendar-grid-settings': { what: 'the time scale (zoom) and full day or 7 AM to 1 AM', kept: 'synced', spec: 'calendar-settings-kept.spec.ts' },
  'open-walnut-home-calendar-all-day-height': { what: "the Home calendar panel's all-day row height", kept: 'synced', spec: 'calendar.spec.ts' },
  'walnut-calendar-rail-filter': { what: "the task list's filter text", kept: 'device', why: 'a search box, not a setting: another device opens its list unfiltered' },
};

function keysInSource(): Map<string, string> {
  const found = new Map<string, string>();
  for (const rel of SOURCES) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of text.matchAll(/usePageView(?:Of)?(?:<[^>]*>)?\(\s*'calendar'\s*,\s*'([\w.-]+)'/g)) found.set(viewKey('calendar', m[1]), rel);
    for (const m of text.matchAll(/['"`]((?:open-walnut|walnut)-[\w:.-]+)['"`]/g)) found.set(m[1], rel);
  }
  return found;
}

describe('every calendar setting is kept', () => {
  const found = keysInSource();

  it('finds the settings it guards', () => {
    for (const known of [viewKey('calendar', 'view'), viewKey('calendar', 'createKind'), 'open-walnut-calendar-grid-settings']) {
      expect([...found.keys()], known).toContain(known);
    }
  });

  it('every key the calendar stores is listed with how it is kept', () => {
    const unlisted = [...found].filter(([k]) => !SETTINGS[k]).map(([k, file]) => `${file}: ${k}`);
    expect(unlisted, 'a calendar setting is not listed in SETTINGS: say how it is kept (synced + its spec, or device + why)').toEqual([]);
    const stale = Object.keys(SETTINGS).filter((k) => !found.has(k));
    expect(stale, 'a listed setting is gone from the source: drop it from SETTINGS').toEqual([]);
  });

  it('a synced setting is mirrored to the server, and its spec reads it back after a reload', () => {
    const bad: string[] = [];
    for (const [key, s] of Object.entries(SETTINGS)) {
      if (s.kept === 'device') {
        if (syncable(key)) bad.push(`${key}: listed as device-only but ui-prefs syncs it`);
        continue;
      }
      if (!syncable(key)) bad.push(`${key}: not synced by ui-prefs (needs the open-walnut- prefix, outside its exclude list)`);
      const spec = fs.readFileSync(path.join(ROOT, 'tests/e2e/browser', s.spec), 'utf8');
      if (!spec.includes(`'${key}'`)) bad.push(`${key}: ${s.spec} never names it`);
    }
    expect(bad).toEqual([]);
  });
});
