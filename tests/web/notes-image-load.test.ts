/**
 * What a notes picture's load told the page (web/src/components/notes/image-load.ts).
 *
 * 2026-11-05: two views of one missing picture each asked for it (a note rebuilt
 * while its pictures loaded), and a picture that failed once stayed a missing
 * card until the note was reopened, even after its file came back.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  claimLoad, settleLoad, retryDue, MISSING_FOR_MS, failureOf, noteMissing, recentlyMissing, drawnUrl, noteDrawn,
} from '@/components/notes/image-load';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('one request per picture at a time', () => {
  it('a second view waits for the first answer instead of asking', () => {
    const url = '/api/notes-v2/attachment?path=a.png&note=n.md&exact=note';
    const second = vi.fn();
    expect(claimLoad(url, vi.fn())).toBe(true);
    expect(claimLoad(url, second)).toBe(false);
    settleLoad(url, 'failed');
    expect(second).toHaveBeenCalledWith('failed');
    // Settled: the next view asks again itself.
    expect(claimLoad(url, vi.fn())).toBe(true);
    settleLoad(url, 'ok');
  });

  it('a waiter whose loader never answers asks itself', () => {
    vi.useFakeTimers();
    const url = '/api/notes-v2/attachment?path=b.png&note=n.md&exact=note';
    const waiter = vi.fn();
    claimLoad(url, vi.fn());
    claimLoad(url, waiter);
    vi.advanceTimersByTime(16_000);
    expect(waiter).toHaveBeenCalledWith('retry');
    settleLoad(url, 'ok');
    expect(waiter).toHaveBeenCalledTimes(1);
  });
});

describe('a failed picture is asked again after a few seconds', () => {
  it('missing for a moment, then due again', () => {
    vi.useFakeTimers();
    noteMissing('/x.png');
    expect(recentlyMissing('/x.png')).toBe(true);
    const at = Date.now();
    expect(retryDue(at)).toBe(false);
    vi.advanceTimersByTime(MISSING_FOR_MS);
    expect(recentlyMissing('/x.png')).toBe(false);
    expect(retryDue(at)).toBe(true);
  });
});

describe('a failure is told apart: missing, or here but not drawable', () => {
  it('a common type is missing without asking again', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await failureOf('/api/notes-v2/attachment?path=a.png&note=n.md')).toBe('missing');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a HEIC or TIFF that answers is undrawable here; one that 404s is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: url.includes('there') })));
    expect(await failureOf('/api/notes-v2/attachment?path=there.heic&note=n.md')).toBe('undrawable');
    expect(await failureOf('/api/notes-v2/attachment?path=gone.tiff&note=n.md')).toBe('missing');
  });
});

it('remembers which URL an image drew from, per note', () => {
  noteDrawn('A/Note.md', 'map.png', '/u1');
  expect(drawnUrl('A/Note.md', 'map.png')).toBe('/u1');
  expect(drawnUrl('B/Note.md', 'map.png')).toBeUndefined();
});
