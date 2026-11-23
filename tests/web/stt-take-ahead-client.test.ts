/**
 * The web recorder's side of hearing a take ahead (web/src/api/stt-take-ahead.ts):
 * one upload at a time, and a take that will not be heard is forgotten by the
 * server only after the upload on its way lands, so that upload cannot make the
 * take again (its audio kept on the server with no take to end it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TakeAhead, formatOfMime, APPEND_ANSWER, MISSES_MAX, START_OVER_MAX } from '@/api/stt-take-ahead';

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

  it('an upload that did not arrive (a restart\'s few seconds) is tried again at the next tick', async () => {
    const chunks = [new Blob([new Uint8Array(500)])];
    const t = take(chunks);
    const first = t.tick();
    await flush();
    calls[0]!.resolve(200, { size: 500 });
    await first;
    chunks.push(new Blob([new Uint8Array(300)]));
    // A restart's few seconds: no answer at all. The same bytes go again next time.
    const second = t.tick();
    await flush();
    calls[1]!.reject(new TypeError('Load failed'));
    await second;
    const third = t.tick();
    await flush();
    expect(calls[2]!.url).toContain('offset=500');
    calls[2]!.resolve(200, { size: 800 });
    await third;
    expect(t.finish()).toBe(t.takeId);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'POST']);
  });

  it('gives up after MISSES_MAX uploads in a row that did not arrive, and tells the server to forget the take', async () => {
    const t = take([new Blob([new Uint8Array(500)])]);
    for (let i = 0; i < MISSES_MAX; i++) {
      const up = t.tick();
      await flush();
      calls[i]!.reject(new Error('The operation timed out.'));
      await up;
    }
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual([...Array(MISSES_MAX).fill('POST'), 'DELETE']));
    // The stop then sends the whole clip without the take id.
    expect(t.finish()).toBeUndefined();
    await t.tick();
    expect(calls.length).toBe(MISSES_MAX + 1);
  });

  it('a take the server lost (404 after a restart) is sent again whole from byte 0, at once', async () => {
    const chunks = [new Blob([new Uint8Array(500)])];
    const t = take(chunks);
    const first = t.tick();
    await flush();
    calls[0]!.resolve(200, { size: 500 });
    await first;
    chunks.push(new Blob([new Uint8Array(300)]));
    const second = t.tick();
    await flush();
    calls[1]!.resolve(404, { error: 'Unknown take' });
    await vi.waitFor(() => expect(calls.length).toBe(3));
    expect(calls[2]!.url).toContain('offset=0&');
    calls[2]!.resolve(200, { size: 800 });
    await second;
    expect(t.finish()).toBe(t.takeId);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'POST']);
  });

  it('a stop while a start-over is on its way: the whole clip goes without the id, and the take it makes is deleted', async () => {
    const chunks = [new Blob([new Uint8Array(500)])];
    const t = take(chunks);
    const first = t.tick();
    await flush();
    calls[0]!.resolve(200, { size: 500 });
    await first;
    chunks.push(new Blob([new Uint8Array(300)]));
    const second = t.tick();
    await flush();
    calls[1]!.resolve(404, { error: 'Unknown take' });
    await vi.waitFor(() => expect(calls.length).toBe(3));
    expect(t.finish()).toBeUndefined();
    // Not before the upload lands: it would make the take again after the delete.
    await flush();
    expect(calls.length).toBe(3);
    calls[2]!.resolve(200, { size: 800 });
    await second;
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'POST', 'DELETE']));
  });

  it('a busy server (503), a gateway error (502) and a boot page (200 without a size) are tried again; a 409 resyncs', async () => {
    const t = take([new Blob([new Uint8Array(500)])]);
    const answers: Array<[number, unknown]> = [[503, { error: 'Too many takes being stopped at once' }], [502, {}], [200, '<html>']];
    for (const [i, [status, body]] of answers.entries()) {
      const up = t.tick();
      await flush();
      calls[i]!.resolve(status, body);
      await up;
    }
    // A timed-out upload the server did receive: the next answer says where it stands.
    const up = t.tick();
    await flush();
    calls[3]!.resolve(409, { error: 'Offset does not match the take', size: 500 });
    await up;
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'POST', 'POST']);
    expect(t.finish()).toBe(t.takeId);
  });

  it('a take lost again and again (one restart after another) starts over at most START_OVER_MAX times, then gives up', async () => {
    const t = take([new Blob([new Uint8Array(500)])]);
    const up = t.tick();
    for (let i = 0; i <= START_OVER_MAX; i++) {
      await vi.waitFor(() => expect(calls.length).toBe(i + 1));
      calls[i]!.resolve(404, { error: 'Unknown take' });
    }
    await up;
    await vi.waitFor(() => expect(calls.map((c) => c.method).at(-1)).toBe('DELETE'));
    expect(calls.length).toBe(START_OVER_MAX + 2);
    expect(t.finish()).toBeUndefined();
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

  it('guard: every answer the append route can give has a named client action', () => {
    // The class: an answer the client did not plan for stops hearing ahead, and a long take's
    // stop waits for the whole clip. Read the server's own list of answers.
    const src = readFileSync(join(__dirname, '../../src/core/stt/take-ahead.ts'), 'utf8');
    const union = /status:\s*((?:\d{3}\s*\|\s*)*\d{3});\s*error/.exec(src);
    expect(union, 'AppendOutcome status union in take-ahead.ts').toBeTruthy();
    const statuses = union![1]!.split('|').map((x) => Number(x.trim()));
    expect(statuses.length).toBeGreaterThan(3);
    for (const status of statuses) expect(APPEND_ANSWER[status], `client action for ${status}`).toBeDefined();
    // A lost take must be sent again, never given up on.
    expect(APPEND_ANSWER[404]).toBe('start-over');
  });
});

