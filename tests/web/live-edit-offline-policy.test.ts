/**
 * Live Edit's answer to a write that never reached the server.
 *
 * 2026-09-24: a deploy restarted the server for about two seconds while a design
 * doc was being typed into. The auto-write's fetch rejected, and the hook treated
 * that like any other failure: it paused live mode for the file and put the
 * browser's own words ("Failed to fetch") in the banner. Live mode then stayed
 * off for that file; the next several minutes of typing were never written.
 *
 * These pin the decisions that replace that:
 *  - a failed connection and a gateway status are "unreachable" (retry), a 409 is
 *    still a conflict (merge), everything else is a refusal (pause at once);
 *  - the classification goes by the error's TYPE, never its message, because the
 *    three browsers word the same failure three different ways;
 *  - the retry backoff is bounded above (16s) and the outage bounded in time (60s),
 *    so a minute of outage is a handful of requests and then a clear pause;
 *  - a pause records WHY, so the toggle can explain itself.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  classifyWriteFailure, offlineRetryDelay, offlineGivesUp,
  OFFLINE_RETRY_DELAYS_MS, LIVE_OFFLINE_GIVE_UP_MS, LIVE_UNREACHABLE_PAUSED_MESSAGE,
  suspendLiveEdit, liveSuspensionReason, isLiveSuspended, resumeLiveEdit, clearLiveSuspensions,
} from '../../web/src/hooks/useLiveEdit';
import {
  FileSaveConflictError, FileSaveHttpError, FileSaveUnreachableError, isNetworkFetchError,
  saveFileContent, SAVE_UNREACHABLE_MESSAGE,
} from '../../web/src/api/files';

/** The browsers' three sentences for one failure. Only the type is stable. */
const NETWORK_WORDINGS = [
  'Failed to fetch', // Chromium
  'Load failed', // WebKit, which is the Mac app
  'NetworkError when attempting to fetch resource.', // Firefox
];

describe('classifyWriteFailure', () => {
  it('treats a failed connection as unreachable, whatever the browser called it', () => {
    for (const wording of NETWORK_WORDINGS) {
      const err = new FileSaveUnreachableError(new TypeError(wording));
      expect(classifyWriteFailure(err)).toBe('unreachable');
      expect(isNetworkFetchError(err)).toBe(true);
      // The wording rides along for the log line.
      expect(err.message).toBe(wording);
    }
  });

  it('does not take a bare TypeError for a dead server', () => {
    // A TypeError thrown by bookkeeping AFTER a successful PUT (a null deref in
    // an apply callback, say) must not re-send a write that already landed, nor
    // tell the user a saved file needs saving. Only the fetch wrapper may say
    // "unreachable".
    for (const wording of NETWORK_WORDINGS) {
      expect(classifyWriteFailure(new TypeError(wording))).toBe('refused');
      expect(isNetworkFetchError(new TypeError(wording))).toBe(false);
    }
  });

  it('treats a gateway that lost the server as unreachable', () => {
    for (const status of [502, 503, 504]) {
      expect(classifyWriteFailure(new FileSaveHttpError(`Save failed: ${status}`, status))).toBe('unreachable');
    }
  });

  it('keeps a 409 a conflict, whatever its reason', () => {
    expect(classifyWriteFailure(new FileSaveConflictError('abc'))).toBe('conflict');
    expect(classifyWriteFailure(new FileSaveConflictError('abc', 'unverified-base'))).toBe('conflict');
    expect(classifyWriteFailure(new FileSaveConflictError('abc', 'unlocked-machine-write'))).toBe('conflict');
  });

  it('treats a refusal as a refusal: retrying a 4xx would resend the same rejected request', () => {
    expect(classifyWriteFailure(new FileSaveHttpError('Path is outside the allowed roots', 403))).toBe('refused');
    expect(classifyWriteFailure(new FileSaveHttpError('Bad request', 400))).toBe('refused');
    expect(classifyWriteFailure(new FileSaveHttpError('EACCES', 500))).toBe('refused');
    expect(classifyWriteFailure(new Error('Empty response from file-content'))).toBe('refused');
    expect(classifyWriteFailure('string')).toBe('refused');
  });

  it('does not mistake a cancelled request for a dead server', () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    expect(isNetworkFetchError(abort)).toBe(false);
    expect(classifyWriteFailure(abort)).toBe('refused');
  });
});

describe('saveFileContent tells the three failures apart at the fetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('wraps a failed connection, keeping the browser wording for the log', async () => {
    for (const wording of NETWORK_WORDINGS) {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(wording); }));
      const err = await saveFileContent('/w/doc.md', 'text').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FileSaveUnreachableError);
      expect((err as Error).message).toBe(wording);
      expect(classifyWriteFailure(err)).toBe('unreachable');
    }
  });

  it('lets an abort through as itself', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    vi.stubGlobal('fetch', vi.fn(async () => { throw abort; }));
    const err = await saveFileContent('/w/doc.md', 'text').catch((e: unknown) => e);
    expect(err).toBe(abort);
    expect(classifyWriteFailure(err)).toBe('refused');
  });

  it('reports a gateway status with its number, so it can be retried', async () => {
    // A proxy in front of a restarting server answers with an HTML error page,
    // not JSON: the status is the only usable signal.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<h1>502 Bad Gateway</h1>', { status: 502 })));
    const err = await saveFileContent('/w/doc.md', 'text').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileSaveHttpError);
    expect((err as FileSaveHttpError).status).toBe(502);
    expect(classifyWriteFailure(err)).toBe('unreachable');
  });

  it('reports a refusal with the server\'s own words, and does not retry it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'Path is outside the allowed roots' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )));
    const err = await saveFileContent('/w/doc.md', 'text').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileSaveHttpError);
    expect((err as Error).message).toBe('Path is outside the allowed roots');
    expect(classifyWriteFailure(err)).toBe('refused');
  });

  it('still hands a 409 to the merge path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ currentHash: 'abc', reason: 'stale-lock' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )));
    const err = await saveFileContent('/w/doc.md', 'text').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileSaveConflictError);
    expect(classifyWriteFailure(err)).toBe('conflict');
  });
});

describe('offlineRetryDelay', () => {
  it('doubles from one second and stops at the ceiling', () => {
    expect([1, 2, 3, 4, 5].map(offlineRetryDelay)).toEqual([...OFFLINE_RETRY_DELAYS_MS]);
    expect(offlineRetryDelay(6)).toBe(16_000);
    expect(offlineRetryDelay(40)).toBe(16_000);
  });

  it('never waits less than the first step, even for a nonsense count', () => {
    expect(offlineRetryDelay(0)).toBe(1000);
    expect(offlineRetryDelay(-3)).toBe(1000);
  });

  it('spends a whole outage on a handful of requests', () => {
    // How many writes go out before the give-up line, if every one fails at once.
    let t = 0;
    let n = 1; // the write that discovered the outage
    while (!offlineGivesUp(0, t)) { t += offlineRetryDelay(n); n += 1; }
    expect(n).toBeLessThanOrEqual(9);
    expect(t).toBeGreaterThanOrEqual(LIVE_OFFLINE_GIVE_UP_MS);
    // Well within the window a deploy's restart needs to be covered by retries.
    expect(t).toBeLessThan(LIVE_OFFLINE_GIVE_UP_MS + 16_000);
  });
});

describe('offlineGivesUp', () => {
  it('holds on for the full minute, then stops', () => {
    expect(offlineGivesUp(1000, 1000)).toBe(false);
    expect(offlineGivesUp(1000, 1000 + LIVE_OFFLINE_GIVE_UP_MS - 1)).toBe(false);
    expect(offlineGivesUp(1000, 1000 + LIVE_OFFLINE_GIVE_UP_MS)).toBe(true);
  });
});

describe('the pause records why', () => {
  afterEach(() => clearLiveSuspensions());

  it('distinguishes an outage pause from a conflict pause for the same file', () => {
    suspendLiveEdit('clouddev', '/w/doc.md', 'unreachable');
    expect(isLiveSuspended('clouddev', '/w/doc.md')).toBe(true);
    expect(liveSuspensionReason('clouddev', '/w/doc.md')).toBe('unreachable');
    suspendLiveEdit('clouddev', '/w/doc.md');
    expect(liveSuspensionReason('clouddev', '/w/doc.md')).toBe('conflict');
    resumeLiveEdit('clouddev', '/w/doc.md');
    expect(liveSuspensionReason('clouddev', '/w/doc.md')).toBeNull();
  });

  it('pauses one host, not every host sharing the path', () => {
    suspendLiveEdit('clouddev', '/w/doc.md', 'unreachable');
    expect(liveSuspensionReason(undefined, '/w/doc.md')).toBeNull();
    expect(liveSuspensionReason('olddev', '/w/doc.md')).toBeNull();
  });
});

describe('what the user reads', () => {
  it('names the cause and the way out, never the browser error', () => {
    for (const text of [LIVE_UNREACHABLE_PAUSED_MESSAGE, SAVE_UNREACHABLE_MESSAGE]) {
      expect(text).toMatch(/Walnut/);
      expect(text).toMatch(/still in the editor/);
      expect(text).toMatch(/Save/);
      expect(text).not.toMatch(/Failed to fetch|Load failed|NetworkError/);
    }
    expect(LIVE_UNREACHABLE_PAUSED_MESSAGE).toMatch(/click Live to resume/);
  });
});
