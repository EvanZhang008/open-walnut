/**
 * Walnut Sessions host — the rules that must hold without a Mac.
 *
 * The host exists so macOS attributes the daemon's file access to one stable
 * signed bundle instead of to whichever `node` started Walnut. Everything here
 * is a rule that, if it broke, would either put a permission dialog on a
 * developer's screen during a test run, invalidate the user's grant, or report a
 * separation that does not exist.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSessionHostManifest,
  parseSessionHostIdentity,
  renderSessionHostInfoPlist,
  sessionHostArgv,
  sessionHostPaths,
  sessionHostUnavailableReason,
  SESSION_HOST_BUNDLE_ID,
  SESSION_HOST_REFUSAL_STATUS,
} from '../../src/providers/session-host-core.js';

const HOME = '/Users/example';
const HOST = '/Users/example/Library/Application Support/Open Walnut/Walnut Sessions.app/Contents/MacOS/WalnutSessionsHost';
const SHA = 'a'.repeat(64);

describe('sessionHostPaths', () => {
  it('puts the bundle and its manifest in one fixed, version-free place', () => {
    const paths = sessionHostPaths(HOME);
    expect(paths.root).toBe('/Users/example/Library/Application Support/Open Walnut');
    expect(paths.app).toBe(`${paths.root}/Walnut Sessions.app`);
    expect(paths.executable).toBe(HOST);
    expect(paths.manifest).toBe(`${paths.root}/session-host-launch.json`);
    // Full Disk Access is administered as a row the user adds by PATH. A version
    // in any of these would make every upgrade look like a new program and ask
    // for the grant again — the exact problem the host exists to end.
    for (const value of Object.values(paths)) {
      expect(value).not.toMatch(/\bv\d+\b/);
    }
  });

  it('refuses a relative home rather than inventing a location', () => {
    expect(() => sessionHostPaths('relative/home')).toThrow(/absolute/);
  });

  it('keeps the manifest beside the bundle, never inside it', () => {
    const paths = sessionHostPaths(HOME);
    // The host resolves the manifest from its own bundle path. Inside the bundle
    // it would be part of the signed contents, so every approval would break the
    // signature and with it the identity the grant is attached to.
    expect(paths.manifest.startsWith(`${paths.app}/`)).toBe(false);
    expect(paths.manifest.startsWith(`${paths.root}/`)).toBe(true);
  });
});

describe('renderSessionHostInfoPlist', () => {
  const plist = renderSessionHostInfoPlist();

  it('names the stable bundle identity the grant is remembered against', () => {
    expect(plist).toContain(`<string>${SESSION_HOST_BUNDLE_ID}</string>`);
    expect(plist).toContain('<string>Walnut Sessions</string>');
    expect(plist).toContain('<string>WalnutSessionsHost</string>');
  });

  it('is a background process, so it never takes a Dock tile', () => {
    expect(plist).toContain('<key>LSUIElement</key>');
  });

  it('declares NO usage description', () => {
    // A *UsageDescription key is the caption for a promptable service, and under
    // the hardened runtime tccd refuses to prompt at all unless the matching
    // entitlement is declared too — silently, forever (see
    // tests/core/helper-entitlements-ratchet.test.ts). The host asks for nothing
    // promptable, so a usage string here would only be able to mislead.
    expect(plist).not.toMatch(/UsageDescription/);
  });

  it('is byte-stable, because its bytes are part of the build fingerprint', () => {
    expect(renderSessionHostInfoPlist()).toBe(plist);
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
  it('separates the host options from the payload with --', () => {
    expect(sessionHostArgv(HOST, '/opt/walnut/daemon', ['--start']))
      .toEqual([HOST, '--', '/opt/walnut/daemon', '--start']);
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
    bundleIdentifier: SESSION_HOST_BUNDLE_ID,
    executablePath: HOST,
    disclaimed: true,
    manifestPath: '/Users/example/Library/Application Support/Open Walnut/session-host-launch.json',
  };

  it('reads a real answer', () => {
    const parsed = parseSessionHostIdentity(`${JSON.stringify(identity)}\n`);
    expect(parsed?.bundleIdentifier).toBe(SESSION_HOST_BUNDLE_ID);
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
