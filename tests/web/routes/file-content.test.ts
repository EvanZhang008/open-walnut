import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import { WALNUT_HOME } from '../../../src/constants.js';
import { fileContentRouter, isSecretPath } from '../../../src/web/routes/file-content.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
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
  // PDF/image bodies are never parsed here — only the Content-Type + byte
  // fidelity matter, since the BROWSER's own viewer does the rendering.
  await fs.writeFile(path.join(tmpDir, 'report.pdf'), videoBytes);
  await fs.writeFile(path.join(tmpDir, 'shot.png'), videoBytes);
  await fs.writeFile(path.join(tmpDir, 'photo.HEIC'), videoBytes);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('file-content secret paths', () => {
  it('denies every file under the Plugin secret store', () => {
    expect(isSecretPath(path.join(WALNUT_HOME, 'secrets', 'plugins', 'sample.json'))).toBe(true);
  });
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

describe('GET /api/file-content raw docs + images (browser-native viewers)', () => {
  // These are the whole point of the change: a PDF must arrive as
  // application/pdf so Chrome/Firefox render it with their built-in viewer,
  // NOT as text/plain (which shows mojibake) and NOT via the JSON payload
  // (which would text-decode binary bytes).
  it('serves a PDF as application/pdf with Range support', async () => {
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: path.join(tmpDir, 'report.pdf'), raw: '1' })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-disposition']).toBeUndefined(); // inline, not a download
    expect(Buffer.compare(res.body as Buffer, videoBytes)).toBe(0);
  });

  it('serves a PNG as image/png with exact bytes', async () => {
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: path.join(tmpDir, 'shot.png'), raw: '1' })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(res.body as Buffer, videoBytes)).toBe(0);
  });

  it('matches the extension case-insensitively (.HEIC)', async () => {
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: path.join(tmpDir, 'photo.HEIC'), raw: '1' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/heic');
  });

  it('a PDF Range request still comes back 206 byte-exact', async () => {
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: path.join(tmpDir, 'report.pdf'), raw: '1' })
      .set('Range', 'bytes=10-19')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 10-19/${videoBytes.length}`);
    expect(Buffer.compare(res.body as Buffer, videoBytes.subarray(10, 20))).toBe(0);
  });

  it('svg stays on the TEXT path (it is text — source/preview toggle is useful)', async () => {
    await fs.writeFile(path.join(tmpDir, 'icon.svg'), '<svg></svg>');
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: path.join(tmpDir, 'icon.svg'), raw: '1' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
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

describe('GET /api/file-content contentHash (the editor lock token)', () => {
  it('hands back a contentHash for a whole text read', async () => {
    const res = await request(createApp())
      .get('/api/file-content')
      .query({ path: path.join(tmpDir, 'notes.txt') });
    expect(res.status).toBe(200);
    expect(res.body.contentHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('OMITS contentHash for a truncated read — which is what keeps the editor read-only', async () => {
    // >512 KB so the read truncates. Hashing the served prefix would let a save
    // round-trip it back over the whole file and delete the tail.
    const bigPath = path.join(tmpDir, 'big.txt');
    await fs.writeFile(bigPath, 'x'.repeat(600 * 1024));
    const res = await request(createApp()).get('/api/file-content').query({ path: bigPath });
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.contentHash).toBeUndefined();
  });

  it('omits contentHash for a binary file (never editable)', async () => {
    const res = await request(createApp()).get('/api/file-content').query({ path: videoPath });
    expect(res.body.contentHash).toBeUndefined();
  });
});

describe('PUT /api/file-content (the editor save path)', () => {
  it('saves new bytes and returns the new hash', async () => {
    const target = path.join(tmpDir, 'notes.txt');
    const res = await request(createApp())
      .put('/api/file-content')
      .send({ path: target, content: 'edited by the viewer\n' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(await fs.readFile(target, 'utf-8')).toBe('edited by the viewer\n');
    // The returned hash matches a fresh read's, so the editor can keep saving.
    const read = await request(createApp()).get('/api/file-content').query({ path: target });
    expect(read.body.contentHash).toBe(res.body.contentHash);
  });

  it('accepts a matching expectedHash', async () => {
    const target = path.join(tmpDir, 'notes.txt');
    const read = await request(createApp()).get('/api/file-content').query({ path: target });
    const res = await request(createApp())
      .put('/api/file-content')
      .send({ path: target, content: 'second revision\n', expectedHash: read.body.contentHash });
    expect(res.status).toBe(200);
    expect(await fs.readFile(target, 'utf-8')).toBe('second revision\n');
  });

  it('409s a STALE expectedHash instead of clobbering (the agent-wrote-it-first case)', async () => {
    const target = path.join(tmpDir, 'notes.txt');
    const read = await request(createApp()).get('/api/file-content').query({ path: target });
    // Someone else (an agent mid-turn, another tab, git checkout) writes first.
    await fs.writeFile(target, 'written by an agent\n');
    const res = await request(createApp())
      .put('/api/file-content')
      .send({ path: target, content: 'my stale edit\n', expectedHash: read.body.contentHash });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('conflict');
    expect(res.body.currentHash).toMatch(/^[0-9a-f]{12}$/);
    // The other writer's bytes SURVIVE — that's the whole point.
    expect(await fs.readFile(target, 'utf-8')).toBe('written by an agent\n');
  });

  it('a re-save using the conflict response currentHash then succeeds (explicit overwrite)', async () => {
    const target = path.join(tmpDir, 'notes.txt');
    const read = await request(createApp()).get('/api/file-content').query({ path: target });
    await fs.writeFile(target, 'written by an agent\n');
    const conflict = await request(createApp())
      .put('/api/file-content')
      .send({ path: target, content: 'mine\n', expectedHash: read.body.contentHash });
    const res = await request(createApp())
      .put('/api/file-content')
      .send({ path: target, content: 'mine\n', expectedHash: conflict.body.currentHash });
    expect(res.status).toBe(200);
    expect(await fs.readFile(target, 'utf-8')).toBe('mine\n');
  });

  it('creates a NEW file (no expectedHash is not a conflict)', async () => {
    const target = path.join(tmpDir, 'brand-new.ts');
    const res = await request(createApp())
      .put('/api/file-content')
      .send({ path: target, content: 'export const x = 1\n' });
    expect(res.status).toBe(200);
    expect(await fs.readFile(target, 'utf-8')).toBe('export const x = 1\n');
  });

  it('saves EMPTY content (clearing a file is a real edit)', async () => {
    const target = path.join(tmpDir, 'notes.txt');
    const res = await request(createApp())
      .put('/api/file-content')
      .send({ path: target, content: '' });
    expect(res.status).toBe(200);
    expect(await fs.readFile(target, 'utf-8')).toBe('');
  });

  it('415s rather than let a text editor overwrite a BINARY file', async () => {
    const res = await request(createApp())
      .put('/api/file-content')
      .send({ path: videoPath, content: 'this would destroy the video\n' });
    expect(res.status).toBe(415);
    expect(Buffer.compare(await fs.readFile(videoPath), videoBytes)).toBe(0);
  });

  it('409s a file too large for the editor to have loaded whole', async () => {
    const bigPath = path.join(tmpDir, 'big2.txt');
    const original = 'y'.repeat(600 * 1024);
    await fs.writeFile(bigPath, original);
    const res = await request(createApp())
      .put('/api/file-content')
      .send({ path: bigPath, content: 'truncating save\n' });
    expect(res.status).toBe(409);
    expect(await fs.readFile(bigPath, 'utf-8')).toBe(original);
  });

  it('413s content over the size cap', async () => {
    const res = await request(createApp())
      .put('/api/file-content')
      .send({ path: path.join(tmpDir, 'huge.txt'), content: 'z'.repeat(600 * 1024) });
    expect(res.status).toBe(413);
  });

  it('rejects directory traversal on WRITE too (same sandbox as read)', async () => {
    const res = await request(createApp())
      .put('/api/file-content')
      .send({ path: tmpDir + '/../escaped.txt', content: 'nope' });
    expect(res.status).toBe(400);
  });

  it('requires an absolute path', async () => {
    const res = await request(createApp())
      .put('/api/file-content')
      .send({ path: 'relative/file.txt', content: 'nope' });
    expect(res.status).toBe(400);
  });

  it('rejects a non-string content', async () => {
    const res = await request(createApp())
      .put('/api/file-content')
      .send({ path: path.join(tmpDir, 'notes.txt'), content: { not: 'a string' } });
    expect(res.status).toBe(400);
  });

  it('does not create parent directories (a save into a missing dir is a typo)', async () => {
    const res = await request(createApp())
      .put('/api/file-content')
      .send({ path: path.join(tmpDir, 'no-such-dir', 'f.txt'), content: 'x' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    await expect(fs.stat(path.join(tmpDir, 'no-such-dir'))).rejects.toThrow();
  });
});
