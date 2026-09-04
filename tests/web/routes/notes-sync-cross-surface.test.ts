import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('notes-sync-test'));

// Same stub as notes-v2.test.ts: the semantic search lane is not under test and
// would otherwise open a real index / load an embedding model during teardown.
vi.mock('../../../src/core/search/wiring.js', () => ({
  isSearchV2Enabled: () => false,
  searchV2Lane: vi.fn(async () => []),
  upsertSearchV2File: vi.fn(async () => {}),
  sweepSearchV2Files: vi.fn(async () => ({ changed: 0, removed: 0 })),
  getSearchIndexStatus: vi.fn(() => ({
    enabled: false, model: null, docs: 0, byKind: {}, vectors: 0,
    backfillRunning: false, error: null,
  })),
}));

import express from 'express';
import request from 'supertest';
import { fileContentRouter } from '../../../src/web/routes/file-content.js';
import { notesV2Router, resetIndexBootstrap } from '../../../src/web/routes/notes-v2.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { NOTES_DIR, MEMORY_DIR, WALNUT_HOME } from '../../../src/constants.js';
import { bus } from '../../../src/core/event-bus.js';
import { getConfig, updateConfig } from '../../../src/core/config-manager.js';
import { closeNotesIndexDb } from '../../../src/core/notes-index.js';
import { stopNotesIndexer } from '../../../src/core/notes-indexer.js';

/**
 * One document, several surfaces.
 *
 * A vault note is editable from the /notes editor (PUT /api/notes-v2/content/*)
 * AND from the Files panel (PUT /api/file-content) — two unrelated write paths
 * to the same bytes. The file-content one used to emit NOTHING, so the /notes
 * editor kept showing pre-edit text and its own next save 409'd on the user's
 * own change. These pin the announcement that fixes it, plus the bookmark
 * bookkeeping that a delete/rename must carry (a bookmark for a deleted note is
 * a row whose first keystroke RE-CREATES the file).
 */

interface Captured { name: string; data: Record<string, unknown> }
const captured: Captured[] = [];

function createApp() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/file-content', fileContentRouter);
  app.use('/api/notes-v2', notesV2Router);
  app.use(errorHandler);
  return app;
}

beforeAll(() => {
  bus.subscribe('notes-sync-spy', (e) => {
    captured.push({ name: e.name, data: (e.data ?? {}) as Record<string, unknown> });
  }, { global: true, interest: ['notes:updated', 'memory:updated', 'config:changed'] });
});

afterAll(async () => {
  bus.unsubscribe('notes-sync-spy');
  resetIndexBootstrap();
  stopNotesIndexer();
  try { closeNotesIndexDb(); } catch { /* never opened */ }
});

beforeEach(async () => {
  captured.length = 0;
  await fs.mkdir(NOTES_DIR, { recursive: true });
  await fs.mkdir(MEMORY_DIR, { recursive: true });
});

afterEach(async () => {
  await fs.rm(NOTES_DIR, { recursive: true, force: true });
});

const emitted = (name: string) => captured.filter((c) => c.name === name);

describe('PUT /api/file-content announces the DOCUMENT it just wrote', () => {
  it('a vault note emits notes:updated under the canonical notes/<path-without-.md> source', async () => {
    const abs = path.join(NOTES_DIR, 'Folder', 'Cross Surface.md');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, '# before\n', 'utf-8');

    const res = await request(createApp())
      .put('/api/file-content')
      .send({ path: abs, content: '# after\n' });
    expect(res.status, res.text).toBe(200);

    // Exactly the name every other emitter uses (notes-v2, the legacy
    // global-notes route, the agent files tool) — one name per note, or the
    // /notes editor's listener never matches it.
    const notes = emitted('notes:updated');
    expect(notes).toHaveLength(1);
    expect(notes[0].data.source).toBe('notes/Folder/Cross Surface');
    expect(notes[0].data.contentHash).toBe(res.body.contentHash);
  });

  it('global-notes.md announces as notes/global-notes — the name the home panel listens for', async () => {
    const abs = path.join(NOTES_DIR, 'global-notes.md');
    await fs.writeFile(abs, 'a\n', 'utf-8');
    const res = await request(createApp()).put('/api/file-content').send({ path: abs, content: 'b\n' });
    expect(res.status, res.text).toBe(200);
    expect(emitted('notes:updated').map((e) => e.data.source)).toEqual(['notes/global-notes']);
  });

  it('a memory file emits memory:updated with its memory-dir-relative path', async () => {
    const abs = path.join(MEMORY_DIR, 'daily', '2026-09-03.md');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, 'log\n', 'utf-8');

    const res = await request(createApp()).put('/api/file-content').send({ path: abs, content: 'log2\n' });
    expect(res.status, res.text).toBe(200);

    const mem = emitted('memory:updated');
    expect(mem).toHaveLength(1);
    expect(mem[0].data.path).toBe('daily/2026-09-03.md');
    expect(mem[0].data.contentHash).toBe(res.body.contentHash);
    expect(emitted('notes:updated')).toHaveLength(0);
  });

  it('an ordinary file announces nothing (no surface is showing it as a note or a memory doc)', async () => {
    const abs = path.join(WALNUT_HOME, 'scratch.ts');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, 'x\n', 'utf-8');
    const res = await request(createApp()).put('/api/file-content').send({ path: abs, content: 'y\n' });
    expect(res.status, res.text).toBe(200);
    expect(emitted('notes:updated')).toHaveLength(0);
    expect(emitted('memory:updated')).toHaveLength(0);
  });

  it('a SIBLING directory of the vault is not the vault (segment-wise, not prefix-wise)', async () => {
    // `…/notes-backup/x.md` starts with the vault path as a STRING but is a
    // different tree; announcing it would point the /notes editor at a note that
    // does not exist.
    const abs = path.join(`${NOTES_DIR}-backup`, 'x.md');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, 'x\n', 'utf-8');
    const res = await request(createApp()).put('/api/file-content').send({ path: abs, content: 'y\n' });
    expect(res.status, res.text).toBe(200);
    expect(emitted('notes:updated')).toHaveLength(0);
    await fs.rm(path.dirname(abs), { recursive: true, force: true });
  });

  it('a vault ATTACHMENT is not a note', async () => {
    const abs = path.join(NOTES_DIR, '_attachment', 'diagram.svg');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, '<svg/>\n', 'utf-8');
    const res = await request(createApp()).put('/api/file-content').send({ path: abs, content: '<svg />\n' });
    expect(res.status, res.text).toBe(200);
    expect(emitted('notes:updated')).toHaveLength(0);
  });
});

describe('note bookmarks follow the vault', () => {
  beforeEach(async () => {
    await updateConfig({ favorites: { notes: ['Keep/kept.md', 'Bye/gone.md'], projects: [] } });
    captured.length = 0;
  });

  it('deleting a bookmarked note drops the bookmark and says so via config:changed', async () => {
    const abs = path.join(NOTES_DIR, 'Bye', 'gone.md');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, '# gone\n', 'utf-8');

    const res = await request(createApp()).delete('/api/notes-v2/content/Bye/gone.md');
    expect(res.status, res.text).toBe(200);

    const config = await getConfig();
    expect(config.favorites?.notes).toEqual(['Keep/kept.md']);
    expect(emitted('config:changed').map((e) => e.data.key)).toContain('favorites');
  });

  it('renaming a bookmarked note MOVES the bookmark instead of silently un-bookmarking it', async () => {
    const abs = path.join(NOTES_DIR, 'Bye', 'gone.md');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, '# gone\n', 'utf-8');

    const res = await request(createApp())
      .post('/api/notes-v2/move')
      .send({ from: 'Bye/gone.md', to: 'Bye/renamed.md' });
    expect(res.status, res.text).toBe(200);

    const config = await getConfig();
    expect(config.favorites?.notes).toEqual(['Keep/kept.md', 'Bye/renamed.md']);
  });

  it('deleting a FOLDER drops every bookmark under it in one write', async () => {
    const abs = path.join(NOTES_DIR, 'Bye', 'gone.md');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, '# gone\n', 'utf-8');

    const res = await request(createApp()).delete('/api/notes-v2/folder/Bye');
    expect(res.status, res.text).toBe(200);

    const config = await getConfig();
    expect(config.favorites?.notes).toEqual(['Keep/kept.md']);
  });

  it('deleting an UNBOOKMARKED note leaves the list (and the config file) alone', async () => {
    const abs = path.join(NOTES_DIR, 'Other', 'plain.md');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, '# plain\n', 'utf-8');

    const res = await request(createApp()).delete('/api/notes-v2/content/Other/plain.md');
    expect(res.status, res.text).toBe(200);

    const config = await getConfig();
    expect(config.favorites?.notes).toEqual(['Keep/kept.md', 'Bye/gone.md']);
    expect(emitted('config:changed')).toHaveLength(0);
  });
});
