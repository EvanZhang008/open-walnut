/**
 * What the popover and the pill say about a host's subscription limits
 * (web/src/utils/subscription-limit-format.ts). Fixed clock and time zone, so
 * every string is exact. `\s` in the time patterns: ICU puts a narrow no-break
 * space before AM/PM.
 */
import { describe, it, expect } from 'vitest';
import type { HostLimitFrame, LimitWindow } from '@/api/subscription-limits';
import {
  AGE_SHOWN_AFTER_MS, computeLimitReadout, formatAge, formatResetTime, limitLabel,
} from '@/utils/subscription-limit-format';

const NOW = Date.UTC(2026, 9, 2, 12, 0); // Fri Oct 2 2026, 12:00 UTC
const H = 3_600_000;
const D = 24 * H;
const OPTS = { locale: 'en-US', timeZone: 'UTC' };

function win(type: string, utilization: number | undefined, resetsIn: number, seenAgo = 60_000): LimitWindow {
  return { type, ...(utilization !== undefined ? { utilization } : {}), resetsAt: NOW + resetsIn, seenAt: NOW - seenAgo, sessionId: 'sid-1' };
}

function frame(windows: LimitWindow[], extra: Partial<HostLimitFrame> = {}): HostLimitFrame {
  return {
    host: '__local__', serverNow: NOW, updatedAt: NOW - 60_000,
    windows: Object.fromEntries(windows.map((w) => [w.type, w])),
    ...extra,
  };
}

const readout = (f: HostLimitFrame | null) => computeLimitReadout(f, NOW, OPTS);
const line = (r: { label: string; value?: string; when?: string; age?: string }) => [r.label, r.value, r.when, r.age].filter(Boolean).join(' · ');

describe('computeLimitReadout', () => {
  it('nothing reported, nothing shown (never an empty meter)', () => {
    expect(readout(null)).toBeNull();
    expect(readout(frame([]))).toBeNull();
    expect(readout(frame([], { current: { status: 'allowed', seenAt: NOW } }))).toBeNull();
  });

  it('a 5-hour warning and the weekly window: one line each, in window order, and a warning hint', () => {
    const r = readout(frame(
      [win('seven_day', 0.31, 4 * D), win('five_hour', 0.92, 3 * H + 40 * 60_000)],
      { current: { status: 'allowed_warning', type: 'five_hour', utilization: 0.92, resetsAt: NOW + 3 * H + 40 * 60_000, seenAt: NOW - 60_000 } },
    ))!;
    expect(r.rows.map((x) => x.type)).toEqual(['five_hour', 'seven_day']);
    expect(line(r.rows[0])).toMatch(/^5-hour limit · 92% · resets 3:40\sPM$/);
    expect(r.rows[0].state).toBe('warning');
    expect(line(r.rows[1])).toBe('Weekly limit · 31% · resets Tue');
    expect(r.rows[1].state).toBe('ok');
    expect(r.hint?.level).toBe('warning');
    expect(r.hint?.text).toMatch(/^5-hour limit 92% used · resets 3:40\sPM$/);
    expect(r.overage).toBeUndefined();
    expect(r.rows[0].title).toContain('92% used');
  });

  it('the normal state has rows and no hint', () => {
    const r = readout(frame([win('five_hour', 0.4, 2 * H)], { current: { status: 'allowed', type: 'five_hour', seenAt: NOW - 60_000 } }))!;
    expect(r.rows[0].state).toBe('ok');
    expect(r.hint).toBeNull();
  });

  it('a window whose reset passed shows as reset, never the old percentage, and its warning is over', () => {
    const r = readout(frame(
      [win('five_hour', 0.97, -5 * 60_000, 3 * H), win('seven_day', 0.5, 2 * D)],
      { current: { status: 'allowed_warning', type: 'five_hour', utilization: 0.97, resetsAt: NOW - 5 * 60_000, seenAt: NOW - 3 * H } },
    ))!;
    expect(r.rows[0]).toMatchObject({ state: 'reset', when: 'reset' });
    expect(r.rows[0].value).toBeUndefined();
    expect(r.rows[0].age).toBeUndefined();
    expect(line(r.rows[0])).toBe('5-hour limit · reset');
    expect(r.hint).toBeNull();
  });

  it('an old reading says how old it is; a fresh one does not', () => {
    const r = readout(frame([win('five_hour', 0.4, 2 * H, 2 * H + 5 * 60_000), win('seven_day', 0.2, 3 * D, AGE_SHOWN_AFTER_MS - 1000)]))!;
    expect(r.rows[0].age).toBe('as of 2h ago');
    expect(r.rows[1].age).toBeUndefined();
  });

  it('a low-usage warning (under 70%) stays quiet, as the CLI keeps it quiet', () => {
    const r = readout(frame([win('seven_day', 0.42, 3 * D)], {
      current: { status: 'allowed_warning', type: 'seven_day', utilization: 0.42, resetsAt: NOW + 3 * D, seenAt: NOW - 60_000 },
    }))!;
    expect(r.rows[0].state).toBe('ok');
    expect(r.hint).toBeNull();
  });

  it('a reached limit: a red hint and "reached" when the CLI gave no number', () => {
    const r = readout(frame([win('five_hour', undefined, 90 * 60_000)], {
      current: { status: 'rejected', type: 'five_hour', resetsAt: NOW + 90 * 60_000, seenAt: NOW - 60_000 },
    }))!;
    expect(r.rows[0]).toMatchObject({ state: 'rejected', value: 'reached' });
    expect(r.hint?.level).toBe('rejected');
    expect(r.hint?.text).toMatch(/^5-hour limit reached · resets 1:30\sPM$/);
  });

  it('past the limit on extra usage: an amber hint and the extra-usage line', () => {
    const r = readout(frame([win('five_hour', 1, 2 * H)], {
      current: { status: 'rejected', type: 'five_hour', resetsAt: NOW + 2 * H, seenAt: NOW - 60_000 },
      overage: { status: 'allowed', isUsingOverage: true, resetsAt: NOW + 10 * D, seenAt: NOW - 60_000 },
    }))!;
    expect(r.hint).toEqual({ level: 'warning', text: '5-hour limit reached · using extra usage' });
    expect(r.overage).toEqual({ text: 'Using extra usage · resets Oct 12', state: 'ok' });
  });

  it('extra usage is mentioned when the limit is hit and it is unavailable, not otherwise', () => {
    const blocked = readout(frame([win('seven_day', 1, 2 * D)], {
      current: { status: 'rejected', type: 'seven_day', resetsAt: NOW + 2 * D, seenAt: NOW - 60_000 },
      overage: { status: 'rejected', disabledReason: 'out_of_credits', isUsingOverage: false, seenAt: NOW - 60_000 },
    }))!;
    expect(blocked.overage).toEqual({ text: 'Extra usage unavailable: out of credits', state: 'rejected' });
    expect(blocked.hint?.level).toBe('rejected');
    const fine = readout(frame([win('seven_day', 0.3, 2 * D)], {
      current: { status: 'allowed', type: 'seven_day', seenAt: NOW - 60_000 },
      overage: { status: 'rejected', disabledReason: 'org_level_disabled', isUsingOverage: false, seenAt: NOW - 60_000 },
    }))!;
    expect(fine.overage).toBeUndefined();
  });

  it('an older CLI\'s headline (no percentage) still shows the window and its reset', () => {
    const r = readout(frame([win('five_hour', undefined, 4 * H)], { current: { status: 'allowed', type: 'five_hour', seenAt: NOW - 60_000 } }))!;
    expect(r.rows[0].value).toBeUndefined();
    expect(line(r.rows[0])).toMatch(/^5-hour limit · resets 4:00\sPM$/);
  });

  it('per-model weekly windows get their names; a future window sorts last with a readable name', () => {
    const r = readout(frame([
      win('seven_day_brand_new', 0.1, 3 * D), win('seven_day_overage_included', 0.6, 3 * D),
      win('seven_day_sonnet', 0.2, 3 * D), win('seven_day_opus', 0.3, 3 * D),
    ]))!;
    expect(r.rows.map((x) => x.label)).toEqual(['Weekly Opus limit', 'Weekly Sonnet limit', 'Weekly Fable limit', 'Seven day brand new limit']);
  });

  it('a Bedrock / Vertex / API-key sign-in hides every reading older than that check', () => {
    const windows = [win('five_hour', 0.95, 2 * H, 30 * 60_000)];
    const current = { status: 'allowed_warning' as const, type: 'five_hour', utilization: 0.95, resetsAt: NOW + 2 * H, seenAt: NOW - 30 * 60_000 };
    expect(readout(frame(windows, { current, signIn: { kind: 'other', detail: 'Bedrock', checkedAt: NOW - 60_000 } }))).toBeNull();
    // No check time at all: still hidden.
    expect(readout(frame(windows, { current, signIn: { kind: 'other', detail: 'an Anthropic API key' } }))).toBeNull();
    // A reading NEWER than the check proves a subscription now: it shows.
    const later = readout(frame(windows, { current, signIn: { kind: 'other', detail: 'Bedrock', checkedAt: NOW - H } }))!;
    expect(later.rows).toHaveLength(1);
    expect(later.hint?.level).toBe('warning');
    // A subscription or an unknown sign-in never hides anything.
    expect(readout(frame(windows, { current, signIn: { kind: 'subscription', checkedAt: NOW } }))?.rows).toHaveLength(1);
    expect(readout(frame(windows, { current, signIn: { kind: 'unknown', checkedAt: NOW } }))?.rows).toHaveLength(1);
  });

  it('a status with no reset time stops counting after five hours', () => {
    const f = frame([win('seven_day', 0.9, 3 * D)], { current: { status: 'allowed_warning', type: 'seven_day', utilization: 0.9, seenAt: NOW - 6 * H } });
    expect(readout(f)!.hint).toBeNull();
    const fresh = frame([win('seven_day', 0.9, 3 * D)], { current: { status: 'allowed_warning', type: 'seven_day', utilization: 0.9, seenAt: NOW - H } });
    expect(readout(fresh)!.hint?.level).toBe('warning');
  });
});

describe('format helpers', () => {
  it('reset time: a clock time within 20h, a weekday within the week, a date beyond', () => {
    expect(formatResetTime(NOW + 3 * H + 40 * 60_000, NOW, OPTS)).toMatch(/^3:40\sPM$/);
    expect(formatResetTime(NOW + 19 * H, NOW, OPTS)).toMatch(/^7:00\sAM$/);
    expect(formatResetTime(NOW + 4 * D, NOW, OPTS)).toBe('Tue');
    expect(formatResetTime(NOW + 10 * D, NOW, OPTS)).toBe('Oct 12');
  });

  it('age: minutes, hours, days', () => {
    expect(formatAge(12 * 60_000)).toBe('12m ago');
    expect(formatAge(3 * H)).toBe('3h ago');
    expect(formatAge(50 * H)).toBe('2d ago');
    expect(formatAge(0)).toBe('1m ago');
  });

  it('labels', () => {
    expect(limitLabel('five_hour')).toBe('5-hour limit');
    expect(limitLabel('seven_day')).toBe('Weekly limit');
    expect(limitLabel(undefined)).toBe('Usage limit');
  });
});
