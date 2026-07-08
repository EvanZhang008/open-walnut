/**
 * Process fd-health tripwire (inc-1783406628291: ~16k leaked fds made every
 * ssh spawn fail EBADF; the leak was invisible until the process died).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getFdCount,
  fdBand,
  checkProcessFdHealth,
  processHealthSnapshot,
  _resetFdHealthState,
} from '../../../src/core/observability/process-health.js';

beforeEach(() => {
  _resetFdHealthState();
});

describe('getFdCount', () => {
  it('returns a plausible count for this process', () => {
    const n = getFdCount();
    expect(n).not.toBeNull();
    expect(n!).toBeGreaterThan(2); // stdin/stdout/stderr at minimum
    expect(n!).toBeLessThan(100_000);
  });
});

describe('fdBand', () => {
  it('classifies healthy / warn / error bands', () => {
    expect(fdBand(100)).toBe(0);
    expect(fdBand(999)).toBe(0);
    expect(fdBand(1_000)).toBe(1);
    expect(fdBand(3_999)).toBe(1);
    expect(fdBand(4_000)).toBe(2);
    expect(fdBand(16_380)).toBe(2); // the incident's actual count
  });
});

describe('checkProcessFdHealth', () => {
  it('does not throw on a healthy process (smoke — real fd table)', () => {
    expect(() => checkProcessFdHealth()).not.toThrow();
  });
});

describe('processHealthSnapshot', () => {
  it('produces parseable JSON with the fields bundles rely on', () => {
    const snap = JSON.parse(processHealthSnapshot());
    expect(snap.pid).toBe(process.pid);
    expect(typeof snap.fdCount).toBe('number');
    expect(typeof snap.rssMb).toBe('number');
    expect(typeof snap.uptimeSec).toBe('number');
  });
});
