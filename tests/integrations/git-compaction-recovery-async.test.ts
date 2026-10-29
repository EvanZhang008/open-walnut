/**
 * Compaction crash recovery runs in the SERVER at boot, so it must never block
 * the event loop. 2026-10-27/28: the synchronous version (execSync) froze the
 * loop for 30s at three boots while a git step ran to its timeout beside a held
 * index.lock, and every route waited.
 *
 * These run the real recovery against a real repo with a slow fake `git` first
 * on PATH (it sleeps, then runs the real git), and watch a timer tick while it
 * works. A synchronous git call shows up as a gap as long as the sleep.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recoverFromCrashedCompaction } from '../../src/integrations/git-compaction.js';
import { compactionInProgress, setCompactionInProgress } from '../../src/integrations/git-sync.js';

const REAL_GIT = execSync('command -v git', { encoding: 'utf-8', shell: '/bin/sh' }).trim();

let repoDir: string;
let binDir: string;
let savedPath: string | undefined;

function sh(cmd: string): string {
  return execSync(cmd, { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

/** A `git` that sleeps `seconds` before each call (or only for `onlyFor` subcommands), then runs the real one. */
function installSlowGit(seconds: number, onlyFor?: string): void {
  const match = onlyFor ? `case "$1" in ${onlyFor}) sleep ${seconds} ;; esac` : `sleep ${seconds}`;
  fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh\n${match}\nexec "${REAL_GIT}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
}

/** Simulate a worker killed after the local swap, before the hub took the rewrite. */
function crashAfterSwap(): { original: string } {
  fs.writeFileSync(path.join(repoDir, 'data.txt'), 'two\n');
  sh('git add -A && git commit -qm two');
  const original = sh('git rev-parse main');
  sh('git branch backup-20261028 main');
  const rewritten = sh('git commit-tree main^{tree} -m compacted');
  sh(`git update-ref refs/heads/main ${rewritten}`);
  fs.writeFileSync(
    path.join(repoDir, '.git', 'compaction-state.json'),
    JSON.stringify({ phase: 'swapped', backup: 'backup-20261028', startedAt: new Date().toISOString() }),
  );
  return { original };
}

/**
 * Ticks of a 10ms timer while `work` runs, and the largest gap between them. A
 * fully synchronous `work` lets the timer fire zero times, however loaded the
 * machine is; that is the load-proof half of the check.
 */
async function loopDuring(work: () => Promise<void>): Promise<{ ticks: number; maxGap: number }> {
  let last = Date.now();
  let maxGap = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, 10);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  return { ticks, maxGap: Math.max(maxGap, Date.now() - last) };
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-compact-recover-'));
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-compact-slowgit-'));
  sh('git init -q && git checkout -qb main');
  sh('git config user.email test@test.com && git config user.name Test');
  fs.writeFileSync(path.join(repoDir, 'data.txt'), 'one\n');
  sh('git add -A && git commit -qm one');
  savedPath = process.env.PATH;
  setCompactionInProgress(false);
});

afterEach(() => {
  process.env.PATH = savedPath;
  setCompactionInProgress(false);
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(binDir, { recursive: true, force: true });
});

describe('compaction crash recovery stays off the event loop', () => {
  it('keeps the loop ticking while a slow git runs, and still puts main back', async () => {
    const { original } = crashAfterSwap();
    installSlowGit(1);

    let flagSeenDuringRecovery = false;
    const probe = setInterval(() => { if (compactionInProgress) flagSeenDuringRecovery = true; }, 20);
    const loop = await loopDuring(() => recoverFromCrashedCompaction(repoDir));
    clearInterval(probe);

    // Each of the 7 git steps sleeps 1s. Synchronous, the timer never fires in
    // those 7s and the gap is all of them; async, it keeps firing.
    expect(loop.ticks).toBeGreaterThanOrEqual(5);
    expect(loop.maxGap).toBeLessThan(3_000);
    process.env.PATH = savedPath;
    expect(sh('git rev-parse main')).toBe(original);
    expect(fs.existsSync(path.join(repoDir, '.git', 'compaction-state.json'))).toBe(false);
    // It held the compaction flag (git-sync stands aside) and released it.
    expect(flagSeenDuringRecovery).toBe(true);
    expect(compactionInProgress).toBe(false);
  }, 60_000);

  it('a git step that hangs is cut at its deadline, and recovery goes on', async () => {
    const { original } = crashAfterSwap();
    // Only `checkout` hangs; the 6s budget is generous for the real steps even
    // on a loaded machine, and well under the old execSync's own 30s.
    installSlowGit(60, 'checkout');

    const started = Date.now();
    const loop = await loopDuring(() => recoverFromCrashedCompaction(repoDir, { timeoutMs: 6_000 }));

    // The old execSync waited out its own 30s timeout here, loop frozen.
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(loop.ticks).toBeGreaterThanOrEqual(5);
    process.env.PATH = savedPath;
    expect(sh('git rev-parse main')).toBe(original);
    expect(fs.existsSync(path.join(repoDir, '.git', 'compaction-state.json'))).toBe(false);
  }, 60_000);

  // A killed step settles only when its pipes close; a child that left the
  // process group still holds them. Recovery must not wait for it, or git-sync
  // (which starts after recovery) never starts and backups stop.
  it('a step whose escaped child keeps its pipes open still settles on its deadline', async () => {
    const { original } = crashAfterSwap();
    const pidFile = path.join(binDir, 'escaped.pid');
    // `checkout` leaves a grandchild in its own session holding stdout/stderr for 45s, then exits.
    fs.writeFileSync(path.join(binDir, 'git'), [
      '#!/bin/sh',
      `case "$1" in checkout) perl -e 'use POSIX; exit if fork; POSIX::setsid(); open(my $f, ">", $ARGV[0]); print $f $$; close $f; sleep 45' "${pidFile}"; exit 0 ;; esac`,
      `exec "${REAL_GIT}" "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;

    const started = Date.now();
    try {
      await recoverFromCrashedCompaction(repoDir, { timeoutMs: 3_000 });
      // Settled at the step's deadline plus grace (3s + 5s), long before the child's 45s.
      expect(Date.now() - started).toBeLessThan(30_000);
      process.env.PATH = savedPath;
      expect(sh('git rev-parse main')).toBe(original);
      expect(compactionInProgress).toBe(false);
    } finally {
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf-8')), 'SIGKILL'); } catch { /* gone */ }
    }
  }, 60_000);

  it('a held index.lock does not stop main going back or hang recovery', async () => {
    const { original } = crashAfterSwap();
    fs.writeFileSync(path.join(repoDir, '.git', 'index.lock'), '');

    await recoverFromCrashedCompaction(repoDir, { timeoutMs: 2_000 });

    expect(sh('git rev-parse main')).toBe(original);
    expect(fs.readFileSync(path.join(repoDir, 'data.txt'), 'utf-8')).toBe('two\n');
    expect(fs.existsSync(path.join(repoDir, '.git', 'compaction-state.json'))).toBe(false);
  }, 30_000);

  it('never clears a compaction flag another holder (git maintenance) took', async () => {
    crashAfterSwap();
    setCompactionInProgress(true);

    await recoverFromCrashedCompaction(repoDir);

    expect(compactionInProgress).toBe(true);
  }, 30_000);
});
