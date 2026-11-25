/**
 * A data repo whose .gitignore is gone gets the template back (ensureCriticalIgnores, which
 * returned when the file was missing), at boot and before every `add -A`.
 *
 * Found by a 20 GB leader switch rehearsal between machines (2026-11-24): the standby copy left
 * the .gitignore out (then rebuildable, home-entries.ts data-repo-ignore) while it copied `.git`,
 * so a promoted home was an existing repo with no ignore list. Nothing wrote it back, and the new
 * leader's auto-commit took in tmp/ (the standby's own spool, whose chunks vanished under `git add`
 * every 30 s), /voice-archive/ and the machine-local stores, and committed the .gitignore's
 * deletion. Real git, temp dirs only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dirs = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('node:path') as typeof import('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require('node:os') as typeof import('node:os');
  const root = p.join(o.tmpdir(), `walnut-ignore-restore-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return { root, home: p.join(root, '.open-walnut') };
});

vi.mock('../../src/constants.js', async () => {
  const { createMockConstants } = await import('../helpers/mock-constants.js');
  return createMockConstants('walnut-ignore-restore', { WALNUT_HOME: dirs.home });
});

import { commitIfDirty, endGitQuiet, ensureCriticalIgnores, ensureRepo, git, quietGitWriters } from '../../src/integrations/git-sync.js';

const ignored = (rel: string): boolean => {
  try { execFileSync('git', ['-C', dirs.home, 'check-ignore', '-q', rel]); return true; } catch { return false; }
};

beforeEach(() => {
  fs.rmSync(dirs.root, { recursive: true, force: true });
  fs.mkdirSync(dirs.home, { recursive: true });
});

afterEach(() => {
  endGitQuiet(dirs.home);
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

describe('a data repo without its .gitignore at boot', () => {
  it('a promoted copy (a .git, the .gitignore gone): the template comes back at boot, before the first commit', async () => {
    expect(await ensureRepo()).toEqual({ available: true });
    const gi = path.join(dirs.home, '.gitignore');
    const template = fs.readFileSync(gi);
    fs.rmSync(gi);
    fs.mkdirSync(path.join(dirs.home, 'tmp', 'standby-spool'), { recursive: true });
    fs.writeFileSync(path.join(dirs.home, 'tmp', 'standby-spool', 'chunk'), 'x');
    fs.mkdirSync(path.join(dirs.home, 'voice-archive'), { recursive: true });
    fs.writeFileSync(path.join(dirs.home, 'voice-archive', 'a.webm'), 'x');

    expect(await ensureRepo()).toEqual({ available: true });

    expect(fs.readFileSync(gi).equals(template)).toBe(true);
    expect(git('status --porcelain -- .gitignore')).toBe('');
    expect(ignored('tmp/standby-spool/chunk')).toBe(true);
    expect(ignored('voice-archive/a.webm')).toBe(true);
  });

  it('an existing repo that never had one (made by a bare `git init`): the template', async () => {
    execFileSync('git', ['init', '-q', dirs.home]);
    fs.mkdirSync(path.join(dirs.home, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(dirs.home, 'notes', 'a.md'), 'a\n');
    expect(await ensureRepo()).toEqual({ available: true });
    expect(fs.existsSync(path.join(dirs.home, '.gitignore'))).toBe(true);
    expect(ignored('tmp/x')).toBe(true);
    expect(ignored('voice-archive/a.webm')).toBe(true);
    expect(ignored('notes/a.md')).toBe(false);
  });

  it('a HEAD that committed its deletion: the template too', async () => {
    expect(await ensureRepo()).toEqual({ available: true });
    git('rm -q --cached -- .gitignore');
    git('commit -q -m "gone"');
    fs.rmSync(path.join(dirs.home, '.gitignore'));
    expect(await ensureRepo()).toEqual({ available: true });
    expect(ignored('tmp/x')).toBe(true);
    expect(ignored('voice-archive/a.webm')).toBe(true);
  });

  it('a home quiet for a leader switch\'s stop: nothing is written (the next leader\'s boot writes it)', async () => {
    expect(await ensureRepo()).toEqual({ available: true });
    fs.rmSync(path.join(dirs.home, '.gitignore'));
    await quietGitWriters(dirs.home, { budgetMs: 0 });
    ensureCriticalIgnores();
    expect(fs.existsSync(path.join(dirs.home, '.gitignore'))).toBe(false);
    expect((await ensureRepo()).available).toBe(false);
    expect(fs.existsSync(path.join(dirs.home, '.gitignore'))).toBe(false);
  });

  it('gone while the server runs: the next commit writes it back first, and commits neither its deletion nor what it ignores', async () => {
    expect(await ensureRepo()).toEqual({ available: true });
    const gi = path.join(dirs.home, '.gitignore');
    const template = fs.readFileSync(gi);
    fs.rmSync(gi);
    fs.mkdirSync(path.join(dirs.home, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(dirs.home, 'tmp', 'scratch'), 'x');
    fs.mkdirSync(path.join(dirs.home, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(dirs.home, 'notes', 'a.md'), 'a\n');
    await commitIfDirty();
    expect(fs.readFileSync(gi).equals(template)).toBe(true);
    const files = git('ls-files').split('\n');
    expect(files).toContain('.gitignore');
    expect(files).toContain('notes/a.md');
    expect(files.filter((f) => f.startsWith('tmp/'))).toEqual([]);
  });

  it('one that has its .gitignore: left as it is', async () => {
    expect(await ensureRepo()).toEqual({ available: true });
    const gi = path.join(dirs.home, '.gitignore');
    const before = fs.readFileSync(gi, 'utf8');
    expect(await ensureRepo()).toEqual({ available: true });
    expect(fs.readFileSync(gi, 'utf8')).toBe(before);
  });
});
