/**
 * A server whose data dir is a throwaway temp dir must never compile or run a native
 * macOS helper, whether or not it was started as `--_ephemeral-child`.
 *
 * The 2026-09-26 case: tests/e2e/health-e2e.test.ts started a real server IN the
 * vitest worker (so IS_EPHEMERAL was false) with WALNUT_HOME under the system temp
 * dir. Its first calendar read compiled `walnut-calendar-v6` into that temp cache and
 * asked for Calendars, and tccd, which keys a bare executable's grant by PATH, put
 * the dialog on the user's screen for a program nobody will ever run again. The
 * earlier gate keyed on the argv flag, which in-process servers never carry.
 *
 * `spawn` is mocked so "no compiler was started" is a count, and so a regression
 * cannot run a real `xcrun swiftc` from inside the test suite.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

// The default: IS_EPHEMERAL false, WALNUT_HOME under os.tmpdir(). Exactly the shape
// of every in-process `startServer` test.
vi.mock('../../src/constants.js', () => createMockConstants('walnut-helper-temp-home'));

const spawnCalls: string[][] = [];
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (cmd: string, args: string[]) => {
      spawnCalls.push([cmd, ...(args ?? [])]);
      throw new Error(`test refused to spawn ${cmd}`);
    },
  };
});

const { WALNUT_HOME, IS_EPHEMERAL } = await import('../../src/constants.js');
const {
  ensureHelper, helperFailure, isThrowawayDataDir, nativeHelpersAllowed,
  olderHelperGenerations, resetHelperBuilds,
} = await import('../../src/core/helper-build.js');
import type { HelperSpec } from '../../src/core/helper-build.js';

const SPEC: HelperSpec = {
  name: 'walnut-calendar',
  version: 'v6',
  identifier: 'dev.openwalnut.calendar',
  infoPlist: '<plist/>',
};

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeAll(() => {
  // The gate sits behind the platform check; Linux CI has to reach it too.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', realPlatform);
});

beforeEach(async () => {
  spawnCalls.length = 0;
  resetHelperBuilds();
  delete process.env.WALNUT_NATIVE_HELPERS;
  await fsp.mkdir(path.join(WALNUT_HOME, 'cache'), { recursive: true });
});

afterEach(async () => {
  delete process.env.WALNUT_NATIVE_HELPERS;
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('native helpers under a temp data dir, on a non-ephemeral server', () => {
  it('refuses to build and never starts a compiler (the in-process test server case)', async () => {
    // The precondition that made the old gate miss it.
    expect(IS_EPHEMERAL).toBe(false);
    expect(nativeHelpersAllowed()).toBe(false);

    const bin = await ensureHelper(SPEC, 'walnut-calendar.swift');

    expect(bin).toBeNull();
    // Same reason code the consumers already degrade on, so no caller changes.
    expect(helperFailure(SPEC.name)).toBe('ephemeral');
    expect(spawnCalls).toEqual([]);
    expect(fs.readdirSync(path.join(WALNUT_HOME, 'cache'))).toEqual([]);
  });

  it('does not offer an older generation sitting in the temp cache either', async () => {
    // A copied data dir can carry old helpers. Running one asks for the same
    // permission under yet another path.
    const older = path.join(WALNUT_HOME, 'cache', 'walnut-calendar-v5');
    await fsp.writeFile(older, '#!/bin/sh\n', { mode: 0o755 });

    expect(olderHelperGenerations(SPEC)).toEqual([]);
  });

  it('WALNUT_NATIVE_HELPERS=1 opens the gate', () => {
    process.env.WALNUT_NATIVE_HELPERS = '1';
    expect(nativeHelpersAllowed()).toBe(true);
  });
});

describe('isThrowawayDataDir', () => {
  it('matches the system temp roots, in both their symlinked and real forms', () => {
    // os.tmpdir() on macOS is /var/folders/…, and tccd reports the same file as
    // /private/var/folders/…, so both spellings have to count.
    for (const dir of [
      '/var/folders/ph/abc/T/walnut-health-e2e-1',
      '/private/var/folders/ph/abc/T/walnut-health-e2e-1',
      '/tmp/walnut-sandbox',
      '/private/tmp/dry/home',
      '/tmp',
    ]) {
      expect(isThrowawayDataDir(dir), dir).toBe(true);
    }
  });

  it('covers the temp dir this very test suite runs in', () => {
    // Every createMockConstants home lives here; if this ever stops matching, the
    // gate silently stops protecting the suite that caused the incident.
    expect(isThrowawayDataDir(WALNUT_HOME)).toBe(true);
  });

  it('leaves a real data dir alone', () => {
    // Not os.homedir(): tests run under a fake HOME in the temp dir (tests/setup/exec-guard.ts).
    for (const dir of [
      '/Users/someone/.open-walnut',
      '/home/someone/.open-walnut',
    ]) {
      expect(isThrowawayDataDir(dir), dir).toBe(false);
    }
  });

  it('compares whole path segments, not string prefixes', () => {
    expect(isThrowawayDataDir('/tmpfoo/.open-walnut')).toBe(false);
    expect(isThrowawayDataDir('/var/folders-backup/.open-walnut')).toBe(false);
  });

  it('ignores TMPDIR, so a TMPDIR pointed at the home cannot disable real helpers', () => {
    // Why the rule is fixed system roots and NOT os.tmpdir(): TMPDIR=$HOME would make
    // every real data dir "temporary" and silently switch off calendar, Screen Time
    // and the rest on the user's own server.
    // A home outside the temp roots: the real HOME is faked to one inside them.
    const home = '/Users/someone';
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = home;
    try {
      expect(os.tmpdir()).toBe(home);
      expect(isThrowawayDataDir(path.join(home, '.open-walnut'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });
});
