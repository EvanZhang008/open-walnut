import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { boundHistoryPreview, HISTORY_OPEN_PREVIEW_BYTES, HISTORY_OPEN_PREVIEW_MS } from '../../src/core/history-open-preview.js';

afterEach(() => vi.useRealTimers());

describe('cold chat first-paint budget', () => {
  it('keeps the byte window below a single small daemon response', () => {
    expect(HISTORY_OPEN_PREVIEW_BYTES).toBeLessThanOrEqual(128 * 1024);
    expect(HISTORY_OPEN_PREVIEW_MS).toBeLessThanOrEqual(3000);
  });

  it('returns rows immediately, and a rejected read degrades without an error', async () => {
    const rows = [{ role: 'assistant', text: 'latest answer' }];
    expect(await boundHistoryPreview('fast', async () => rows)).toBe(rows);
    expect(await boundHistoryPreview('failed', async () => { throw new Error('host offline'); })).toBeNull();
  });

  it('a host that never answers cannot delay phase two past the preview budget', async () => {
    vi.useFakeTimers();
    let done = false;
    const result = boundHistoryPreview('hung', () => new Promise(() => {})).then(value => { done = true; return value; });
    await vi.advanceTimersByTimeAsync(HISTORY_OPEN_PREVIEW_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeNull();
  });

  it('a late answer stays observed and cannot replace the timed-out response', async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const result = boundHistoryPreview('late', () => new Promise((_, r) => { reject = r; }));
    await vi.advanceTimersByTimeAsync(HISTORY_OPEN_PREVIEW_MS);
    expect(await result).toBeNull();
    reject(new Error('late transport failure'));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('every first-paint reader in the route is byte and time bounded', () => {
    const route = fs.readFileSync(new URL('../../src/web/routes/sessions.ts', import.meta.url), 'utf8');
    const start = route.indexOf("if (source === 'streams')");
    const p1 = route.slice(start, route.indexOf('return\n    }', start) + 'return\n    }'.length);
    const calls = [...p1.matchAll(/(?:readProviderSessionHistory|readSessionHistoryTailWindow)\(/g)];
    expect(calls.length).toBe(3);
    expect((p1.match(/boundHistoryPreview\(sessionId/g) ?? []).length).toBe(calls.length);
    expect((p1.match(/HISTORY_OPEN_PREVIEW_BYTES/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(p1).toContain('maxColdReadBytes: HISTORY_COLD_TAIL_READ_BYTES');
  });
});
