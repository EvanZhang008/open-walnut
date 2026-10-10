/**
 * The Calendar row in Settings → macOS Access, when writes have their own program.
 *
 * An older Walnut.app (before the calendar write-safety protocol) answers reads itself but
 * hands every create and move to the walnut-calendar helper, and a write never asks macOS for
 * itself. So the row must not say "granted" while that helper is not allowed: it is the only
 * place the user can press Request access for it. What this file pins:
 *
 *  - reads and writes both allowed: granted, Walnut named;
 *  - reads allowed, the write helper never asked: not-determined, a prompt button, and the
 *    copy names the helper rather than "Calendar now belongs to Walnut";
 *  - reads allowed, the write helper refused: settings-only, pointing at the helper's entry;
 *  - neither asked yet: one Request access, and the steps warn that a second dialog follows.
 *
 * The EventKit side is faked; nothing runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
import type { CalendarAccessReport } from '../../src/core/calendar/sources/eventkit.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-permissions-calendar-row'));

const APP = '/Applications/Walnut.app';
let report: CalendarAccessReport = { state: 'granted', read: 'granted', writeGap: null };
let fallback: { path: string; version: string } | null = null;

vi.mock('../../src/core/calendar/sources/eventkit.js', () => ({
  calendarAccessReport: async () => report,
  calendarGrantApp: async () => APP,
  calendarHelperFallback: () => fallback,
}));

vi.mock('../../src/core/permissions/darwin-fda.js', () => ({
  probeFullDiskAccess: async () => ({}),
  fullDiskAccessRows: () => [],
}));

vi.mock('../../src/providers/session-host.js', () => ({
  inspectSessionHost: async () => ({ app: APP }),
}));

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const { getPermissionsReport, __resetPermissionCachesForTest } = await import('../../src/core/permissions/darwin.js');

async function calendarRow() {
  __resetPermissionCachesForTest();
  const res = await getPermissionsReport(true);
  const row = res.permissions.find((p) => p.id === 'calendar');
  if (!row) throw new Error('no calendar row');
  const steps = row.steps.map((s) => (typeof s === 'string' ? s : s.text));
  return { ...row, steps };
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  process.env.WALNUT_LAUNCHER = 'mac-app';
  report = { state: 'granted', read: 'granted', writeGap: null };
  fallback = null;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  delete process.env.WALNUT_LAUNCHER;
});

describe('calendar row with a separate write route', () => {
  it('granted on both routes names Walnut and says nothing about a helper', async () => {
    const row = await calendarRow();
    expect(row.state).toBe('granted');
    expect(row.grantTarget).toBe(APP);
    expect(row.why).not.toContain('walnut-calendar helper');
  });

  it('reads fine, write helper never asked: a prompt, and the copy names the helper', async () => {
    report = { state: 'not-determined', read: 'granted', writeGap: 'not-determined' };
    const row = await calendarRow();
    expect(row.state).toBe('not-determined');
    expect(row.fixKind).toBe('prompt');
    expect(row.grantTarget).toMatch(/^walnut-calendar/);
    expect(row.steps[0]).toContain('Walnut can read your calendars already');
    expect(row.steps.join(' ')).not.toContain('Calendar now belongs to Walnut itself');
    expect(row.why).toContain('separate walnut-calendar helper');
  });

  it('reads fine, write helper refused: settings-only, pointing at the helper entry', async () => {
    report = { state: 'denied', read: 'granted', writeGap: 'denied' };
    const row = await calendarRow();
    expect(row.fixKind).toBe('settings-only');
    expect(row.steps.join(' ')).toContain('Find the walnut-calendar entry');
  });

  it('nothing asked yet, reads through an older helper: one button, and a warning about the second dialog', async () => {
    report = { state: 'not-determined', read: 'not-determined', writeGap: 'not-determined' };
    fallback = { path: '/cache/walnut-calendar-v6', version: 'v6' };
    const row = await calendarRow();
    expect(row.fixKind).toBe('prompt');
    expect(row.grantTarget).toBe(APP);
    expect(row.why).toContain('reading works');
    expect(row.why).not.toContain('nothing is missing');
    expect(row.steps.at(-1)).toContain('A second dialog asks for the walnut-calendar helper');
  });
});
