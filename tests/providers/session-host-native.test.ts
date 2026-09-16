/**
 * Walnut Sessions host — the real bundle, compiled and run.
 *
 * This is the layer that cannot be mocked: whether macOS actually holds the host
 * responsible for the processes below it, and whether the host is invisible in
 * every other respect. A mocked version of either question would be worthless —
 * the whole feature is a claim about what the operating system does.
 *
 * It builds into a TEMP home and never signs (signing reaches the login
 * keychain), so it touches neither the user's installed host nor their grants.
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
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-session-host-native'));

const { approveSessionHostCommand, buildSessionHostBundle, readSessionHostIdentity } =
  await import('../../src/providers/session-host.js');
const { sessionHostArgv, sessionHostPaths, SESSION_HOST_BUNDLE_ID, SESSION_HOST_REFUSAL_STATUS } =
  await import('../../src/providers/session-host-core.js');

const hasSwift = process.platform === 'darwin'
  && spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).status === 0;

let home: string;
let paths: ReturnType<typeof sessionHostPaths>;
let payload: string;

/** Reports everything the host must have passed through untouched. */
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
  const probe = spawnSync(process.env.WALNUT_TEST_HOST, ['--identity'], { encoding: 'utf8', timeout: 10000 })
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

interface RunResult { status: number | null; stdout: string; stderr: string }

function runHost(argv: string[], input = ''): RunResult {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    input,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, WALNUT_TEST_HOST: paths.executable, WALNUT_TEST_MARKER: 'spaces "quotes" $literal 测试' },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

beforeAll(async () => {
  if (!hasSwift) return;
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-session-host-'));
  paths = sessionHostPaths(home);
  payload = path.join(home, 'payload.cjs');
  await fsp.writeFile(payload, PAYLOAD);
  const built = await buildSessionHostBundle(paths, { sign: false });
  expect(built, `host build failed: ${built.detail ?? ''}`).toMatchObject({ ok: true });
}, 180_000);

afterAll(async () => {
  if (home) await fsp.rm(home, { recursive: true, force: true, maxRetries: 3 });
});

describe.skipIf(!hasSwift)('the installed bundle', () => {
  it('has the layout and the stable identity macOS keys a grant to', () => {
    expect(fs.statSync(paths.executable).isFile()).toBe(true);
    const plist = fs.readFileSync(paths.infoPlist, 'utf8');
    expect(plist).toContain(SESSION_HOST_BUNDLE_ID);
    expect(fs.readFileSync(paths.fingerprint, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is REUSED, never rewritten, when the source has not moved', async () => {
    // Rewriting an unchanged bundle is the one silently destructive thing the
    // builder could do: the code identity is what the grant is remembered
    // against, so a pointless rebuild hands the user an identical-looking host
    // that lost the permission they granted.
    const before = fs.statSync(paths.executable).mtimeMs;
    const again = await buildSessionHostBundle(paths, { sign: false });
    expect(again).toMatchObject({ ok: true, reused: true });
    expect(fs.statSync(paths.executable).mtimeMs).toBe(before);
  }, 60_000);

  it('reports its own identity, and is its own responsible process', async () => {
    const identity = await readSessionHostIdentity(paths.executable);
    expect(identity?.bundleIdentifier).toBe(SESSION_HOST_BUNDLE_ID);
    expect(identity?.bundlePath).toBe(paths.app);
    expect(identity?.manifestPath).toBe(paths.manifest);
  });
});

describe.skipIf(!hasSwift)('running an approved command', () => {
  it('is transparent: argv, env, stdin, and the exit status all pass through', async () => {
    // Real shapes on purpose: a quoted word, a literal $, spaces, unicode, and a
    // large stdin. The daemon's own argv is simple, but the host must not be the
    // reason anything downstream sees something different from what was sent.
    const args = ['0', 'two words', '"quoted"', '$HOME', '测试'];
    const argv = [payload, ...args];
    const input = `ordinary fixture\n${'你好🌰'.repeat(20_000)}`;
    await approveSessionHostCommand(paths, [process.execPath, ...argv]);

    const result = runHost(sessionHostArgv(paths.executable, process.execPath, argv), input);
    expect(result.status, result.stderr).toBe(0);
    const seen = JSON.parse(result.stdout);
    expect(seen.argv).toEqual(args);
    expect(seen.stdin).toBe(input);
    expect(seen.marker).toBe('spaces "quotes" $literal 测试');
    // The marker the host uses to recognise its own re-exec must never reach the
    // payload, or it would look like a Walnut setting to everything downstream.
    expect(seen.leakedHostMarker).toBeNull();
  }, 60_000);

  it('makes the host responsible for the payload AND for its grandchildren', async () => {
    // The mechanism the whole feature rests on. Without the disclaimed re-exec the
    // payload would inherit THIS test process's responsible process, which is the
    // node running vitest — the shape that made every dialog say "node".
    const argv = [payload, '0'];
    await approveSessionHostCommand(paths, [process.execPath, ...argv]);
    const result = runHost(sessionHostArgv(paths.executable, process.execPath, argv));
    expect(result.status, result.stderr).toBe(0);
    const seen = JSON.parse(result.stdout);

    expect(seen.grandchild.failed).toBeUndefined();
    // The payload's parent IS the inner (disclaimed) host, and the system names
    // that same process as responsible for a process two hops further down.
    expect(seen.grandchild.responsiblePid).toBe(seen.parentPid);
    expect(seen.grandchild.responsiblePid).not.toBe(process.pid);
    expect(seen.grandchild.responsiblePid).not.toBe(seen.pid);
  }, 60_000);

  it('mirrors every exit status, including the one that drives a service restart', async () => {
    // The daemon exits non-zero on purpose so launchd restarts it to finish an
    // update. A host that normalised or swallowed a status would break daemon
    // updates in a way nothing reports.
    for (const code of [0, 1, 7, 42, 255]) {
      const argv = [payload, String(code)];
      await approveSessionHostCommand(paths, [process.execPath, ...argv]);
      const result = runHost(sessionHostArgv(paths.executable, process.execPath, argv));
      expect(result.status, `exit ${code}: ${result.stderr}`).toBe(code);
    }
  }, 120_000);

  it('forwards a signal to the payload instead of dying alone', async () => {
    // The daemon is stopped with SIGTERM and must get the chance to flush and
    // exit cleanly; a host that ignored signals would leave it running while its
    // supervisor disappeared.
    const argv = [payload, 'signal'];
    await approveSessionHostCommand(paths, [process.execPath, ...argv]);
    const spawned = sessionHostArgv(paths.executable, process.execPath, argv);
    const child = spawn(spawned[0]!, spawned.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WALNUT_TEST_HOST: paths.executable },
    });
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
    // Otherwise the host is a tool for running anything under a granted identity,
    // which any other program on the machine could pick up and use.
    await approveSessionHostCommand(paths, [process.execPath, payload, '0']);
    const result = runHost(sessionHostArgv(paths.executable, process.execPath, [payload, '7']));
    expect(result.status).toBe(SESSION_HOST_REFUSAL_STATUS);
    expect(result.stderr).toMatch(/not approved/);
  }, 60_000);

  it('refuses a payload that changed after it was approved', async () => {
    const argv = [payload, '0'];
    await approveSessionHostCommand(paths, [process.execPath, ...argv]);
    const original = await fsp.readFile(payload, 'utf8');
    try {
      await fsp.writeFile(payload, `${original}\n// swapped after approval\n`);
      const result = runHost(sessionHostArgv(paths.executable, process.execPath, argv));
      expect(result.status).toBe(SESSION_HOST_REFUSAL_STATUS);
      expect(result.stderr).toMatch(/hashes .* but was approved as/);
    } finally {
      await fsp.writeFile(payload, original);
    }
  }, 60_000);

  it('refuses a manifest other accounts can read or write', async () => {
    // The manifest names what this identity will execute. A permissive mode on it
    // turns the host into someone else's tool.
    await approveSessionHostCommand(paths, [process.execPath, payload, '0']);
    await fsp.chmod(paths.manifest, 0o644);
    try {
      const result = runHost(sessionHostArgv(paths.executable, process.execPath, [payload, '0']));
      expect(result.status).toBe(SESSION_HOST_REFUSAL_STATUS);
      expect(result.stderr).toMatch(/too permissive/);
    } finally {
      await fsp.chmod(paths.manifest, 0o600);
    }
  }, 60_000);

  it('refuses when there is no manifest at all', async () => {
    await approveSessionHostCommand(paths, [process.execPath, payload, '0']);
    const saved = await fsp.readFile(paths.manifest, 'utf8');
    await fsp.rm(paths.manifest);
    try {
      const result = runHost(sessionHostArgv(paths.executable, process.execPath, [payload, '0']));
      expect(result.status).toBe(SESSION_HOST_REFUSAL_STATUS);
    } finally {
      await fsp.writeFile(paths.manifest, saved, { mode: 0o600 });
    }
  }, 60_000);

  it('refuses a bare invocation without starting anything', () => {
    // Also the probe src/core/helper-build.ts uses to tell a bad signature from a
    // program that merely disliked its arguments, so it must exit rather than hang.
    const result = runHost([paths.executable]);
    expect(result.status).toBe(SESSION_HOST_REFUSAL_STATUS);
    expect(result.stderr).toMatch(/usage:/);
  });
});

describe.skipIf(!hasSwift)('approving a launch', () => {
  it('hashes every argv element that is a file, and writes a private manifest', async () => {
    await approveSessionHostCommand(paths, [process.execPath, payload, '--start']);
    const manifest = JSON.parse(await fsp.readFile(paths.manifest, 'utf8'));
    expect((await fsp.stat(paths.manifest)).mode & 0o777).toBe(0o600);
    // The interpreter and its script are both payloads; `--start` is not a path.
    expect(manifest.commands[0].files.map((f: { path: string }) => f.path))
      .toEqual([process.execPath, payload]);
    expect(manifest.commands[0].argv).toEqual([process.execPath, payload, '--start']);
  }, 60_000);

  it('replaces the previous approval instead of accumulating', async () => {
    await approveSessionHostCommand(paths, [process.execPath, payload, '1']);
    await approveSessionHostCommand(paths, [process.execPath, payload, '2']);
    const manifest = JSON.parse(await fsp.readFile(paths.manifest, 'utf8'));
    expect(manifest.commands).toHaveLength(1);
    expect(manifest.commands[0].argv).toEqual([process.execPath, payload, '2']);
  }, 60_000);
});
