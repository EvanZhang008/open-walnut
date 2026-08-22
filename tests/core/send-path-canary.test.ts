/**
 * Send-path canary — pure transition-logic tests for evaluateCanary.
 *
 * Born from the 2026-08-21/22 incident family: sends failed for hours (disk
 * 507, then a sleeping Mac) and the USER was the monitoring. The canary's
 * whole value is (a) naming the exact failing hop and (b) alerting exactly
 * once per degradation EDGE — so every test here pins an edge behavior.
 */
import { describe, it, expect } from 'vitest';
import { evaluateCanary, type CanaryInputs } from '../../src/core/send-path-canary.js';

function inputs(over: Partial<CanaryInputs> = {}): CanaryInputs {
  return {
    diskBlocked: false,
    diskUsedPct: 30,
    connectedHosts: ['__local__', 'clouddev'],
    bankedSends: 0,
    prevPrimaryAbsentTicks: 0,
    ...over,
  };
}

describe('evaluateCanary — healthy path', () => {
  it('all green: healthy, no problems, no alerts', () => {
    const { next, alerts } = evaluateCanary(inputs(), []);
    expect(next.healthy).toBe(true);
    expect(next.problems).toEqual([]);
    expect(alerts).toEqual([]);
    expect(next.primaryAbsentTicks).toBe(0);
  });

  it('primary absent but nothing banked = normal life, not an incident', () => {
    const { next, alerts } = evaluateCanary(
      inputs({ connectedHosts: ['clouddev'], bankedSends: 0, prevPrimaryAbsentTicks: 10 }),
      [],
    );
    expect(next.healthy).toBe(true);
    expect(alerts).toEqual([]);
    expect(next.primaryAbsentTicks).toBe(11); // still counting
  });
});

describe('evaluateCanary — disk_blocked edge', () => {
  it('fires ONE alert on the healthy→blocked edge, naming the disk', () => {
    const { next, alerts } = evaluateCanary(inputs({ diskBlocked: true, diskUsedPct: 91 }), []);
    expect(next.healthy).toBe(false);
    expect(next.problems).toContain('disk_blocked');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe('canary:disk_blocked');
    expect(alerts[0].title).toMatch(/disk/i);
    expect(alerts[0].body).toContain('91');
  });

  it('does NOT re-alert while the condition holds (edge-triggered)', () => {
    const { next, alerts } = evaluateCanary(
      inputs({ diskBlocked: true, diskUsedPct: 92 }),
      ['disk_blocked'],
    );
    expect(next.healthy).toBe(false);
    expect(alerts).toEqual([]);
  });

  it('fires the recovery alert on the blocked→healthy edge', () => {
    const { next, alerts } = evaluateCanary(inputs(), ['disk_blocked']);
    expect(next.healthy).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe('canary:recovered');
  });
});

describe('evaluateCanary — sends_waiting_on_primary', () => {
  it('needs BOTH a sustained primary absence AND banked sends', () => {
    // Tick 1-2: absent + banked, below the 3-tick threshold — no problem yet.
    let r = evaluateCanary(inputs({ connectedHosts: [], bankedSends: 2, prevPrimaryAbsentTicks: 0 }), []);
    expect(r.next.problems).toEqual([]);
    expect(r.next.primaryAbsentTicks).toBe(1);
    r = evaluateCanary(inputs({ connectedHosts: [], bankedSends: 2, prevPrimaryAbsentTicks: 1 }), []);
    expect(r.next.problems).toEqual([]);
    // Tick 3: threshold reached → problem + one alert naming the Mac.
    r = evaluateCanary(inputs({ connectedHosts: [], bankedSends: 2, prevPrimaryAbsentTicks: 2 }), []);
    expect(r.next.problems).toContain('sends_waiting_on_primary');
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0].key).toBe('canary:sends_waiting_on_primary');
    expect(r.alerts[0].title).toContain('2');
    expect(r.alerts[0].body).toMatch(/Mac/);
  });

  it('primary reconnecting resets the tick counter immediately', () => {
    const { next } = evaluateCanary(
      inputs({ connectedHosts: ['__local__'], bankedSends: 3, prevPrimaryAbsentTicks: 7 }),
      ['sends_waiting_on_primary'],
    );
    expect(next.primaryAbsentTicks).toBe(0);
    expect(next.problems).toEqual([]);
  });

  it('holds (no re-alert) while the queue keeps waiting', () => {
    const { alerts } = evaluateCanary(
      inputs({ connectedHosts: [], bankedSends: 5, prevPrimaryAbsentTicks: 6 }),
      ['sends_waiting_on_primary'],
    );
    expect(alerts).toEqual([]);
  });

  it('recovery alert when the queue drains after the Mac returns', () => {
    const { next, alerts } = evaluateCanary(
      inputs({ connectedHosts: ['__local__'], bankedSends: 0 }),
      ['sends_waiting_on_primary'],
    );
    expect(next.healthy).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe('canary:recovered');
  });
});

describe('evaluateCanary — compound and transition cases', () => {
  it('both problems at once produce both alerts, one each', () => {
    const { next, alerts } = evaluateCanary(
      inputs({ diskBlocked: true, diskUsedPct: 95, connectedHosts: [], bankedSends: 1, prevPrimaryAbsentTicks: 5 }),
      [],
    );
    expect(next.problems).toEqual(['disk_blocked', 'sends_waiting_on_primary']);
    expect(alerts.map((a) => a.key).sort()).toEqual([
      'canary:disk_blocked',
      'canary:sends_waiting_on_primary',
    ]);
  });

  it('one problem clearing while the other persists = no alert at all (no false recovery)', () => {
    const { next, alerts } = evaluateCanary(
      inputs({ diskBlocked: false, connectedHosts: [], bankedSends: 1, prevPrimaryAbsentTicks: 5 }),
      ['disk_blocked', 'sends_waiting_on_primary'],
    );
    expect(next.problems).toEqual(['sends_waiting_on_primary']);
    expect(alerts).toEqual([]); // recovery only fires when EVERYTHING is green
  });

  it('null disk percentage renders a "?" instead of crashing the alert body', () => {
    const { alerts } = evaluateCanary(inputs({ diskBlocked: true, diskUsedPct: null }), []);
    expect(alerts[0].body).toContain('?');
  });

  it('state snapshot carries the raw inputs for the /canary endpoint', () => {
    const { next } = evaluateCanary(
      inputs({ connectedHosts: ['clouddev'], bankedSends: 4, diskUsedPct: 42, prevPrimaryAbsentTicks: 1 }),
      [],
    );
    expect(next.connectedHosts).toEqual(['clouddev']);
    expect(next.bankedSends).toBe(4);
    expect(next.diskUsedPct).toBe(42);
    expect(next.checkedAt).toMatch(/^\d{4}-/);
  });
});
