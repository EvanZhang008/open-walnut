/**
 * What a brand-new user sees on the first screen, web side (2026-11-10 review, U01). The rule for
 * every install: on the first screen (Walnut not set up yet) nothing that asks nothing of the user
 * shows as a notice; real warnings stay, worded calmly. The Demo shows no update offer and no
 * backup card, since it is a throwaway copy.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { LiveUpdate, UpdateStatus } from '@/api/update';
import type { FleetHost } from '@/api/hosts-fleet';
import { serverPillView } from '@/components/common/server-update-pill';
import { updateCardView } from '@/components/common/update-card-view';
import { gitSyncNeedsLook } from '@/hooks/useSystemHealth';
import { problemsOf } from '@/components/settings/sections/host-fleet-dashboard-model';

const NPM = { kind: 'npm' as const, sourceDir: null, packageRoot: '/usr/lib/node_modules/open-walnut', manager: 'npm' as const, updateCommand: 'npm install -g open-walnut@latest' };
const live = (over: Partial<LiveUpdate> = {}): LiveUpdate => ({
  state: 'idle', version: null, error: null, canInstall: false, held: null, updatesAuto: false,
  idle: { ready: false, userIdleMs: 1000, turnsRunning: 0, waitingSince: null }, ...over,
});
const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  enabled: true, install: NPM, current: '0.6.29', channel: 'stable', latest: '0.6.30', tags: { latest: '0.6.30', nightly: null }, available: true,
  checkedAt: new Date().toISOString(), error: null, checking: false, packageUrl: 'https://www.npmjs.com/package/open-walnut', live: live(), ...over,
});

describe('the update offer waits until Walnut is set up', () => {
  it('"How to update" and "Update" are held on the first screen, shown once set up', () => {
    expect(serverPillView(status())?.action).toBe('how');
    expect(serverPillView(status(), { firstRun: true })).toBeNull();
    expect(serverPillView(status({ live: live({ canInstall: true }) }), { firstRun: true })).toBeNull();
    // Work already under way still shows.
    expect(serverPillView(status({ live: live({ state: 'restarting', version: '0.6.30' }) }), { firstRun: true })?.stage).toBe('restarting');
    expect(serverPillView(status({ live: live({ state: 'downloading', version: '0.6.30' }) }), { firstRun: true })?.stage).toBe('updating');
  });

  it('the Demo offers none at all, and its card says why in plain words', () => {
    const demo = status({ enabled: false, reason: 'demo', available: false, latest: null });
    expect(serverPillView(demo)).toBeNull();
    expect(updateCardView(demo)).toMatchObject({ tone: 'neutral', status: 'Walnut Demo', canCheck: false });
    // No package-manager jargon on a copy that cannot update itself.
    const noManager = updateCardView(status({ install: { ...NPM, manager: null, updateCommand: null } }));
    expect(noManager.note).not.toMatch(/package manager/i);
  });
});

describe('a backup that runs nowhere by design is no warning', () => {
  it('off: never needs a look; a real unprotected or failing backup still does', () => {
    expect(gitSyncNeedsLook({ protected: false, consecutiveFailures: 0, off: 'demo' })).toBe(false);
    expect(gitSyncNeedsLook({ protected: false, consecutiveFailures: 0, off: 'test' })).toBe(false);
    expect(gitSyncNeedsLook({ protected: false, consecutiveFailures: 0, error: 'git unavailable' })).toBe(true);
    expect(gitSyncNeedsLook({ protected: true, consecutiveFailures: 3 })).toBe(true);
    expect(gitSyncNeedsLook({ protected: true, consecutiveFailures: 0 })).toBe(false);
  });

  it('private data holds never contribute to the bell or Needs you verdict', () => {
    const heldFiles = [{ file: '/home/alice/.open-walnut/notes/setup.md', kinds: ['private-key'], lines: [2], since: 'now' }];
    expect(gitSyncNeedsLook({ protected: true, consecutiveFailures: 0, heldFiles })).toBe(false);
    // Holding one file must not hide an actual backup failure.
    expect(gitSyncNeedsLook({ protected: true, consecutiveFailures: 3, heldFiles })).toBe(true);
  });

  it('guard: nothing in the web app judges the backup by `protected` alone', () => {
    const root = path.join(__dirname, '../../web/src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) {
          const text = fs.readFileSync(p, 'utf8');
          // `gitSync.protected` as a verdict (in a `!`, `&&` or ternary), outside the one rule.
          for (const m of text.matchAll(/!?gitSync\.protected\s*(?:&&|\|\||\?)|!gitSync\.protected\b/g)) {
            if (!p.endsWith('useSystemHealth.ts')) offenders.push(`${path.relative(root, p)}: ${m[0]}`);
          }
        }
      }
    };
    walk(root);
    // The System pane's detail rows may say which way it failed, inside the card the rule shows.
    expect(offenders.filter((o) => !o.startsWith('components/common/NotificationSystemPane.tsx: !gitSync.protected ?'))).toEqual([]);
  });
});

describe('host lines on a first screen are calm and real', () => {
  const GB = 1024 ** 3;
  const NOW = Date.UTC(2026, 10, 10, 12);
  const host = (over: Partial<FleetHost> = {}): FleetHost => ({
    host: 'devbox', label: 'devbox', local: false, line: '', checkedAt: NOW,
    connection: { kind: 'ssh-tunnel', connected: true, phase: 'connected', phaseLabel: 'Connected', since: NOW - 60_000, rttMs: 5, error: null },
    system: { os: 'Ubuntu 24.04', arch: 'arm64', cpus: 14, memBytes: 8 * GB, diskFreeBytes: 400 * GB, kind: 'private-cloud-vm', probedAt: null },
    now: null, history: null, sessions: { running: 0 }, spend: null, server: null,
    daemon: { version: 'v', startedAt: 0, startup: 'on-demand', startsAfterReboot: false, runtime: 'bun', vitals: true, bootStart: null, reboot: 'does not start by itself after a reboot' },
    placement: { score: 1, busy: false, reasons: [], weight: 50, longRunning: { ok: true, reasons: [] } },
    ...over,
  } as FleetHost);

  it('a throwaway daemon reads no reboot problem; a real one still does', () => {
    expect(problemsOf(host(), NOW).map((p) => p.key)).toEqual(['reboot']);
    expect(problemsOf(host({ daemon: { ...host().daemon!, throwaway: true } }), NOW)).toEqual([]);
  });

  it('low disk is amber "Low on disk space"; only a nearly full one is red "Disk almost full"', () => {
    const at = (free: number) => problemsOf(host({ local: true, daemon: null, system: { ...host().system!, diskFreeBytes: free * GB } }), NOW)[0];
    expect(at(12)).toMatchObject({ key: 'disk', text: 'Low on disk space: 12 GB free', tone: 'warn' });
    expect(at(3)).toMatchObject({ key: 'disk', text: 'Disk almost full: 3 GB free', tone: 'bad' });
    expect(at(40)).toBeUndefined();
  });
});
