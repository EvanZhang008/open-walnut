/**
 * The calendar as a real builtin plugin: the four things the extraction has to keep true.
 *
 * Each one is a promise the plugin platform makes about a capability it owns:
 *
 * - The refresh loop belongs to the plugin lifecycle. Before this slice nothing stopped
 *   the calendar's background poll, so `stopServer` left an interval polling EventKit for
 *   a process that was going away. `deactivate` is the fix; a private timer nobody could
 *   observe is how the leak survived, which is why the service reports
 *   `refreshLoopActive()`.
 * - Turning the plugin off takes `/api/calendar` with it, and turning it back on brings it
 *   back, through the same store routes the Settings switch uses and with no restart.
 * - The config migration COPIES `calendar` into `plugins.calendar` and never claims an
 *   existing one, so a rollback to a Walnut that still reads the top-level key works. It
 *   also renames the source toggle, because `plugins.<id>.enabled` is the plugin
 *   lifecycle switch and writing the calendar's own on/off flag there would turn the
 *   whole plugin off and take its routes with it.
 * - `core:calendar-source` is the host's half of the seam: asking for it before the host
 *   published it must throw and name the key, never hand back undefined.
 * - The plugin owns its config namespace, which means "cleared" has to be expressible: the
 *   web UI clears the calendar allowlist by sending `null`, and a null that cannot be told
 *   apart from an absent key resurrects the legacy top-level list.
 * - The grant hand-off runs on the bus, so core holds no reference into the plugin.
 *
 * Request/response fidelity of the legacy path is graded by
 * tests/web/routes/calendar-api.test.ts, whose only change in this slice is its imports.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import yaml from 'js-yaml';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('calendar-plugin-test'));

import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js';
import { bus } from '../../src/core/event-bus.js';
import { registry } from '../../src/core/integration-registry.js';
import { getPluginToolSpecs, migrateConfigToPlugins } from '../../src/core/integration-loader.js';
import { publishCoreService, disposeCoreServices } from '../../src/core/platform-services.js';
import {
  assertServiceAvailable,
  getServiceEntry,
  resetServicesForTesting,
  ServiceUnavailableError,
} from '../../src/core/plugins/service-registry.js';
import {
  CalendarService,
  getCalendarService,
  _setCalendarServiceForTest,
} from '../../src/integrations/calendar/service.js';
import { createMockCalendarSource } from '../helpers/mock-calendar-source.js';
import { startServer, stopServer } from '../../src/web/server.js';

// ── The host half of the seam ────────────────────────────────────────────────

describe('core:calendar-source', () => {
  it('throws a ServiceUnavailableError naming the key until the host publishes it', () => {
    resetServicesForTesting();
    let thrown: unknown;
    try {
      assertServiceAvailable('core:calendar-source', 'core');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ServiceUnavailableError);
    expect((thrown as Error).message).toContain('core:calendar-source');
    // A service that answered `undefined` here would produce a bug report about the
    // plugin, so the absence has to be loud.
    expect(getServiceEntry('core:calendar-source')).toBeUndefined();
  });

  it('resolves once published, and carries the four methods the plugin needs', () => {
    resetServicesForTesting();
    publishCoreService('calendar-source', {
      createSource: () => createMockCalendarSource().source,
      authStatus: async () => 'granted',
      requestAccess: async () => 'granted',
      helperFallback: () => null,
    });
    expect(() => assertServiceAvailable('core:calendar-source', 'core')).not.toThrow();
    expect(Object.keys(getServiceEntry('core:calendar-source')!.api).sort())
      .toEqual(['authStatus', 'createSource', 'helperFallback', 'requestAccess']);
    disposeCoreServices();
    expect(getServiceEntry('core:calendar-source')).toBeUndefined();
  });
});

// ── The plugin over a real server ───────────────────────────────────────────

describe('calendar plugin lifecycle over a real server', () => {
  let server: HttpServer;
  let port: number;
  let service: CalendarService;

  const apiUrl = (p: string): string => `http://localhost:${port}${p}`;

  beforeAll(async () => {
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
    await fsp.mkdir(WALNUT_HOME, { recursive: true });
    // Same seam the route tests use: in place BEFORE startServer, so the plugin's
    // activate adopts this instance instead of building one over the real EventKit
    // helper (which would compile Swift and read the developer's own calendars).
    service = new CalendarService(createMockCalendarSource().source);
    _setCalendarServiceForTest(service);
    server = await startServer({ port: 0, dev: true });
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    _setCalendarServiceForTest(null);
    await stopServer();
    // Best effort: git-sync writing into `.git/objects` between readdir and rmdir races
    // this into ENOTEMPTY, and failing a green suite on temp-dir housekeeping is worse
    // than leaving the directory to the OS.
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('registers the four calendar tools under their unchanged names', () => {
    const names = getPluginToolSpecs(registry)
      .map((tool) => tool.name)
      .filter((name) => name.startsWith('calendar'))
      .sort();
    // The host prefixes a plugin tool with its normalized id and never twice, so a
    // plugin called `calendar` keeps the names the Personal AI already knows. A rename
    // here would invalidate every cached prompt prefix.
    expect(names).toEqual([
      'calendar_event_create', 'calendar_event_delete', 'calendar_event_update', 'calendar_query',
    ]);
  });

  it('arms the background refresh loop during activate', () => {
    expect(service.refreshLoopActive()).toBe(true);
  });

  it('answers on both spellings: the canonical plugin path and the legacy alias', async () => {
    // The canonical path is what the plugin registered; `/api/calendar` is a rewrite in
    // front of the SAME dispatcher instance, so the two cannot drift apart.
    const canonical = await fetch(apiUrl('/api/plugins/calendar/events?from=2026-08-03&to=2026-08-09'));
    expect(canonical.status).toBe(200);
    const legacy = await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09'));
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toEqual(await canonical.json());
  });

  it('disabling the plugin takes /api/calendar with it, and enabling brings it back', async () => {
    const off = await fetch(apiUrl('/api/plugin-runtime/calendar/disable'), { method: 'POST' });
    expect(off.status).toBe(200);
    // Deactivate stopped the poll. This is half the leak fix; stopServer is the other half.
    expect(service.refreshLoopActive()).toBe(false);
    // No owner for the path any more: the dispatcher falls through and /api answers 404.
    // A 200 here would mean the routes outlived the plugin that registered them.
    const gone = await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09'));
    expect(gone.status).toBe(404);

    const on = await fetch(apiUrl('/api/plugin-runtime/calendar/reload'), { method: 'POST' });
    expect(on.status).toBe(200);
    // The reload built a fresh service over the HOST's real EventKit source, because the
    // plugin clears its slot on deactivate by design, and re-armed its poll. Grade that,
    // then put a mock back BEFORE reading: a real read here compiles the Swift helper and
    // returns the developer's own calendars (32s of swiftc, the first time this was
    // written that way).
    expect(getCalendarService().refreshLoopActive()).toBe(true);
    // The mock that goes in here is deliberately NOT initialized, so it has no timer of its
    // own: `_setCalendarServiceForTest` stops the instance it displaces, but nothing stops
    // this one, and an armed poll on a hand-built service would outlive stopServer.
    _setCalendarServiceForTest(new CalendarService(createMockCalendarSource().source));
    const back = await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09'));
    expect(back.status).toBe(200);
  });

  it('the plugin config survives a disable/enable round trip with the source toggle intact', async () => {
    // `plugins.calendar.enabled` is the lifecycle switch the store just wrote twice. The
    // calendar's OWN toggle is a different key on purpose; if they were the same one, a
    // user turning the calendar off in Settings would uninstall its routes.
    await fetch(apiUrl('/api/calendar/sources/eventkit'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const raw = yaml.load(await fsp.readFile(CONFIG_FILE, 'utf-8')) as {
      plugins?: Record<string, Record<string, unknown>>;
    };
    expect(raw.plugins?.calendar?.source_enabled).toBe(false);
    expect(raw.plugins?.calendar?.enabled).toBe(true);

    await fetch(apiUrl('/api/calendar/sources/eventkit'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
  });

  it('clearing the allowlist with null really clears it, legacy top-level key and all', async () => {
    // The regression this pins: every hide/unhide in the web UI sends
    // `visible_calendar_ids: null`. Writing that as `undefined` made yaml.dump DROP the key,
    // an absent key means "fall back to the legacy top-level list", and the list the user
    // just cleared came straight back. The whole calendar looked stuck on one calendar.
    const seeded = yaml.load(await fsp.readFile(CONFIG_FILE, 'utf-8')) as Record<string, any>;
    seeded.calendar = { ...(seeded.calendar ?? {}), visible_calendar_ids: ['cal-work'] };
    await fsp.writeFile(CONFIG_FILE, yaml.dump(seeded), 'utf-8');

    const put = (body: unknown) => fetch(apiUrl('/api/calendar/sources/eventkit'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const titles = async (): Promise<string[]> => {
      const res = await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09'));
      expect(res.status).toBe(200);
      const { events } = await res.json() as { events: { title: string }[] };
      return events.map((e) => e.title);
    };

    // A harmless write to make the service re-read: the legacy allowlist is in force, so the
    // Home calendar's event is invisible.
    await put({ hidden_calendar_ids: [] });
    expect(await titles()).toContain('Standup');
    expect(await titles()).not.toContain('Gym');

    await put({ visible_calendar_ids: null });
    expect(await titles()).toContain('Gym');

    const after = yaml.load(await fsp.readFile(CONFIG_FILE, 'utf-8')) as Record<string, any>;
    // Written as an explicit null, which is what makes "cleared" distinguishable from
    // "never said", and the legacy key is left exactly as it was (COPY, not move).
    expect(after.plugins.calendar.visible_calendar_ids).toBeNull();
    expect(after.calendar.visible_calendar_ids).toEqual(['cal-work']);

    // The two values that are falsy but NOT nullish must still round-trip, because they go
    // through the same merge: an empty denylist, and the source toggle.
    await put({ hidden_calendar_ids: ['cal-work'] });
    expect(await titles()).not.toContain('Standup');
    await put({ hidden_calendar_ids: [] });
    expect(await titles()).toContain('Standup');
    await put({ enabled: false });
    expect(await titles()).toEqual([]);
    await put({ enabled: true });
    expect(await titles()).toContain('Standup');
  });

  it('refreshes itself when the user grants calendar access mid-session', async () => {
    // permissions.ts emits this instead of calling into the calendar, because core must not
    // hold a reference into a plugin. Nothing tested the far end of that wire.
    const live = getCalendarService();
    const refreshed = vi.spyOn(live, 'refreshAll').mockResolvedValue(undefined);
    try {
      bus.emit('permission:granted', { id: 'calendar' }, ['web-ui'], { source: 'permissions-test' });
      await vi.waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1));

      // Another permission's grant must not wake the calendar.
      bus.emit('permission:granted', { id: 'full-disk-access' }, ['web-ui'], { source: 'permissions-test' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(refreshed).toHaveBeenCalledTimes(1);
    } finally {
      refreshed.mockRestore();
    }
  });

});

// ── The leak this slice fixes ───────────────────────────────────────────────

describe('the refresh loop belongs to the plugin lifecycle', () => {
  // Its own server, and the instance is never swapped: `_setCalendarServiceForTest` stops
  // whatever it displaces, so a test that reinjects mid-run cannot grade a shutdown.
  it('activate arms the poll and stopServer stops it', async () => {
    await fsp.mkdir(WALNUT_HOME, { recursive: true });
    const service = new CalendarService(createMockCalendarSource().source);
    _setCalendarServiceForTest(service);
    let stopped = false;
    try {
      await startServer({ port: 0, dev: true });
      expect(service.refreshLoopActive()).toBe(true);
      // Before this slice NOTHING on the shutdown path stopped this interval: it kept
      // polling EventKit for a process that was going away.
      await stopServer();
      stopped = true;
      expect(service.refreshLoopActive()).toBe(false);
    } finally {
      if (!stopped) await stopServer();
      _setCalendarServiceForTest(null);
      // Best effort: a late log flush recreating a file races rmdir into ENOTEMPTY, and
      // failing a passing assertion on temp-dir housekeeping is worse than leaving it.
      await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ── The config migration ───────────────────────────────────────────────────

describe('calendar config migration', () => {
  async function writeConfig(config: Record<string, unknown>): Promise<void> {
    await fsp.mkdir(WALNUT_HOME, { recursive: true });
    await fsp.writeFile(CONFIG_FILE, yaml.dump(config), 'utf-8');
  }

  async function readConfig(): Promise<Record<string, any>> {
    return yaml.load(await fsp.readFile(CONFIG_FILE, 'utf-8')) as Record<string, any>;
  }

  it('copies top-level calendar into plugins.calendar and leaves the original in place', async () => {
    await writeConfig({
      version: 1,
      calendar: { enabled: false, hidden_calendar_ids: ['cal-work'], refresh_minutes: 30 },
    });

    expect(await migrateConfigToPlugins()).toBe(true);

    const result = await readConfig();
    // COPY, not move: a rollback to a Walnut whose calendar still read the top-level
    // key has to find it there.
    expect(result.calendar).toEqual({
      enabled: false, hidden_calendar_ids: ['cal-work'], refresh_minutes: 30,
    });
    expect(result.plugins.calendar).toEqual({
      hidden_calendar_ids: ['cal-work'], refresh_minutes: 30, source_enabled: false,
    });
    // `enabled` must NOT be copied across: it is the plugin lifecycle switch.
    expect(result.plugins.calendar.enabled).toBeUndefined();
  });

  it('is a no-op on the second run', async () => {
    await writeConfig({ version: 1, calendar: { hidden_calendar_ids: ['cal-work'] } });
    expect(await migrateConfigToPlugins()).toBe(true);
    const first = await readConfig();
    expect(await migrateConfigToPlugins()).toBe(false);
    expect(await readConfig()).toEqual(first);
  });

  it('never overwrites an existing plugins.calendar', async () => {
    await writeConfig({
      version: 1,
      calendar: { hidden_calendar_ids: ['cal-work'] },
      plugins: { calendar: { enabled: true, hidden_calendar_ids: ['cal-home'] } },
    });

    expect(await migrateConfigToPlugins()).toBe(false);

    const result = await readConfig();
    expect(result.plugins.calendar).toEqual({ enabled: true, hidden_calendar_ids: ['cal-home'] });
  });

  it('leaves a config with no calendar section alone', async () => {
    await writeConfig({ version: 1, user: { name: 'test' } });
    expect(await migrateConfigToPlugins()).toBe(false);
    expect((await readConfig()).plugins).toBeUndefined();
  });
});
