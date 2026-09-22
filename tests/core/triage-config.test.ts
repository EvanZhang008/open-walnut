/**
 * readTriageConfig — the ONE reader for config.triage: its defaults, its clamps,
 * and the sources → wake.events mapping bootstrap.ts builds the routine from.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { readTriageConfig, isTriageWithinActiveHours } from '../../src/core/triage/config.js';
import { log } from '../../src/logging/index.js';
import {
  DEFAULT_TRIAGE_EVERY_MESSAGES,
  MIN_TRIAGE_EVERY_MS,
} from '../../src/core/triage/types.js';

describe('readTriageConfig — defaults', () => {
  it('a fresh install is OFF and reads every default at the reader', () => {
    const r = readTriageConfig({});
    expect(r.enabled).toBe(false);
    expect(r.disabledReason).toBe('config');
    expect(r.everyMs).toBe(30 * 60_000);
    expect(r.everyMessages).toBe(DEFAULT_TRIAGE_EVERY_MESSAGES);
    expect(r.sources).toEqual(['mail', 'slack']);
    expect(r.wakeEvents).toEqual([
      'plugin:mail:messages-received',
      'plugin:slack:messages-received',
    ]);
    expect(r.mode).toBe('ask');
    expect(r.autoMarkRead).toBe(false);
    expect(r.activeHours).toBe('08:00-22:00');
  });

  it('a null/undefined config reads exactly like an empty one', () => {
    expect(readTriageConfig(null)).toEqual(readTriageConfig({}));
    expect(readTriageConfig(undefined)).toEqual(readTriageConfig({}));
  });

  it('enabled: true with nothing else is enabled on the defaults', () => {
    const r = readTriageConfig({ triage: { enabled: true } });
    expect(r.enabled).toBe(true);
    expect(r.disabledReason).toBeUndefined();
    expect(r.everyMs).toBe(30 * 60_000);
  });
});

describe('readTriageConfig — the interval clamp', () => {
  it('clamps anything under the floor up to it', () => {
    expect(readTriageConfig({ triage: { enabled: true, every: '1m' } }).everyMs).toBe(MIN_TRIAGE_EVERY_MS);
    expect(readTriageConfig({ triage: { enabled: true, every: '30s' } }).everyMs).toBe(MIN_TRIAGE_EVERY_MS);
  });

  it('keeps an interval at or above the floor', () => {
    expect(readTriageConfig({ triage: { enabled: true, every: '5m' } }).everyMs).toBe(MIN_TRIAGE_EVERY_MS);
    expect(readTriageConfig({ triage: { enabled: true, every: '1h' } }).everyMs).toBe(3_600_000);
    expect(readTriageConfig({ triage: { enabled: true, every: '2h30m' } }).everyMs).toBe(9_000_000);
  });

  it('"0" disables triage even when enabled is true (heartbeat vocabulary)', () => {
    for (const every of ['0', '0m', '0s']) {
      const r = readTriageConfig({ triage: { enabled: true, every } });
      expect(r.enabled, every).toBe(false);
      expect(r.disabledReason, every).toBe('interval-zero');
      expect(r.everyMs, every).toBe(0);
    }
  });

  it('an empty / whitespace interval falls back to the default, not to zero', () => {
    expect(readTriageConfig({ triage: { enabled: true, every: '   ' } }).everyMs).toBe(30 * 60_000);
    expect(readTriageConfig({ triage: { enabled: true, every: '' } }).everyMs).toBe(30 * 60_000);
  });
});

/**
 * parseDuration answers 0 both for a zero the user WROTE and for a value it cannot
 * read at all, and only the first is a choice. Taking the second at face value
 * turned `every: "half an hour"` into triage never running while Settings still
 * showed it enabled, and blamed it on `interval-zero` — which reads as deliberate.
 */
describe('readTriageConfig — an interval nobody can parse is not "off"', () => {
  it('"half an hour" falls back to the default and stays ENABLED', () => {
    const r = readTriageConfig({ triage: { enabled: true, every: 'half an hour' } });
    expect(r.enabled).toBe(true);
    expect(r.disabledReason).toBeUndefined();
    expect(r.everyMs).toBe(30 * 60_000);
  });

  it('so do the other shapes of a typo', () => {
    for (const every of ['thirty minutes', 'hourly', 'm', '??']) {
      const r = readTriageConfig({ triage: { enabled: true, every } });
      expect(r.enabled, every).toBe(true);
      expect(r.everyMs, every).toBe(30 * 60_000);
    }
  });

  it('warns once per distinct value, naming it (the batch action re-reads every fire)', () => {
    const warn = vi.spyOn(log.cron, 'warn').mockImplementation(() => {});
    try {
      const holder = { triage: { enabled: true, every: 'every other tuesday' } };
      readTriageConfig(holder);
      readTriageConfig(holder);
      readTriageConfig(holder);
      const named = warn.mock.calls.filter(
        ([, meta]) => (meta as { configured?: string } | undefined)?.configured === 'every other tuesday',
      );
      expect(named).toHaveLength(1);
      expect(named[0][0]).toContain('could not read the interval');
    } finally {
      warn.mockRestore();
    }
  });

  it('a zero the user WROTE still disables, in every spelling', () => {
    for (const every of ['0', '0m', '0s', '0h', '00', ' 0 ']) {
      const r = readTriageConfig({ triage: { enabled: true, every } });
      expect(r.enabled, every).toBe(false);
      expect(r.disabledReason, every).toBe('interval-zero');
      expect(r.everyMs, every).toBe(0);
    }
  });
});

describe('readTriageConfig — every_messages', () => {
  it('floors, never goes negative, and survives a string', () => {
    expect(readTriageConfig({ triage: { every_messages: 0 } }).everyMessages).toBe(0);
    expect(readTriageConfig({ triage: { every_messages: 7.9 } }).everyMessages).toBe(7);
    expect(readTriageConfig({ triage: { every_messages: -5 } }).everyMessages).toBe(0);
    expect(readTriageConfig({ triage: { every_messages: '12' as never } }).everyMessages).toBe(12);
  });

  it('a value that is not a number at all takes the default', () => {
    expect(readTriageConfig({ triage: { every_messages: 'lots' as never } }).everyMessages)
      .toBe(DEFAULT_TRIAGE_EVERY_MESSAGES);
    expect(readTriageConfig({ triage: { every_messages: NaN } }).everyMessages)
      .toBe(DEFAULT_TRIAGE_EVERY_MESSAGES);
  });
});

describe('readTriageConfig — sources → wake.events', () => {
  it('one source yields exactly one event', () => {
    const r = readTriageConfig({ triage: { sources: ['slack'] } });
    expect(r.sources).toEqual(['slack']);
    expect(r.wakeEvents).toEqual(['plugin:slack:messages-received']);
  });

  it('drops unknown names, dedupes, and normalises case', () => {
    const r = readTriageConfig({ triage: { sources: ['MAIL', 'mail', 'sms', 'slack'] as never } });
    expect(r.sources).toEqual(['mail', 'slack']);
  });

  it('an EXPLICITLY empty array means no event sources (clock only)', () => {
    const r = readTriageConfig({ triage: { sources: [] } });
    expect(r.sources).toEqual([]);
    expect(r.wakeEvents).toEqual([]);
  });

  it('a non-array value falls back to both', () => {
    expect(readTriageConfig({ triage: { sources: 'mail' as never } }).sources).toEqual(['mail', 'slack']);
  });
});

describe('readTriageConfig — mode, auto_mark_read, active_hours', () => {
  it('mode accepts ask/assist and falls back to ask', () => {
    expect(readTriageConfig({ triage: { mode: 'assist' } }).mode).toBe('assist');
    expect(readTriageConfig({ triage: { mode: 'ASK' as never } }).mode).toBe('ask');
    expect(readTriageConfig({ triage: { mode: 'yolo' as never } }).mode).toBe('ask');
  });

  it('auto_mark_read is strictly boolean true', () => {
    expect(readTriageConfig({ triage: { auto_mark_read: true } }).autoMarkRead).toBe(true);
    expect(readTriageConfig({ triage: { auto_mark_read: 'yes' as never } }).autoMarkRead).toBe(false);
  });

  it('an explicitly EMPTY active_hours means 24/7, an absent one takes the window', () => {
    expect(readTriageConfig({ triage: { active_hours: '' } }).activeHours).toBeUndefined();
    expect(readTriageConfig({ triage: {} }).activeHours).toBe('08:00-22:00');
    expect(readTriageConfig({ triage: { active_hours: ' 09:00-17:00 ' } }).activeHours).toBe('09:00-17:00');
  });

  it('isTriageWithinActiveHours answers true for 24/7 and for a window containing now', () => {
    expect(isTriageWithinActiveHours({ activeHours: undefined })).toBe(true);
    expect(isTriageWithinActiveHours({ activeHours: '00:00-23:59' })).toBe(true);
    // A malformed window degrades to "always active" (isWithinActiveHours warns).
    expect(isTriageWithinActiveHours({ activeHours: 'nonsense' })).toBe(true);
  });

  it('a window that excludes now suppresses the run', () => {
    // Build a one-minute window an hour behind the clock, wrapping correctly.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const start = new Date(now.getTime() - 2 * 3_600_000);
    const end = new Date(now.getTime() - 1 * 3_600_000);
    const windowStr = `${pad(start.getHours())}:${pad(start.getMinutes())}-${pad(end.getHours())}:${pad(end.getMinutes())}`;
    expect(isTriageWithinActiveHours({ activeHours: windowStr })).toBe(false);
  });
});
