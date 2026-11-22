/**
 * The web recorder's side of hearing a take ahead (web/src/api/stt-take-ahead.ts):
 * one upload at a time, and a take that will not be heard is forgotten by the
 * server only after the upload on its way lands, so that upload cannot make the
 * take again (its audio kept on the server with no take to end it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TakeAhead, formatOfMime } from '@/api/stt-take-ahead';

interface Call { url: string; method: string; resolve: (status: number, body: unknown) => void; reject: (err: Error) => void }

let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    calls.push({
      url, method: init?.method ?? 'GET',
      resolve: (status, body) => resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
      reject,
    });
  })));
});
afterEach(() => { vi.unstubAllGlobals(); });

const flush = () => new Promise((r) => setTimeout(r, 0));

function take(chunks: Blob[]) {
  return new TakeAhead(() => chunks, () => 'audio/webm;codecs=opus', () => undefined, 60 * 60_000);
}

describe('TakeAhead', () => {
  it('a drop while the first part is on its way deletes the take after that part lands', async () => {
    const t = take([new Blob([new Uint8Array(1000)])]);
    const uploading = t.tick();
    await flush();
    expect(calls.map((c) => c.method)).toEqual(['POST']);
    const dropping = t.drop();
    await flush();
    // Not before the part lands: it would make the take again after the delete.
    expect(calls.length).toBe(1);
    calls[0]!.resolve(200, { size: 1000 });
    await uploading;
    await dropping;
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      expect.stringMatching(/^POST \/api\/stt\/takes\/[0-9a-f]+\/append\?offset=0&format=webm$/),
      `DELETE /api/stt/takes/${t.takeId}`,
    ]);
  });

  it('gives up on a failed upload and tells the server to forget the take', async () => {
    const t = take([new Blob([new Uint8Array(500)])]);
    const uploading = t.tick();
    await flush();
    calls[0]!.reject(new Error('The operation timed out.'));
    await uploading;
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']));
    // The stop then sends the whole clip without the take id.
    expect(t.finish()).toBeUndefined();
    await t.tick();
    expect(calls.length).toBe(2);
  });

  it('a refused part (the server stopped hearing it ahead) also forgets the take', async () => {
    const t = take([new Blob([new Uint8Array(500)])]);
    const uploading = t.tick();
    await flush();
    calls[0]!.resolve(410, { error: 'Take is no longer heard ahead' });
    await uploading;
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']));
  });

  it('a take that never uploaded is dropped without a request, and drops once', async () => {
    const t = take([]);
    await t.drop();
    await t.drop();
    expect(calls).toEqual([]);
  });

  it('the stop names the take only when the server holds part of it', async () => {
    const t = take([new Blob([new Uint8Array(800)])]);
    const uploading = t.tick();
    await flush();
    calls[0]!.resolve(200, { size: 800 });
    await uploading;
    expect(t.finish()).toBe(t.takeId);
  });

  it('names the format the server takes for each recorder', () => {
    expect(formatOfMime('audio/webm;codecs=opus')).toBe('webm');
    expect(formatOfMime('audio/mp4')).toBe('mp4');
    expect(formatOfMime('audio/ogg;codecs=opus')).toBe('ogg');
    expect(formatOfMime('')).toBe('webm');
  });
});
