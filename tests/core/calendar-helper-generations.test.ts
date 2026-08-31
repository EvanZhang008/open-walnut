/**
 * The macOS helper cache must never cost the user a permission grant.
 *
 * Two behaviours are covered, both learned from a real incident: a server restart
 * recompiled the calendar helper, the ad-hoc binary's content hash changed, macOS
 * therefore saw a program it had never granted Calendars to, and the calendar read
 * back EMPTY with nothing on screen to explain it.
 *
 *   1. helperCacheDecision — an existing binary is only rebuilt when its source
 *      really moved, so restarts and rebuilds cannot clobber a granted binary.
 *   2. the eventkit fallback — when the current generation is denied, a previous
 *      generation that still holds the grant serves the read instead of nothing.
 *
 * The fallback test uses REAL executable stub helpers rather than a mocked
 * child_process: the thing under test is which binary gets spawned, so spawning
 * has to be real for the test to mean anything.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-helper-cache'));

const { WALNUT_HOME } = await import('../../src/constants.js');
const { helperCacheDecision, olderHelperGenerations } = await import('../../src/core/helper-build.js');
import type { HelperSpec } from '../../src/core/helper-build.js';

const CACHE = path.join(WALNUT_HOME, 'cache');

const SPEC: HelperSpec = {
  name: 'walnut-calendar',
  version: 'v5',
  identifier: 'dev.openwalnut.calendar',
  infoPlist: '<plist/>',
};

function fingerprintOf(spec: HelperSpec, source: string): string {
  return createHash('sha256')
    .update(Buffer.from(source))
    .update('\n--\n')
    .update(spec.identifier)
    .update('\n--\n')
    .update(spec.infoPlist ?? '')
    .digest('hex');
}

beforeEach(async () => {
  await fsp.mkdir(CACHE, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('helperCacheDecision', () => {
  const src = () => path.join(WALNUT_HOME, 'walnut-calendar.swift');
  const bin = () => path.join(CACHE, 'walnut-calendar-v5');

  it('compiles when nothing is cached', async () => {
    await fsp.writeFile(src(), 'print("hi")');
    expect(helperCacheDecision(SPEC, src())).toBe('compile');
  });

  it('reuses a cached binary whose source fingerprint is unchanged', async () => {
    const source = 'print("hi")';
    await fsp.writeFile(src(), source);
    await fsp.writeFile(bin(), 'granted-binary');
    await fsp.writeFile(`${bin()}.srchash`, fingerprintOf(SPEC, source));
    expect(helperCacheDecision(SPEC, src())).toBe('reuse');
  });

  it('adopts a cached binary that predates the fingerprint sidecar', async () => {
    await fsp.writeFile(src(), 'print("hi")');
    await fsp.writeFile(bin(), 'granted-binary');
    expect(helperCacheDecision(SPEC, src())).toBe('adopt');
  });

  it('rebuilds only when the source moved without a version bump', async () => {
    await fsp.writeFile(src(), 'print("changed")');
    await fsp.writeFile(bin(), 'granted-binary');
    await fsp.writeFile(`${bin()}.srchash`, fingerprintOf(SPEC, 'print("hi")'));
    expect(helperCacheDecision(SPEC, src())).toBe('rebuild');
  });

  it('treats the signing identifier and the embedded plist as part of the source', async () => {
    const source = 'print("hi")';
    await fsp.writeFile(src(), source);
    await fsp.writeFile(bin(), 'granted-binary');
    await fsp.writeFile(`${bin()}.srchash`, fingerprintOf(SPEC, source));
    expect(helperCacheDecision({ ...SPEC, infoPlist: '<plist>other</plist>' }, src())).toBe('rebuild');
  });

  it('keeps a cached binary when the source is not readable at all', async () => {
    await fsp.writeFile(bin(), 'granted-binary');
    await fsp.writeFile(`${bin()}.srchash`, 'whatever');
    expect(helperCacheDecision(SPEC, path.join(WALNUT_HOME, 'gone.swift'))).toBe('reuse');
  });
});

describe('olderHelperGenerations', () => {
  const stub = async (name: string, mode = 0o755) => {
    const file = path.join(CACHE, name);
    await fsp.writeFile(file, '#!/bin/sh\nexit 0\n', { mode });
    return file;
  };

  it('lists only older numbered generations, newest first', async () => {
    await stub('walnut-calendar-v2');
    await stub('walnut-calendar-v3');
    await stub('walnut-calendar-v4');
    await stub('walnut-calendar-v5'); // the current one, never a fallback
    await stub('walnut-calendar-v6'); // a NEWER one is not a fallback either
    await stub('walnut-activity-v4'); // a different helper entirely
    await fsp.writeFile(path.join(CACHE, 'walnut-calendar-v4.plist'), 'x');

    expect(olderHelperGenerations(SPEC)).toEqual([
      path.join(CACHE, 'walnut-calendar-v4'),
      path.join(CACHE, 'walnut-calendar-v3'),
      path.join(CACHE, 'walnut-calendar-v2'),
    ]);
  });

  it('skips generations that are not executable', async () => {
    await stub('walnut-calendar-v4', 0o644);
    await stub('walnut-calendar-v3');
    expect(olderHelperGenerations(SPEC)).toEqual([path.join(CACHE, 'walnut-calendar-v3')]);
  });

  it('is empty when the cache has no earlier generation', async () => {
    await stub('walnut-calendar-v5');
    expect(olderHelperGenerations(SPEC)).toEqual([]);
  });
});

describe('eventkit fallback to a generation that still holds the grant', () => {
  /** A stub helper: `granted` answers every subcommand, `denied` answers none. */
  const writeStub = async (name: string, granted: boolean): Promise<string> => {
    const file = path.join(CACHE, name);
    const body = granted
      ? `#!/bin/sh
case "$1" in
  status) echo '{"state":"granted"}' ;;
  calendars) echo '[{"id":"cal-1","title":"Work","account":"iCloud","color":"#FF0000","readonly":false}]' ;;
  list) echo '[{"id":"ev-1","calendarId":"cal-1","calendarName":"Work","account":"iCloud","title":"Ops Review","start":"2026-08-31T11:00:00","end":"2026-08-31T12:00:00","allDay":false,"readonly":false}]' ;;
  *) echo '{"error":"unsupported","code":"usage"}'; exit 1 ;;
esac
`
      : `#!/bin/sh
case "$1" in
  status) echo '{"state":"not-determined"}' ;;
  *) echo '{"error":"Calendar access denied.","code":"permission-denied"}'; exit 1 ;;
esac
`;
    await fsp.writeFile(file, body, { mode: 0o755 });
    return file;
  };

  const loadSource = async (currentBin: string) => {
    vi.resetModules();
    // Only ensureHelper is faked (no swiftc in a unit test); the generation scan
    // and everything else stays real, pointed at the temp cache.
    vi.doMock('../../src/core/helper-build.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/core/helper-build.js')>();
      return { ...actual, ensureHelper: async () => currentBin };
    });
    return import('../../src/core/calendar/sources/eventkit.js');
  };

  afterEach(() => {
    vi.doUnmock('../../src/core/helper-build.js');
    vi.resetModules();
  });

  it('serves events from the previous generation when the current one is denied', async () => {
    const current = await writeStub('walnut-calendar-v5', false);
    await writeStub('walnut-calendar-v4', true);

    const mod = await loadSource(current);
    mod.resetCalendarHelperFallback();
    const source = mod.createEventKitSource();

    const events = await source.listEvents('2026-08-01', '2026-08-31');
    expect(events.map((e) => e.title)).toEqual(['Ops Review']);

    // And the state is reported, not swallowed: an empty-looking calendar with no
    // explanation is exactly the failure this whole path exists to prevent.
    expect(mod.calendarHelperFallback()?.version).toBe('v4');
    expect(source.degraded?.()).toMatch(/System Settings/);
  });

  it('reports permission-denied when no older generation holds the grant', async () => {
    const current = await writeStub('walnut-calendar-v5', false);
    await writeStub('walnut-calendar-v4', false);

    const mod = await loadSource(current);
    mod.resetCalendarHelperFallback();
    const source = mod.createEventKitSource();

    await expect(source.listEvents('2026-08-01', '2026-08-31')).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(mod.calendarHelperFallback()).toBeNull();
    expect(source.degraded?.()).toBeUndefined();
  });

  it('does not touch a fallback while the current generation works', async () => {
    const current = await writeStub('walnut-calendar-v5', true);
    await writeStub('walnut-calendar-v4', true);

    const mod = await loadSource(current);
    mod.resetCalendarHelperFallback();
    const source = mod.createEventKitSource();

    await source.listEvents('2026-08-01', '2026-08-31');
    expect(mod.calendarHelperFallback()).toBeNull();
  });
});

// A cached fingerprint sidecar must not be mistaken for a binary.
describe('cache sidecars', () => {
  it('does not offer a .srchash file as a helper generation', async () => {
    await fsp.writeFile(path.join(CACHE, 'walnut-calendar-v4.srchash'), 'abc', { mode: 0o755 });
    expect(olderHelperGenerations(SPEC)).toEqual([]);
    expect(fs.existsSync(path.join(CACHE, 'walnut-calendar-v4.srchash'))).toBe(true);
  });
});
