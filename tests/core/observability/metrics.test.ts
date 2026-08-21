import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  observe,
  count,
  timed,
  snapshot,
  flush,
  resetMetrics,
  stopMetricsFlush,
} from '../../../src/core/observability/metrics.js';

beforeEach(() => {
  resetMetrics();
});

afterEach(() => {
  stopMetricsFlush();
  resetMetrics();
  vi.restoreAllMocks();
});

describe('metrics registry', () => {
  it('observe() aggregates count/sum/min/max and window percentiles', () => {
    for (const v of [10, 20, 30, 40, 50]) observe('test.lat', v);

    const snap = snapshot();
    const s = snap.series.find((x) => x.name === 'test.lat')!;
    expect(s.count).toBe(5);
    expect(s.sum).toBe(150);
    expect(s.min).toBe(10);
    expect(s.max).toBe(50);
    expect(s.avg).toBe(30);
    expect(s.window).not.toBeNull();
    expect(s.window!.p50).toBe(30);
    expect(s.window!.p99).toBe(50);
  });

  it('labels create distinct series; label ORDER does not', () => {
    observe('http.request', 5, { route: '/api/tasks', method: 'GET' });
    observe('http.request', 15, { method: 'GET', route: '/api/tasks' }); // same labels, other order
    observe('http.request', 100, { route: '/api/notes', method: 'GET' });

    const snap = snapshot();
    const series = snap.series.filter((s) => s.name === 'http.request');
    expect(series).toHaveLength(2);
    const tasks = series.find((s) => s.labels?.route === '/api/tasks')!;
    expect(tasks.count).toBe(2); // both orderings landed in one series
  });

  it('flush() resets the window but keeps lifetime aggregates', () => {
    observe('test.lat', 100);
    flush();
    observe('test.lat', 10);

    const snap = snapshot();
    const s = snap.series.find((x) => x.name === 'test.lat')!;
    expect(s.count).toBe(2);       // lifetime survives flush
    expect(s.max).toBe(100);       // lifetime max survives
    expect(s.window!.count).toBe(1); // window restarted
    expect(s.window!.max).toBe(10);
  });

  it('timed() records duration and re-throws failures with an .error count', async () => {
    const ok = await timed('op.x', async () => 'result');
    expect(ok).toBe('result');

    await expect(timed('op.x', async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    const snap = snapshot();
    const op = snap.series.find((s) => s.name === 'op.x')!;
    const err = snap.series.find((s) => s.name === 'op.x.error')!;
    expect(op.count).toBe(2);  // both success and failure durations recorded
    expect(err.count).toBe(1);
  });

  it('never throws on garbage input (hot-path safety)', () => {
    expect(() => observe('bad', NaN)).not.toThrow();
    expect(() => observe('bad', Infinity)).not.toThrow();
    expect(() => count('ok')).not.toThrow();
    // NaN/Infinity are silently dropped, not stored
    const snap = snapshot();
    expect(snap.series.find((s) => s.name === 'bad')).toBeUndefined();
  });

  it('caps series cardinality instead of growing unbounded', () => {
    // Blow past MAX_SERIES (500) with unique labels — the guard drops the excess.
    for (let i = 0; i < 600; i++) {
      observe('cardinality.bomb', 1, { id: String(i) });
    }
    const snap = snapshot();
    expect(snap.series.length).toBeLessThanOrEqual(500);
    expect(snap.droppedSeries).toBeGreaterThan(0);
  });

  it('reservoir stays bounded under heavy traffic', () => {
    for (let i = 0; i < 10_000; i++) observe('busy', i % 100);
    const snap = snapshot();
    const s = snap.series.find((x) => x.name === 'busy')!;
    expect(s.count).toBe(10_000);
    // Percentiles still sane from the bounded sample
    expect(s.window!.p50).toBeGreaterThanOrEqual(0);
    expect(s.window!.p50).toBeLessThanOrEqual(99);
  });
});
