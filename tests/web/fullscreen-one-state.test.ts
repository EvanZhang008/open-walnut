/**
 * Full screen is ONE state of the tab (2026-11-02, the user, on a plugin's session
 * panel still full page: "isn't this global setting?"). Every sheet asks one owner
 * (web/src/hooks/fullscreen-owner.ts) whether it is full screen; none keeps a flag
 * of its own. The source half fails on a host or a sheet that would keep its own.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FULLSCREEN_PLACE_KEY, bindFullscreen, claimFullscreen, clearFullscreen, detachFullscreen,
  fullscreenHeldBy, fullscreenOwner, fullscreenPlace, keepsAcrossRoutes, newFullscreenId,
  releaseFullscreen, resetFullscreenOwner, sheetPlace, subscribeFullscreen,
} from '../../web/src/hooks/fullscreen-owner';

const ROOT = path.resolve(__dirname, '../../web/src');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const files = sources(ROOT).map((f) => ({ file: path.relative(ROOT, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`])\/\/[^\n]*/g, '$1');

afterEach(() => resetFullscreenOwner());

/** Each `<SessionPanel ...>` tag whole: braces balanced, so `() => x` in a prop does not end it. */
function sessionPanelTags(text: string): string[] {
  const tags: string[] = [];
  for (const m of text.matchAll(/<SessionPanel\b/g)) {
    let depth = 0;
    let i = m.index! + m[0].length;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    tags.push(text.slice(m.index!, i + 1));
  }
  return tags;
}

describe('one full screen for the tab', () => {
  it('entering moves it, leaving it ends it everywhere, and a sheet that does not hold it changes nothing', () => {
    const home = newFullscreenId();
    const plugin = newFullscreenId();
    let heard = 0;
    subscribeFullscreen(() => { heard += 1; });

    claimFullscreen(home);
    expect(fullscreenOwner()).toBe(home);
    // The plugin's panel goes full screen: the home column is no longer.
    claimFullscreen(plugin);
    expect(fullscreenOwner()).toBe(plugin);
    // A panel resetting itself (it does not hold full screen) leaves it alone.
    releaseFullscreen(home);
    expect(fullscreenOwner()).toBe(plugin);
    // Leaving it leaves no sheet full screen: the home column does not come back.
    releaseFullscreen(plugin);
    expect(fullscreenOwner()).toBeNull();

    // Leaving it by a sheet that does not hold it changes nothing.
    claimFullscreen(home);
    releaseFullscreen(plugin);
    expect(fullscreenOwner()).toBe(home);
    releaseFullscreen(home);
    expect(fullscreenOwner()).toBeNull();
    expect(heard).toBe(5);
  });

  it('the place full screen is kept: the sheet showing it after a remount, a reload or a restart is full screen until the user leaves it', () => {
    // 2026-11-02, the user: "it keep lost my state like the open state of the session, like full screen".
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
    };
    try {
      const plugin = sheetPlace('plugin:practice', 'sid-1', false, '/apps/practice~main');
      const home = sheetPlace('home-column', 'sid-2', true, '/org');
      expect(plugin).toBe('plugin:practice@/apps/practice~main|sid-1');
      expect(home).toBe('home-column|sid-2');

      const a = newFullscreenId();
      claimFullscreen(a, plugin);
      expect(JSON.parse(store.get(FULLSCREEN_PLACE_KEY)!)).toBe(plugin);
      // The plugin reloads (or the user visits another page): the sheet goes, the place stays.
      detachFullscreen(a);
      expect(fullscreenOwner()).toBeNull();
      expect(fullscreenPlace()).toBe(plugin);
      // The page reloads (or the app restarts): a fresh load reads the place from disk.
      resetFullscreenOwner();
      const b = newFullscreenId();
      expect(fullscreenHeldBy(b, plugin)).toBe(true);
      // A sheet of another place is not full screen, and cannot bind it.
      const other = newFullscreenId();
      expect(fullscreenHeldBy(other, home)).toBe(false);
      bindFullscreen(other, home);
      expect(fullscreenOwner()).toBeNull();
      // The one showing it binds; a second sheet of the same place then is not full screen.
      bindFullscreen(b, plugin);
      expect(fullscreenOwner()).toBe(b);
      const twin = newFullscreenId();
      bindFullscreen(twin, plugin);
      expect(fullscreenHeldBy(twin, plugin)).toBe(false);
      // Leaving it ends it for good: nothing comes back after a reload.
      releaseFullscreen(b);
      expect(JSON.parse(store.get(FULLSCREEN_PLACE_KEY)!)).toBeNull();
      resetFullscreenOwner();
      expect(fullscreenHeldBy(newFullscreenId(), plugin)).toBe(false);

      // Entering on another place moves it; a column opened on Home clears a place nobody shows.
      const c = newFullscreenId();
      claimFullscreen(c, home);
      detachFullscreen(c);
      expect(fullscreenPlace()).toBe(home);
      clearFullscreen();
      expect(fullscreenPlace()).toBeNull();
      expect(JSON.parse(store.get(FULLSCREEN_PLACE_KEY)!)).toBeNull();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('only a home page panel keeps full screen across pages; a plugin box or slot panel does not', () => {
    expect(keepsAcrossRoutes(true, true, false)).toBe(true);
    expect(keepsAcrossRoutes(true, true, true)).toBe(false);
    expect(keepsAcrossRoutes(true, false, false)).toBe(false);
    expect(keepsAcrossRoutes(false, true, false)).toBe(false);
  });

  it('useFullscreen keeps no flag of its own: it reads and writes the one owner', () => {
    const hook = code(read('hooks/useFullscreen.tsx'));
    expect(hook).toContain('useSyncExternalStore(subscribeFullscreen');
    expect(hook).toContain('claimFullscreen(id, place)');
    // The tab's sheets read the owner; only a nested or page-wide sheet has a flag of its own.
    expect(hook).toMatch(/const isFullscreen = tab \? ownsTab : ownFlag;/);
    expect(hook).not.toMatch(/setIsFullscreen/);
    // Every session panel is one of the tab's sheets.
    expect(code(read('components/sessions/SessionPanel.tsx'))).toMatch(/useFullscreen\(\{ keepAcrossRoutes: true, place: sheetAt, phoneLayer: !!\(phoneLayer \|\| phoneHostSlot\) \}\)/);
    // Nothing else claims full screen around the hook.
    const claimers = files.filter(({ text }) => /\bclaimFullscreen\(/.test(code(text))).map(({ file }) => file).sort();
    expect(claimers).toEqual(['hooks/fullscreen-owner.ts', 'hooks/useFullscreen.tsx']);
  });

  it('every full screen is the pop-up sheet, and each sheet says whose state it is', () => {
    // 2026-11-02, the user: "all full screens are that pop-up window, a little margin on both
    // sides, not really the whole screen". Each sheet: the tab's one state, or a flag of its own.
    const SHEETS: Record<string, 'tab' | 'own'> = {
      'components/sessions/SessionPanel.tsx': 'tab', // a session panel, wherever it is hosted
      'components/org/OrgTaskRail.tsx': 'tab', // an Org node's side bar (Tasks, Brief, Threads)
      'components/tasks/HomeBoardSheet.tsx': 'tab',
      'components/sessions/SideQuestionDrawer.tsx': 'tab', // a panel's Side threads pop-up (2026-11-05: "can also full screen like the outside")
      'components/dock/FocusDock.tsx': 'own', // the dock, beside every page
      'components/sessions/WorkflowProgress.tsx': 'own', // a workflow card inside a panel's chat
    };
    const users = files.filter(({ file, text }) => file !== 'hooks/useFullscreen.tsx' && /\buseFullscreen\(/.test(code(text))).map(({ file }) => file).sort();
    expect(users, 'a new full-screen sheet: list it in SHEETS').toEqual(Object.keys(SHEETS).sort());
    for (const [file, kind] of Object.entries(SHEETS)) {
      const call = code(read(file)).match(/\buseFullscreen\(([^)]*)\)/)![1];
      if (kind === 'tab') expect(call, file).toMatch(/keepAcrossRoutes: true, place: /);
      else expect(call, file).toBe('');
    }
    // No stylesheet turns a sheet into the whole window: the sheet keeps a gutter on every side.
    const styles = fs.readdirSync(path.join(ROOT, 'styles')).filter((f) => f.endsWith('.css')).map((f) => `styles/${f}`);
    for (const file of styles) {
      for (const m of read(file).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*open-walnut-fullscreen(?!-backdrop)[^{}]*)\{([^}]*)\}/g)) {
        const rule = `${file}: ${m[1].trim()}`;
        expect(m[2], rule).not.toMatch(/\binset:\s*0\b|\b(width|max-width):\s*100(vw|%)|\b(height|max-height):\s*100(vh|%)|\bborder-radius:\s*0\b/);
        // Edge to edge (715987269 set top, right and bottom to 0): at most one side flush.
        const flush = [...m[2].matchAll(/\b(top|right|bottom):\s*0(px)?\s*(!important)?\s*;/g)].length;
        expect(flush, rule).toBeLessThan(2);
      }
    }
  });

  it('reads a whole tag, arrow functions in props included', () => {
    expect(sessionPanelTags('<SessionPanel onClose={() => x()} fullscreen />')).toEqual(['<SessionPanel onClose={() => x()} fullscreen />']);
  });

  it('every SessionPanel host gets full screen only from the panel itself', () => {
    // Each host, and where it puts the panel. A new host is added here once it
    // passes no full screen of its own (the checks below).
    const HOSTS = [
      'components/chat/AskObjectDrawer.tsx', // an object's ask drawer
      'components/chat/AskWalnutSlot.tsx', // the Ask slot
      'components/sessions/SessionPanel.tsx', // its own wrapper export
      'components/org/OrgNodeDetail.tsx', // an Org node
      'components/org/OrgSidePanel.tsx', // the Org side panel
      'pages/MainPage.tsx', // the home columns
      'pages/NotesPage.tsx', // the Notes page
      'plugins/views.tsx', // a plugin's SessionView
      'popout/PopoutSession.tsx', // a popped-out window
    ];
    const hosts = files.filter(({ text }) => /<SessionPanel\b/.test(code(text))).map(({ file }) => file).sort();
    expect(hosts, 'a new SessionPanel host: list it in HOSTS once it passes no full screen of its own').toEqual([...HOSTS].sort());
    for (const { file, text } of files.filter(({ file }) => HOSTS.includes(file))) {
      const body = code(text);
      // A prop that would start a panel full page, or a sheet class set by the host.
      for (const tag of sessionPanelTags(body)) expect(tag, file).not.toMatch(/full[sS]creen|expanded/);
      expect(body, file).not.toMatch(/['"`]\s*open-walnut-fullscreen/);
    }
    // The panel takes no such prop and has one source of full screen.
    const panel = code(read('components/sessions/SessionPanel.tsx'));
    expect(panel.match(/\buseFullscreen\(/g)).toHaveLength(1);
    const props = panel.slice(panel.indexOf('export interface SessionPanelProps'), panel.indexOf('}\n', panel.indexOf('export interface SessionPanelProps')));
    expect(props).not.toMatch(/full[sS]creen/);
  });
});
