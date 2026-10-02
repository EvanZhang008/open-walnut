/**
 * Protected reads go to Walnut.app first, so Full Disk Access belongs to Walnut.
 *
 * What this file pins:
 *
 *  - the route: Walnut.app when it knows `--reader-bridge`, the helper when not, and
 *    the helper is never COMPILED while the app route exists (a new build is a new
 *    program nobody granted);
 *  - the move: while Walnut is refused, a helper the user granted before keeps
 *    reading (the stand-in), Walnut is asked again after a minute, and a grant to
 *    Walnut retires the helper on its own;
 *  - the gate: a server on a temporary data dir never runs the user's real Walnut.app;
 *  - readProtectedFile's errno contract, which plugins build on;
 *  - the Swift side agrees (flag, build scripts, dispatch before NSApplication).
 *
 * No process runs: `spawn` is faked and the assertion is the argv each read went to.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-protected-reader'));

const APP = '/Applications/Walnut.app';
const APP_EXE = `${APP}/Contents/MacOS/Walnut`;
const HELPER = '/cache/walnut-reader-v1';
const STORE = '/var/folders/x/0/com.apple.ScreenTimeAgent/Store/RMAdminStore-Cloud.sqlite';

/** What each program answers for a path: an exit code, plus bytes for `read`. */
type Answer = { code: number; bytes?: string };
let answers: Record<string, Record<string, Answer>> = {};
let calls: string[][] = [];

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (file: string, args: string[]) => {
      calls.push([file, ...args]);
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough; stderr: PassThrough; kill: () => void;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => undefined;
      // `[Walnut, --reader-bridge, sub, path]` or `[helper, sub, path]`.
      const [sub, target] = args[0] === '--reader-bridge' ? args.slice(1) : args;
      const answer = answers[file]?.[target!] ?? { code: 2 };
      setImmediate(() => {
        if (sub === 'read' && answer.code === 0 && answer.bytes) child.stdout.write(answer.bytes);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', answer.code);
      });
      return child;
    },
  };
});

let appInstalled = true;
let gateOpen = true;
let helperBuilt = true;
let ensureHelperCalls = 0;

vi.mock('../../src/providers/desktop-app.js', () => ({
  findDesktopAppWith: async (flag: string) => {
    expect(flag).toBe('--reader-bridge');
    return appInstalled ? { app: APP, executable: APP_EXE } : null;
  },
}));

vi.mock('../../src/core/helper-build.js', () => ({
  nativeHelpersAllowed: () => gateOpen,
  ensureHelper: async () => {
    ensureHelperCalls += 1;
    return gateOpen ? HELPER : null;
  },
  existingHelperBinary: () => (gateOpen && helperBuilt ? HELPER : null),
  helperFailure: () => (gateOpen ? null : 'ephemeral'),
}));

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

async function load() {
  // Fresh module per test: the stand-in and its clock are module state.
  vi.resetModules();
  return import('../../src/core/protected-reader.js');
}

const { WALNUT_HOME } = await import('../../src/constants.js');

beforeEach(() => {
  // The "ever worked" markers live in the data dir; every test starts without them.
  fs.rmSync(path.join(WALNUT_HOME, 'cache'), { recursive: true, force: true });
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  answers = {};
  calls = [];
  appInstalled = true;
  gateOpen = true;
  helperBuilt = true;
  ensureHelperCalls = 0;
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', realPlatform);
});

describe('reader route', () => {
  it('reads through Walnut.app when it knows the bridge, and never builds the helper', async () => {
    answers[APP_EXE] = { [STORE]: { code: 0 } };
    const pr = await load();

    const r = await pr.runProtectedReader('probe', STORE);

    expect(r.code).toBe(0);
    expect(r.viaStandIn).toBe(false);
    expect(r.route?.grantTarget).toBe(APP); // the bundle is what the user adds
    expect(calls).toEqual([[APP_EXE, '--reader-bridge', 'probe', STORE]]);
    expect(ensureHelperCalls).toBe(0);
    expect(await pr.readerGrantApp()).toBe(APP);
  });

  it('uses the helper when no Walnut.app knows the bridge', async () => {
    appInstalled = false;
    answers[HELPER] = { [STORE]: { code: 0 } };
    const pr = await load();

    const r = await pr.runProtectedReader('probe', STORE);

    expect(calls).toEqual([[HELPER, 'probe', STORE]]);
    expect(r.route).toMatchObject({ kind: 'helper', grantTarget: HELPER });
    expect(await pr.readerGrantApp()).toBeNull();
  });

  it('on a temporary data dir runs neither Walnut.app nor a helper', async () => {
    gateOpen = false;
    const pr = await load();

    const r = await pr.runProtectedReader('probe', STORE);

    expect(r.route).toBeNull();
    expect(calls).toEqual([]);
    expect(pr.readerUnavailable()).toBe('ephemeral');
    expect(await pr.readerGrantApp()).toBeNull();
    await expect(pr.readProtectedFile(STORE, 1024)).rejects.toMatchObject({ code: 'ENOTSUP' });
  });
});

describe('the move from the helper to Walnut', () => {
  it('while Walnut is refused, the granted helper keeps reading, and nothing is built', async () => {
    answers[APP_EXE] = { [STORE]: { code: 3 } };
    answers[HELPER] = { [STORE]: { code: 0 } };
    const pr = await load();

    const r = await pr.runProtectedReader('probe', STORE);

    expect(r.code).toBe(0);
    expect(r.viaStandIn).toBe(true);
    expect(pr.readerStandIn()).toBe(HELPER);
    expect(calls).toEqual([
      [APP_EXE, '--reader-bridge', 'probe', STORE],
      [HELPER, 'probe', STORE],
    ]);
    // An EXISTING helper only: compiling one to ask it would mint a new program.
    expect(ensureHelperCalls).toBe(0);
  });

  it('inside the minute the stand-in answers alone; after it Walnut is asked again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    answers[APP_EXE] = { [STORE]: { code: 3 } };
    answers[HELPER] = { [STORE]: { code: 0 } };
    const pr = await load();
    await pr.runProtectedReader('probe', STORE);

    calls = [];
    vi.setSystemTime(Date.now() + 30_000);
    await pr.runProtectedReader('probe', STORE);
    expect(calls).toEqual([[HELPER, 'probe', STORE]]);

    // The user adds Walnut to Full Disk Access.
    answers[APP_EXE] = { [STORE]: { code: 0 } };
    calls = [];
    vi.setSystemTime(Date.now() + 61_000);
    const r = await pr.runProtectedReader('probe', STORE);
    expect(calls).toEqual([[APP_EXE, '--reader-bridge', 'probe', STORE]]);
    expect(r.viaStandIn).toBe(false);
    expect(pr.readerStandIn()).toBeNull(); // retired on its own
  });

  it('preferCurrent asks Walnut first even inside the minute (the fix dialog\'s poll)', async () => {
    answers[APP_EXE] = { [STORE]: { code: 3 } };
    answers[HELPER] = { [STORE]: { code: 0 } };
    const pr = await load();
    await pr.runProtectedReader('probe', STORE);

    answers[APP_EXE] = { [STORE]: { code: 0 } };
    calls = [];
    const r = await pr.runProtectedReader('probe', STORE, { preferCurrent: true });

    expect(calls).toEqual([[APP_EXE, '--reader-bridge', 'probe', STORE]]);
    expect(r.viaStandIn).toBe(false);
    expect(pr.readerStandIn()).toBeNull();
  });

  it('with no granted helper, Walnut\'s refusal is the answer', async () => {
    answers[APP_EXE] = { [STORE]: { code: 3 } };
    answers[HELPER] = { [STORE]: { code: 3 } };
    const pr = await load();

    const r = await pr.runProtectedReader('probe', STORE);

    expect(r.code).toBe(3);
    expect(r.viaStandIn).toBe(false);
    expect(pr.readerStandIn()).toBeNull();
  });

  it('a helper that fails for another reason does not become the stand-in', async () => {
    answers[APP_EXE] = { [STORE]: { code: 3 } };
    answers[HELPER] = { [STORE]: { code: 4 } };
    const pr = await load();

    const r = await pr.runProtectedReader('probe', STORE);

    expect(r.code).toBe(3); // Walnut's refusal stays the answer
    expect(pr.readerStandIn()).toBeNull();
  });

  it('with no helper ever built, nothing stands in and nothing is compiled', async () => {
    helperBuilt = false;
    answers[APP_EXE] = { [STORE]: { code: 3 } };
    const pr = await load();

    const r = await pr.runProtectedReader('probe', STORE);

    expect(r.code).toBe(3);
    expect(calls).toEqual([[APP_EXE, '--reader-bridge', 'probe', STORE]]);
    expect(ensureHelperCalls).toBe(0);
  });

  it('remembers per program whether it ever worked (a stale grant is per program)', async () => {
    answers[APP_EXE] = { [STORE]: { code: 3 } };
    answers[HELPER] = { [STORE]: { code: 0 } };
    const pr = await load();
    await pr.runProtectedReader('probe', STORE);

    // The helper worked; Walnut never has. A later Walnut refusal is "never granted".
    expect(await pr.routeEverSucceeded('helper')).toBe(true);
    expect(await pr.routeEverSucceeded('app')).toBe(false);
  });
});

describe('readProtectedFile', () => {
  const FOCUS = '/Users/someone/Library/DoNotDisturb/DB/Assertions.json';

  it('returns the bytes, Unicode intact', async () => {
    // A Focus mode named in Chinese ("sleep"), as on the machine this was built on.
    const json = '{"name":"\u7761\u7720"}';
    answers[APP_EXE] = { [FOCUS]: { code: 0, bytes: json } };
    const pr = await load();

    const buf = await pr.readProtectedFile(FOCUS, 1024);

    expect(buf.toString('utf8')).toBe(json);
  });

  it('maps the reader\'s exits onto errno codes', async () => {
    answers[APP_EXE] = {
      '/refused': { code: 3 },
      '/missing': { code: 2 },
      '/broken': { code: 4 },
      '/big': { code: 0, bytes: 'x'.repeat(2048) },
    };
    helperBuilt = false;
    const pr = await load();

    await expect(pr.readProtectedFile('/refused', 1024)).rejects.toMatchObject({ code: 'EPERM' });
    await expect(pr.readProtectedFile('/missing', 1024)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(pr.readProtectedFile('/broken', 1024)).rejects.toMatchObject({ code: 'EIO' });
    await expect(pr.readProtectedFile('/big', 1024)).rejects.toMatchObject({ code: 'EFBIG' });
    await expect(pr.readProtectedFile('relative/path', 1024)).rejects.toMatchObject({ code: 'EINVAL' });
  });

  it('streams into a file and removes the file when the read fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-protected-read-'));
    try {
      answers[APP_EXE] = { '/ok': { code: 0, bytes: 'hello' }, '/refused': { code: 3 } };
      helperBuilt = false;
      const pr = await load();

      const ok = await pr.runProtectedReader('read', '/ok', { dst: path.join(dir, 'ok') });
      expect(ok.code).toBe(0);
      expect(fs.readFileSync(path.join(dir, 'ok'), 'utf8')).toBe('hello');

      const refused = await pr.runProtectedReader('read', '/refused', { dst: path.join(dir, 'no') });
      expect(refused.code).toBe(3);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fs.existsSync(path.join(dir, 'no'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the Swift side agrees', () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');

  it('uses the same flag', async () => {
    const { READER_BRIDGE_FLAG } = await load();
    expect(read('desktop/ReaderBridge.swift')).toContain(`let readerBridgeFlag = "${READER_BRIDGE_FLAG}"`);
  });

  it('builds the shared source into every app binary', () => {
    // A build script that forgets it produces an app without the flag, which the
    // server then silently routes around: correct, but the grant never moves.
    for (const script of ['desktop/build.sh', 'desktop/build-release.sh']) {
      const compiles = read(script).split('swiftc ').slice(1);
      expect(compiles.length, script).toBeGreaterThan(0);
      for (const cmd of compiles) {
        const invocation = cmd.slice(0, cmd.indexOf('-framework Carbon'));
        expect(invocation, script).toContain('ReaderBridge.swift');
        expect(invocation, script).toContain('src/data/walnut-reader.swift');
        expect(invocation, script).toContain('-D WALNUT_APP');
      }
    }
  });

  it('dispatches the bridge before the app exists', () => {
    // After NSApplication.shared, a read would be a visible app instance.
    const main = read('desktop/main.swift');
    const bridge = main.indexOf('runReaderBridgeIfRequested()');
    expect(bridge).toBeGreaterThan(0);
    expect(bridge).toBeLessThan(main.indexOf('NSApplication.shared'));
  });

  it('the shared source keeps the helper\'s entry point out of the app build', () => {
    const src = read('src/data/walnut-reader.swift');
    expect(src).toMatch(/#if !WALNUT_APP\s+@main/);
    expect(src).toContain('func walnutReaderMain(_ args: [String]) -> Never');
  });
});
