/**
 * A New task with no folder picked starts in the home folder (draft-home-default.ts; 2026-11-11,
 * the user: New task defaults to HOME). It is not a pin and names no project.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const state = vi.hoisted(() => ({ localHome: undefined as string | undefined }));
vi.mock('@/api/sessions', () => ({
  peekWorkingDirs: () => (state.localHome ? { dirs: [], hosts: [], localHome: state.localHome } : null),
}));
const { homeDraftFolder, onHomeDefault, withHomeFolder } = await import('@/components/sessions/draft-home-default');
const { freshLauncherMeta } = await import('@/components/sessions/task-meta-constants');
const { shownFolderName } = await import('@/utils/home-folder');
type Draft = Parameters<typeof withHomeFolder>[0];

const fresh = (extra: Partial<Draft> = {}): Draft => ({ id: 'draft:1-0', cwd: '', host: null, meta: freshLauncherMeta(), ...extra });

describe('a New task with no folder starts in the home', () => {
  beforeEach(() => { state.localHome = undefined; });

  it('takes the absolute local home when the window knows it, else ~ (the launch expands it)', () => {
    expect(homeDraftFolder()).toBe('~');
    state.localHome = '/Users/sam';
    expect(homeDraftFolder()).toBe('/Users/sam');
  });

  it('fills the folder on this machine, unpinned, with no project, and shows it as ~', () => {
    state.localHome = '/Users/sam';
    const d = withHomeFolder(fresh());
    expect(d).toMatchObject({ cwd: '/Users/sam', host: null, cwdPinned: false, openedCwd: '/Users/sam', openedHost: null });
    expect(d.project).toBeUndefined();
    expect(d.projectSource).toBeUndefined();
    expect(shownFolderName(d.cwd, d.host)).toBe('~');
  });

  it('leaves every draft that already has a place, or launches without one, as it is', () => {
    const picked = fresh({ cwd: '/srv/app', host: 'devbox', cwdPinned: true });
    expect(withHomeFolder(picked)).toBe(picked);
    for (const d of [fresh({ walnut: true }), fresh({ orgLead: true }), fresh({ forkOf: { sessionId: 's1' } as Draft['forkOf'] })]) {
      expect(withHomeFolder(d)).toBe(d);
    }
  });

  it('counts as no choice for the folder picker until a pick pins a folder', () => {
    state.localHome = '/Users/sam';
    const d = withHomeFolder(fresh());
    // The picker opens on the recent folders for the default, in edit mode for a chosen folder.
    expect(onHomeDefault(d)).toBe(true);
    expect(onHomeDefault({ ...d, cwdPinned: true })).toBe(false);
    expect(onHomeDefault({ ...d, cwd: '/srv/app' })).toBe(false);
    expect(onHomeDefault({ ...d, host: 'devbox' })).toBe(false);
    expect(onHomeDefault(fresh())).toBe(false);
    const bar = fs.readFileSync(path.join(__dirname, '../../web/src/components/sessions/DraftLaunchBar.tsx'), 'utf8');
    expect(bar).toContain('initialPath={draft.cwd && !onHomeDefault(draft) ?');
  });

  it('guard: every place Home makes or rebinds a plain draft goes through the home default', () => {
    // A new open, a restored column and a reused (rebound) column: the three ways a Home draft
    // gets its row. A new one of these that writes `cwd: ''` without it would bring back the
    // "Choose folder and host" step after Send.
    const main = fs.readFileSync(path.join(__dirname, '../../web/src/pages/MainPage.tsx'), 'utf8');
    expect(main).toMatch(/setDraftColumns\(prev => \[\n\s+\.\.\.prev,\n\s+withHomeFolder\(\{/);
    expect(main).toMatch(/restoreDraftColumns\([\s\S]{0,200}?\)\)\.map\(withHomeFolder\)/);
    expect(main).toMatch(/return withHomeFolder\(next\);\n\}/);
    // No other draft row is minted with an empty folder on Home.
    const emptyRows = main.split('\n').filter((l) => /\bid, cwd: '', host: null\b/.test(l));
    expect(emptyRows).toHaveLength(1); // the restore base, mapped through withHomeFolder above
  });
});
