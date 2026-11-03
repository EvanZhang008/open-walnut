/**
 * The update notice's `server` kind: what it says and offers for every live
 * self-update state of the contract, and that a server older than live update
 * (no `live`) offers nothing, as before.
 */
import { describe, it, expect } from 'vitest';
import type { LiveUpdate, UpdateStatus } from '@/api/update';
import {
  INSTALLED_TOOLTIP, RESTART_TOOLTIP, WORKING_SHORT, displayVersion, howToUpdateCommands, readSeenVersion, serverPillView, updatedNotice, writeSeenVersion,
} from '@/components/common/server-update-pill';

const NPM = { kind: 'npm' as const, sourceDir: null, packageRoot: '/usr/local/lib/node_modules/open-walnut', manager: 'npm' as const, updateCommand: 'npm install -g open-walnut@latest' };

function live(over: Partial<LiveUpdate> = {}): LiveUpdate {
  return {
    state: 'idle', version: null, error: null, canInstall: true, held: null, updatesAuto: true,
    idle: { ready: false, userIdleMs: 1000, turnsRunning: 0, waitingSince: null }, ...over,
  };
}

function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    enabled: true, install: NPM, current: '0.5.1', channel: 'stable', latest: '0.9.0', tags: { latest: '0.9.0', nightly: null }, available: true,
    checkedAt: new Date().toISOString(), error: null, checking: false, packageUrl: 'https://www.npmjs.com/package/open-walnut', ...over,
  };
}

describe('serverPillView', () => {
  it('an older server (no live field) offers nothing, whatever it reports', () => {
    expect(serverPillView(status())).toBeNull();
    expect(serverPillView(status({ autoUpdate: true }))).toBeNull();
    expect(serverPillView(null)).toBeNull();
  });

  it('nothing newer, a disabled check, or no version: nothing', () => {
    expect(serverPillView(status({ available: false, latest: '0.5.1', live: live() }))).toBeNull();
    expect(serverPillView(status({ enabled: false, reason: 'source', live: live({ state: 'off', canInstall: false }) }))).toBeNull();
    expect(serverPillView(status({ latest: null, available: false, live: live() }))).toBeNull();
  });

  it('available, this copy cannot install: "How to update"', () => {
    const v = serverPillView(status({ live: live({ state: 'off', canInstall: false }) }))!;
    expect(v).toMatchObject({ stage: 'available', heading: 'Walnut 0.9.0 available', action: 'how', label: 'How to update', busy: false });
  });

  it('available, can install, auto off: "Update"', () => {
    const v = serverPillView(status({ live: live({ state: 'off', updatesAuto: false }) }))!;
    expect(v).toMatchObject({ stage: 'available', heading: 'Walnut 0.9.0 available', action: 'install', label: 'Update', short: 'Update' });
  });

  it('available, can install, auto on but the version is held: "Update", and the tooltip names why', () => {
    const v = serverPillView(status({ live: live({ held: 'it failed to start last time' }) }))!;
    expect(v).toMatchObject({ action: 'install', label: 'Update' });
    expect(v.tooltip).toContain('it failed to start last time');
  });

  it('available, auto on, idle or downloading: "Updating Walnut to X…" with nothing to click', () => {
    for (const state of ['idle', 'downloading'] as const) {
      const v = serverPillView(status({ live: live({ state, version: state === 'downloading' ? '0.9.0' : null }) }))!;
      expect(v).toMatchObject({ stage: 'updating', heading: 'Updating Walnut to 0.9.0…', action: null, busy: false });
    }
  });

  it('installed or waiting: "Walnut X is ready" · Restart, with the idle tooltip', () => {
    for (const state of ['installed', 'waiting'] as const) {
      const v = serverPillView(status({ live: live({ state, version: '0.9.0' }) }))!;
      expect(v).toMatchObject({ stage: 'ready', heading: 'Walnut 0.9.0 is ready', action: 'restart', label: 'Restart', tooltip: RESTART_TOOLTIP });
      expect(v.tooltip).toBe('Restarts by itself once you have been away 10 minutes');
    }
  });

  it('restarting: "Restarting into Walnut X…", busy (no ×), nothing to click', () => {
    const v = serverPillView(status({ live: live({ state: 'restarting', version: '0.9.0' }) }))!;
    expect(v).toMatchObject({ stage: 'restarting', heading: 'Restarting into Walnut 0.9.0…', action: null, busy: true });
  });

  it('failed: "Walnut X did not install" · Try again (installs again), the error in the tooltip', () => {
    const v = serverPillView(status({ live: live({ state: 'failed', version: '0.9.0', error: 'EACCES' }) }))!;
    expect(v).toMatchObject({ stage: 'failed', heading: 'Walnut 0.9.0 did not install', action: 'install', label: 'Try again' });
    expect(v.tooltip).toContain('EACCES');
  });

  it('a version the startup path installed after this server started reads as ready when the server can restart itself', () => {
    const v = serverPillView(status({ installed: '0.9.0', live: live({ state: 'off', updatesAuto: false }) }))!;
    expect(v).toMatchObject({ stage: 'ready', heading: 'Walnut 0.9.0 is ready', action: 'restart' });
  });

  it('installed on a server that cannot restart itself (canInstall false): "is installed", no Restart button that can only fail', () => {
    const cases = [
      // A startup install that outlived its budget, on a server with no restart handler.
      status({ installed: '0.9.0', live: live({ state: 'off', canInstall: false, updatesAuto: true }) }),
      // A live state that says installed or waiting, with no way to restart.
      status({ live: live({ state: 'installed', version: '0.9.0', canInstall: false }) }),
      status({ live: live({ state: 'waiting', version: '0.9.0', canInstall: false }) }),
    ];
    for (const st of cases) {
      const v = serverPillView(st)!;
      expect(v).toMatchObject({ stage: 'installed', heading: 'Walnut 0.9.0 is installed', action: null, busy: false, working: false, tooltip: INSTALLED_TOOLTIP });
      expect(v.tooltip).not.toBe(RESTART_TOOLTIP);
      expect(v.tooltip).toContain('Quit Walnut and start it again');
      expect(v.versionTitle).toContain('Walnut 0.9.0');
      expect(v.identity).toBe('server:0.9.0:installed');
    }
    const nightly = serverPillView(status({ live: live({ state: 'installed', version: '0.6.25-nightly.20261103.9', canInstall: false }) }))!;
    expect(nightly.heading).toBe('Walnut 0.6.25 nightly is installed');
  });

  it('each step of one release has its own snooze identity; the same step of a newer release does too', () => {
    const avail = serverPillView(status({ live: live({ updatesAuto: false, state: 'off' }) }))!.identity;
    const ready = serverPillView(status({ live: live({ state: 'installed', version: '0.9.0' }) }))!.identity;
    const newer = serverPillView(status({ latest: '1.0.0', live: live({ updatesAuto: false, state: 'off' }) }))!.identity;
    expect(new Set([avail, ready, newer]).size).toBe(3);
  });
});

describe('displayVersion (one formatter for every server heading)', () => {
  it('a nightly drops its build stamp; anything else stays as it is', () => {
    expect(displayVersion('0.6.25-nightly.20261103.9000002')).toBe('0.6.25 nightly');
    expect(displayVersion('0.6.25-nightly')).toBe('0.6.25 nightly');
    expect(displayVersion('v1.2.3-nightly+abc')).toBe('1.2.3 nightly');
    expect(displayVersion('0.9.0')).toBe('0.9.0');
    expect(displayVersion('1.0.0-beta.2')).toBe('1.0.0-beta.2');
    expect(displayVersion('0.6.25-nightlyish')).toBe('0.6.25-nightlyish');
  });

  it('every server heading shows the short form; the full version rides the heading tooltip and the action tooltip', () => {
    const v = '0.6.25-nightly.20261103.9000002';
    const nightly = (l: Partial<LiveUpdate>, over: Partial<UpdateStatus> = {}) =>
      serverPillView(status({ latest: v, channel: 'nightly', tags: { latest: '0.6.24', nightly: v }, live: live(l), ...over }))!;
    const views = [
      nightly({ state: 'off', canInstall: false }),
      nightly({ state: 'off', updatesAuto: false }),
      nightly({ state: 'downloading', version: v }),
      nightly({ state: 'installed', version: v }),
      nightly({ state: 'restarting', version: v }),
      nightly({ state: 'failed', version: v, error: 'x' }),
    ];
    expect(views.map((x) => x.heading)).toEqual([
      'Walnut 0.6.25 nightly available', 'Walnut 0.6.25 nightly available', 'Updating Walnut to 0.6.25 nightly…',
      'Walnut 0.6.25 nightly is ready', 'Restarting into Walnut 0.6.25 nightly…', 'Walnut 0.6.25 nightly did not install',
    ]);
    for (const x of views) expect(x.versionTitle).toBe(`Walnut ${v}`);
    expect(views[2]!.tooltip).toContain(v);
    expect(views[5]!.tooltip).toContain(v);
  });

  it('the collapsed rail: installing and restarting say "Wait" with a turning icon; the rest keep their verbs', () => {
    const u = serverPillView(status({ live: live({ state: 'downloading', version: '0.9.0' }) }))!;
    const r = serverPillView(status({ live: live({ state: 'restarting', version: '0.9.0' }) }))!;
    expect([u.short, u.working, r.short, r.working]).toEqual([WORKING_SHORT, true, WORKING_SHORT, true]);
    expect(WORKING_SHORT.length).toBeLessThanOrEqual(7);
    const ready = serverPillView(status({ live: live({ state: 'installed', version: '0.9.0' }) }))!;
    expect([ready.short, ready.working]).toEqual(['Restart', false]);
  });
});

describe('howToUpdateCommands', () => {
  it('lists the install command, then a Homebrew keg\'s way to the file when it differs', () => {
    expect(howToUpdateCommands(status())).toEqual([{ note: null, command: 'npm install -g open-walnut@latest' }]);
    const brewHint = { note: 'Homebrew installed this copy.', command: 'brew upgrade open-walnut' };
    expect(howToUpdateCommands(status({ brewHint }))).toEqual([
      { note: null, command: 'npm install -g open-walnut@latest' },
      { note: 'Homebrew installed this copy.', command: 'brew upgrade open-walnut' },
    ]);
    expect(howToUpdateCommands(status({ brewHint, install: { ...NPM, kind: 'other', updateCommand: 'brew upgrade open-walnut' } })))
      .toEqual([{ note: null, command: 'brew upgrade open-walnut' }]);
    expect(howToUpdateCommands(status({ install: { ...NPM, updateCommand: null } }))).toEqual([]);
  });
});

describe('updatedNotice ("Walnut updated to X")', () => {
  it('announces only a version that differs from the one this tab saw; the first answer only records', () => {
    expect(updatedNotice(null, '0.9.0')).toBeNull();
    expect(updatedNotice('0.9.0', '0.9.0')).toBeNull();
    expect(updatedNotice('0.5.1', '0.9.0')).toBe('0.9.0');
    expect(updatedNotice('0.5.1', null)).toBeNull();
  });

  it('reads and writes the tab\'s seen version, and survives a store that throws', () => {
    const map = new Map<string, string>();
    const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
    expect(readSeenVersion(store)).toBeNull();
    writeSeenVersion('0.9.0', store);
    expect(readSeenVersion(store)).toBe('0.9.0');
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readSeenVersion(broken)).toBeNull();
    expect(() => writeSeenVersion('1', broken)).not.toThrow();
  });
});
