/**
 * Session host — the rules that must hold without a Mac.
 *
 * The host exists so macOS attributes the daemon's file access to Walnut.app
 * instead of to whichever `node` started the server. Everything here is a rule
 * that, if it broke, would either put a permission dialog on a developer's
 * screen during a test run, invalidate the user's grant, or report a separation
 * that does not exist.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSessionHostManifest,
  classifySessionHostStart,
  desktopAppCandidates,
  desktopAppExecutable,
  parseSessionHostIdentity,
  sessionHostArgv,
  sessionHostManifestPath,
  sessionHostUnavailableReason,
  SESSION_HOST_FLAG,
  SESSION_HOST_REFUSAL_STATUS,
} from '../../src/providers/session-host-core.js';

const HOME = '/Users/example';
const HOST = '/Applications/Walnut.app/Contents/MacOS/Walnut';
const SHA = 'a'.repeat(64);

describe('sessionHostManifestPath', () => {
  it('is one fixed, version-free place under the real home', () => {
    const manifest = sessionHostManifestPath(HOME);
    expect(manifest).toBe('/Users/example/Library/Application Support/Open Walnut/session-host-launch.json');
    // Keep this in step with desktop/SessionHost.swift's sessionHostManifestPath(),
    // which derives the same path from the passwd entry. If the two drift, the app
    // refuses every launch because it reads a file Walnut never writes.
    expect(manifest).not.toMatch(/\bv\d+\b/);
  });

  it('refuses a relative home rather than inventing a location', () => {
    expect(() => sessionHostManifestPath('relative/home')).toThrow(/absolute/);
  });

  it('is never inside an app bundle', () => {
    // Inside a bundle the manifest would be part of the signed contents, so every
    // approval would break the signature and with it the identity the grant is
    // attached to. Walnut.app also lives in /Applications, which is root-owned.
    expect(sessionHostManifestPath(HOME)).not.toMatch(/\.app\//);
  });
});

describe('desktop app discovery', () => {
  it('prefers the installed app over a repo checkout', () => {
    const candidates = desktopAppCandidates(HOME);
    expect(candidates[0]).toBe('/Applications/Walnut.app');
    expect(candidates[1]).toBe('/Users/example/Applications/Walnut.app');
    // A contributor who also has the app installed must get the INSTALLED one:
    // that is the bundle their permission grants belong to.
    expect(candidates[candidates.length - 1]).toMatch(/desktop\/Walnut\.app$/);
  });

  it('points at the executable, which is what TCC attributes to', () => {
    expect(desktopAppExecutable('/Applications/Walnut.app')).toBe(HOST);
  });

  it('refuses a relative home', () => {
    expect(() => desktopAppCandidates('relative/home')).toThrow(/absolute/);
  });
});

describe('buildSessionHostManifest', () => {
  it('records the command and its payload hashes', () => {
    const manifest = buildSessionHostManifest([
      { argv: ['/opt/walnut/daemon', '--start'], files: [{ path: '/opt/walnut/daemon', sha256: SHA }] },
    ]);
    expect(JSON.parse(manifest)).toEqual({
      version: 1,
      commands: [{
        argv: ['/opt/walnut/daemon', '--start'],
        files: [{ path: '/opt/walnut/daemon', sha256: SHA }],
      }],
    });
  });

  it('is deterministic, so an unchanged approval rewrites the same bytes', () => {
    const command = { argv: ['/opt/node', '/opt/daemon.cjs', '--start'] };
    expect(buildSessionHostManifest([command])).toBe(buildSessionHostManifest([command]));
  });

  it('refuses a relative program', () => {
    // The host execs argv[0] directly. A relative word would resolve against
    // whatever cwd it inherited, which is not a command anyone approved.
    expect(() => buildSessionHostManifest([{ argv: ['daemon', '--start'] }])).toThrow(/absolute/);
  });

  it('refuses a NUL, which could never be the command that ran', () => {
    expect(() => buildSessionHostManifest([{ argv: ['/opt/daemon\0--evil'] }])).toThrow(/NUL/);
    expect(() => buildSessionHostManifest([{ argv: ['/opt/daemon', 'a\0b'] }])).toThrow(/NUL/);
  });

  it('refuses a hash that is not a lowercase hex sha256', () => {
    for (const sha256 of ['', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}g`]) {
      expect(() => buildSessionHostManifest([
        { argv: ['/opt/daemon'], files: [{ path: '/opt/daemon', sha256 }] },
      ])).toThrow(/sha256/);
    }
  });

  it('refuses an empty approval', () => {
    // An empty manifest is not "approve nothing", it is a file the host would
    // read and then refuse everything with — a confusing way to break sessions.
    expect(() => buildSessionHostManifest([])).toThrow(/at least one command/);
    expect(() => buildSessionHostManifest([{ argv: [] }])).toThrow(/must not be empty/);
  });

  it('keeps flags and unicode verbatim, since the host matches argv exactly', () => {
    const argv = ['/opt/walnut/daemon', '--start', 'two words', '"quoted"', '$HOME', '测试'];
    expect(JSON.parse(buildSessionHostManifest([{ argv }])).commands[0].argv).toEqual(argv);
  });
});

describe('sessionHostArgv', () => {
  it('leads with the flag, then separates host options from the payload with --', () => {
    // The flag must be argv[1]: desktop/main.swift dispatches on it before
    // NSApplication exists, so a supervised launch never becomes a visible app.
    expect(sessionHostArgv(HOST, '/opt/walnut/daemon', ['--start']))
      .toEqual([HOST, SESSION_HOST_FLAG, '--', '/opt/walnut/daemon', '--start']);
    expect(SESSION_HOST_FLAG).toBe('--session-host');
  });

  it('refuses relative paths on either side', () => {
    expect(() => sessionHostArgv('host', '/opt/daemon', [])).toThrow(/absolute/);
    expect(() => sessionHostArgv(HOST, 'daemon', [])).toThrow(/absolute/);
  });
});

describe('sessionHostUnavailableReason', () => {
  const base = {
    platform: 'darwin',
    cloudMode: false,
    ephemeral: false,
    daemonDir: '/tmp/open-walnut',
    prodDaemonDir: '/tmp/open-walnut',
    optedOut: false,
  };

  it('allows the real production daemon on macOS', () => {
    expect(sessionHostUnavailableReason(base)).toBeNull();
    // Trailing separators and `.` segments describe the same directory; a textual
    // mismatch here would silently drop the identity on a normalisation detail.
    expect(sessionHostUnavailableReason({ ...base, daemonDir: '/tmp/open-walnut/' })).toBeNull();
    expect(sessionHostUnavailableReason({ ...base, daemonDir: '/tmp/./open-walnut' })).toBeNull();
  });

  it('never touches a non-macOS or cloud host', () => {
    expect(sessionHostUnavailableReason({ ...base, platform: 'linux' })).toBe('not_macos');
    expect(sessionHostUnavailableReason({ ...base, platform: 'win32' })).toBe('not_macos');
    expect(sessionHostUnavailableReason({ ...base, cloudMode: true })).toBe('cloud');
  });

  it('refuses an ephemeral server, which is what keeps dialogs off a test run', () => {
    // Same rule as src/core/helper-build.ts: a throwaway data dir must never
    // install or run a native macOS component. 29 Calendar dialogs in one
    // afternoon came from exactly this shape.
    expect(sessionHostUnavailableReason({ ...base, ephemeral: true })).toBe('ephemeral');
  });

  it('leaves isolated daemons on the plain spawn path', () => {
    // The host is the identity the USER granted to. A test or sandbox daemon has
    // no business borrowing it, and routing one through it would let a test run
    // mutate the user's permission surface.
    expect(sessionHostUnavailableReason({ ...base, daemonDir: '/tmp/walnut-test-123' }))
      .toBe('isolated_daemon');
  });

  it('honours the opt-out ahead of anything it might otherwise build', () => {
    expect(sessionHostUnavailableReason({ ...base, optedOut: true })).toBe('disabled');
    expect(sessionHostUnavailableReason({ ...base, optedOut: true, ephemeral: true })).toBe('disabled');
    // Platform still wins: there is nothing to disable off macOS.
    expect(sessionHostUnavailableReason({ ...base, optedOut: true, platform: 'linux' })).toBe('not_macos');
  });
});

describe('parseSessionHostIdentity', () => {
  const identity = {
    pid: 4242,
    parentPid: 1,
    responsiblePid: 4242,
    selfResponsible: true,
    bundlePath: '/Users/example/Library/Application Support/Open Walnut/Walnut Sessions.app',
    bundleIdentifier: 'com.local.walnut-desktop',
    executablePath: HOST,
    disclaimed: true,
    manifestPath: '/Users/example/Library/Application Support/Open Walnut/session-host-launch.json',
  };

  it('reads a real answer', () => {
    const parsed = parseSessionHostIdentity(`${JSON.stringify(identity)}\n`);
    expect(parsed?.bundleIdentifier).toBe('com.local.walnut-desktop');
    expect(parsed?.selfResponsible).toBe(true);
    expect(parsed?.disclaimed).toBe(true);
  });

  it('derives selfResponsible from the pids, not from the claim', () => {
    // The flag and the numbers come from the same process. Only the numbers are
    // the system's answer, and this value decides whether Walnut may tell the
    // user their sessions run under a separate identity.
    const lying = { ...identity, responsiblePid: 99, selfResponsible: true };
    expect(parseSessionHostIdentity(JSON.stringify(lying))?.selfResponsible).toBe(false);
  });

  it('returns null on anything it cannot read, so "unknown" is never "working"', () => {
    for (const bad of ['', 'not json', '[]', 'null', '{"pid":1}', JSON.stringify({ ...identity, pid: '1' })]) {
      expect(parseSessionHostIdentity(bad)).toBeNull();
    }
  });
});

describe('classifySessionHostStart', () => {
  it('accepts the start as soon as the daemon published its port', () => {
    for (const hostAlive of [true, false]) {
      const start = classifySessionHostStart({ portFileSeen: true, hostUsed: true, hostAlive });
      expect(start).toEqual({ verdict: 'started', reason: 'port_file_written' });
    }
  });

  it('retries directly when the host exited without bringing a daemon up', () => {
    // The degradation rule: an identity upgrade must never be able to leave the
    // machine with no local sessions.
    expect(classifySessionHostStart({ portFileSeen: false, hostUsed: true, hostAlive: false }))
      .toEqual({ verdict: 'retry_directly', reason: 'host_exited_without_daemon' });
  });

  it('refuses to retry while the host is still running', () => {
    // The one case that could produce TWO daemons against one runtime dir. A
    // live host may have a daemon seconds away from writing its port file, so
    // this must fail loudly instead of starting a competitor. The retry is only
    // safe in the case above, and only because the host outlives its daemon.
    expect(classifySessionHostStart({ portFileSeen: false, hostUsed: true, hostAlive: true }))
      .toEqual({ verdict: 'give_up', reason: 'host_still_running' });
  });

  it('keeps the plain spawn failure exactly as it was', () => {
    // No host involved: this is the pre-existing "port file not created" error,
    // and adding the identity layer must not turn it into a second spawn.
    for (const hostAlive of [true, false]) {
      expect(classifySessionHostStart({ portFileSeen: false, hostUsed: false, hostAlive }))
        .toEqual({ verdict: 'give_up', reason: 'plain_spawn_failed' });
    }
  });

  it('never answers retry_directly for a spawn the host did not make', () => {
    // Generated rather than hand-listed: a retry is authorized by exactly one
    // combination, and every other one of the eight must not get it.
    const combos = [true, false].flatMap((portFileSeen) =>
      [true, false].flatMap((hostUsed) =>
        [true, false].map((hostAlive) => ({ portFileSeen, hostUsed, hostAlive })),
      ),
    );
    const retries = combos.filter((c) => classifySessionHostStart(c).verdict === 'retry_directly');
    expect(retries).toEqual([{ portFileSeen: false, hostUsed: true, hostAlive: false }]);
  });
});

describe('refusal status', () => {
  it('is reserved for the host, apart from any status the daemon chooses', () => {
    // The daemon exits non-zero on purpose so launchd restarts it to finish an
    // update. A shared code would make "the host would not run this" and "the
    // daemon asked for a restart" indistinguishable.
    expect(SESSION_HOST_REFUSAL_STATUS).toBe(125);
    expect(SESSION_HOST_REFUSAL_STATUS).not.toBe(0);
    expect(SESSION_HOST_REFUSAL_STATUS).not.toBe(1);
  });
});
