/**
 * The calendar protocol, compiled for real in both shapes it ships in.
 *
 * src/data/walnut-calendar.swift is ONE implementation compiled two ways: on its
 * own as the helper (with -parse-as-library, because its entry point is `@main`),
 * and into Walnut.app next to desktop/CalendarBridge.swift with -D WALNUT_APP.
 * Swift rejects a top-level expression in a non-main file even inside an inactive
 * #if, so whether both shapes build is a question only the compiler can answer.
 *
 * Only arguments that can never reach EventKit's permission request are run: no
 * subcommand, an unknown one (which the shared source refuses BEFORE asking), and
 * `capabilities` (answered before the re-exec, needing no calendar at all).
 * Anything else would put a real Calendars dialog on the screen of whoever runs the
 * suite, which is exactly what happened on 2026-09-26 when an unknown subcommand
 * still asked first. Nothing here is signed, installed, or granted.
 *
 * The app shape is built for macOS 12, like desktop/build-release.sh, so an API
 * newer than that without an #available guard fails here and not in a release.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHARED = path.join(REPO, 'src', 'data', 'walnut-calendar.swift');
const BRIDGE = path.join(REPO, 'desktop', 'CalendarBridge.swift');
/** Status the test app's main exits with when the bridge was NOT entered. */
const NORMAL_LAUNCH = 64;

const hasSwift = process.platform === 'darwin'
  && spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).status === 0;

/** Stands in for desktop/main.swift: the bridge first, then "the GUI". */
const TEST_MAIN = `
import Darwin
runCalendarBridgeIfRequested()
exit(${NORMAL_LAUNCH})
`;

let dir: string;
let appExe: string;
let helperExe: string;

function compile(out: string, args: string[]): void {
  const r = spawnSync('xcrun', ['swiftc', '-O', '-o', out, ...args], { encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) throw new Error(`swiftc failed:\n${r.stderr}`);
}

function run(exe: string, args: string[]): { status: number | null; json: Record<string, unknown> | null } {
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 30_000 });
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(r.stdout) as Record<string, unknown>; } catch { /* not JSON */ }
  return { status: r.status, json };
}

describe.skipIf(!hasSwift)('calendar protocol, both shipped shapes', () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-calendar-bridge-native-'));
    const main = path.join(dir, 'main.swift');
    fs.writeFileSync(main, TEST_MAIN);
    appExe = path.join(dir, 'app');
    helperExe = path.join(dir, 'helper');
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    compile(appExe, [
      '-D', 'WALNUT_APP', main, BRIDGE, SHARED, '-framework', 'EventKit',
      '-target', `${arch}-apple-macos12.0`,
    ]);
    // Exactly what src/core/helper-build.ts runs: no -framework, autolinking only.
    compile(helperExe, ['-parse-as-library', SHARED]);
  }, 600_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the app shape answers the bridge through the shared protocol', () => {
    const none = run(appExe, ['--calendar-bridge']);
    expect(none.status).toBe(1);
    expect(none.json).toMatchObject({ code: 'usage' });

    const unknown = run(appExe, ['--calendar-bridge', 'bogus']);
    expect(unknown.status).toBe(1);
    expect(unknown.json).toEqual({ error: 'unknown subcommand: bogus', code: 'usage' });

    const caps = run(appExe, ['--calendar-bridge', 'capabilities']);
    expect(caps.status).toBe(0);
    expect(caps.json).toEqual({ writeSafetyVersion: 1 });
  });

  it('the app shape falls through to a normal launch without the flag', () => {
    // A bridge that swallowed an ordinary launch would leave Walnut unable to open.
    expect(run(appExe, []).status).toBe(NORMAL_LAUNCH);
    expect(run(appExe, ['bogus']).status).toBe(NORMAL_LAUNCH);
    // The flag has to be argv[1]; anywhere later it is an ordinary argument.
    expect(run(appExe, ['--other', '--calendar-bridge', 'bogus']).status).toBe(NORMAL_LAUNCH);
  });

  it('the helper shape answers the same protocol on its own', () => {
    expect(run(helperExe, []).json).toMatchObject({ code: 'usage' });
    const unknown = run(helperExe, ['bogus']);
    expect(unknown.status).toBe(1);
    expect(unknown.json).toEqual({ error: 'unknown subcommand: bogus', code: 'usage' });

    const caps = run(helperExe, ['capabilities']);
    expect(caps.status).toBe(0);
    expect(caps.json).toEqual({ writeSafetyVersion: 1 });
  });
});
