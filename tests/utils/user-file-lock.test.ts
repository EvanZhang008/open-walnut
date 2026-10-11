/**
 * withUserFileLock (src/utils/user-file-lock.ts): a file a person edits is locked under
 * WALNUT_HOME/locks, by the sha256 of its resolved path, never beside the file.
 *
 * 2026-10-05: the Files panel locked a `Gemfile` at `Gemfile.lock`, which is the user's own
 * lockfile; once it was older than 30s it was deleted as a stale lock on every save.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('user-file-lock'));

import { LOG_DIR, NOTES_DIR, WALNUT_HOME } from '../../src/constants.js';
import { userFileLockTarget, withUserFileLock } from '../../src/utils/user-file-lock.js';

const LOCKS = path.join(WALNUT_HOME, 'locks');
let repo: string;

beforeEach(async () => {
  repo = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'user-file-lock-repo-')));
  await fsp.rm(LOCKS, { recursive: true, force: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(repo, { recursive: true, force: true });
});

function keyOf(realPath: string): string {
  return path.join(LOCKS, crypto.createHash('sha256').update(realPath).digest('hex'));
}

/** Every entry under `dir`, recursively, relative to it. */
function tree(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[]).sort();
}

describe('userFileLockTarget', () => {
  it('locks a repo file under WALNUT_HOME/locks by its resolved path', async () => {
    const gemfile = path.join(repo, 'Gemfile');
    fs.writeFileSync(gemfile, 'source "https://rubygems.org"\n');
    expect(await userFileLockTarget(gemfile)).toBe(keyOf(gemfile));
  });

  it('locks a note in the vault under WALNUT_HOME/locks too', async () => {
    const note = path.join(NOTES_DIR, 'plans', 'trip.md');
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, '# trip\n');
    expect(await userFileLockTarget(note)).toBe(keyOf(await fsp.realpath(note)));
  });

  it("keeps a Walnut store's own `<file>.lock`, so its store code and the Files panel share it", async () => {
    const store = path.join(WALNUT_HOME, 'tasks', 'tasks.json');
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, '{}');
    expect(await userFileLockTarget(store)).toBe(await fsp.realpath(store));
    const daemonFile = path.join(LOG_DIR, 'sessions.json');
    expect(await userFileLockTarget(daemonFile)).toBe(path.join(await fsp.realpath(LOG_DIR), 'sessions.json'));
  });

  it("treats a folder whose name only starts like WALNUT_HOME's as the user's", async () => {
    const sibling = `${WALNUT_HOME}-other`;
    fs.mkdirSync(sibling, { recursive: true });
    try {
      const file = path.join(sibling, 'Gemfile');
      fs.writeFileSync(file, 'x\n');
      expect(await userFileLockTarget(file)).toBe(keyOf(await fsp.realpath(file)));
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('gives one key to a file reached through a symlink, a symlinked folder, or another letter case', async () => {
    const real = path.join(repo, 'src', 'main.rb');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, 'puts 1\n');
    fs.symlinkSync(real, path.join(repo, 'link.rb'));
    fs.symlinkSync(path.join(repo, 'src'), path.join(repo, 'src-link'));
    const key = await userFileLockTarget(real);
    expect(await userFileLockTarget(path.join(repo, 'link.rb'))).toBe(key);
    expect(await userFileLockTarget(path.join(repo, 'src-link', 'main.rb'))).toBe(key);
    expect(await userFileLockTarget(path.join(repo, 'src', '..', 'src', 'main.rb'))).toBe(key);
    if (fs.existsSync(path.join(repo, 'SRC', 'MAIN.RB'))) {
      // A case-insensitive volume (the macOS default): another case is the same file.
      expect(await userFileLockTarget(path.join(repo, 'SRC', 'MAIN.RB'))).toBe(key);
    }
  });

  it('gives a file that does not exist yet the same key through a symlinked folder', async () => {
    fs.mkdirSync(path.join(repo, 'src'));
    fs.symlinkSync(path.join(repo, 'src'), path.join(repo, 'src-link'));
    const key = await userFileLockTarget(path.join(repo, 'src', 'new.rb'));
    expect(key).toBe(keyOf(path.join(repo, 'src', 'new.rb')));
    expect(await userFileLockTarget(path.join(repo, 'src-link', 'new.rb'))).toBe(key);
  });
});

describe('withUserFileLock', () => {
  it.each(['Gemfile', 'Podfile', 'Pipfile'])(
    'saves a %s next to an old lockfile of the same name and leaves that lockfile byte-identical',
    async (name) => {
      const file = path.join(repo, name);
      const lockfile = `${file}.lock`;
      fs.writeFileSync(file, 'old\n');
      const lockBytes = Buffer.from(`${name} lockfile\n  pinned: 1.2.3\n`);
      fs.writeFileSync(lockfile, lockBytes);
      const then = new Date(Date.now() - 120_000);
      fs.utimesSync(lockfile, then, then);
      const before = fs.statSync(lockfile);

      await withUserFileLock(file, async () => { fs.writeFileSync(file, 'new\n'); });

      expect(fs.readFileSync(file, 'utf-8')).toBe('new\n');
      expect(Buffer.compare(fs.readFileSync(lockfile), lockBytes)).toBe(0);
      expect(fs.statSync(lockfile).mtimeMs).toBe(before.mtimeMs);
      expect(tree(repo)).toEqual([name, `${name}.lock`].sort());
    },
  );

  it('makes the missing lock root and leaves nothing in it, or in the repo, afterwards', async () => {
    expect(fs.existsSync(LOCKS)).toBe(false);
    const file = path.join(repo, 'README.md');
    fs.writeFileSync(file, 'hi\n');
    let sawLock = false;
    await withUserFileLock(file, async () => { sawLock = fs.existsSync(`${keyOf(file)}.lock`); });
    expect(sawLock).toBe(true);
    expect(fs.readdirSync(LOCKS)).toEqual([]);
    expect(tree(repo)).toEqual(['README.md']);
  });

  it('excludes a writer that came in through a symlink while another holds the real path', async () => {
    const real = path.join(repo, 'notes.txt');
    fs.writeFileSync(real, '0');
    fs.symlinkSync(real, path.join(repo, 'alias.txt'));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holderIn!: () => void;
    const holderStarted = new Promise<void>((resolve) => { holderIn = resolve; });
    const holder = withUserFileLock(real, async () => { holderIn(); await held; });
    await holderStarted;
    let entered = false;
    const other = withUserFileLock(path.join(repo, 'alias.txt'), async () => { entered = true; });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(entered).toBe(false);
    release();
    await Promise.all([holder, other]);
    expect(entered).toBe(true);
  });
});
