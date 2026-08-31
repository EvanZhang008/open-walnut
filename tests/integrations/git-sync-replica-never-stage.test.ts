/**
 * The replica may never author a commit for primary-authoritative data.
 *
 * Incident (2026-08-30): the cloud replica's 30s auto-commit committed its own
 * older copy of `human-inbox/index.json` over the primary's newer one, and the
 * merge kept the replica's version — a letter the human had already read came
 * back unread. The replica has no authority there at all: every
 * `/api/v1/human-inbox` route on it relays to the primary, so its local copy is a
 * read-only mirror it received over git-sync, and the only commit it can produce
 * against that mirror is a revert.
 *
 * The fix is per-BOX, not per-file, which is the whole subtlety: the PRIMARY must
 * keep committing this data (git is its only backup), so the rule cannot live in
 * the .gitignore template. It lives in the staging step, gated on CLOUD_MODE.
 *
 * Everything here runs against a REAL git repo in an isolated WALNUT_HOME and
 * drives the actual staging entry point (`stageAllForCommit`) — the assertions
 * read `git diff --cached` and `git status`, never a reimplementation of them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-never-stage'));

import {
  CLOUD_NEVER_STAGE_DIRS,
  initSync,
  stageAllArgs,
  stageAllForCommit,
} from '../../src/integrations/git-sync.js';
import { WALNUT_HOME } from '../../src/constants.js';

/**
 * Test-side reader over git output: does this path live under a never-author dir?
 *
 * Deliberately NOT imported from the production module — nothing in production
 * needs it, because the exclusion is expressed as a git PATHSPEC and the restore
 * asks git for a path-scoped status. A predicate exported from src/ for tests only
 * would imply a caller that does not exist.
 */
function underNeverStageDir(file: string): boolean {
  return CLOUD_NEVER_STAGE_DIRS.some(dir => file === dir || file.startsWith(`${dir}/`));
}

function gitOut(args: string): string {
  return execSync(`git ${args}`, { cwd: WALNUT_HOME, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function stagedPaths(): string[] {
  const out = gitOut('diff --cached --name-only');
  return out.length === 0 ? [] : out.split('\n').map(l => l.trim()).filter(Boolean);
}

/**
 * Dirty paths, parsed off UNTRIMMED porcelain output on purpose: a modified-but-
 * unstaged file's status is ` M path`, so trimming the whole output eats the
 * leading space of the FIRST line and a fixed `slice(3)` then loses a character
 * of the filename. That trap is exactly why the production restore asks git for a
 * path-scoped status instead of re-parsing a caller's snapshot.
 */
function dirtyPaths(): string[] {
  const out = execSync('git status --porcelain -uall', {
    cwd: WALNUT_HOME, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  return out.split('\n').filter(l => l.length > 3).map(l => l.slice(3).trim());
}

function write(rel: string, content: string): void {
  const full = path.join(WALNUT_HOME, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

function read(rel: string): string {
  return fs.readFileSync(path.join(WALNUT_HOME, rel), 'utf-8');
}

/** A letter index and a body, plus one ordinary synced store to compare against. */
function writeMixedDirt(): void {
  write('human-inbox/index.json', '{"version":1,"lastUpdated":"2026-08-30T00:00:00.000Z","letters":[]}');
  write('human-inbox/bodies/lt-abcdef-112233.md', '# a letter body\n');
  write('tasks/tasks.json', '{"tasks":[]}');
  write('notifications.json', '{"feed":[]}');
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  // A repo with one commit, so HEAD exists (the restore step needs something to
  // restore to) and the mocked CLOUD_MODE=false keeps init on the primary shape.
  initSync();
  write('seed.txt', 'seed\n');
  gitOut('add -A');
  gitOut('commit -q -m seed');
});

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('which paths the rule covers', () => {
  it('excludes the letter store and nothing that merely looks like it', async () => {
    // Asserted through REAL git staging, not through a path predicate: the rule is
    // a git pathspec, so what it actually matches is git's answer, and a lookalike
    // sibling directory is the case a sloppy pathspec (`human-inbox*`) would eat.
    writeMixedDirt();
    write('human-inboxes/index.json', '{"not":"the letter store"}');

    await stageAllForCommit({ cloudMode: true });

    const staged = stagedPaths();
    expect(staged).toContain('human-inboxes/index.json');
    expect(staged).toContain('tasks/tasks.json');
    expect(staged.filter(underNeverStageDir)).toEqual([]);
  });

  it('does NOT cover notifications.json — the replica genuinely authors that', async () => {
    // routes/notifications.ts writes the LOCAL store with no relay, and
    // session-tracker / hooks / plugins all record into it on the box they run
    // on. Refusing to commit it would silently discard the phone's own mark-read
    // and dismiss actions instead of syncing them, which is a different bug, not
    // the same fix.
    expect(CLOUD_NEVER_STAGE_DIRS).not.toContain('notifications.json');
    writeMixedDirt();

    await stageAllForCommit({ cloudMode: true });

    expect(stagedPaths()).toContain('notifications.json');
  });

  it('keeps the letter store OUT of the ignore template, so the primary still backs it up', () => {
    const gitignore = read('.gitignore');
    expect(gitignore).not.toMatch(/human-inbox/);
    // Proof the primary really does track it: the primary-shaped pass below
    // stages it, which an ignore rule would have made impossible.
  });
});

describe('a replica-shaped staging pass', () => {
  it('stages ordinary data and never a letter path', async () => {
    writeMixedDirt();

    await stageAllForCommit({ cloudMode: true });

    const staged = stagedPaths();
    expect(staged).toContain('tasks/tasks.json');
    expect(staged).toContain('notifications.json');
    expect(staged.filter(underNeverStageDir)).toEqual([]);
  });

  it('drops letter paths that were ALREADY in the index', async () => {
    writeMixedDirt();
    // A box mid-upgrade: an older build's `add -A` already staged them.
    gitOut('add -A');
    expect(stagedPaths().filter(underNeverStageDir).length).toBeGreaterThan(0);

    await stageAllForCommit({ cloudMode: true });

    expect(stagedPaths().filter(underNeverStageDir)).toEqual([]);
    expect(stagedPaths()).toContain('tasks/tasks.json');
  });

  it('restores a TRACKED letter file it diverged on, so the next pull is not blocked', async () => {
    // The primary's copy, committed and pulled by the replica.
    write('human-inbox/index.json', '{"version":1,"lastUpdated":"2026-08-30T10:00:00.000Z","letters":["primary"]}');
    gitOut('add -A');
    gitOut('commit -q -m "primary letter state"');
    const fromPrimary = read('human-inbox/index.json');

    // The replica's disk drifts (a torn checkout, a stale snapshot, an old build).
    write('human-inbox/index.json', '{"version":1,"lastUpdated":"2026-08-30T09:00:00.000Z","letters":[]}');
    write('tasks/tasks.json', '{"tasks":[]}');

    await stageAllForCommit({ cloudMode: true });

    // Nothing letter-shaped staged…
    expect(stagedPaths().filter(underNeverStageDir)).toEqual([]);
    // …the primary's content is back on disk…
    expect(read('human-inbox/index.json')).toBe(fromPrimary);
    // …and, the point of the restore: NOTHING under the path is left dirty.
    // `git rebase` refuses outright with unstaged changes ("cannot rebase: You
    // have unstaged changes") and `merge` refuses to overwrite them, so a
    // permanently-dirty excluded file would freeze the replica's pulls too — not
    // just its letters.
    expect(dirtyPaths().filter(underNeverStageDir)).toEqual([]);
    expect(stagedPaths()).toContain('tasks/tasks.json');
  });

  it('leaves an untracked local letter file alone (it blocks nothing)', async () => {
    write('human-inbox/orphan.md', 'local only\n');

    await stageAllForCommit({ cloudMode: true });

    expect(stagedPaths()).toEqual([]);
    expect(fs.existsSync(path.join(WALNUT_HOME, 'human-inbox/orphan.md'))).toBe(true);
  });
});

describe('a primary-shaped staging pass', () => {
  it('still stages the letter store, deletions included', async () => {
    writeMixedDirt();

    await stageAllForCommit({ cloudMode: false });

    const staged = stagedPaths();
    expect(staged).toContain('human-inbox/index.json');
    expect(staged).toContain('human-inbox/bodies/lt-abcdef-112233.md');
    expect(staged).toContain('tasks/tasks.json');

    gitOut('commit -q -m "primary backup"');
    // A deletion is a change too: `add -A -- .` on the replica shape must not
    // quietly stop recording removals for the paths it DOES cover.
    fs.rmSync(path.join(WALNUT_HOME, 'tasks/tasks.json'));
    await stageAllForCommit({ cloudMode: true });
    expect(gitOut('diff --cached --name-status')).toMatch(/^D\s+tasks\/tasks\.json$/m);
  });

  it('uses the plain add on the primary and an excluding one on the replica', () => {
    expect(stageAllArgs(false)).toBe('add -A');
    expect(stageAllArgs(true)).toContain(":(exclude)human-inbox'");
  });
});
