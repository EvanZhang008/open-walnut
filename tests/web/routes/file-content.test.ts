import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import { fileContentRouter } from '../../../src/web/routes/file-content.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use('/api/file-content', fileContentRouter);
  app.use(errorHandler);
  return app;
}

let tmpDir: string;
let videoPath: string;
let videoBytes: Buffer;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-fc-test-'));
  // Fake "video": arbitrary binary bytes incl. NULs — content doesn't matter,
  // only that byte windows come back exact.
  videoBytes = Buffer.alloc(4096);
  for (let i = 0; i < videoBytes.length; i++) videoBytes[i] = i % 251;
  videoPath = path.join(tmpDir, 'demo.mp4');
  await fs.writeFile(videoPath, videoBytes);
  await fs.writeFile(path.join(tmpDir, 'page.html'), '<h1>hi</h1>\n');
  await fs.writeFile(path.join(tmpDir, 'notes.txt'), 'hello walnut\n');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('GET /api/file-content raw media (local)', () => {
  it('serves full video with video/mp4 Content-Type and Accept-Ranges', async () => {
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: videoPath, raw: '1' })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(videoBytes.length));
    expect(Buffer.compare(res.body as Buffer, videoBytes)).toBe(0);
  });

  it('serves an exact byte window for a Range request (206)', async () => {
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: videoPath, raw: '1' })
      .set('Range', 'bytes=100-199')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 100-199/${videoBytes.length}`);
    expect(res.headers['content-length']).toBe('100');
    expect(Buffer.compare(res.body as Buffer, videoBytes.subarray(100, 200))).toBe(0);
  });

  it("answers Safari's bytes=0-1 probe with exactly 2 bytes", async () => {
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: videoPath, raw: '1' })
      .set('Range', 'bytes=0-1')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(206);
    expect(res.headers['content-length']).toBe('2');
    expect((res.body as Buffer).length).toBe(2);
  });

  it('clamps an open-ended range (bytes=4000-) to EOF', async () => {
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: videoPath, raw: '1' })
      .set('Range', 'bytes=4000-');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 4000-4095/${videoBytes.length}`);
    expect(res.headers['content-length']).toBe('96');
  });

  it('returns 416 for an out-of-range start', async () => {
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: videoPath, raw: '1' })
      .set('Range', 'bytes=999999-');

    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${videoBytes.length}`);
  });

  it('404s a missing media file', async () => {
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: path.join(tmpDir, 'nope.mp4'), raw: '1' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/file-content download=1', () => {
  it('sets Content-Disposition attachment for media', async () => {
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: videoPath, raw: '1', download: '1' });

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="demo.mp4"');
  });

  it('downloads a non-media file as octet-stream attachment', async () => {
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: path.join(tmpDir, 'notes.txt'), raw: '1', download: '1' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment; filename="notes.txt"');
    expect(res.text ?? res.body.toString()).toContain('hello walnut');
  });
});

describe('GET /api/file-content raw regressions', () => {
  it('still serves HTML raw with text/html (iframe preview path)', async () => {
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: path.join(tmpDir, 'page.html'), raw: '1' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<h1>hi</h1>');
  });

  it('rejects directory traversal for media too', async () => {
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: tmpDir + '/../demo.mp4', raw: '1' });
    expect(res.status).toBe(400);
  });

  it('JSON path still flags binary files (non-raw)', async () => {
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: videoPath });
    expect(res.status).toBe(200);
    expect(res.body.binary).toBe(true);
    expect(res.body.content).toBeNull();
  });
});
