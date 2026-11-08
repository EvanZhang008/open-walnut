/**
 * A session panel that came back from a saved layout or the address, not from a click,
 * closes itself when its session no longer exists, instead of drawing "Session not found"
 * (D05: `walnut demo reset` with two columns open left them on the new first run as
 * "Session not found", and after a reload as "Untitled session / Failed to load history").
 *
 * The class: every saved layout field that holds session ids is listed here with the page
 * that draws it and how a gone session leaves; a new field fails until it is classified.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAYOUT_FIELDS } from '../../web/src/utils/layout-record';
import { connectionLineText, DEMO_OFFLINE_LINE, OFFLINE_LINE } from '../../web/src/components/layout/ConnectionLine';

const WEB = join(__dirname, '../../web/src');
const read = (rel: string) => readFileSync(join(WEB, rel), 'utf8');

/** Every layout field, and what a stale id in it does after a restore. */
const FIELDS: Record<keyof typeof LAYOUT_FIELDS, string> = {
  homeColumns: 'pages/MainPage.tsx: a restored column passes onRestoredGone',
  phoneColumns: 'pages/MainPage.tsx: the same strip code as homeColumns',
  orgColumns: 'pages/OrgPage.tsx: a restored pin passes onRestoredGone through OrgSidePanel',
  homeTaskbar: 'the old taskbar list: read once into homeRecent, then cleared',
  homeMinimized: 'taskbar chips only: a chip opens its column by a click, which shows the not-found card',
  homeRecent: 'taskbar Recent chips only: the same click as a minimized chip',
  homeFocusedTask: 'a task id, focused only when tasks.find finds it',
  askSelected: 'a task id, re-resolved by AskWalnutSlot when the task is gone',
  askAgent: 'an agent id, not a session',
};

describe('restored session panels whose session is gone', () => {
  it('every layout field is classified', () => {
    expect(Object.keys(LAYOUT_FIELDS).sort()).toEqual(Object.keys(FIELDS).sort());
  });

  it('SessionPanel draws nothing and tells its host, for a restored id only', () => {
    const panel = read('components/sessions/SessionPanel.tsx');
    expect(panel).toMatch(/onRestoredGone\?: \(sessionId: string\) => void;/);
    expect(panel).toMatch(/if \(missing && onRestoredGone\) return null;/);
    expect(panel).toMatch(/onRestoredGoneRef\.current\(sessionId\)/);
  });

  it('a restored id waits as long as a launch before it closes (a reload right after a remote launch)', () => {
    const panel = read('components/sessions/SessionPanel.tsx');
    expect(panel).not.toMatch(/RESTORED_MISSING_RETRIES/);
    expect(panel).toMatch(/if \(s === null && attempt < MISSING_SESSION_RETRIES\) \{/);
    // Every retry bound on a 404 in the panel is that one constant.
    expect(panel.match(/attempt < [A-Z_]+/g)?.filter((m) => /MISSING|RESTORED/.test(m))).toEqual(['attempt < MISSING_SESSION_RETRIES']);
  });

  it('Home marks only the first load\'s columns as restored, never a Back/Forward or a return to Home', () => {
    const main = read('pages/MainPage.tsx');
    const calls = [...main.matchAll(/markRestored\(restoredColumnIdsRef\.current, /g)].map((m) => m.index!);
    // The saved strip at mount, and the address (?s1=..) of the load.
    expect(calls.length).toBe(2);
    for (const at of calls) {
      const line = main.slice(main.lastIndexOf('\n', at) + 1, main.indexOf('\n', at));
      const inInitializer = main.slice(Math.max(0, at - 200), at).includes('useState<SessionSlot[]>(() => {');
      expect(inInitializer || /if \(p\.fromLoad\) markRestored\(/.test(line), `unmarked-for-load restore: ${line.trim()}`).toBe(true);
    }
  });

  it('Home closes such a column', () => {
    const main = read('pages/MainPage.tsx');
    // The address's columns: the saved strip it repeats is marked, a link's own id is not.
    expect(main).toMatch(/const saved = loadSessionColumns\(\);\n\s+const cols = mergeUrlColumns\(p\.sessionIds, saved\);/);
    expect(main).toMatch(/onRestoredGone: handleRestoredGone/);
    // Every loadSessionColumns() call outside its own definition: the two first-load restores
    // above and the return to Home (unmarked); a new one must be classified here.
    const calls = main.match(/= loadSessionColumns\(\)/g) ?? [];
    expect(calls.length).toBe(3);
  });

  it('Org closes a restored pin or remembered panel the same way', () => {
    const org = read('pages/OrgPage.tsx');
    expect(org.match(/\.\.\.restoredGone\(/g)?.length).toBe(2);
    expect(read('components/org/OrgSidePanel.tsx')).toMatch(/onRestoredGone: \(\) => onRestoredGone\(\)/);
  });
});

describe('the desktop line when Walnut is not answering', () => {
  it('says nothing while connected or while a host server answers alone', () => {
    expect(connectionLineText({ offline: false, macAway: false }, false)).toBeNull();
    expect(connectionLineText({ offline: true, macAway: true }, false)).toBeNull();
  });

  it('says plainly that the server is gone, and how to bring the Demo back', () => {
    expect(connectionLineText({ offline: true, macAway: false }, false)).toBe(OFFLINE_LINE);
    expect(connectionLineText({ offline: true, macAway: false }, true)).toBe(DEMO_OFFLINE_LINE);
    expect(DEMO_OFFLINE_LINE).toMatch(/walnut demo/);
  });

  it('is mounted on every desktop page, with the connection watched on every layout', () => {
    const shell = read('components/layout/AppShell.tsx');
    expect(shell).toMatch(/useConnectionWatch\(\);/);
    expect(shell).toMatch(/!isMobileSidebar && <ConnectionLine \/>/);
  });
});
