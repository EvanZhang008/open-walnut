/**
 * Session host — the real supervisor, compiled and run.
 *
 * This is the layer that cannot be mocked: whether macOS actually holds the app
 * responsible for the processes below it, and whether the supervisor is invisible
 * in every other respect. A mocked version of either question would be worthless,
 * because the whole feature is a claim about what the operating system does.
 *
 * It compiles desktop/SessionHost.swift (the same file Walnut.app is built from)
 * into a THROWAWAY test bundle with its own identifier, and points it at a temp
 * manifest. So it never touches the user's Walnut.app, their manifest, or their
 * grants, and it never signs (signing reaches the login keychain).
 *
 * WHAT THIS DOES NOT PROVE: that a TCC grant follows the identity. That needs a
 * real protected resource and a real dialog, which no automated test may trigger.
 * The responsibility assertions below are the mechanism this depends on; the
 * grant behaviour on top of it is verified by hand.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-session-host-native'));

const { approveSessionHostCommand, readSessionHostIdentity } =
  await import('../../src/providers/session-host.js');
const { parseSessionHostIdentity, sessionHostArgv, SESSION_HOST_FLAG, SESSION_HOST_REFUSAL_STATUS } =
  await import('../../src/providers/session-host-core.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = path.join(REPO, 'desktop', 'SessionHost.swift');
const TEST_BUNDLE_ID = 'dev.openwalnut.test-session-host';
/** Status the test's own main exits with when the flag was absent. */
const NOT_SUPERVISOR = 64;

const hasSwift = process.platform === 'darwin'
  && spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).status === 0;

let home: string;
let app: string;
let executable: string;
let infoPlist: string;
let manifest: string;
let payload: string;

/**
 * The app's own `main.swift` starts the GUI after calling the supervisor. This
 * one instead supplies the manifest path (the default-argument seam documented in
 * desktop/SessionHost.swift) and exits with a marker, so a launch WITHOUT the flag
 * is observable as "the supervisor was not entered".
 */
const TEST_MAIN = `
import Darwin
import Foundation

let manifest = ProcessInfo.processInfo.environment["WALNUT_TEST_MANIFEST"] ?? ""
runSessionHostIfRequested(CommandLine.arguments, manifestPath: manifest)
FileHandle.standardError.write(Data("test host: normal launch, no supervision\\n".utf8))
exit(${NOT_SUPERVISOR})
`;

/** Reports everything the supervisor must have passed through untouched. */
const PAYLOAD = `
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const mode = process.argv[2]
if (mode === 'signal') {
  process.on('SIGTERM', () => {
    process.stdout.write(JSON.stringify({ signalled: 'SIGTERM' }) + '\\n', () => process.exit(42))
  })
  process.stdout.write(JSON.stringify({ ready: true }) + '\\n')
  setInterval(() => {}, 1000)
} else {
  // A GRANDCHILD asks the system who is responsible for it. That is the real
  // question: the daemon spawns a shell, which spawns the CLI, which spawns
  // tools, and the attribution has to survive every one of those hops.
  const probe = spawnSync(
    process.env.WALNUT_TEST_HOST,
    [process.env.WALNUT_TEST_FLAG, '--identity'],
    { encoding: 'utf8', timeout: 10000 },
  )
  process.stdout.write(JSON.stringify({
    pid: process.pid,
    parentPid: process.ppid,
    argv: process.argv.slice(2),
    stdin: fs.readFileSync(0, 'utf8'),
    marker: process.env.WALNUT_TEST_MARKER,
    leakedHostMarker: process.env.WALNUT_SESSION_HOST_DISCLAIMED ?? null,
    grandchild: probe.status === 0 ? JSON.parse(probe.stdout) : { failed: probe.stderr },
  }) + '\\n', () => process.exit(Number(mode)))
}
`;

function testEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WALNUT_TEST_MANIFEST: manifest,
    WALNUT_TEST_HOST: executable,
    WALNUT_TEST_FLAG: SESSION_HOST_FLAG,
    WALNUT_TEST_MARKER: 'spaces "quotes" $literal 测试',
  };
}

interface RunResult { status: number | null; stdout: string; stderr: string }

function runHost(argv: string[], input = ''): RunResult {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    input,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    env: testEnv(),
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  '<dict>',
  '\t<key>CFBundleExecutable</key><string>TestSessionHost</string>',
  `\t<key>CFBundleIdentifier</key><string>${TEST_BUNDLE_ID}</string>`,
  '\t<key>CFBundleName</key><string>Test Session Host</string>',
  '\t<key>CFBundlePackageType</key><string>APPL</string>',
  '\t<key>LSUIElement</key><true/>',
  '</dict>',
  '</plist>',
  '',
].join('\n');

beforeAll(async () => {
  if (!hasSwift) return;
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-session-host-'));
  app = path.join(home, 'TestSessionHost.app');
  executable = path.join(app, 'Contents', 'MacOS', 'TestSessionHost');
  infoPlist = path.join(app, 'Contents', 'Info.plist');
  manifest = path.join(home, 'session-host-launch.json');
  payload = path.join(home, 'payload.cjs');

  await fsp.mkdir(path.dirname(executable), { recursive: true });
  await fsp.writeFile(infoPlist, PLIST);
  await fsp.writeFile(payload, PAYLOAD);
  const main = path.join(home, 'main.swift');
  await fsp.writeFile(main, TEST_MAIN);

  // `nice` because a Swift compile competes with everything else on the machine,
  // and this file is on the slow tier where wall clock is not the point.
  const compiled = spawnSync(
    'nice',
    ['-n', '10', 'xcrun', 'swiftc', '-O', '-o', executable, main, SOURCE],
    { encoding: 'utf8', timeout: 300_000 },
  );
  expect(compiled.status, `compile failed: ${compiled.stderr}`).toBe(0);
}, 320_000);

afterAll(async () => {
  if (home) await fsp.rm(home, { recursive: true, force: true, maxRetries: 3 });
});

describe.skipIf(!hasSwift)('the compiled supervisor', () => {
  it('reports its own identity, and is its own responsible process', async () => {
    // Through the production reader, which passes no environment of its own.
    const identity = await readSessionHostIdentity(executable);
    expect(identity?.bundleIdentifier).toBe(TEST_BUNDLE_ID);
    expect(identity?.bundlePath).toBe(app);
    expect(identity?.selfResponsible).toBe(true);
  });

  it('reads the manifest path it was given, not one from its own environment', () => {
    // Proves the default-argument seam reached the code that reads the manifest,
    // which is what lets the refusal tests below run without the real one. The
    // production app takes the other branch and derives it from the passwd entry.
    const result = runHost([executable, SESSION_HOST_FLAG, '--identity']);
    expect(result.status, result.stderr).toBe(0);
    expect(parseSessionHostIdentity(result.stdout)?.manifestPath).toBe(manifest);
  });

  it('needs the flag: a normal launch never enters supervisor code', () => {
    // This is what makes it safe to put in the app the user double-clicks. Without
    // the flag the app must start normally, which for this test binary means its
    // own marker status rather than a refusal.
    const result = runHost([executable]);
    expect(result.status).toBe(NOT_SUPERVISOR);
    expect(result.stderr).toMatch(/normal launch/);
  });

  it('refuses the flag without a command instead of starting anything', () => {
    const result = runHost([executable, SESSION_HOST_FLAG]);
    expect(result.status).toBe(SESSION_HOST_REFUSAL_STATUS);
    expect(result.stderr).toMatch(/usage:/);
  });
});

describe.skipIf(!hasSwift)('running an approved command', () => {
  it('is transparent: argv, env, stdin, and the exit status all pass through', async () => {
    // Real shapes on purpose: a quoted word, a literal $, spaces, unicode, and a
    // large stdin. The daemon's own argv is simple, but the supervisor must not be
    // the reason anything downstream sees something different from what was sent.
    const args = ['0', 'two words', '"quoted"', '$HOME', '测试'];
    const argv = [payload, ...args];
    const input = `ordinary fixture\n${'你好🌰'.repeat(20_000)}`;
    await approveSessionHostCommand(manifest, [process.execPath, ...argv]);

    const result = runHost(sessionHostArgv(executable, process.execPath, argv), input);
    expect(result.status, result.stderr).toBe(0);
    const seen = JSON.parse(result.stdout);
    expect(seen.argv).toEqual(args);
    expect(seen.stdin).toBe(input);
    expect(seen.marker).toBe('spaces "quotes" $literal 测试');
    // The marker used to recognise its own re-exec must never reach the payload,
    // or it would look like a Walnut setting to everything downstream.
    expect(seen.leakedHostMarker).toBeNull();
  }, 60_000);

  it('makes the app responsible for the payload AND for its grandchildren', async () => {
    // The mechanism the whole feature rests on. Without the disclaimed re-exec the
    // payload would inherit THIS test process's responsible process, which is the
    // node running vitest — the shape that made every dialog say "node".
    const argv = [payload, '0'];
    await approveSessionHostCommand(manifest, [process.execPath, ...argv]);
    const result = runHost(sessionHostArgv(executable, process.execPath, argv));
    expect(result.status, result.stderr).toBe(0);
    const seen = JSON.parse(result.stdout);

    expect(seen.grandchild.failed).toBeUndefined();
    // The payload's parent IS the inner (disclaimed) supervisor, and the system
    // names that same process as responsible for a process two hops further down.
    expect(seen.grandchild.responsiblePid).toBe(seen.parentPid);
    expect(seen.grandchild.responsiblePid).not.toBe(process.pid);
    expect(seen.grandchild.responsiblePid).not.toBe(seen.pid);
  }, 60_000);

  it('mirrors every exit status, including the one that drives a service restart', async () => {
    // The daemon exits non-zero on purpose so launchd restarts it to finish an
    // update. A supervisor that normalised or swallowed a status would break daemon
    // updates in a way nothing reports.
    for (const code of [0, 1, 7, 42, 255]) {
      const argv = [payload, String(code)];
      await approveSessionHostCommand(manifest, [process.execPath, ...argv]);
      const result = runHost(sessionHostArgv(executable, process.execPath, argv));
      expect(result.status, `exit ${code}: ${result.stderr}`).toBe(code);
    }
  }, 120_000);

  it('forwards a signal to the payload instead of dying alone', async () => {
    // The daemon is stopped with SIGTERM and must get the chance to flush and
    // exit cleanly; a supervisor that ignored signals would leave it running while
    // its supervisor disappeared.
    const argv = [payload, 'signal'];
    await approveSessionHostCommand(manifest, [process.execPath, ...argv]);
    const spawned = sessionHostArgv(executable, process.execPath, argv);
    const child = spawn(spawned[0]!, spawned.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: testEnv() });
    let stdout = '';
    let sent = false;
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (!sent && stdout.includes('"ready":true')) { sent = true; child.kill('SIGTERM'); }
    });
    const status = await new Promise<number | null>((resolve, reject) => {
      const guard = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.once('error', reject);
      child.once('exit', (code) => { clearTimeout(guard); resolve(code); });
    });
    expect(sent).toBe(true);
    expect(stdout).toContain('"signalled":"SIGTERM"');
    expect(status).toBe(42);
  }, 60_000);
});

describe.skipIf(!hasSwift)('refusals', () => {
  it('runs nothing that is not in the manifest', async () => {
    // Otherwise the app is a tool for running anything under a granted identity,
    // which any other program on the machine could pick up and use.
    await approveSessionHostCommand(manifest, [process.execPath, payload, '0']);
    const result = runHost(sessionHostArgv(executable, process.execPath, [payload, '7']));
    expect(result.status).toBe(SESSION_HOST_REFUSAL_STATUS);
    expect(result.stderr).toMatch(/not approved/);
  }, 60_000);

  it('refuses a payload that changed after it was approved', async () => {
    const argv = [payload, '0'];
    await approveSessionHostCommand(manifest, [process.execPath, ...argv]);
    const original = await fsp.readFile(payload, 'utf8');
    try {
      await fsp.writeFile(payload, `${original}\n// swapped after approval\n`);
      const result = runHost(sessionHostArgv(executable, process.execPath, argv));
      expect(result.status).toBe(SESSION_HOST_REFUSAL_STATUS);
      expect(result.stderr).toMatch(/hashes .* but was approved as/);
    } finally {
      await fsp.writeFile(payload, original);
    }
  }, 60_000);

  it('refuses a manifest other accounts can read or write', async () => {
    // The manifest names what this identity will execute. A permissive mode on it
    // turns the app into someone else's tool.
    await approveSessionHostCommand(manifest, [process.execPath, payload, '0']);
    await fsp.chmod(manifest, 0o644);
    try {
      const result = runHost(sessionHostArgv(executable, process.execPath, [payload, '0']));
      expect(result.status).toBe(SESSION_HOST_REFUSAL_STATUS);
      expect(result.stderr).toMatch(/too permissive/);
    } finally {
      await fsp.chmod(manifest, 0o600);
    }
  }, 60_000);

  it('refuses when there is no manifest at all', async () => {
    await approveSessionHostCommand(manifest, [process.execPath, payload, '0']);
    const saved = await fsp.readFile(manifest, 'utf8');
    await fsp.rm(manifest);
    try {
      const result = runHost(sessionHostArgv(executable, process.execPath, [payload, '0']));
      expect(result.status).toBe(SESSION_HOST_REFUSAL_STATUS);
    } finally {
      await fsp.writeFile(manifest, saved, { mode: 0o600 });
    }
  }, 60_000);
});

describe.skipIf(!hasSwift)('approving a launch', () => {
  it('hashes every argv element that is a file, and writes a private manifest', async () => {
    await approveSessionHostCommand(manifest, [process.execPath, payload, '--start']);
    const written = JSON.parse(await fsp.readFile(manifest, 'utf8'));
    expect((await fsp.stat(manifest)).mode & 0o777).toBe(0o600);
    // The interpreter and its script are both payloads; `--start` is not a path.
    expect(written.commands[0].files.map((f: { path: string }) => f.path))
      .toEqual([process.execPath, payload]);
    expect(written.commands[0].argv).toEqual([process.execPath, payload, '--start']);
  }, 60_000);

  it('replaces the previous approval instead of accumulating', async () => {
    await approveSessionHostCommand(manifest, [process.execPath, payload, '1']);
    await approveSessionHostCommand(manifest, [process.execPath, payload, '2']);
    const written = JSON.parse(await fsp.readFile(manifest, 'utf8'));
    expect(written.commands).toHaveLength(1);
    expect(written.commands[0].argv).toEqual([process.execPath, payload, '2']);
  }, 60_000);

  it('creates the manifest directory it needs, at 0700', async () => {
    // Walnut writes this before the app ever reads it, and the app refuses a
    // directory other accounts could write to.
    const nested = path.join(home, 'fresh', 'session-host-launch.json');
    await approveSessionHostCommand(nested, [process.execPath, payload, '0']);
    expect((await fsp.stat(path.dirname(nested))).mode & 0o777).toBe(0o700);
  }, 60_000);
});
