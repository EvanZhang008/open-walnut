import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('memory-sync-test'));

import express from 'express';
import request from 'supertest';
import { memoryRouter } from '../../../src/web/routes/memory.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { MEMORY_DIR, MEMORY_FILE } from '../../../src/constants.js';
import { bus } from '../../../src/core/event-bus.js';
import { computeContentHash } from '../../../src/utils/file-ops.js';

/**
 * A memory .md file is editable from /memory AND from the Files panel (rooted at
 * ~/.open-walnut). Before this it was last-write-wins with NO event on either
 * side: /memory's 15s poll only ever refreshed the metadata tree, so the open
 * document kept its pre-edit bytes and its next autosave wrote them back over
 * the other surface's change.
 *
 * Two things make that safe, and both are pinned here: the read hands over a
 * `contentHash` the write sends back (so a stale write is a 409, not a silent
 * overwrite), and every write announces `memory:updated` so the other surface
 * re-reads instead of waiting for a poll.
 */

interface Captured { name: string; data: Record<string, unknown> }
const captured: Captured[] = [];

function createApp() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/memory', memoryRouter);
  app.use(errorHandler);
  return app;
}

beforeAll(() => {
  bus.subscribe('memory-sync-spy', (e) => {
    captured.push({ name: e.name, data: (e.data ?? {}) as Record<string, unknown> });
  }, { global: true, interest: ['memory:updated'] });
});

afterAll(() => {
  bus.unsubscribe('memory-sync-spy');
});

beforeEach(async () => {
  captured.length = 0;
  await fs.mkdir(path.join(MEMORY_DIR, 'daily'), { recursive: true });
  await fs.writeFile(MEMORY_FILE, '# Memory\n\n## Rule\n- one\n', 'utf-8');
  await fs.writeFile(path.join(MEMORY_DIR, 'daily', '2026-09-03.md'), '# Day\n\n- first\n', 'utf-8');
});

const memoryEvents = () => captured.filter((c) => c.name === 'memory:updated');

describe('memory reads carry an optimistic-lock token', () => {
  it('GET /global answers with the contentHash of the bytes it served', async () => {
    const res = await request(createApp()).get('/api/memory/global');
    expect(res.status, res.text).toBe(200);
    expect(res.body.memory.contentHash).toBe(computeContentHash(res.body.memory.content));
  });

  it('GET of a nested memory file answers with its contentHash too', async () => {
    const res = await request(createApp()).get('/api/memory/daily/2026-09-03.md');
    expect(res.status, res.text).toBe(200);
    expect(res.body.memory.contentHash).toBe(computeContentHash(res.body.memory.content));
  });
});

describe('memory writes refuse to clobber a change the editor never showed', () => {
  it('PUT /global with the current hash succeeds and returns the next one', async () => {
    const read = await request(createApp()).get('/api/memory/global');
    const res = await request(createApp())
      .put('/api/memory/global')
      .send({ content: '# Memory\n\n## Rule\n- two\n', expectedHash: read.body.memory.contentHash });
    expect(res.status, res.text).toBe(200);
    expect(res.body.contentHash).toBe(computeContentHash('# Memory\n\n## Rule\n- two\n'));
  });

  it('PUT /global with a STALE hash is a 409 that names the current bytes', async () => {
    const res = await request(createApp())
      .put('/api/memory/global')
      .send({ content: 'clobbered\n', expectedHash: 'sha256-not-what-is-on-disk' });
    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe('conflict');
    expect(res.body.currentHash).toBe(computeContentHash('# Memory\n\n## Rule\n- one\n'));
    // The refusal must actually protect the file.
    expect(await fs.readFile(MEMORY_FILE, 'utf-8')).toBe('# Memory\n\n## Rule\n- one\n');
  });

  it('a nested memory file gets the same lock', async () => {
    const rel = 'daily/2026-09-03.md';
    const stale = await request(createApp())
      .put(`/api/memory/${rel}`)
      .send({ content: 'clobbered\n', expectedHash: 'sha256-stale' });
    expect(stale.status, stale.text).toBe(409);

    const read = await request(createApp()).get(`/api/memory/${rel}`);
    const ok = await request(createApp())
      .put(`/api/memory/${rel}`)
      .send({ content: '# Day\n\n- second\n', expectedHash: read.body.memory.contentHash });
    expect(ok.status, ok.text).toBe(200);
    expect(await fs.readFile(path.join(MEMORY_DIR, rel), 'utf-8')).toBe('# Day\n\n- second\n');
  });

  it('omitting expectedHash keeps the old last-write-wins behaviour (/api/v1 relies on it)', async () => {
    const res = await request(createApp()).put('/api/memory/global').send({ content: 'plain\n' });
    expect(res.status, res.text).toBe(200);
    expect(await fs.readFile(MEMORY_FILE, 'utf-8')).toBe('plain\n');
  });
});

describe('memory writes announce themselves', () => {
  it('PUT /global emits memory:updated for MEMORY.md', async () => {
    const res = await request(createApp()).put('/api/memory/global').send({ content: 'next\n' });
    expect(res.status, res.text).toBe(200);
    expect(memoryEvents()).toHaveLength(1);
    expect(memoryEvents()[0].data).toMatchObject({
      path: 'MEMORY.md', contentHash: computeContentHash('next\n'),
    });
  });

  it('PUT of a nested file emits memory:updated with the same relative path the page selects by', async () => {
    const res = await request(createApp())
      .put('/api/memory/daily/2026-09-03.md')
      .send({ content: 'later\n' });
    expect(res.status, res.text).toBe(200);
    expect(memoryEvents()[0].data.path).toBe('daily/2026-09-03.md');
  });

  it('a REFUSED write announces nothing — nothing changed on disk', async () => {
    const res = await request(createApp())
      .put('/api/memory/global')
      .send({ content: 'no\n', expectedHash: 'sha256-stale' });
    expect(res.status).toBe(409);
    expect(memoryEvents()).toHaveLength(0);
  });
});
