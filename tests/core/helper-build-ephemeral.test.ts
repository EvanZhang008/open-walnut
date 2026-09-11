/**
 * An ephemeral server must never compile or run a native macOS helper.
 *
 * tccd remembers a grant for a bare executable by PATH, so a helper compiled into a
 * throwaway data dir is a program macOS has never seen, and the first calendar read it
 * serves puts the Calendars dialog on the user's screen. One browser fixture boot, one
 * dialog (29 in one afternoon on 2026-09-11). The gate under test is what keeps a
 * fixture from ever becoming a TCC subject.
 *
 * `spawn` is mocked so the assertion "no compiler was started" is a count, and so a
 * regression cannot run a real `xcrun swiftc` from inside the test suite.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-helper-ephemeral', { IS_EPHEMERAL: true }));

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

const { WALNUT_HOME } = await import('../../src/constants.js');
const {
  ensureHelper, helperFailure, nativeHelpersAllowed, resetHelperBuilds,
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

describe('native helpers on an ephemeral server', () => {
  it('refuses to build, reports why, and never starts a compiler', async () => {
    expect(nativeHelpersAllowed()).toBe(false);

    const bin = await ensureHelper(SPEC, 'walnut-calendar.swift');

    expect(bin).toBeNull();
    expect(helperFailure(SPEC.name)).toBe('ephemeral');
    expect(spawnCalls).toEqual([]);
    expect(fs.readdirSync(path.join(WALNUT_HOME, 'cache'))).toEqual([]);
  });

  it('refuses to RUN a helper that already sits in the temp cache', async () => {
    // Running it is what prompts, so a cached copy (a fixture that survived a previous
    // gate-less boot) must be ignored, not reused.
    const cached = path.join(WALNUT_HOME, 'cache', 'walnut-calendar-v6');
    await fsp.writeFile(cached, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const bin = await ensureHelper(SPEC, 'walnut-calendar.swift');

    expect(bin).toBeNull();
    expect(helperFailure(SPEC.name)).toBe('ephemeral');
  });

  it('WALNUT_NATIVE_HELPERS=1 opens the gate again', async () => {
    process.env.WALNUT_NATIVE_HELPERS = '1';
    expect(nativeHelpersAllowed()).toBe(true);

    // A source file that does not exist stops the build one step past the gate, so
    // the opt-in is proven without ever reaching swiftc.
    const bin = await ensureHelper(SPEC, 'no-such-helper.swift');

    expect(bin).toBeNull();
    expect(helperFailure(SPEC.name)).toBe('compile_failed');
    expect(spawnCalls).toEqual([]);
  });

  it('the calendar source explains the refusal instead of asking for Xcode', async () => {
    const { createEventKitSource, CalendarHelperError } = await import('../../src/core/calendar/sources/eventkit.js');
    const source = createEventKitSource();

    const failure = await source.listEvents('2026-09-01', '2026-09-30').catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(CalendarHelperError);
    expect((failure as InstanceType<typeof CalendarHelperError>).code).toBe('not-configured');
    expect(String((failure as Error).message)).toMatch(/ephemeral server/);
    expect(String((failure as Error).message)).not.toMatch(/Xcode/);
    expect(spawnCalls).toEqual([]);
  });
});
