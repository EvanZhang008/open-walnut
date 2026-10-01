/**
 * POST /api/stt/setup streams progress LIVE through the compression middleware.
 *
 * The bug (real new-user test, 2026-09-30): the route did not opt out of
 * `compression`, so with a browser's Accept-Encoding the response went out as
 * `Content-Encoding: br` and every progress event sat in the encoder until
 * res.end(). A 148 MB model finished with 137 body bytes delivered, all at the
 * end; the bar stayed at 0% for the whole 1.6 GB Large v3 Turbo download.
 *
 * The app here mounts the SAME compression middleware server.ts does, and the
 * download generator is a stub that will not finish until the test has SEEN
 * its first progress event: a buffered response can only time out.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Server } from 'node:http';
import http from 'node:http';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

let release: () => void = () => {};
let seenSignal: AbortSignal | undefined;
let finished = false;
let brewFinished = false;

vi.mock('../../../src/core/stt/setup.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/stt/setup.js')>();
  return {
    ...real,
    // Takes no signal, like the real one: a brew install is never killed halfway.
    async *installViaBrew(pkg: string) {
      yield { type: 'progress', percent: 5, message: `brew install ${pkg}` };
      await new Promise<void>((resolve) => { release = resolve; });
      yield { type: 'progress', percent: 90, message: `Installing ${pkg}...` };
      brewFinished = true;
      yield { type: 'done', message: `${pkg} installed` };
    },
    async *downloadGgmlModel(_url: string, _dir: string, _file: string, opts: { signal?: AbortSignal } = {}) {
      seenSignal = opts.signal;
      yield { type: 'progress', percent: 1, message: '16.0 / 1600 MB' };
      await new Promise<void>((resolve) => {
        release = resolve;
        opts.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      if (opts.signal?.aborted) return;
      yield { type: 'progress', percent: 50, message: '800.0 / 1600 MB' };
      finished = true;
      yield { type: 'done', message: 'downloaded', path: '/tmp/x.bin' };
    },
  };
});

import express from 'express';
import compression from 'compression';

const { sttRouter } = await import('../../../src/web/routes/stt.js');

let server: Server | null = null;

function listen(): Promise<number> {
  const app = express();
  // Exactly the production middleware (src/web/server.ts): 1KB threshold, env-gated.
  app.use(compression({ threshold: 1024 }));
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/stt', sttRouter);
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port));
  });
}

afterEach(async () => {
  release();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  seenSignal = undefined;
  finished = false;
  brewFinished = false;
});

/** POST with a browser's Accept-Encoding and read the RAW bytes (no decoding). */
function post(port: number, body: unknown, onChunk: (text: string) => void): { res: Promise<http.IncomingMessage>; ended: Promise<void>; req: http.ClientRequest } {
  const payload = JSON.stringify(body);
  let resolveRes!: (r: http.IncomingMessage) => void;
  let resolveEnd!: () => void;
  const res = new Promise<http.IncomingMessage>((r) => { resolveRes = r; });
  const ended = new Promise<void>((r) => { resolveEnd = r; });
  const req = http.request({
    host: '127.0.0.1', port, path: '/api/stt/setup', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Accept-Encoding': 'gzip, deflate, br' },
  }, (r) => {
    resolveRes(r);
    r.on('data', (c: Buffer) => onChunk(c.toString('utf-8')));
    r.on('end', () => resolveEnd());
    r.on('close', () => resolveEnd());
  });
  req.on('error', () => resolveEnd());
  req.end(payload);
  return { res, ended, req };
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms))]);
}

describe('POST /api/stt/setup through compression', () => {
  it('is never compressed, and the first progress event arrives while the download is still running', async () => {
    const port = await listen();
    let text = '';
    let firstChunk!: () => void;
    const gotFirst = new Promise<void>((r) => { firstChunk = r; });
    const { res, ended } = post(port, { action: 'download_ggml_model', model: 'ggml-large-v3-turbo' }, (t) => {
      text += t;
      if (text.includes('"type":"progress"')) firstChunk();
    });

    const r = await within(res, 10_000, 'response headers');
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.headers['content-type']).toMatch(/text\/event-stream/);
    expect(String(r.headers['cache-control'])).toMatch(/no-transform/);
    expect(r.headers['x-accel-buffering']).toBe('no');

    // The stub is parked until we release it: this only resolves if the event was flushed.
    await within(gotFirst, 10_000, 'the first progress event (a buffered stream never delivers it)');
    expect(finished).toBe(false);
    expect(text).toContain('data: {"type":"progress","percent":1,"message":"16.0 / 1600 MB"}\n\n');

    release();
    await within(ended, 10_000, 'the end of the stream');
    expect(text).toContain('"type":"done"');
    expect(seenSignal?.aborted).toBe(false);
  });

  it('stops the download when the client goes away mid-stream', async () => {
    const port = await listen();
    let firstChunk!: () => void;
    const gotFirst = new Promise<void>((r) => { firstChunk = r; });
    const { req } = post(port, { action: 'download_ggml_model', model: 'ggml-large-v3-turbo' }, (t) => {
      if (t.includes('"type":"progress"')) firstChunk();
    });
    await within(gotFirst, 10_000, 'the first progress event');
    expect(seenSignal?.aborted).toBe(false);

    req.destroy(); // the tab closed
    await vi.waitFor(() => expect(seenSignal?.aborted).toBe(true), { timeout: 10_000 });
    expect(finished).toBe(false);
  });

  it('lets a brew install finish after the client goes away (a half-linked keg is worse)', async () => {
    const port = await listen();
    let firstChunk!: () => void;
    const gotFirst = new Promise<void>((r) => { firstChunk = r; });
    const { req } = post(port, { action: 'install_brew_pkg', pkg: 'uv' }, (t) => {
      if (t.includes('"type":"progress"')) firstChunk();
    });
    await within(gotFirst, 10_000, 'the first progress event');
    req.destroy();
    // Give the route time to see the close; a break here would return() the install.
    await new Promise((r) => setTimeout(r, 200));
    release();
    await vi.waitFor(() => expect(brewFinished).toBe(true), { timeout: 10_000 });
  });

  it('rejects unknown packages and models as an error event, and allows uv', async () => {
    const port = await listen();
    const run = async (body: unknown) => {
      let text = '';
      const { ended } = post(port, body, (t) => { text += t; });
      await within(ended, 10_000, 'the stream');
      return text;
    };
    expect(await run({ action: 'install_brew_pkg', pkg: 'wget' })).toContain('Package not allowed: wget');
    expect(await run({ action: 'download_mlx_model', model: 'someone/else' })).toContain('Model not allowed: someone/else');
    expect(await run({ action: 'nope' })).toContain('Unknown action: nope');
    const { BREW_PACKAGES } = await import('../../../src/core/stt/setup.js');
    expect([...BREW_PACKAGES].sort()).toEqual(['ffmpeg', 'uv', 'whisper-cpp']);
  });
});
