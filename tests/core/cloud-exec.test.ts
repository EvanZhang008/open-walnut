/**
 * Cloud-exec decision core — the rules that decide whether the cloud companion
 * runs a session itself, and where it is allowed to run it.
 *
 * Every case here is a design invariant with a stated failure mode in
 * src/core/cloud-exec.ts, not incidental coverage. The three that matter most:
 * default-OFF on an internet-facing box, no silent host fallback, and
 * segment-anchored cwd containment.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { Config } from '../../src/core/types.js';
import {
  CLOUD_HOST_ALIAS,
  CLOUD_EXEC_DEFAULT_MAX_SESSIONS,
  cloudExecHostEntry,
  cloudExecStatus,
  cloudSessionLimits,
  isCwdWithinRoots,
  launchHostForCore,
  launchOptionsWhenPrimaryOffline,
  readCloudExecConfig,
  reservedHostAliasConflicts,
  resolveLaunchTarget,
  unionOwnedSessions,
} from '../../src/core/cloud-exec.js';

const HOME = '/home/walnut';

function cfg(exec?: Config['cloud'] extends infer C ? (C extends { exec?: infer E } ? E : never) : never): Pick<Config, 'cloud'> {
  return exec ? { cloud: { exec } } : {};
}

describe('cloud exec: default posture is OFF', () => {
  it('is off with no config at all', () => {
    expect(readCloudExecConfig(undefined, true, HOME).enabled).toBe(false);
    expect(cloudExecStatus(undefined, true, HOME)).toEqual({ enabled: false, reason: 'not_enabled' });
  });

  it('is off on the PRIMARY box even when the config says enabled', () => {
    // cloudMode=false: the knob is cloud-companion-only. A primary box that
    // somehow carries this config must not change behavior.
    const c = cfg({ enabled: true, cwd_roots: ['/srv/work'] });
    expect(readCloudExecConfig(c, false, HOME).enabled).toBe(false);
    expect(cloudExecStatus(c, false, HOME).reason).toBe('not_cloud_mode');
  });

  it('refuses enabled:true with NO roots — an unbounded exec host is not a default', () => {
    const c = cfg({ enabled: true });
    expect(readCloudExecConfig(c, true, HOME).enabled).toBe(false);
    expect(cloudExecStatus(c, true, HOME).reason).toBe('no_cwd_roots');
  });

  it('distinguishes "no roots" from "roots present but unusable"', () => {
    // A relative root is a typo the operator can only find if we say which
    // failure it is — both would otherwise read as "no_cwd_roots".
    const c = cfg({ enabled: true, cwd_roots: ['work/relative'] });
    expect(cloudExecStatus(c, true, HOME).reason).toBe('cwd_roots_not_absolute');
    expect(readCloudExecConfig(c, true, HOME).cwdRoots).toEqual([]);
  });

  it('turns on with enabled + one absolute root, and reports a root COUNT not the paths', () => {
    const c = cfg({ enabled: true, cwd_roots: ['/srv/work'] });
    expect(readCloudExecConfig(c, true, HOME).enabled).toBe(true);
    const status = cloudExecStatus(c, true, HOME);
    expect(status).toEqual({
      enabled: true,
      maxSessions: CLOUD_EXEC_DEFAULT_MAX_SESSIONS,
      cwdRootCount: 1,
    });
    // The box's directory layout is not an internet-facing client's business.
    expect(JSON.stringify(status)).not.toContain('/srv/work');
  });

  it('expands ~ in roots against the given home', () => {
    const c = cfg({ enabled: true, cwd_roots: ['~/projects', '~'] });
    expect(readCloudExecConfig(c, true, HOME).cwdRoots)
      .toEqual([path.join(HOME, 'projects'), HOME]);
  });

  it('defaults max_sessions low (2GB box shared with the HTTP API) and honors a valid override', () => {
    expect(readCloudExecConfig(cfg({ enabled: true, cwd_roots: ['/a'] }), true, HOME).maxSessions).toBe(2);
    expect(readCloudExecConfig(cfg({ enabled: true, cwd_roots: ['/a'], max_sessions: 5 }), true, HOME).maxSessions).toBe(5);
    // Junk falls back to the safe default rather than uncapping the box.
    for (const bad of [0, -1, 2.5]) {
      expect(readCloudExecConfig(
        cfg({ enabled: true, cwd_roots: ['/a'], max_sessions: bad }), true, HOME,
      ).maxSessions).toBe(CLOUD_EXEC_DEFAULT_MAX_SESSIONS);
    }
  });
});

describe('cloud exec: cwd containment is segment-anchored', () => {
  const roots = ['/srv/work', '/data/repos'];

  it('accepts the root itself and anything under it', () => {
    expect(isCwdWithinRoots('/srv/work', roots, HOME)).toBe(true);
    expect(isCwdWithinRoots('/srv/work/proj/sub', roots, HOME)).toBe(true);
    expect(isCwdWithinRoots('/data/repos/x', roots, HOME)).toBe(true);
  });

  it('rejects a SIBLING whose name merely starts with the root — the substring trap', () => {
    // A bare prefix check would accept both of these.
    expect(isCwdWithinRoots('/srv/work-secrets', roots, HOME)).toBe(false);
    expect(isCwdWithinRoots('/srv/workshop/x', roots, HOME)).toBe(false);
  });

  it('rejects a traversal escape — normalize runs BEFORE the containment test', () => {
    // Any rule that can DELETE a `..` must precede the safety check, or
    // `/srv/work/../etc` reads as contained.
    expect(isCwdWithinRoots('/srv/work/../etc', roots, HOME)).toBe(false);
    expect(isCwdWithinRoots('/srv/work/proj/../../etc/shadow', roots, HOME)).toBe(false);
    // A path that traverses but lands back INSIDE is fine.
    expect(isCwdWithinRoots('/srv/work/a/../b', roots, HOME)).toBe(true);
  });

  it('rejects unrelated, relative, and empty paths', () => {
    expect(isCwdWithinRoots('/etc', roots, HOME)).toBe(false);
    expect(isCwdWithinRoots('relative/path', roots, HOME)).toBe(false);
    expect(isCwdWithinRoots('', roots, HOME)).toBe(false);
    expect(isCwdWithinRoots('/srv', roots, HOME)).toBe(false); // parent, not child
  });

  it('rejects everything when the root list is empty', () => {
    expect(isCwdWithinRoots('/srv/work', [], HOME)).toBe(false);
  });
});

describe('cloud exec: host selection never silently falls back', () => {
  const enabled = cfg({ enabled: true, cwd_roots: ['/srv/work'] });

  it('relays an ABSENT host — undefined still means "the primary box"', () => {
    // The core invariant: running work on the wrong machine is worse than an
    // honest error, so a missing host is never reinterpreted as the cloud box.
    expect(resolveLaunchTarget(undefined, '/srv/work', enabled, true, HOME)).toEqual({ kind: 'relay' });
    expect(resolveLaunchTarget('', '/srv/work', enabled, true, HOME)).toEqual({ kind: 'relay' });
  });

  it('relays a named config host untouched', () => {
    expect(resolveLaunchTarget('devbox', '/srv/work', enabled, true, HOME)).toEqual({ kind: 'relay' });
  });

  it('runs here ONLY for the explicit cloud alias with an allowed cwd', () => {
    expect(resolveLaunchTarget(CLOUD_HOST_ALIAS, '/srv/work/proj', enabled, true, HOME))
      .toEqual({ kind: 'run-here' });
  });

  it('refuses the cloud alias when exec is off, naming the reason', () => {
    const t = resolveLaunchTarget(CLOUD_HOST_ALIAS, '/srv/work', undefined, true, HOME);
    expect(t.kind).toBe('refused');
    if (t.kind === 'refused') {
      expect(t.reason).toBe('not_enabled');
      expect(t.message).toMatch(/cloud\.exec\.enabled/);
    }
  });

  it('refuses a cwd outside the roots WITHOUT echoing the allowed roots', () => {
    const t = resolveLaunchTarget(CLOUD_HOST_ALIAS, '/etc', enabled, true, HOME);
    expect(t.kind).toBe('refused');
    if (t.kind === 'refused') {
      expect(t.reason).toBe('cwd_not_allowed');
      expect(t.message).toContain('/etc');
      expect(t.message).not.toContain('/srv/work');
    }
  });

  it('refuses the cloud alias on a NON-cloud box', () => {
    const t = resolveLaunchTarget(CLOUD_HOST_ALIAS, '/srv/work', enabled, false, HOME);
    expect(t.kind).toBe('refused');
    if (t.kind === 'refused') expect(t.reason).toBe('not_cloud_mode');
  });
});

describe('cloud exec: the alias is an EDGE concept only', () => {
  it('maps the cloud alias to undefined for the session core, passing everything else through', () => {
    // This is what keeps the spawn path free of a new branch: undefined →
    // no sshTarget → createSessionManager routes to the local daemon.
    expect(launchHostForCore(CLOUD_HOST_ALIAS)).toBeUndefined();
    expect(launchHostForCore(undefined)).toBeUndefined();
    expect(launchHostForCore('devbox')).toBe('devbox');
    expect(launchHostForCore('')).toBe('');
  });

  it('does not collide with the pre-existing local alias', () => {
    expect(CLOUD_HOST_ALIAS).not.toBe('__local__');
    expect(CLOUD_HOST_ALIAS).not.toBe('');
  });
});

describe('cloud exec: launcher host row', () => {
  it('is absent when exec is off — the picker never offers a host that would refuse', () => {
    expect(cloudExecHostEntry(undefined, true, HOME)).toBeNull();
    expect(cloudExecHostEntry(cfg({ enabled: true }), true, HOME)).toBeNull();
    expect(cloudExecHostEntry(cfg({ enabled: true, cwd_roots: ['/a'] }), false, HOME)).toBeNull();
  });

  it('is present, with the cloud alias, when exec is on', () => {
    const entry = cloudExecHostEntry(cfg({ enabled: true, cwd_roots: ['/a'] }), true, HOME);
    expect(entry).toEqual({ alias: CLOUD_HOST_ALIAS, label: expect.any(String) });
  });
});

describe('cloud exec: primary-offline launch options', () => {
  it('offers ONLY the cloud host, flagged so a client can ask before running anything', () => {
    const opts = launchOptionsWhenPrimaryOffline(cfg({ enabled: true, cwd_roots: ['/a'] }), true, HOME);
    expect(opts).toEqual({
      hosts: [{ alias: CLOUD_HOST_ALIAS, label: expect.any(String) }],
      dirs: [],
      primaryOffline: true,
      degraded: true,
    });
    // The Mac's hosts and frequent dirs live on the Mac — inventing entries for
    // machines we cannot reach would be a confident wrong answer.
    expect(opts!.hosts).toHaveLength(1);
  });

  it('returns null when this box cannot execute either — caller keeps its honest 503', () => {
    expect(launchOptionsWhenPrimaryOffline(undefined, true, HOME)).toBeNull();
    expect(launchOptionsWhenPrimaryOffline(cfg({ enabled: true, cwd_roots: ['/a'] }), false, HOME)).toBeNull();
  });
});

describe('cloud exec: read-side union of the two disjoint session halves', () => {
  const projected = [
    { id: 'mac-1', host: '', process_status: 'running' },
    { id: 'remote-1', host: 'devbox', process_status: 'idle' },
  ];

  it('re-tags own rows to the cloud alias — a stored host of "" means THE MAC downstream', () => {
    // Shipping '' verbatim would tell the phone a cloud session lives on the
    // Mac, and its next send would be relayed to a machine with no such process.
    const out = unionOwnedSessions(projected, [{ id: 'cloud-1', host: '', process_status: 'running' }]);
    expect(out).toHaveLength(3);
    expect(out.find((s) => s.id === 'cloud-1')!.host).toBe(CLOUD_HOST_ALIAS);
    // Projection rows are untouched.
    expect(out.find((s) => s.id === 'mac-1')!.host).toBe('');
    expect(out.find((s) => s.id === 'remote-1')!.host).toBe('devbox');
  });

  it('lets the projection win on an id collision — the Mac owns lifecycle', () => {
    const out = unionOwnedSessions(projected, [{ id: 'mac-1', host: '', process_status: 'stopped' }]);
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.id === 'mac-1')).toMatchObject({ host: '', process_status: 'running' });
  });

  it('handles either half being empty', () => {
    expect(unionOwnedSessions([], [{ id: 'c', host: '' }])).toEqual([{ id: 'c', host: CLOUD_HOST_ALIAS }]);
    expect(unionOwnedSessions(projected, [])).toEqual(projected);
    expect(unionOwnedSessions([], [])).toEqual([]);
  });
});

describe('cloud exec: reserved alias shadowing', () => {
  it('flags a config.hosts entry that would shadow a reserved alias', () => {
    // Such an entry would appear in the picker and silently run work elsewhere.
    expect(reservedHostAliasConflicts(['devbox', '__local__', CLOUD_HOST_ALIAS]).sort())
      .toEqual(['__cloud__', '__local__']);
  });

  it('reports nothing for an ordinary host list', () => {
    expect(reservedHostAliasConflicts(['devbox', 'nas', 'cloud'])).toEqual([]);
  });
});

describe('cloud exec: session limits', () => {
  it('caps the LOCAL key (the one the tracker consults) at the small cloud default', () => {
    // The alias is edge-only, so the spawn is a local session and the generic
    // local=7 default would swap-thrash a 2GB box.
    const limits = cloudSessionLimits(cfg({ enabled: true, cwd_roots: ['/a'] }), true, HOME);
    expect(limits.local).toBe(CLOUD_EXEC_DEFAULT_MAX_SESSIONS);
  });

  it('never overrides an explicit operator limit', () => {
    const c = { ...cfg({ enabled: true, cwd_roots: ['/a'] }), session_limits: { local: 4 } };
    expect(cloudSessionLimits(c, true, HOME).local).toBe(4);
  });

  it('leaves limits untouched when exec is off', () => {
    expect(cloudSessionLimits({ session_limits: { local: 7 } }, true, HOME)).toEqual({ local: 7 });
    expect(cloudSessionLimits(undefined, true, HOME)).toEqual({});
  });
});
