/**
 * Fix Walnut in the v6 draft (DraftFixWalnutRow.tsx): the words that say where the repair session
 * runs, and the way from the repair draft back to a plain one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ localHome: undefined as string | undefined }));
vi.mock('@/api/sessions', () => ({
  peekWorkingDirs: () => (state.localHome ? { dirs: [], hosts: [], localHome: state.localHome } : null),
}));
const mod = await import('@/components/sessions/draft-fix-walnut');
const { fixWalnutWhere, isFixWalnutDraft, leaveFixWalnut } = mod;
const { freshLauncherMeta } = await import('@/components/sessions/task-meta-constants');
type Draft = Parameters<typeof leaveFixWalnut>[0];

const repair = (extra: Partial<Draft> = {}): Draft => ({
  id: 'draft:1-0', cwd: '/Users/sam/code/walnut', host: null, cwdPinned: true, intent: 'fix-walnut',
  openedCwd: '/Users/sam/code/walnut', openedHost: null, meta: freshLauncherMeta(), ...extra,
});

describe('Fix Walnut', () => {
  beforeEach(() => { state.localHome = '/Users/sam'; });

  it('says where the session runs, or that Start clones the source first', () => {
    expect(fixWalnutWhere({ dir: '/Users/sam/code/walnut', cloneNeeded: false, repoUrl: 'u' }, '/Users/sam')).toBe('in ~/code/walnut');
    expect(fixWalnutWhere({ dir: '/srv/walnut', cloneNeeded: false, repoUrl: 'u' }, '/Users/sam')).toBe('in /srv/walnut');
    expect(fixWalnutWhere({ dir: '/Users/sam/open-walnut', cloneNeeded: true, repoUrl: 'u' }, '/Users/sam'))
      .toBe("Start clones Walnut's source into ~/open-walnut first");
  });

  it('leaving the repair draft drops the intent and the pin and starts again in the home', () => {
    const d = leaveFixWalnut(repair({ project: 'Walnut', projectSource: 'user' }));
    expect(isFixWalnutDraft(d)).toBe(false);
    expect('intent' in d).toBe(false);
    expect(d).toMatchObject({ cwd: '/Users/sam', host: null, cwdPinned: false, openedCwd: '/Users/sam', openedHost: null });
    // What the person picked otherwise stays.
    expect(d).toMatchObject({ project: 'Walnut', projectSource: 'user' });
  });

  it('entering remembers the place and the engine, and leaving gives them back', () => {
    const { withFixWalnutPrev } = mod;
    const before = repair({ intent: undefined, cwd: '/srv/app', host: 'devbox', hostLabel: 'Devbox', cwdPinned: false, openedCwd: '/srv/app', openedHost: 'devbox', meta: { ...freshLauncherMeta(), engine: 'codex', model: 'gpt-x' } });
    delete (before as { intent?: string }).intent;
    // The repair seed drops the engine (MainPage's withoutRepairEngine).
    const inRepair = withFixWalnutPrev(before, repair({ meta: { ...freshLauncherMeta(), engine: undefined, model: undefined } }));
    expect(inRepair.fixWalnutPrev).toMatchObject({ cwd: '/srv/app', host: 'devbox', engine: 'codex', model: 'gpt-x' });
    const back = leaveFixWalnut(inRepair);
    expect(back).toMatchObject({ cwd: '/srv/app', host: 'devbox', hostLabel: 'Devbox', cwdPinned: false, openedCwd: '/srv/app', openedHost: 'devbox' });
    expect(back.meta).toMatchObject({ engine: 'codex', model: 'gpt-x' });
    expect('fixWalnutPrev' in back).toBe(false);
    // An engine picked while it was the repair draft stays.
    const picked = leaveFixWalnut({ ...inRepair, meta: { ...inRepair.meta, engine: 'claude', model: 'opus' } });
    expect(picked.meta).toMatchObject({ engine: 'claude', model: 'opus' });
  });

  it('a plain draft is left as it is', () => {
    const plain = repair({ intent: undefined, cwdPinned: false });
    delete (plain as { intent?: string }).intent;
    expect(leaveFixWalnut(plain)).toBe(plain);
  });
});
