/**
 * Write-side conflict-marker guard — regression suite for the 2026-08-22
 * incident in the data repo.
 *
 * Mechanism: an orphaned-rebase recovery snapshotted a worktree whose files
 * still held git conflict markers, and the 30s auto-save committed that marker
 * text as the real content of `config/share/ui-prefs.json` and of a conversation
 * file. Both then failed every `JSON.parse`: hours of 500s on /api/ui-prefs plus
 * six crashes of a bus subscriber.
 *
 * The rule these tests pin: marker text is never data, so no auto-save,
 * merge-resolution or rescue path may leave it as a JSON file's live content.
 * Real git repos and real conflicted rebases throughout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-markerguard-test'));

import {
  initSync,
  commitIfDirty,
  healConflictMarkeredJsonFiles,
  healConflictMarkeredJsonFromStatus,
  recoverOrphanedGitSurgery,
  resetSyncGuardForTest,
  MAX_MARKER_SCAN_FILES,
  ORPHAN_SURGERY_MIN_AGE_MS,
} from '../../src/integrations/git-sync.js';
import { WALNUT_HOME } from '../../src/constants.js';

const MARKERED = [
  '{',
  '<<<<<<< HEAD',
  '  "theme": "dark"',
  '||||||| merged common ancestors',
  '  "theme": "base"',
  '=======',
  '  "theme": "light"',
  '>>>>>>> origin/main',
  '}',
].join('\n');

let repo: string;

function run(cmd: string, cwd = repo): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** Read a path as committed at HEAD (null when it is not in the tree). */
function showHead(rel: string): string | null {
  try {
    return execSync(`git show HEAD:${rel}`, { cwd: repo, encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

async function writeFile(rel: string, content: string): Promise<string> {
  const full = path.join(repo, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, 'utf-8');
  return full;
}

beforeEach(async () => {
  repo = WALNUT_HOME;
  await fsp.rm(repo, { recursive: true, force: true });
  await fsp.mkdir(repo, { recursive: true });
  resetSyncGuardForTest();
  initSync(); // real repo + .gitignore + initial commit
  run('git config user.email t@t && git config user.name t');
});

afterEach(async () => {
  await fsp.rm(repo, { recursive: true, force: true });
});

describe('commitIfDirty (the auto-save path that committed the incident)', () => {
  it('restores the last valid version instead of committing marker text', async () => {
    const rel = 'config/share/ui-prefs.json';
    await writeFile(rel, JSON.stringify({ theme: 'dark', panel: 320 }, null, 2));
    run('git add -A && git commit -q -m good');

    // What the rescue left behind on disk.
    await writeFile(rel, MARKERED);
    // Returns false, and that IS the fix working: the restore puts the file back
    // to exactly its HEAD content, so nothing is left to stage. The marker text
    // never reaches the index at all.
    expect(await commitIfDirty()).toBe(false);

    // Live file AND the committed blob both parse.
    const onDisk = await fsp.readFile(path.join(repo, rel), 'utf-8');
    expect(JSON.parse(onDisk)).toEqual({ theme: 'dark', panel: 320 });
    expect(JSON.parse(showHead(rel)!)).toEqual({ theme: 'dark', panel: 320 });
    expect(showHead(rel)).not.toContain('<<<<<<<');
  });

  it('quarantines a markered file with no valid history and never tracks the sidecar', async () => {
    const rel = 'conversations/general/conv-1.json';
    // Only ever committed as non-JSON → nothing in history parses.
    await writeFile(rel, 'not json at all\n');
    run('git add -A && git commit -q -m seed');
    await writeFile(rel, MARKERED);

    await commitIfDirty();

    // Live file is gone → readers fall back cleanly instead of throwing.
    await expect(fsp.stat(path.join(repo, rel))).rejects.toThrow();
    const parked = (await fsp.readdir(path.join(repo, 'conversations', 'general')))
      .filter((f) => f.includes('.conflicted-'));
    expect(parked).toHaveLength(1);
    // The forensic sidecar must never enter the index (gitignored).
    expect(run('git ls-files')).not.toContain('.conflicted-');
  });

  it('leaves clean JSON and non-JSON files completely alone', async () => {
    await writeFile('tasks/tasks.json', JSON.stringify({ tasks: [] }));
    // A markdown note that legitimately documents markers must not be rewritten.
    await writeFile('notes/howto.md', `explain a conflict\n${MARKERED}\n`);
    expect(await commitIfDirty()).toBe(true);

    expect(JSON.parse(showHead('tasks/tasks.json')!)).toEqual({ tasks: [] });
    expect(showHead('notes/howto.md')).toContain('<<<<<<< HEAD');
    expect((await fsp.readdir(path.join(repo, 'notes')))).toEqual(['howto.md']);
  });
});

describe('healConflictMarkeredJson* helpers', () => {
  it('scans only changed .json paths from a porcelain snapshot', async () => {
    await writeFile('a.json', JSON.stringify({ a: 1 }));
    await writeFile('b.md', MARKERED);
    const result = await healConflictMarkeredJsonFromStatus(
      [' M a.json', ' M b.md', ' D gone.json'],
      'test',
    );
    expect(result.scanned).toBe(1); // a.json only: b.md filtered, gone.json missing
    expect(result.restored).toEqual([]);
  });

  it('caps the scan so one tick can never fan out over thousands of files', async () => {
    const lines: string[] = [];
    for (let i = 0; i < MAX_MARKER_SCAN_FILES + 5; i++) {
      await writeFile(`bulk/f${i}.json`, JSON.stringify({ i }));
      lines.push(` M bulk/f${i}.json`);
    }
    const result = await healConflictMarkeredJsonFromStatus(lines, 'test');
    expect(result.scanned).toBe(MAX_MARKER_SCAN_FILES);
  });

  it('is a no-op for a path that does not exist', async () => {
    const result = await healConflictMarkeredJsonFiles(['nope.json'], 'test');
    expect(result).toEqual({ scanned: 0, restored: [], quarantined: [] });
  });
});

describe('orphaned-rebase rescue (where the markers came from)', () => {
  /** Drive the repo into a REAL conflicted rebase over a JSON data file. */
  async function startConflictedRebaseOnJson(rel: string): Promise<void> {
    await writeFile(rel, JSON.stringify({ theme: 'base' }, null, 2));
    run('git add -A && git commit -q -m base');
    run('git checkout -q -b side');
    await writeFile(rel, JSON.stringify({ theme: 'side' }, null, 2));
    run('git commit -qam side');
    run('git checkout -q main');
    await writeFile(rel, JSON.stringify({ theme: 'main' }, null, 2));
    run('git commit -qam main');
    try {
      run('git rebase side');
    } catch {
      // Expected: the conflict strands .git/rebase-merge with markers on disk.
    }
  }

  it('never lets marker text reach the live file or the rescue history', async () => {
    const rel = 'config/share/ui-prefs.json';
    await startConflictedRebaseOnJson(rel);

    // Confirm the precondition the incident started from.
    expect(await fsp.readFile(path.join(repo, rel), 'utf-8')).toContain('<<<<<<<');

    // Age the surgery state so it counts as orphaned (no live owner).
    const stateDir = path.join(repo, '.git', 'rebase-merge');
    const old = new Date(Date.now() - ORPHAN_SURGERY_MIN_AGE_MS - 60_000);
    await fsp.utimes(stateDir, old, old);

    const result = await recoverOrphanedGitSurgery();
    expect(result.recovered).toBe(true);
    expect(result.kind).toBe('rebase');

    // Live file parses…
    const live = await fsp.readFile(path.join(repo, rel), 'utf-8');
    expect(live).not.toContain('<<<<<<<');
    expect(() => JSON.parse(live)).not.toThrow();

    // …and so does what the rescue committed on both branches it left behind.
    for (const ref of ['HEAD', result.rescueBranch!]) {
      const blob = execSync(`git show ${ref}:${rel}`, { cwd: repo, encoding: 'utf-8', timeout: 30_000 });
      expect(blob).not.toContain('<<<<<<<');
      expect(() => JSON.parse(blob)).not.toThrow();
    }

    // Sync is unfrozen: the next auto-save works and stays marker-free.
    await commitIfDirty();
    expect(showHead(rel)).not.toContain('<<<<<<<');
  });
});
