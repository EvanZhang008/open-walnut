/**
 * The folder picker's host tabs (spec 4.1, checklist C20 / C34 / C73): enabled
 * hosts get a tab, removed or disabled hosts with history move under one trailing
 * 'Removed hosts' tab, and every remote tab has ONE title from the shared dot.
 * Pure function tests, no IO.
 */
import { describe, it, expect } from 'vitest';
import {
  ALL_TAB, LOCAL_TAB, REMOVED_TAB, REMOVED_TAB_LABEL, buildHostTabs, goneHosts, historyForTab, hostOfTab,
  tabInfersHost, tabTitle,
} from '../../../web/src/components/sessions/path-selector/host-tabs';
import type { ConfiguredHost, WorkingDirEntry } from '../../../web/src/api/sessions';
import type { HostStatus } from '../../../web/src/api/hosts';

const configured: ConfiguredHost[] = [
  { alias: 'devbox', label: 'Dev box' },
  { alias: 'buildbox', label: 'Build box' },
];
const dir = (cwd: string, host: string | null): WorkingDirEntry =>
  ({ cwd, host, project: '', count: 1, lastUsed: '2026-09-20T00:00:00Z' }) as WorkingDirEntry;
const dirs = [dir('/Users/alice/walnut', null), dir('/home/alice/api', 'devbox'), dir('/home/alice/old', 'netbox')];

describe('buildHostTabs', () => {
  it('All, Local, each enabled host, then Removed hosts only when a removed host has history', () => {
    const m = buildHostTabs({ configured, dirs });
    expect(m.tabs.map((t) => t.key)).toEqual([ALL_TAB, LOCAL_TAB, 'devbox', 'buildbox', REMOVED_TAB]);
    expect(m.tabs.at(-1)).toMatchObject({ label: REMOVED_TAB_LABEL, kind: 'removed' });
    expect([...m.removedHosts]).toEqual(['netbox']);
  });

  it('no Removed hosts tab when every history host is still configured', () => {
    const m = buildHostTabs({ configured, dirs: dirs.slice(0, 2) });
    expect(m.tabs.some((t) => t.key === REMOVED_TAB)).toBe(false);
  });

  it('a tombstoned host loses its tab at once and its history moves to Removed hosts', () => {
    const m = buildHostTabs({ configured, dirs, gone: new Set(['devbox']) });
    expect(m.tabs.map((t) => t.key)).not.toContain('devbox');
    expect(m.removedHosts.has('devbox')).toBe(true);
    expect(m.liveHosts.map((h) => h.alias)).toEqual(['buildbox']);
  });

  it('a label-less host is named by its alias; a raw auto-discovered one keeps its nudge flag', () => {
    const m = buildHostTabs({ configured: [{ alias: 'a.example.com', label: '', rawName: true }], dirs: [] });
    expect(m.tabs[2]).toMatchObject({ key: 'a.example.com', label: 'a.example.com', rawName: true });
  });
});

describe('historyForTab', () => {
  const { removedHosts } = buildHostTabs({ configured, dirs });
  it('All never shows a removed host row; Removed hosts shows only those', () => {
    expect(historyForTab(dirs, ALL_TAB, removedHosts).map((d) => d.cwd)).toEqual(['/Users/alice/walnut', '/home/alice/api']);
    expect(historyForTab(dirs, REMOVED_TAB, removedHosts).map((d) => d.cwd)).toEqual(['/home/alice/old']);
    expect(historyForTab(dirs, LOCAL_TAB, removedHosts).map((d) => d.cwd)).toEqual(['/Users/alice/walnut']);
    expect(historyForTab(dirs, 'devbox', removedHosts).map((d) => d.cwd)).toEqual(['/home/alice/api']);
  });
});

describe('tab helpers', () => {
  it('only a real host tab names a host; All and Removed hosts infer it from the row', () => {
    expect(hostOfTab('devbox')).toBe('devbox');
    for (const t of [ALL_TAB, LOCAL_TAB, REMOVED_TAB]) expect(hostOfTab(t)).toBeNull();
    expect(tabInfersHost(ALL_TAB)).toBe(true);
    expect(tabInfersHost(REMOVED_TAB)).toBe(true);
    expect(tabInfersHost('devbox')).toBe(false);
  });

  it('a host tab has the dot sentence as its only title; All and Local have none', () => {
    const m = buildHostTabs({ configured, dirs });
    const dot = { kind: 'warn' as const, title: 'Build box: Claude Code on Build box is 2.1.220.' };
    expect(tabTitle(m.tabs[3], dot)).toBe(dot.title);
    expect(tabTitle(m.tabs[0], dot)).toBeUndefined();
    expect(tabTitle(m.tabs[1], undefined)).toBeUndefined();
  });

  it('goneHosts: a host the store once reported and no longer does', () => {
    const now = [{ host: 'buildbox' } as HostStatus];
    expect([...goneHosts(new Set(['devbox', 'buildbox']), now)]).toEqual(['devbox']);
  });
});
