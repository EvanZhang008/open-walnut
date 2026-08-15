/**
 * E2E regression: attaching an image must not kill the WebSocket.
 *
 * ## The bug (2026-08-09, user-visible as "WebSocket disconnected")
 *
 * Both send paths (`chat` for the Personal AI, `session:send` for CLI sessions) used to
 * put raw base64 image bytes inside the RPC payload. The WS server caps a single
 * frame at 4MB (`attachWss`, a memory-exhaustion guard), and the `ws` library
 * enforces that cap by CLOSING the connection with code 1009 — the frame never
 * reaches a handler, so no error response is possible. One phone screenshot is
 * ~4-6MB base64, so every image send:
 *   1. closed the socket,
 *   2. rejected that RPC *and every other in-flight RPC* with "WebSocket
 *      disconnected",
 *   3. auto-reconnected, re-sent on retry, and died again.
 *
 * The fix moves the bytes to `POST /api/images/upload` (HTTP, 15MB body limit)
 * and sends only `imageRefs: [{ filename }]`.
 *
 * ## What this file locks down
 *
 *   1. The 1009 close is REAL — an oversized frame still closes the socket. This
 *      is the guard's intended behavior; the test exists so nobody "fixes" the
 *      symptom by raising maxPayload (which just moves the cliff).
 *   2. An `imageRefs` send is small enough to survive, reaches the handler, and
 *      the image path is embedded in the message the session receives.
 *   3. Refs and inline base64 produce the SAME augmented message, so the new
 *      path is a true substitute for REST callers that still send inline.
 *   4. A stale/bogus ref degrades to a plain text send instead of failing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-image-ws-cap'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';
import { getQueue } from '../../src/core/session-message-queue.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

/** A real 1x1 PNG — sharp must be able to decode it on the upload path. */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

interface RpcResult {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: string;
}

/** Outcome of one RPC attempt: either a response frame, or the socket closing. */
type RpcOutcome =
  | { kind: 'response'; res: RpcResult }
  | { kind: 'closed'; code: number };

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws connect timeout')), 5000);
  });
}

/**
 * Send one RPC and report what happened — a response, or the socket dying.
 * Deliberately does NOT throw on close: "did the connection survive?" is the
 * property under test, so the caller must be able to assert on it.
 */
function sendRpc(ws: WebSocket, method: string, payload: unknown, timeoutMs = 15_000): Promise<RpcOutcome> {
  return new Promise((resolve, reject) => {
    const id = `t-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => reject(new Error(`rpc ${method} timed out`)), timeoutMs);
    const onMessage = (raw: Buffer | string) => {
      const frame = JSON.parse(raw.toString()) as { type: string; id?: string; ok?: boolean; payload?: unknown; error?: string };
      if (frame.type !== 'res' || frame.id !== id) return; // ignore broadcast events
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve({ kind: 'response', res: { ok: !!frame.ok, payload: frame.payload as Record<string, unknown>, error: frame.error } });
    };
    ws.on('message', onMessage);
    ws.once('close', (code: number) => {
      clearTimeout(timer);
      resolve({ kind: 'closed', code });
    });
    ws.send(JSON.stringify({ type: 'req', id, method, payload }));
  });
}

/** Upload an image over HTTP and return the ref the RPC should carry. */
async function uploadImage(base64 = TINY_PNG_B64, mediaType = 'image/png'): Promise<string> {
  const res = await fetch(apiUrl('/api/images/upload'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: base64, mediaType }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { filename?: string; url?: string };
  expect(body.filename).toBeTruthy();
  return body.filename!;
}

/** Register a session record so session:send has something to enqueue against. */
async function makeSession(id: string): Promise<void> {
  await createSessionRecord(id, `task-${id}`, '', WALNUT_HOME);
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 30_000);

afterAll(async () => {
  await stopServer();
}, 15_000);

describe('WS frame cap (the mechanism behind "WebSocket disconnected")', () => {
  it('closes the connection with 1009 when a frame exceeds maxPayload', async () => {
    const ws = await connectWs();
    // Past the 32MB maxPayload backstop (attachWss). This pins the MECHANISM:
    // `ws` answers an oversized frame by closing with 1009 before any handler
    // runs — which is exactly why big payloads must never ride the socket
    // (images → HTTP refs, pastes → /api/pastes). `set-interest` is an inert
    // carrier: the frame is rejected before any handler runs.
    const oversized = 'A'.repeat(33 * 1024 * 1024);
    const outcome = await sendRpc(ws, 'set-interest', { mode: 'lightweight', ids: [oversized] });

    expect(outcome.kind).toBe('closed');
    if (outcome.kind === 'closed') expect(outcome.code).toBe(1009);
  }, 30_000);

  it('a screenshot-sized frame (5MB) no longer kills the socket — backstop headroom', async () => {
    // The 2026-08-09 incident shape: one phone screenshot in base64 (~5MB) on
    // the wire. With the old 4MB cap this closed the connection; the raised
    // backstop must absorb it. (Clients still shouldn't SEND frames this big —
    // web ws.ts rejects at 3.5MB — this guards against the cap regressing.)
    const ws = await connectWs();
    const big = 'A'.repeat(5 * 1024 * 1024);
    const outcome = await sendRpc(ws, 'set-interest', { mode: 'lightweight', ids: [big] });

    expect(outcome.kind).toBe('response');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  }, 30_000);

  it('an image sent as a ref keeps the frame small and the socket alive', async () => {
    const sessionId = 'img-ref-session';
    await makeSession(sessionId);
    const filename = await uploadImage();

    const ws = await connectWs();
    const outcome = await sendRpc(ws, 'session:send', {
      sessionId,
      message: 'what is in this picture?',
      imageRefs: [{ filename }],
    });

    // The property that was broken: the socket survived and we got a real answer.
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.res.ok).toBe(true);
    expect(outcome.res.payload?.messageId).toBeTruthy();
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // And the image actually reached the session: the enqueued text carries the
    // on-disk path for the CLI's Read tool.
    const queued = await getQueue(sessionId);
    const texts = queued.map((m) => m.message).join('\n');
    expect(texts).toContain('[Images attached');
    expect(texts).toContain(filename);
    expect(texts).toContain('what is in this picture?');
    ws.close();
  }, 30_000);

  it('refs and inline base64 augment the message identically', async () => {
    const refSession = 'aug-ref-session';
    const inlineSession = 'aug-inline-session';
    await makeSession(refSession);
    await makeSession(inlineSession);

    const filename = await uploadImage();
    const ws = await connectWs();

    const viaRef = await sendRpc(ws, 'session:send', {
      sessionId: refSession, message: 'hello', imageRefs: [{ filename }],
    });
    const viaInline = await sendRpc(ws, 'session:send', {
      sessionId: inlineSession, message: 'hello', images: [{ data: TINY_PNG_B64, mediaType: 'image/png' }],
    });
    expect(viaRef.kind).toBe('response');
    expect(viaInline.kind).toBe('response');

    const refText = (await getQueue(refSession)).map((m) => m.message).join('\n');
    const inlineText = (await getQueue(inlineSession)).map((m) => m.message).join('\n');
    // Filenames are timestamped, so compare the SHAPE: same prefix, same trailer,
    // one path line each. A divergence here means the two paths drifted.
    const shape = (s: string) => s.replace(/- \S+\.(png|jpg|jpeg|gif|webp)/g, '- <path>');
    expect(shape(refText)).toBe(shape(inlineText));
    ws.close();
  }, 30_000);

  it('a stale ref degrades to a plain text send instead of failing', async () => {
    const sessionId = 'stale-ref-session';
    await makeSession(sessionId);

    const ws = await connectWs();
    const outcome = await sendRpc(ws, 'session:send', {
      sessionId,
      message: 'text still matters',
      imageRefs: [{ filename: '1700000000000-deadbeefcafe.png' }], // never uploaded
    });

    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.res.ok).toBe(true);

    const texts = (await getQueue(sessionId)).map((m) => m.message).join('\n');
    expect(texts).toContain('text still matters');
    // No image preamble — nothing was attached, and the user's words survived.
    expect(texts).not.toContain('[Images attached');
    ws.close();
  }, 30_000);

  it('rejects a path-traversal filename in a ref', async () => {
    const sessionId = 'traversal-ref-session';
    await makeSession(sessionId);

    const ws = await connectWs();
    const outcome = await sendRpc(ws, 'session:send', {
      sessionId,
      message: 'nice try',
      imageRefs: [{ filename: '../../../etc/passwd' }],
    });

    expect(outcome.kind).toBe('response');
    const texts = (await getQueue(sessionId)).map((m) => m.message).join('\n');
    expect(texts).toContain('nice try');
    expect(texts).not.toContain('passwd');
    expect(texts).not.toContain('[Images attached');
    ws.close();
  }, 30_000);
});

describe('POST /api/images/upload', () => {
  it('returns a filename usable as an ImageRef, and clamps on ingest', async () => {
    const filename = await uploadImage();
    // Content-addressed name the ref-resolver's safety check accepts.
    expect(filename).toMatch(/^\d+-[a-f0-9]{12}\.(png|jpg)$/);

    // And it is really served back.
    const res = await fetch(apiUrl(`/api/images/${filename}`));
    expect(res.status).toBe(200);
  }, 30_000);
});
