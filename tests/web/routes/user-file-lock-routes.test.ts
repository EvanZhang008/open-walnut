/**
 * A save through the Files panel (PUT /api/file-content) or the notes editor
 * (PUT /api/notes-v2/content/*) locks the user's file under WALNUT_HOME/locks, never beside it.
 *
 * 2026-10-05: the Files panel locked a `Gemfile` at `Gemfile.lock`, which is the user's own
 * lockfile. Once that lockfile was older than 30s, the save deleted it as a stale lock. Each
 * save also left `<file>.lock` dirs in the user's repo and vault while it ran, where git status,
 * editors and sync tools see them.
 *
 * What each block pins:
 *   - saving a Gemfile / Podfile / Pipfile next to an old lockfile of that name succeeds and
 *     leaves the lockfile byte-identical (bytes and mtime);
 *   - while either route writes, the folder it writes in holds no lock entry, and the lock it
 *     holds is the one entry in WALNUT_HOME/locks;
 *   - the two routes take ONE lock for one note: a held lock stops both, also when the Files
 *     panel reaches the note through a symlinked folder; and racing compare-and-set saves on
 *     the same note through both routes never both win.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('user-file-lock-routes'));

// The notes routes bootstrap the search index; keep it from opening a real search.sqlite or
// loading an embedding model (same stub as tests/web/routes/notes-v2.test.ts).
vi.mock('../../../src/core/search/wiring.js', () => ({
  isSearchV2Enabled: () => true,
  searchV2Lane: vi.fn(async () => []),
  upsertSearchV2File: vi.fn(async () => {}),
  sweepSearchV2Files: vi.fn(async () => ({ changed: 0, removed: 0 })),
  getSearchIndexStatus: vi.fn(() => ({
    enabled: true, model: null, docs: 0, byKind: {}, vectors: 0,
    backfillRunning: false, error: null,
  })),
}));

import express from 'express';
import request from 'supertest';
import { NOTES_DIR, WALNUT_HOME } from '../../../src/constants.js';
import { fileContentRouter } from '../../../src/web/routes/file-content.js';
import { notesV2Router, settleIndexBootstrap } from '../../../src/web/routes/notes-v2.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { computeContentHash } from '../../../src/utils/file-ops.js';

const LOCKS = path.join(WALNUT_HOME, 'locks');

function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  app.use('/api/file-content', fileContentRouter);
  app.use('/api/notes-v2', notesV2Router);
  app.use(errorHandler);
  return app;
}

let app: express.Express;
let repo: string;
let vault: string;

beforeEach(async () => {
  await settleIndexBootstrap();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(NOTES_DIR, { recursive: true });
  vault = await fsp.realpath(NOTES_DIR);
  repo = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'ufl-routes-repo-')));
  app = createApp();
});

afterEach(async () => {
  vi.restoreAllMocks();
  // The notes routes start the index in the background: wait for it to end (and release its
  // file lock) before removing the data dir.
  await settleIndexBootstrap();
  await fsp.rm(repo, { recursive: true, force: true });
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

/** Every entry under `dir`, recursively, relative to it. */
function tree(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[]).sort();
}

function lockEntries(dir: string): string[] {
  return tree(dir).filter((e) => /\.lock$|\.lock[./]|\.claim-/.test(e));
}

function keyName(realPath: string): string {
  return `${crypto.createHash('sha256').update(realPath).digest('hex')}.lock`;
}

interface WriteSeen { file: string; folderLocks: string[]; walnutLocks: string[] }

/** Record, at the moment a route writes into `roots` (real paths), what lock entries exist
 *  where. `file` is the written file's real path. */
function watchWrites(roots: string[]): WriteSeen[] {
  const seen: WriteSeen[] = [];
  const realWriteFile = fsp.writeFile.bind(fsp);
  vi.spyOn(fsp, 'writeFile').mockImplementation((async (file: unknown, ...rest: unknown[]) => {
    const p = typeof file === 'string' && path.isAbsolute(file)
      ? path.join(fs.realpathSync(path.dirname(file)), path.basename(file))
      : '';
    const root = roots.find((r) => p.startsWith(r + path.sep));
    if (root) {
      seen.push({
        file: p,
        folderLocks: lockEntries(root),
        walnutLocks: fs.existsSync(LOCKS) ? fs.readdirSync(LOCKS).sort() : [],
      });
    }
    return (realWriteFile as (...a: unknown[]) => Promise<void>)(file, ...rest);
  }) as typeof fsp.writeFile);
  return seen;
}

const note = (id: string, body: string) => `---\nid: ${id}\n---\n${body}\n`;

describe('Files panel save of a manifest next to its lockfile', () => {
  it.each(['Gemfile', 'Podfile', 'Pipfile'])(
    'saves %s twice and leaves its old lockfile byte-identical',
    async (name) => {
      const file = path.join(repo, name);
      const lockfile = `${file}.lock`;
      fs.writeFileSync(file, 'v0\n');
      const lockBytes = Buffer.from(`${name} lockfile\n  pinned (1.2.3)\n`);
      fs.writeFileSync(lockfile, lockBytes);
      const then = new Date(Date.now() - 120_000);
      fs.utimesSync(lockfile, then, then);
      const mtime = fs.statSync(lockfile).mtimeMs;
      const seen = watchWrites([repo]);

      const first = await request(app).put('/api/file-content').send({ path: file, content: 'v1\n' });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const second = await request(app)
        .put('/api/file-content')
        .send({ path: file, content: 'v2\n', expectedHash: first.body.contentHash });
      expect(second.status, JSON.stringify(second.body)).toBe(200);

      expect(fs.readFileSync(file, 'utf-8')).toBe('v2\n');
      expect(Buffer.compare(fs.readFileSync(lockfile), lockBytes)).toBe(0);
      expect(fs.statSync(lockfile).mtimeMs).toBe(mtime);
      expect(tree(repo)).toEqual([name, `${name}.lock`].sort());
      // While the save ran, the only `.lock` in the repo was the user's own lockfile, and the
      // save's lock was the one entry in WALNUT_HOME/locks.
      expect(seen).toHaveLength(2);
      for (const s of seen) {
        expect(s.folderLocks).toEqual([`${name}.lock`]);
        expect(s.walnutLocks).toEqual([keyName(file)]);
      }
      expect(fs.readdirSync(LOCKS)).toEqual([]);
    },
  );
});

describe('no lock entry inside the repo or the vault', () => {
  it('a repo file save and a note save each lock under WALNUT_HOME/locks only', async () => {
    fs.mkdirSync(path.join(repo, 'src'));
    const code = path.join(repo, 'src', 'main.rb');
    fs.writeFileSync(code, 'puts 1\n');
    fs.mkdirSync(path.join(vault, 'plans'));
    const notePath = path.join(vault, 'plans', 'trip.md');
    fs.writeFileSync(notePath, note('n-trip', 'v0'));
    const seen = watchWrites([repo, vault]);

    const a = await request(app).put('/api/file-content').send({ path: code, content: 'puts 2\n' });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const b = await request(app).put('/api/notes-v2/content/plans/trip.md').send({ content: note('n-trip', 'v1') });
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    const c = await request(app).put('/api/file-content').send({ path: notePath, content: note('n-trip', 'v2') });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    // A new note in a new folder: notes-v2 makes the folder, and nothing else.
    const d = await request(app).put('/api/notes-v2/content/ideas/new.md').send({ content: note('n-new', 'x') });
    expect(d.status, JSON.stringify(d.body)).toBe(200);

    expect(seen.map((s) => path.relative(s.file.startsWith(repo) ? repo : vault, s.file))).toEqual([
      'src/main.rb', 'plans/trip.md', 'plans/trip.md', 'ideas/new.md',
    ]);
    for (const s of seen) {
      expect(s.folderLocks, s.file).toEqual([]);
      expect(s.walnutLocks, s.file).toEqual([keyName(s.file)]);
    }
    expect(lockEntries(repo)).toEqual([]);
    expect(lockEntries(vault)).toEqual([]);
    expect(fs.readFileSync(notePath, 'utf-8')).toBe(note('n-trip', 'v2'));
  });
});

describe('one lock for one note across the Files panel and the notes editor', () => {
  it('a held lock stops both routes, also through a symlinked folder', async () => {
    const { withUserFileLock } = await import('../../../src/utils/user-file-lock.js');
    fs.mkdirSync(path.join(vault, 'plans'));
    const notePath = path.join(vault, 'plans', 'trip.md');
    fs.writeFileSync(notePath, note('n-trip', 'v0'));
    fs.symlinkSync(path.join(vault, 'plans'), path.join(repo, 'plans-link'));

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let holderIn!: () => void;
    const holding = new Promise<void>((r) => { holderIn = r; });
    const holder = withUserFileLock(notePath, async () => { holderIn(); await held; });
    await holding;

    const done: string[] = [];
    const viaFiles = request(app)
      .put('/api/file-content')
      .send({ path: path.join(repo, 'plans-link', 'trip.md'), content: note('n-trip', 'files') })
      .then((r) => { done.push('files'); return r; });
    const viaNotes = request(app)
      .put('/api/notes-v2/content/plans/trip.md')
      .send({ content: note('n-trip', 'notes') })
      .then((r) => { done.push('notes'); return r; });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toEqual([]);
    expect(fs.readFileSync(notePath, 'utf-8')).toBe(note('n-trip', 'v0'));

    release();
    const [f, n] = await Promise.all([viaFiles, viaNotes, holder]);
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect(n.status, JSON.stringify(n.body)).toBe(200);
    expect([note('n-trip', 'files'), note('n-trip', 'notes')]).toContain(fs.readFileSync(notePath, 'utf-8'));
    expect(lockEntries(vault)).toEqual([]);
    expect(lockEntries(repo)).toEqual([]);
  });

  it('racing compare-and-set saves through both routes never both win', async () => {
    fs.mkdirSync(path.join(vault, 'plans'));
    const notePath = path.join(vault, 'plans', 'trip.md');
    fs.writeFileSync(notePath, note('n-trip', 'r0'));
    for (let round = 1; round <= 15; round++) {
      const base = computeContentHash(fs.readFileSync(notePath, 'utf-8'));
      const filesBody = note('n-trip', `files ${round}`);
      const notesBody = note('n-trip', `notes ${round}`);
      const [f, n] = await Promise.all([
        request(app).put('/api/file-content').send({ path: notePath, content: filesBody, expectedHash: base }),
        request(app).put('/api/notes-v2/content/plans/trip.md').send({ content: notesBody, expectedHash: base }),
      ]);
      const statuses = [f.status, n.status].sort();
      expect(statuses, `round ${round}: ${JSON.stringify([f.body, n.body])}`).toEqual([200, 409]);
      expect(fs.readFileSync(notePath, 'utf-8')).toBe(f.status === 200 ? filesBody : notesBody);
    }
    expect(lockEntries(vault)).toEqual([]);
  });
});
