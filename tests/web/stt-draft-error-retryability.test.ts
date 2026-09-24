/**
 * A draft rejection has to say whether re-sending the SAME bytes could ever
 * work. The 2026-09-01 incident retried a 413 every 2 seconds for as long as the
 * user kept talking, because `draftTranscribe` threw a generic Error and the
 * loop had nothing to branch on.
 *
 * fetch is mocked — this test never touches the network or a microphone.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { draftTranscribe, SttDraftError, isRetryableDraftFailure } from '../../web/src/api/stt.js';

const realFetch = globalThis.fetch;

/** Minimal Response stand-in: only the fields draftTranscribe reads. */
function reply(status: number, body: unknown = { error: 'nope' }): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function mockFetch(res: Response | Error) {
  globalThis.fetch = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function failureOf(res: Response | Error): Promise<unknown> {
  mockFetch(res);
  try {
    await draftTranscribe('AAAA', 'wav');
    throw new Error('expected draftTranscribe to reject');
  } catch (err) {
    return err;
  }
}

describe('draftTranscribe — payload rejections are NOT retryable', () => {
  it.each([413, 415, 422])('%i → retryable false', async (status) => {
    const err = await failureOf(reply(status));
    expect(err).toBeInstanceOf(SttDraftError);
    expect((err as SttDraftError).status).toBe(status);
    expect((err as SttDraftError).retryable).toBe(false);
    expect(isRetryableDraftFailure(err)).toBe(false);
  });

  it('carries the server error text so the log names the cause', async () => {
    const err = await failureOf(reply(413, { error: 'Draft audio too large', code: 'draft_too_large' }));
    expect((err as Error).message).toContain('413');
    expect((err as Error).message).toContain('Draft audio too large');
  });

  it('still rejects cleanly when the body is not JSON', async () => {
    const notJson = {
      ok: false, status: 413,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    } as unknown as Response;
    const err = await failureOf(notJson);
    expect(err).toBeInstanceOf(SttDraftError);
    expect((err as SttDraftError).retryable).toBe(false);
  });
});

describe('draftTranscribe — transient failures ARE retryable', () => {
  it.each([500, 502, 503, 429])('%i → retryable true', async (status) => {
    const err = await failureOf(reply(status));
    expect(err).toBeInstanceOf(SttDraftError);
    expect((err as SttDraftError).retryable).toBe(true);
    expect(isRetryableDraftFailure(err)).toBe(true);
  });

  it('treats a timeout / aborted request as retryable', async () => {
    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    const err = await failureOf(timeout);
    expect(err).toBe(timeout);
    expect(isRetryableDraftFailure(err)).toBe(true);
  });

  it('treats a dropped connection as retryable', async () => {
    const err = await failureOf(new TypeError('Failed to fetch'));
    expect(isRetryableDraftFailure(err)).toBe(true);
  });
});

describe('draftTranscribe — the success shape is unchanged', () => {
  it('resolves { text, durationMs }', async () => {
    mockFetch(reply(200, { text: '\u4f60\u597d world', durationMs: 42 })); // CJK "hello"
    await expect(draftTranscribe('AAAA', 'wav', 'zh')).resolves.toEqual({ text: '\u4f60\u597d world', durationMs: 42 }); // CJK "hello"
  });
});
