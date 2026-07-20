import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('notes-v2-test'));

// The semantic leg (QMD) is not under test here — stub memoryNotesSearch so the
// hybrid search exercises only the structural (string) leg deterministically.
vi.mock('../../../src/core/memory-search.js', () => ({
  memoryNotesSearch: vi.fn(async () => []),
}));

// The reconciler drives the QMD semantic store per changed file (best-effort).
// Stub the store so reconcile never opens a real notes-search.sqlite / loads an
// embedding model — that async file I/O would otherwise race test teardown and is
// not under test here (the structural sidecar is what these tests assert).
vi.mock('../../../src/core/qmd-store.js', () => ({
  DEFAULT_QMD_MODEL: 'test-model',
  embedQmdStore: vi.fn(async (
    store: { embed: (options: unknown) => Promise<unknown> },
    _label: string,
    options: unknown,
  ) => store.embed(options)),
  getNotesStore: vi.fn(async () => ({
    internal: {
      findActiveDocument: () => undefined,
      insertContent: () => {},
      insertDocument: () => {},
      updateDocumentTitle: () => {},
      updateDocument: () => {},
      deactivateDocument: () => {},
      getActiveDocumentPaths: () => [],
      cleanupOrphanedVectors: () => 0,
      deleteInactiveDocuments: () => 0,
      cleanupOrphanedContent: () => 0,
    },
    embed: async () => {},
    getStatus: async () => ({ needsEmbedding: 0 }),
  })),
}));

import express from 'express';
import request from 'supertest';
import { notesV2Router, resetIndexBootstrap } from '../../../src/web/routes/notes-v2.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import { closeNotesIndexDb } from '../../../src/core/notes-index.js';
import { rebuildIndex, stopNotesIndexer, resetNotesIndexer } from '../../../src/core/notes-indexer.js';

const NOTES_DIR = path.join(WALNUT_HOME, 'notes');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  app.use('/api/notes-v2', notesV2Router);
  app.use(errorHandler);
  return app;
}

/** Helper to write a note file directly on disk */
async function writeNote(relPath: string, content: string): Promise<void> {
  const fullPath = path.join(NOTES_DIR, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

/** Helper to read a note file from disk */
async function readNote(relPath: string): Promise<string> {
  return fs.readFile(path.join(NOTES_DIR, relPath), 'utf-8');
}

/** Helper to check if a file exists */
async function fileExists(relPath: string): Promise<boolean> {
  try {
    await fs.stat(path.join(NOTES_DIR, relPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the structural index from whatever is on disk. The structural sidecar
 * is the source of truth for search/backlinks/list/tags, so tests that write
 * notes directly to disk must reconcile before asserting index-backed reads.
 */
async function syncIndex(): Promise<void> {
  await rebuildIndex();
}

// Stop ALL async index work (debounced reconcile + off-loop rebuild + bus listener)
// and let any in-flight microtask settle before removing WALNUT_HOME. The router
// self-bootstraps the index off-loop on first request and the reconciler is
// debounced (~300ms) — without this, that background work re-creates
// notes-index.sqlite + WAL in the dir we're removing, racing teardown (ENOTEMPTY).
async function quiesceIndex(): Promise<void> {
  resetIndexBootstrap(); // unsubscribe bus listener + stopNotesIndexer (synchronous)
  stopNotesIndexer();
  // Yield twice: once for a reconcile mid-await, once for fs.promises write settle.
  await new Promise((r) => setTimeout(r, 5));
  closeNotesIndexDb();
}

beforeEach(async () => {
  await quiesceIndex();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(NOTES_DIR, { recursive: true });
  resetNotesIndexer(); // re-arm the reconciler for this test
});

afterEach(async () => {
  await quiesceIndex();
  // maxRetries: the off-loop indexer can still be flushing a sqlite/QMD write
  // when teardown starts; a bare rm intermittently hits ENOTEMPTY (flake).
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// ─── GET / — File Tree ────────────────────────────────────────────────

describe('GET /api/notes-v2 (tree)', () => {
  it('returns empty tree when no notes exist', async () => {
    const app = createApp();
    const res = await request(app).get('/api/notes-v2');

    expect(res.status).toBe(200);
    expect(res.body.tree).toEqual([]);
  });

  it('returns tree with files and folders', async () => {
    await writeNote('hello.md', '# Hello');
    await writeNote('sub/nested.md', '# Nested');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2');

    expect(res.status).toBe(200);
    const { tree } = res.body;
    expect(tree.length).toBe(2); // folder first, then file

    // Folder comes first (sorted: folders before files)
    const folder = tree.find((n: any) => n.type === 'folder');
    expect(folder).toBeDefined();
    expect(folder.name).toBe('sub');
    expect(folder.children).toHaveLength(1);
    expect(folder.children[0].name).toBe('nested.md');

    const file = tree.find((n: any) => n.type === 'file');
    expect(file).toBeDefined();
    expect(file.name).toBe('hello.md');
    expect(file.path).toBe('hello.md');
  });

  it('skips hidden files and non-attachment, non-.md files', async () => {
    await writeNote('.hidden.md', 'hidden');
    await fs.writeFile(path.join(NOTES_DIR, 'readme.txt'), 'not markdown'); // not an attachment type
    await writeNote('visible.md', '# Visible');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2');

    expect(res.status).toBe(200);
    expect(res.body.tree).toHaveLength(1);
    expect(res.body.tree[0].name).toBe('visible.md');
    expect(res.body.tree[0].kind).toBe('note');
  });

  it('includes attachment files (png/jpg/pdf) marked kind=attachment', async () => {
    await writeNote('note.md', '# Note');
    await fs.mkdir(path.join(NOTES_DIR, '_attachment'), { recursive: true });
    await fs.writeFile(path.join(NOTES_DIR, '_attachment', 'pic.png'), 'PNGBYTES');
    await fs.writeFile(path.join(NOTES_DIR, '_attachment', 'scan.PDF'), '%PDF-1.4'); // uppercase ext
    await fs.writeFile(path.join(NOTES_DIR, '_attachment', 'data.csv'), 'a,b'); // excluded type

    const app = createApp();
    const res = await request(app).get('/api/notes-v2');

    expect(res.status).toBe(200);
    const folder = res.body.tree.find((n: any) => n.name === '_attachment');
    expect(folder).toBeDefined();
    const names = folder.children.map((c: any) => c.name).sort();
    expect(names).toEqual(['pic.png', 'scan.PDF']); // csv excluded
    for (const child of folder.children) {
      expect(child.kind).toBe('attachment');
    }
  });
});

// ─── GET /attachment — serve image/pdf bytes ─────────────────────────

describe('GET /api/notes-v2/attachment', () => {
  it('serves a png with the right content-type', async () => {
    await fs.mkdir(path.join(NOTES_DIR, '_attachment'), { recursive: true });
    await fs.writeFile(path.join(NOTES_DIR, '_attachment', 'pic.png'), 'PNGBYTES');

    const app = createApp();
    const res = await request(app)
      .get('/api/notes-v2/attachment')
      .query({ path: '_attachment/pic.png' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.body.toString()).toBe('PNGBYTES');
  });

  it('serves a pdf (uppercase ext) as application/pdf', async () => {
    await fs.mkdir(path.join(NOTES_DIR, '_attachment'), { recursive: true });
    await fs.writeFile(path.join(NOTES_DIR, '_attachment', 'scan.PDF'), '%PDF-1.4');

    const app = createApp();
    const res = await request(app)
      .get('/api/notes-v2/attachment')
      .query({ path: '_attachment/scan.PDF' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('rejects a disallowed type (svg / txt)', async () => {
    await fs.writeFile(path.join(NOTES_DIR, 'evil.svg'), '<svg/>');
    const app = createApp();
    const res = await request(app).get('/api/notes-v2/attachment').query({ path: 'evil.svg' });
    expect(res.status).toBe(400);
  });

  it('rejects directory traversal (never serves a file outside the vault)', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/notes-v2/attachment')
      .query({ path: '../../etc/passwd.png' });
    // resolveAttachmentPath folds "unsafe" + "not found" into one null → 404,
    // so a traversal path is never served (and doesn't leak existence).
    expect(res.status).toBe(404);
  });

  it('404s for a missing attachment', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/notes-v2/attachment')
      .query({ path: '_attachment/nope.png' });
    expect(res.status).toBe(404);
  });
});

// ─── POST /attachment — Pasted-image upload into the vault ───────────

describe('POST /api/notes-v2/attachment (upload)', () => {
  // 1x1 transparent PNG
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  it('saves the image into _attachment/ beside the note and returns the vault-relative path', async () => {
    await writeNote('Areas/proj/My Note.md', '# Note');

    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/attachment')
      .send({ notePath: 'Areas/proj/My Note.md', data: PNG_B64, mediaType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.path).toMatch(/^Areas\/proj\/_attachment\/pasted-image-\d{14}-[0-9a-f]{6}\.png$/);

    // Bytes on disk match the upload
    const onDisk = await fs.readFile(path.join(NOTES_DIR, res.body.path));
    expect(onDisk.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);

    // The returned path round-trips through the GET /attachment streamer
    const served = await request(app)
      .get('/api/notes-v2/attachment')
      .query({ path: res.body.path });
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toContain('image/png');
  });

  it('handles a note path without the .md suffix (vault root)', async () => {
    await writeNote('Root.md', '# Root');

    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/attachment')
      .send({ notePath: 'Root', data: PNG_B64, mediaType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.path).toMatch(/^_attachment\/pasted-image-\d{14}-[0-9a-f]{6}\.jpg$/);
  });

  it('two DIFFERENT images pasted in the same second get distinct filenames (content hash)', async () => {
    await writeNote('n.md', '');
    // Second image: same 1x1 PNG with one byte flipped in the IDAT payload region
    const other = Buffer.from(PNG_B64, 'base64');
    other[other.length - 20] ^= 0xff;
    const app = createApp();
    const r1 = await request(app)
      .post('/api/notes-v2/attachment')
      .send({ notePath: 'n.md', data: PNG_B64, mediaType: 'image/png' });
    const r2 = await request(app)
      .post('/api/notes-v2/attachment')
      .send({ notePath: 'n.md', data: other.toString('base64'), mediaType: 'image/png' });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Even within the same wall-clock second, the 6-hex content hash differs.
    expect(r1.body.path).not.toBe(r2.body.path);
    const dir = await fs.readdir(path.join(NOTES_DIR, '_attachment'));
    expect(dir.length).toBe(2);
  });

  it('rejects a disallowed media type', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/attachment')
      .send({ notePath: 'n.md', data: PNG_B64, mediaType: 'image/svg+xml' });
    expect(res.status).toBe(400);
  });

  it('rejects traversal in notePath', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/attachment')
      .send({ notePath: '../../outside/n.md', data: PNG_B64, mediaType: 'image/png' });
    expect(res.status).toBe(400);
  });

  it('rejects missing fields', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/attachment')
      .send({ notePath: 'n.md' });
    expect(res.status).toBe(400);
  });
});

// ─── GET /content/*path — Read Note ──────────────────────────────────

describe('GET /api/notes-v2/content/*path', () => {
  it('reads an existing note', async () => {
    await writeNote('test-note.md', '# Test\n\nContent here.');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/content/test-note.md');

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('# Test\n\nContent here.');
    expect(res.body.updatedAt).toBeDefined();
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(0);
  });

  it('returns the frontmatter id when present', async () => {
    await writeNote('with-id.md', '---\nid: n_abc123\n---\n# Hi');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/content/with-id.md');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('n_abc123');
  });

  it('reads note in subfolder', async () => {
    await writeNote('projects/walnut.md', '# Walnut Notes');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/content/projects/walnut.md');

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('# Walnut Notes');
  });

  it('auto-appends .md extension', async () => {
    await writeNote('auto-ext.md', 'works without extension');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/content/auto-ext');

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('works without extension');
  });

  it('returns 404 for non-existent note', async () => {
    const app = createApp();
    const res = await request(app).get('/api/notes-v2/content/does-not-exist.md');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Note not found');
  });

  it('does not serve files outside notes dir via traversal', async () => {
    const app = createApp();
    const res = await request(app).get('/api/notes-v2/content/../../../etc/passwd');
    expect([400, 404]).toContain(res.status);
  });
});

// ─── PUT /content/*path — Create/Update Note ─────────────────────────

describe('PUT /api/notes-v2/content/*path', () => {
  it('creates a new note and stamps a frontmatter id at create time', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/notes-v2/content/new-note.md')
      .send({ content: '# New Note\n\nFresh content.' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.updatedAt).toBeDefined();
    // Identity contract: id stamped into frontmatter; response echoes it.
    expect(res.body.id).toMatch(/^n_/);

    const onDisk = await readNote('new-note.md');
    expect(onDisk).toContain(`id: ${res.body.id}`);
    expect(onDisk).toContain('# New Note');
    // contentHash reflects the STAMPED bytes (so the FE can refresh w/o a 409).
    const { computeContentHash } = await import('../../../src/utils/file-ops.js');
    expect(res.body.contentHash).toBe(computeContentHash(onDisk));
  });

  it('preserves an existing frontmatter id (does not re-stamp)', async () => {
    const app = createApp();
    const content = '---\nid: n_keepme\ntitle: Keep\n---\n# Body';
    const res = await request(app)
      .put('/api/notes-v2/content/keep.md')
      .send({ content });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('n_keepme');
    expect(await readNote('keep.md')).toBe(content); // byte-clean: unchanged
  });

  it('creates parent folders automatically', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/notes-v2/content/deep/nested/note.md')
      .send({ content: 'nested' });

    expect(res.status).toBe(200);
    expect(await fileExists('deep/nested/note.md')).toBe(true);
  });

  it('updates an existing note', async () => {
    await writeNote('existing.md', '---\nid: n_exist\n---\nold content');

    const app = createApp();
    const res = await request(app)
      .put('/api/notes-v2/content/existing.md')
      .send({ content: '---\nid: n_exist\n---\nupdated content' });

    expect(res.status).toBe(200);
    expect(await readNote('existing.md')).toBe('---\nid: n_exist\n---\nupdated content');
  });

  it('rejects missing content field', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/notes-v2/content/bad.md')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('content');
  });

  it('rejects content exceeding 2MB', async () => {
    const app = createApp();
    const bigContent = 'x'.repeat(2_000_001);
    const res = await request(app)
      .put('/api/notes-v2/content/big.md')
      .send({ content: bigContent });

    expect(res.status).toBe(413);
    expect(res.body.error).toContain('too large');
  });

  it('does not write files outside notes dir via traversal', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/notes-v2/content/../../etc/evil.md')
      .send({ content: 'hacked' });

    expect([400, 404]).toContain(res.status);
  });
});

// ─── DELETE /content/*path — Delete Note ──────────────────────────────

describe('DELETE /api/notes-v2/content/*path', () => {
  it('deletes an existing note', async () => {
    await writeNote('to-delete.md', 'goodbye');

    const app = createApp();
    const res = await request(app).delete('/api/notes-v2/content/to-delete.md');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(await fileExists('to-delete.md')).toBe(false);
  });

  it('cleans up empty parent directories', async () => {
    await writeNote('cleanup/deep/only-child.md', 'content');

    const app = createApp();
    await request(app).delete('/api/notes-v2/content/cleanup/deep/only-child.md');

    expect(await fileExists('cleanup/deep')).toBe(false);
    expect(await fileExists('cleanup')).toBe(false);
  });

  it('returns 404 for non-existent note', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/notes-v2/content/ghost.md');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Note not found');
  });

  it('does not delete files outside notes dir via traversal', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/notes-v2/content/../../../etc/passwd');

    expect([400, 404]).toContain(res.status);
  });
});

// ─── POST /move — Rename/Move (id-keyed links survive, no rewrite) ──────

describe('POST /api/notes-v2/move', () => {
  it('moves/renames a note', async () => {
    await writeNote('old-name.md', '# Old Name');

    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: 'old-name.md', to: 'new-name.md' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(await fileExists('old-name.md')).toBe(false);
    expect(await fileExists('new-name.md')).toBe(true);
    expect(await readNote('new-name.md')).toBe('# Old Name');
  });

  it('moves note to a different folder', async () => {
    await writeNote('root-note.md', 'content');

    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: 'root-note.md', to: 'archive/root-note.md' });

    expect(res.status).toBe(200);
    expect(await fileExists('root-note.md')).toBe(false);
    expect(await readNote('archive/root-note.md')).toBe('content');
  });

  it('does NOT rewrite link text on rename (links key on target id)', async () => {
    // Contract: updateWikiLinksInAll is deleted. Authored link text is left
    // byte-for-byte intact; the backlink edge survives via the target's id.
    await writeNote('target.md', '---\nid: n_target\n---\n# Target');
    await writeNote('linker.md', '---\nid: n_linker\n---\nSee [[target]] for details.');
    await syncIndex();

    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: 'target.md', to: 'renamed-target.md' });

    expect(res.status).toBe(200);
    // Link text in OTHER notes is unchanged (no whole-vault regex rewrite).
    expect(await readNote('linker.md')).toBe(
      '---\nid: n_linker\n---\nSee [[target]] for details.',
    );
  });

  it('returns 404 when source does not exist', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: 'nonexistent.md', to: 'dest.md' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Source note not found');
  });

  it('returns 409 when destination already exists', async () => {
    await writeNote('a.md', 'a');
    await writeNote('b.md', 'b');
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: 'a.md', to: 'b.md' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Destination note already exists');
  });

  it('rejects missing from/to fields', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: 'only-from.md' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('from and to');
  });

  it('rejects path traversal in from/to', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: '../../etc/passwd', to: 'safe.md' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid path');
  });
});

// ─── GET /search?q= — Hybrid (string leg) Search ─────────────────────

describe('GET /api/notes-v2/search', () => {
  it('returns empty results for empty query', async () => {
    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=');

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('returns empty results for missing query', async () => {
    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search');

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('finds notes containing search term (FTS), labeled exact', async () => {
    await writeNote('recipe.md', '# Chocolate Cake\n\nMix flour, cocoa, and sugar.');
    await writeNote('todo.md', '# Tasks\n\nBuy groceries.');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=chocolate');

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].path).toBe('recipe.md');
    expect(res.body.results[0].matchType).toBe('exact');
    expect(res.body.results[0].id).toMatch(/^n_/); // id stamped during reconcile
    // Snippet highlights the matched span with <mark> for the FE viewer.
    expect(res.body.results[0].snippet.toLowerCase()).toContain('<mark>chocolate</mark>');
  });

  it('search is case-insensitive', async () => {
    await writeNote('upper.md', 'IMPORTANT: uppercase content');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=important');

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });

  it('finds mid-token substring via the LIKE fallback', async () => {
    // FTS5 cannot match 'pollo' inside 'Apollo'; the capped LIKE leg can.
    await writeNote('apollo.md', '# Apollo\n\nLaunch sequence.');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=pollo');

    expect(res.status).toBe(200);
    expect(res.body.results.map((r: any) => r.path)).toContain('apollo.md');
  });

  it('searches in subfolders', async () => {
    await writeNote('deep/nested/note.md', 'findable content');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=findable');

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].path).toBe('deep/nested/note.md');
  });
});

// ─── GET /backlinks/*path — Index-backed, id-keyed ───────────────────

describe('GET /api/notes-v2/backlinks/*path', () => {
  it('finds notes that link to the target (resolved by id)', async () => {
    await writeNote('target.md', '# Target Note');
    await writeNote('linker-a.md', 'Refers to [[target]] here.');
    await writeNote('linker-b.md', 'Also links: [[target|see this]].');
    await writeNote('unrelated.md', 'No links here.');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/backlinks/target.md');

    expect(res.status).toBe(200);
    expect(res.body.backlinks).toHaveLength(2);
    const paths = res.body.backlinks.map((b: any) => b.path).sort();
    expect(paths).toEqual(['linker-a.md', 'linker-b.md']);
    // Every resolved edge carries a status.
    for (const b of res.body.backlinks) expect(b.status).toBe('resolved');
  });

  it('does not include self in backlinks', async () => {
    await writeNote('self-ref.md', 'I link to [[self-ref]] myself.');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/backlinks/self-ref.md');

    expect(res.status).toBe(200);
    expect(res.body.backlinks).toHaveLength(0);
  });

  it('returns empty backlinks when no notes link to target', async () => {
    await writeNote('lonely.md', '# Lonely Note');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/backlinks/lonely.md');

    expect(res.status).toBe(200);
    expect(res.body.backlinks).toEqual([]);
  });

  it('includes snippet showing the link context', async () => {
    await writeNote('target.md', '# Target');
    await writeNote('source.md', 'Before context [[target]] after context');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/backlinks/target.md');

    expect(res.status).toBe(200);
    expect(res.body.backlinks).toHaveLength(1);
    expect(res.body.backlinks[0].snippet).toContain('[[target]]');
  });

  it('marks a bare link to two same-named notes as ambiguous', async () => {
    // Two id-less notes share a basename → a bare [[dup]] is genuinely ambiguous.
    await writeNote('a/dup.md', '---\nid: n_dupa\n---\n# Dup A');
    await writeNote('b/dup.md', '---\nid: n_dupb\n---\n# Dup B');
    await writeNote('src.md', '---\nid: n_src\n---\nLink [[dup]] here.');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/backlinks/a/dup.md');
    expect(res.status).toBe(200);
    const amb = res.body.backlinks.find((b: any) => b.status === 'ambiguous');
    expect(amb).toBeDefined();
    expect(amb.path).toBe('src.md');
    expect(amb.candidates).toEqual(expect.arrayContaining(['n_dupa', 'n_dupb']));
  });
});

// ─── GET /list — Flat List of All Notes (now returns id) ──────────────

describe('GET /api/notes-v2/list', () => {
  it('returns empty list when no notes exist', async () => {
    const app = createApp();
    const res = await request(app).get('/api/notes-v2/list');

    expect(res.status).toBe(200);
    expect(res.body.notes).toEqual([]);
  });

  it('returns flat list of all notes with id', async () => {
    await writeNote('root.md', '# Root');
    await writeNote('sub/nested.md', '# Nested');
    await writeNote('sub/deep/leaf.md', '# Leaf');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/list');

    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(3);

    const paths = res.body.notes.map((n: any) => n.path).sort();
    expect(paths).toEqual(['root.md', 'sub/deep/leaf.md', 'sub/nested.md']);

    const root = res.body.notes.find((n: any) => n.path === 'root.md');
    expect(root.name).toBe('root');
    expect(root.id).toMatch(/^n_/);
    expect(root.title).toBe('Root'); // from first H1
  });

  it('skips hidden files', async () => {
    await writeNote('.hidden.md', 'hidden');
    await writeNote('visible.md', 'visible');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/list');

    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0].name).toBe('visible');
  });
});

// ─── GET /tags + /tags/:tag/notes + POST /tags/rename ────────────────

describe('tags', () => {
  it('returns frequency-ranked tags from frontmatter + inline hashtags', async () => {
    await writeNote('a.md', '---\nid: n_a\ntags: [standup, q3]\n---\nNotes #standup again');
    await writeNote('b.md', '---\nid: n_b\n---\nJust #standup here');
    await writeNote('c.md', '---\nid: n_c\ntags: [q3]\n---\nbody');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/tags');
    expect(res.status).toBe(200);
    const tags = res.body.tags as Array<{ tag: string; count: number }>;
    const standup = tags.find((t) => t.tag === 'standup');
    const q3 = tags.find((t) => t.tag === 'q3');
    expect(standup?.count).toBe(2); // a (fm+inline deduped) + b (inline)
    expect(q3?.count).toBe(2);      // a + c (frontmatter)
    // Frequency-ranked: standup and q3 both 2; order is count desc.
    expect(tags[0].count).toBeGreaterThanOrEqual(tags[tags.length - 1].count);
  });

  it('does not treat C# or #123 or URL fragments as tags', async () => {
    await writeNote('x.md', '---\nid: n_x\n---\nI use C# and issue #123 see https://h/p#frag and #real');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/tags');
    const tagNames = (res.body.tags as Array<{ tag: string }>).map((t) => t.tag);
    expect(tagNames).toContain('real');
    expect(tagNames).not.toContain('123');
    expect(tagNames).not.toContain('frag');
  });

  it('lists notes carrying a tag (newest first)', async () => {
    await writeNote('one.md', '---\nid: n_one\n---\n#topic one');
    await writeNote('two.md', '---\nid: n_two\n---\n#topic two');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/tags/topic/notes');
    expect(res.status).toBe(200);
    expect(res.body.notes.map((n: any) => n.path).sort()).toEqual(['one.md', 'two.md']);
  });

  it('renames a tag in only the carrying notes (targeted, not a scan)', async () => {
    await writeNote('has.md', '---\nid: n_has\n---\nA #oldtag in the body');
    await writeNote('other.md', '---\nid: n_other\n---\nNo tag here, just the word oldtag');
    await syncIndex();

    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/tags/rename')
      .send({ from: 'oldtag', to: 'newtag' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(await readNote('has.md')).toContain('#newtag');
    expect(await readNote('has.md')).not.toContain('#oldtag');
    // The non-carrying note's plain word is untouched.
    expect(await readNote('other.md')).toContain('the word oldtag');
  });
});

// ─── Index status / rebuild ──────────────────────────────────────────

describe('index admin', () => {
  it('GET /index/status reports docCount + schemaVersion', async () => {
    await writeNote('one.md', '# One');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/index/status');
    expect(res.status).toBe(200);
    expect(res.body.docCount).toBe(1);
    expect(typeof res.body.schemaVersion).toBe('number');
    expect(res.body).toHaveProperty('dbSizeBytes');
  });

  it('POST /index/rebuild responds with rebuilding:true', async () => {
    const app = createApp();
    const res = await request(app).post('/api/notes-v2/index/rebuild');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, rebuilding: true });
    // The endpoint kicks off an off-loop rebuild; let it settle before afterEach
    // wipes the home dir (otherwise the background write races the rm).
    await new Promise((r) => setTimeout(r, 150));
  });

  it('POST /index/stamp-ids stamps ids into id-less notes (batched migration)', async () => {
    await writeNote('legacy-a.md', '# Legacy A\n\nno id here');
    await writeNote('legacy-b.md', '---\ntitle: Legacy B\n---\nstill no id');

    const app = createApp();
    const res = await request(app).post('/api/notes-v2/index/stamp-ids');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // `scanned` is a pure disk walk → always deterministic. The `stamped` COUNT,
    // however, races the off-loop bootstrap reconcile that ensureIndexBootstrap()
    // kicks at the top of this same route: that reconcile lazily back-writes an id
    // into an id-less note, so a note may already carry an id by the time
    // stampAllIds() counts it (then it's "already identified", not "stamped").
    // The migration's real contract is FULL ID COVERAGE on disk (asserted below),
    // not how many ids this particular call authored vs. the bootstrap authored.
    expect(res.body.scanned).toBe(2);
    expect(res.body.stamped + res.body.skipped).toBeLessThanOrEqual(2);
    // Both files now carry a frontmatter id on disk (the invariant that matters).
    expect(await readNote('legacy-a.md')).toMatch(/^---\nid: n_[0-9a-z]+\n---\n# Legacy A/);
    expect(await readNote('legacy-b.md')).toContain('id: n_');
    expect(await readNote('legacy-b.md')).toContain('title: Legacy B'); // preserved
    // ensureIndexBootstrap kicked an off-loop initNotesIndex rebuild on first
    // request; let it settle before afterEach wipes the home dir.
    await new Promise((r) => setTimeout(r, 150));
  });

  it('POST /index/merge-ids resolves divergent copies (earliest-created-wins)', async () => {
    // Two machines stamped the same id-less note → two copies, two ids, one
    // linker pointing at the title. Earliest created (winner) wins.
    await writeNote(
      'shared.md',
      '---\nid: n_w\ncreated: 2026-01-01T00:00:00.000Z\n---\n# Shared\n\nsame body',
    );
    await writeNote(
      'shared-copy.md',
      '---\nid: n_l\ncreated: 2026-02-01T00:00:00.000Z\n---\n# Shared\n\nsame body',
    );
    await syncIndex();

    const app = createApp();
    const res = await request(app).post('/api/notes-v2/index/merge-ids');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.groups).toBe(1);
    // The loser copy converged onto the winner id on disk.
    expect(await readNote('shared-copy.md')).toContain('id: n_w');
    expect(await readNote('shared-copy.md')).not.toContain('id: n_l');
  });
});

// ─── Security: Path Traversal ────────────────────────────────────────

describe('path traversal protection', () => {
  const traversalPaths = [
    '../../../etc/passwd',
    '..\\..\\..\\etc\\passwd',
    'foo/../../etc/passwd',
  ];

  for (const maliciousPath of traversalPaths) {
    it(`does not serve files outside NOTES_DIR for: ${maliciousPath}`, async () => {
      const app = createApp();
      const res = await request(app).get(`/api/notes-v2/content/${maliciousPath}`);
      expect([400, 404]).toContain(res.status);
      expect(res.body.content).toBeUndefined();
    });
  }

  it('resolveSafePath rejects move with traversal from', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: '../../etc/passwd', to: 'safe.md' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid path');
  });

  it('resolveSafePath rejects move with traversal to', async () => {
    await writeNote('source.md', 'content');
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: 'source.md', to: '../../etc/evil.md' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid path');
  });

  it('resolveSafePath rejects folder creation with traversal', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/folder')
      .send({ path: '../../etc' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid path');
  });
});

// ─── Review-fix coverage: Office attachments, ~$ lock files, /reveal,
//     attachment move (no .md suffix), tag-rename precision ────────────

describe('Office attachments in tree + streaming', () => {
  it('lists docx/xlsx as attachments and skips ~$ Office lock files', async () => {
    await writeNote('n.md', 'note');
    await fs.writeFile(path.join(NOTES_DIR, 'report.docx'), 'DOCX');
    await fs.writeFile(path.join(NOTES_DIR, 'sheet.XLSX'), 'XLSX');
    await fs.writeFile(path.join(NOTES_DIR, '~$report.docx'), 'LOCK');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2');
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      (res.body.tree as Array<{ name: string; kind?: string }>).map((n) => [n.name, n]),
    );
    expect(byName['report.docx']?.kind).toBe('attachment');
    expect(byName['sheet.XLSX']?.kind).toBe('attachment');
    expect(byName['~$report.docx']).toBeUndefined();
  });

  it('serves docx as attachment download (RFC 5987-clean filename)', async () => {
    await fs.writeFile(path.join(NOTES_DIR, "Q3 plan's (final).docx"), 'DOCX');

    const app = createApp();
    const res = await request(app)
      .get('/api/notes-v2/attachment')
      .query({ path: "Q3 plan's (final).docx" });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('officedocument.wordprocessingml');
    const cd = res.headers['content-disposition']!;
    expect(cd).toContain('attachment');
    // ' * ( ) must be percent-encoded — a bare ' collides with the UTF-8'' delimiter.
    expect(cd).not.toMatch(/UTF-8''[^%]*['()*]/);
  });
});

describe('POST /api/notes-v2/move (attachments)', () => {
  it('moves an attachment verbatim — no .md suffix appended', async () => {
    await fs.writeFile(path.join(NOTES_DIR, 'img.png'), 'PNG');

    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: 'img.png', to: '_attachment/img.png' });

    expect(res.status).toBe(200);
    expect(await fileExists('_attachment/img.png')).toBe(true);
    expect(await fileExists('img.png')).toBe(false);
    expect(await fileExists('_attachment/img.png.md')).toBe(false);
  });
});

describe('POST /api/notes-v2/reveal', () => {
  it("mode 'path' resolves without spawning and returns the absolute path", async () => {
    await writeNote('some/note.md', 'hi');
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/reveal')
      .send({ path: 'some/note.md', mode: 'path' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.fullPath).toBe(path.join(NOTES_DIR, 'some/note.md'));
  });

  it('rejects launching a disallowed file type (only notes + attachments open)', async () => {
    await fs.writeFile(path.join(NOTES_DIR, 'evil.command'), 'echo pwned');
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/reveal')
      .send({ path: 'evil.command', mode: 'app' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not allowed');
  });

  it('rejects bad mode and traversal path', async () => {
    const app = createApp();
    expect(
      (await request(app).post('/api/notes-v2/reveal').send({ path: 'a.md', mode: 'exec' })).status,
    ).toBe(400);
    expect(
      (await request(app).post('/api/notes-v2/reveal').send({ path: '../../etc/passwd', mode: 'path' })).status,
    ).toBe(404);
  });
});

describe('POST /api/notes-v2/tags/rename (precision)', () => {
  it('does not rewrite prefix-overlapping tags (#work vs #work-log)', async () => {
    await writeNote('t.md', '---\nid: n_t\ntags: [work]\n---\nBody #work and #work-log stay distinct');
    await syncIndex();

    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/tags/rename')
      .send({ from: 'work', to: 'job' });

    expect(res.status).toBe(200);
    const after = await readNote('t.md');
    expect(after).toContain('#job ');
    expect(after).toContain('#work-log');
    expect(after).not.toContain('#job-log');
  });

  it('does not corrupt non-tag frontmatter fields carrying the same word', async () => {
    await writeNote('f.md', '---\nid: n_f\ntitle: my work notes\ntags: [work]\n---\nBody #work');
    await syncIndex();

    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/tags/rename')
      .send({ from: 'work', to: 'job' });

    expect(res.status).toBe(200);
    const after = await readNote('f.md');
    expect(after).toContain('title: my work notes'); // untouched
    expect(after).toContain('tags: [job]');
    expect(after).toContain('#job');
  });
});
