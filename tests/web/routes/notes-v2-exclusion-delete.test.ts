/**
 * FOLDER EXCLUSION + DELETE ROUTES coverage.
 *
 * Exclusion (settings → search.excluded_folders) is a QUERY-TIME view filter:
 * the index keeps everything, every search leg (title/FTS/LIKE/semantic/
 * attachment) drops rows under an excluded prefix, and `all=1` bypasses it.
 * These tests pin that contract — especially the traps:
 *   - prefix matching is per PATH SEGMENT ('archive' must NOT hide 'archive-2/')
 *   - matching is case-insensitive ('Archive' config hides 'archive/…')
 *   - the SEMANTIC leg is filtered too (it returns absolute paths, so a missed
 *     relative-path conversion would leak excluded notes back in)
 *   - toggling needs NO reindex (same index, different config → different view)
 *
 * DELETE /folder and DELETE /attachment are the destructive tree operations:
 * root guard, traversal guard, type guard (file vs dir), and index/extracted-
 * text cleanup all asserted here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('notes-v2-excl-del-test'));

// Controllable semantic leg (same pattern as the sibling hybrid test): mock the
// index lane by name so reconcile never opens a real search.sqlite and the
// route's semantic hits are exactly what each test dictates.
let semanticHits: any[] = [];
vi.mock('../../../src/core/search/wiring.js', () => ({
  isSearchV2Enabled: () => true,
  searchV2Lane: vi.fn(async () => semanticHits),
  upsertSearchV2File: vi.fn(async () => {}),
  sweepSearchV2Files: vi.fn(async () => ({ changed: 0, removed: 0 })),
}));

import express from 'express';
import request from 'supertest';
import { notesV2Router, resetIndexBootstrap } from '../../../src/web/routes/notes-v2.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js';
import { closeNotesIndexDb, upsertAttachmentText, getAttachmentMeta } from '../../../src/core/notes-index.js';
import { rebuildIndex, stopNotesIndexer, resetNotesIndexer, scanForDrift } from '../../../src/core/notes-indexer.js';

const NOTES_DIR = path.join(WALNUT_HOME, 'notes');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  app.use('/api/notes-v2', notesV2Router);
  app.use(errorHandler);
  return app;
}

async function writeNote(relPath: string, content: string): Promise<void> {
  const fullPath = path.join(NOTES_DIR, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

async function writeBinary(relPath: string, bytes = 'fake-image-bytes'): Promise<void> {
  const fullPath = path.join(NOTES_DIR, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, bytes);
}

/** Persist search.excluded_folders into the (tmp) config.yaml the route reads. */
async function writeExcludedFolders(folders: string[]): Promise<void> {
  const lines = folders.map((f) => `    - ${f}`).join('\n');
  await fs.writeFile(CONFIG_FILE, `search:\n  excluded_folders:\n${lines}\n`, 'utf-8');
}

function seedAttachmentText(relPath: string, text: string): void {
  upsertAttachmentText({
    path: relPath,
    content_hash: `h-${relPath}`,
    text,
    method: 'ocr',
    status: 'ok',
    mtime: new Date().toISOString(),
    size: 100,
  });
}

/** One note-kind index hit; `ref` is the absolute vault path the route maps
 *  back to a note id. `semantic: 'ok'` + a cosine are what make the route treat
 *  it as a real semantic opinion. */
function semanticHit(relPath: string, score: number, title = '') {
  return {
    kind: 'note',
    ref: path.join(NOTES_DIR, relPath),
    title,
    text: 'semantic excerpt',
    score,
    components: { coverage: 0, cosine: score },
    semantic: 'ok',
  };
}

async function quiesceIndex(): Promise<void> {
  resetIndexBootstrap();
  stopNotesIndexer();
  await new Promise((r) => setTimeout(r, 5));
  closeNotesIndexDb();
}

beforeEach(async () => {
  semanticHits = [];
  await quiesceIndex();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(NOTES_DIR, { recursive: true });
  resetNotesIndexer();
});

afterEach(async () => {
  await quiesceIndex();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ─── Folder exclusion: query-time view filter ────────────────────────────────

describe('search: excluded_folders config', () => {
  it('hides notes under an excluded folder from every string leg, no reindex needed', async () => {
    await writeNote('projects/rocket.md', '# Rocket\n\nLaunch checklist for the rocket.');
    await writeNote('archive/old-rocket.md', '# Old Rocket\n\nRetired rocket launch notes.');
    await rebuildIndex();
    const app = createApp();

    // No config → both notes visible (baseline sanity).
    const before = await request(app).get('/api/notes-v2/search?q=rocket&mode=string');
    expect(before.body.results.map((r: any) => r.path)).toEqual(
      expect.arrayContaining(['projects/rocket.md', 'archive/old-rocket.md']),
    );

    // Same index, config added — the archived note disappears from the view.
    await writeExcludedFolders(['archive']);
    const after = await request(app).get('/api/notes-v2/search?q=rocket&mode=string');
    const paths = after.body.results.map((r: any) => r.path);
    expect(paths).toContain('projects/rocket.md');
    expect(paths).not.toContain('archive/old-rocket.md');
  });

  it('all=1 bypasses the exclusion (escape hatch searches everything)', async () => {
    await writeNote('archive/buried.md', '# Buried\n\nOnly lives in the archive.');
    await rebuildIndex();
    await writeExcludedFolders(['archive']);
    const app = createApp();

    const normal = await request(app).get('/api/notes-v2/search?q=buried&mode=string');
    expect(normal.body.results.map((r: any) => r.path)).not.toContain('archive/buried.md');

    const bypass = await request(app).get('/api/notes-v2/search?q=buried&mode=string&all=1');
    expect(bypass.body.results.map((r: any) => r.path)).toContain('archive/buried.md');
  });

  it('matches case-insensitively and only on whole path segments', async () => {
    await writeNote('archive/hidden.md', '# Hidden\n\nZephyr topic inside archive.');
    await writeNote('archive-2/visible.md', '# Visible\n\nZephyr topic in a sibling folder.');
    await rebuildIndex();
    // Config says 'Archive' (capital A) — must still hide 'archive/…' but NOT 'archive-2/…'.
    await writeExcludedFolders(['Archive']);
    const app = createApp();

    const res = await request(app).get('/api/notes-v2/search?q=zephyr&mode=string');
    const paths = res.body.results.map((r: any) => r.path);
    expect(paths).not.toContain('archive/hidden.md');
    expect(paths).toContain('archive-2/visible.md');
  });

  it('escapes LIKE metacharacters in folder names (%, _) instead of widening the match', async () => {
    // Folder literally named '50%_off'. Unescaped, '%' and '_' are LIKE wildcards:
    // '50%_off/%' would ALSO swallow '50-anything-off/…' style paths.
    await writeNote('50%_off/deal.md', '# Deal\n\nPangolin coupon inside the odd folder.');
    await writeNote('50x-off/keeper.md', '# Keeper\n\nPangolin coupon in a lookalike folder.');
    await rebuildIndex();
    await writeExcludedFolders(['50%_off']);
    const app = createApp();

    const res = await request(app).get('/api/notes-v2/search?q=pangolin&mode=string');
    const paths = res.body.results.map((r: any) => r.path);
    expect(paths).not.toContain('50%_off/deal.md');   // the literal folder is hidden
    expect(paths).toContain('50x-off/keeper.md');     // a wildcard would have eaten this too
  });

  it('applies MULTIPLE excluded folders at once (params/placeholders stay aligned)', async () => {
    await writeNote('archive/a.md', '# A\n\nMarmoset topic.');
    await writeNote('trash/b.md', '# B\n\nMarmoset topic.');
    await writeNote('active/c.md', '# C\n\nMarmoset topic.');
    await rebuildIndex();
    await writeExcludedFolders(['archive', 'trash']);
    const app = createApp();

    const res = await request(app).get('/api/notes-v2/search?q=marmoset&mode=string');
    const paths = res.body.results.map((r: any) => r.path);
    expect(paths).toEqual(['active/c.md']);
  });

  it('filters non-ASCII-cased folder names on the string leg (JS re-filter)', async () => {
    // SQLite LIKE is case-insensitive for ASCII only — 'été' config vs 'Été/' dir
    // relies on the route's isPathExcluded re-filter (full-Unicode toLowerCase).
    await writeNote('Été/vacances.md', '# Vacances\n\nCapybara plans for summer.');
    await writeNote('plans/keeper.md', '# Keeper\n\nCapybara plans that stay.');
    await rebuildIndex();
    await writeExcludedFolders(['été']);
    const app = createApp();

    const res = await request(app).get('/api/notes-v2/search?q=capybara&mode=string');
    const paths = res.body.results.map((r: any) => r.path);
    expect(paths).not.toContain('Été/vacances.md');
    expect(paths).toContain('plans/keeper.md');
  });

  it('filters the SEMANTIC leg too (absolute-path hits under excluded folders)', async () => {
    await writeNote('archive/semantic-only.md', '# Semantic Only\n\nNothing textual here.');
    await writeNote('active.md', '# Active\n\nNothing textual here either.');
    await rebuildIndex();
    await writeExcludedFolders(['archive']);
    // Both come back from the (mocked) semantic engine; only the archived one must drop.
    semanticHits = [
      semanticHit('archive/semantic-only.md', 0.9, 'Semantic Only'),
      semanticHit('active.md', 0.8, 'Active'),
    ];
    const app = createApp();

    const res = await request(app).get('/api/notes-v2/search?q=nonmatching-query');
    const paths = res.body.results.map((r: any) => r.path);
    expect(paths).toContain('active.md');
    expect(paths).not.toContain('archive/semantic-only.md');
  });

  it('filters the ATTACHMENT leg (extracted OCR/PDF text under excluded folders)', async () => {
    await rebuildIndex();
    seedAttachmentText('archive/_attachment/old-scan.png', 'quarterly waffle report scan');
    seedAttachmentText('records/_attachment/new-scan.png', 'quarterly waffle report scan');
    await writeExcludedFolders(['archive']);
    const app = createApp();

    const res = await request(app).get('/api/notes-v2/search?q=waffle&mode=string');
    const paths = res.body.results.map((r: any) => r.path);
    expect(paths).toContain('records/_attachment/new-scan.png');
    expect(paths).not.toContain('archive/_attachment/old-scan.png');
  });
});

// ─── DELETE /folder ──────────────────────────────────────────────────────────

describe('DELETE /api/notes-v2/folder', () => {
  it('recursively deletes the folder, reports the note count, and cleans the index', async () => {
    await writeNote('doomed/one.md', '# One\n\nUnique word flamingo.');
    await writeNote('doomed/sub/two.md', '# Two\n\nUnique word flamingo.');
    await writeNote('keeper.md', '# Keeper\n\nUnique word flamingo.');
    await writeBinary('doomed/_attachment/pic.png');
    await rebuildIndex();
    seedAttachmentText('doomed/_attachment/pic.png', 'flamingo photo caption');
    const app = createApp();

    const del = await request(app).delete('/api/notes-v2/folder/doomed');
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ ok: true, deletedNotes: 2 });

    // Gone from disk…
    await expect(fs.stat(path.join(NOTES_DIR, 'doomed'))).rejects.toMatchObject({ code: 'ENOENT' });
    // …its extracted-text row dropped…
    expect(getAttachmentMeta('doomed/_attachment/pic.png')).toBeUndefined();
    // …and (after reconcile) out of search, while siblings stay.
    await scanForDrift();
    const res = await request(app).get('/api/notes-v2/search?q=flamingo&mode=string');
    const paths = res.body.results.map((r: any) => r.path);
    expect(paths).toContain('keeper.md');
    expect(paths).not.toContain('doomed/one.md');
    expect(paths).not.toContain('doomed/sub/two.md');
  });

  it('rejects traversal attempts (resolveSafePath refuses to leave the vault)', async () => {
    await writeNote('safe.md', '# Safe');
    await rebuildIndex();
    const app = createApp();

    const traversal = await request(app).delete('/api/notes-v2/folder/..%2Foutside');
    expect(traversal.status).toBe(400);

    // The vault itself must survive whatever was attempted.
    await expect(fs.stat(NOTES_DIR)).resolves.toBeDefined();
  });

  it('404s on a missing folder and 400s on a file path', async () => {
    await writeNote('a-note.md', '# A Note');
    await rebuildIndex();
    const app = createApp();

    expect((await request(app).delete('/api/notes-v2/folder/no-such-dir')).status).toBe(404);
    expect((await request(app).delete('/api/notes-v2/folder/a-note.md')).status).toBe(400);
  });
});

// ─── DELETE /attachment ──────────────────────────────────────────────────────

describe('DELETE /api/notes-v2/attachment', () => {
  it('deletes the file and drops its extracted-text row', async () => {
    await writeBinary('records/_attachment/scan.png');
    await rebuildIndex();
    seedAttachmentText('records/_attachment/scan.png', 'searchable scan text');
    const app = createApp();

    const del = await request(app).delete('/api/notes-v2/attachment/records/_attachment/scan.png');
    expect(del.status).toBe(200);
    await expect(fs.stat(path.join(NOTES_DIR, 'records/_attachment/scan.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(getAttachmentMeta('records/_attachment/scan.png')).toBeUndefined();
  });

  it('refuses .md paths (notes go through their own route) and 404s on missing files', async () => {
    await writeNote('real-note.md', '# Real Note');
    await rebuildIndex();
    const app = createApp();

    expect((await request(app).delete('/api/notes-v2/attachment/real-note.md')).status).toBe(400);
    // The note is untouched.
    await expect(fs.stat(path.join(NOTES_DIR, 'real-note.md'))).resolves.toBeDefined();

    expect((await request(app).delete('/api/notes-v2/attachment/ghost.png')).status).toBe(404);
  });
});
