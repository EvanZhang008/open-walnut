/**
 * REGRESSION: "WebSocket disconnected" whenever the user attached an image
 * (2026-08-09).
 *
 * The server caps a WS frame at 4MB and the `ws` library enforces that by
 * CLOSING the socket with code 1009 — the frame never reaches a handler, so the
 * client cannot be told what went wrong. The old send path put raw base64 image
 * bytes in the RPC payload (~4-6MB for one phone screenshot), so an image send
 * killed the socket, failed every in-flight RPC with "WebSocket disconnected",
 * reconnected, retried, and died again.
 *
 * Two client-side guarantees are pinned here:
 *   1. `dispatchRpc` refuses an oversized frame LOCALLY (rejects that one RPC)
 *      instead of handing the socket a suicide pill.
 *   2. Byte length is measured as ENCODED bytes, not string length — the user's
 *      messages are Chinese, where one char is 3 UTF-8 bytes, so a
 *      `.length`-based check would under-count by ~3x and let the frame through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Frames the fake socket accepted, so the test can assert nothing was sent. */
let sent: string[] = [];
let fakeSocket: { readyState: number; send: (b: string) => void; close: () => void; onopen: null; onclose: null; onerror: null; onmessage: null };

beforeEach(() => {
  vi.resetModules();
  sent = [];
  fakeSocket = {
    readyState: 1, // OPEN
    send: (b: string) => { sent.push(b); },
    close: () => {},
    onopen: null, onclose: null, onerror: null, onmessage: null,
  };
  // Minimal WebSocket stand-in: the client only needs OPEN + send().
  const FakeWebSocket = function () { return fakeSocket; } as unknown as typeof WebSocket;
  (FakeWebSocket as unknown as { OPEN: number }).OPEN = 1;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost:3456' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Load a fresh wsClient and force it into the connected state. */
async function connectedClient() {
  const { wsClient } = await import('@/api/ws');
  wsClient.connect();
  // connect() assigned our fake socket; drive it to OPEN so sendRpc dispatches.
  (fakeSocket as unknown as { onopen?: () => void }).onopen?.();
  return wsClient;
}

describe('WS oversized-frame guard', () => {
  it('rejects a frame over the cap instead of letting the server close the socket', async () => {
    const wsClient = await connectedClient();
    // 5MB of base64 — a real phone screenshot, and exactly what the old image
    // send path put on the wire.
    const oversized = 'A'.repeat(5 * 1024 * 1024);

    await expect(wsClient.sendRpc('session:send', { sessionId: 's1', images: [{ data: oversized }] }))
      .rejects.toThrow(/too large/i);

    // The socket must be untouched — that is the whole point.
    expect(sent).toHaveLength(0);
    expect(fakeSocket.readyState).toBe(1);
  });

  it('counts UTF-8 bytes, not string length (Chinese text is 3 bytes/char)', async () => {
    const wsClient = await connectedClient();
    // 1.5M chars => ~1.4MB by `.length` (would pass a naive check) but ~4.5MB
    // encoded (must be rejected).
    const chinese = '中'.repeat(1_500_000);

    await expect(wsClient.sendRpc('session:send', { sessionId: 's1', message: chinese }))
      .rejects.toThrow(/too large/i);
    expect(sent).toHaveLength(0);
  });

  it('a normal-sized RPC still goes out untouched', async () => {
    const wsClient = await connectedClient();
    // Don't await: the response never arrives (no fake server), we only care
    // that the frame was written.
    void wsClient.sendRpc('session:send', { sessionId: 's1', message: '发张图片看看' });

    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]) as { type: string; method: string; payload: { message: string } };
    expect(frame.type).toBe('req');
    expect(frame.method).toBe('session:send');
    expect(frame.payload.message).toBe('发张图片看看');
  });
});

describe('image attachments never ride the WS payload', () => {
  it('buildImageRefsPayload emits refs (filenames), not base64 bytes', async () => {
    const uploaded: Array<Record<string, unknown>> = [];
    vi.doMock('@/api/client', () => ({
      apiPost: async (_path: string, body: Record<string, unknown>) => {
        uploaded.push(body);
        return { filename: '1786000000000-abcdef123456.png', mediaType: 'image/png' };
      },
    }));
    const { buildImageRefsPayload } = await import('@/api/image-upload');

    const bigBase64 = 'B'.repeat(4 * 1024 * 1024);
    const payload = await buildImageRefsPayload([
      { data: bigBase64, mediaType: 'image/png', name: 'screenshot.png' },
    ]);

    // The bytes went over HTTP…
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].data).toBe(bigBase64);
    // …and the WS payload is a tiny ref.
    expect(payload.imageRefs).toEqual([{ filename: '1786000000000-abcdef123456.png' }]);
    expect(JSON.stringify(payload).length).toBeLessThan(200);
  });

  it('no attachments → no imageRefs key (payload shape unchanged)', async () => {
    vi.doMock('@/api/client', () => ({ apiPost: async () => ({ filename: 'x.png' }) }));
    const { buildImageRefsPayload } = await import('@/api/image-upload');

    expect(await buildImageRefsPayload(undefined)).toEqual({});
    expect(await buildImageRefsPayload([])).toEqual({});
  });

  it('a failed upload rejects, so the caller keeps the user text + images', async () => {
    vi.doMock('@/api/client', () => ({
      apiPost: async () => { throw new Error('413 Image too large'); },
    }));
    const { buildImageRefsPayload } = await import('@/api/image-upload');

    await expect(buildImageRefsPayload([{ data: 'x', mediaType: 'image/png', name: 'a.png' }]))
      .rejects.toThrow(/413/);
  });

  it('falls back to the url tail when an older server omits filename', async () => {
    vi.doMock('@/api/client', () => ({
      apiPost: async () => ({ url: '/api/images/1786000000001-fedcba654321.jpg' }),
    }));
    const { buildImageRefsPayload } = await import('@/api/image-upload');

    const payload = await buildImageRefsPayload([{ data: 'x', mediaType: 'image/jpeg', name: 'a.jpg' }]);
    expect(payload.imageRefs).toEqual([{ filename: '1786000000001-fedcba654321.jpg' }]);
  });
});
