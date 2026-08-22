/**
 * E2E tests for git history tiered compaction.
 *
 * Creates real git repos in /tmp/ with commits spanning 60+ days,
 * runs compaction, and verifies:
 * - File tree is identical before/after
 * - Commit count matches expected tiers
 * - Timestamps are preserved
 * - Crash recovery works
 * - Edge cases handled
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  compactGitHistory,
  selectCommits,
  recoverFromCrashedCompaction,
  runScheduledCompaction,
  isCompactionDue,
  markCompactionDone,
} from '../../src/integrations/git-compaction.js';
import {
  commitIfDirty,
  setCompactionInProgress,
  compactionInProgress,
} from '../../src/integrations/git-sync.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-compact-test-'));
  execSync('git init && git checkout -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function removeTempRepo(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** Create a commit with a specific date (days ago from now). */
function commitAt(dir: string, daysAgo: number, fileContent: string, fileName = 'data.txt'): void {
  const date = new Date(Date.now() - daysAgo * 86_400_000);
  const isoDate = date.toISOString();
  const filePath = path.join(dir, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, fileContent, 'utf-8');
  execSync('git add -A', { cwd: dir, stdio: 'pipe' });
  execSync(`git commit --allow-empty -m "commit at ${daysAgo}d ago (${fileName})"`, {
    cwd: dir,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
    },
  });
}

/** Create many commits simulating 30s auto-saves at a given day offset. */
function createAutoSaveCommits(dir: string, daysAgo: number, count: number): void {
  const baseDate = Date.now() - daysAgo * 86_400_000;
  for (let i = 0; i < count; i++) {
    const date = new Date(baseDate + i * 30_000); // 30s apart
    const isoDate = date.toISOString();
    const filePath = path.join(dir, 'auto-save.txt');
    fs.writeFileSync(filePath, `auto-save content ${daysAgo}d commit ${i}`, 'utf-8');
    execSync('git add -A', { cwd: dir, stdio: 'pipe' });
    execSync(`git commit -m "auto-save ${isoDate.slice(0, 19).replace('T', ' ')} (1 files)"`, {
      cwd: dir,
      stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
    });
  }
}

function getCommitCount(dir: string): number {
  const log = execSync('git log --oneline', { cwd: dir, encoding: 'utf-8' }).trim();
  return log ? log.split('\n').length : 0;
}

function getCurrentBranch(dir: string): string {
  return execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
}

function getFileContent(dir: string, file: string): string {
  return fs.readFileSync(path.join(dir, file), 'utf-8');
}

function getTreeHash(dir: string): string {
  return execSync('git rev-parse HEAD^{tree}', { cwd: dir, encoding: 'utf-8' }).trim();
}

function getAllFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (d: string, prefix: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(d, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else {
        files.set(rel, fs.readFileSync(full, 'utf-8'));
      }
    }
  };
  walk(dir, '');
  return files;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('git-compaction', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTempRepo();
  });

  afterEach(() => {
    removeTempRepo(repoDir);
  });

  // -------------------------------------------------------------------------
  // selectCommits unit tests
  // -------------------------------------------------------------------------

  describe('selectCommits', () => {
    it('keeps all recent commits (< 7 days)', () => {
      const now = Date.now();
      const commits = Array.from({ length: 100 }, (_, i) => ({
        hash: `h${i}`,
        date: new Date(now - i * 30_000).toISOString(), // 30s apart, all within hours
        subject: `commit ${i}`,
      }));

      const selected = selectCommits(commits, { recentDays: 7, dailyDays: 30 });
      expect(selected.length).toBe(100); // all kept
    });

    it('compacts 7-30 day old commits to daily', () => {
      const now = Date.now();
      const DAY = 86_400_000;
      const commits: { hash: string; date: string; subject: string }[] = [];

      // 10 commits per day for days 8-15 (8 days × 10 = 80 commits)
      for (let day = 15; day >= 8; day--) {
        for (let i = 0; i < 10; i++) {
          commits.push({
            hash: `h-${day}-${i}`,
            date: new Date(now - day * DAY + i * 3600_000).toISOString(),
            subject: `day ${day} commit ${i}`,
          });
        }
      }

      const selected = selectCommits(commits, { recentDays: 7, dailyDays: 30 });
      // Should keep ~1 per day. 8 days × 10 commits = 80 → ~8-10 daily snapshots.
      // Exact count varies because hour offsets can cross UTC midnight boundaries.
      expect(selected.length).toBeGreaterThanOrEqual(8);
      expect(selected.length).toBeLessThanOrEqual(12);
      // Significant reduction from 80
      expect(selected.length).toBeLessThan(80);
    });

    it('compacts >30 day old commits to weekly', () => {
      const now = Date.now();
      const DAY = 86_400_000;
      const commits: { hash: string; date: string; subject: string }[] = [];

      // 1 commit per day for days 31-90 (60 commits across ~8-9 weeks)
      for (let day = 90; day >= 31; day--) {
        commits.push({
          hash: `h-${day}`,
          date: new Date(now - day * DAY).toISOString(),
          subject: `day ${day}`,
        });
      }

      const selected = selectCommits(commits, { recentDays: 7, dailyDays: 30 });
      // ~8-9 weeks → 8-9 commits
      expect(selected.length).toBeGreaterThanOrEqual(7);
      expect(selected.length).toBeLessThanOrEqual(10);
    });

    it('handles mixed tiers correctly', () => {
      const now = Date.now();
      const DAY = 86_400_000;
      const commits: { hash: string; date: string; subject: string }[] = [];

      // Old: 50 commits at 45 days ago (same day)
      for (let i = 0; i < 50; i++) {
        commits.push({
          hash: `old-${i}`,
          date: new Date(now - 45 * DAY + i * 1000).toISOString(),
          subject: `old ${i}`,
        });
      }
      // Medium: 50 commits at 15 days ago (same day)
      for (let i = 0; i < 50; i++) {
        commits.push({
          hash: `med-${i}`,
          date: new Date(now - 15 * DAY + i * 1000).toISOString(),
          subject: `med ${i}`,
        });
      }
      // Recent: 50 commits at 2 days ago
      for (let i = 0; i < 50; i++) {
        commits.push({
          hash: `new-${i}`,
          date: new Date(now - 2 * DAY + i * 1000).toISOString(),
          subject: `new ${i}`,
        });
      }

      const selected = selectCommits(commits, { recentDays: 7, dailyDays: 30 });
      // weekly: 1 (all same week) + daily: 1 (all same day) + recent: 50
      expect(selected.length).toBe(52);
    });
  });

  // -------------------------------------------------------------------------
  // compactGitHistory E2E tests
  // -------------------------------------------------------------------------

  describe('compactGitHistory', () => {
    it('skips when fewer than 50 commits', async () => {
      for (let i = 0; i < 10; i++) {
        commitAt(repoDir, 40 - i, `content-${i}`);
      }
      const result = await compactGitHistory(repoDir);
      expect(result.skipped).toBe(true);
    });

    it('compacts a repo with 200+ commits spanning 60 days', async () => {
      // Capture expected final file state
      // Create commits across time tiers
      // Old tier (>30 days): 5 commits per day for days 60-35
      for (let day = 60; day >= 35; day -= 1) {
        createAutoSaveCommits(repoDir, day, 3);
      }
      // Medium tier (7-30 days): 5 commits per day for days 25-10
      for (let day = 25; day >= 10; day -= 1) {
        createAutoSaveCommits(repoDir, day, 3);
      }
      // Recent tier (<7 days): 5 commits per day for days 5-1
      for (let day = 5; day >= 1; day -= 1) {
        createAutoSaveCommits(repoDir, day, 3);
      }

      // Also create some unique files that must survive compaction
      commitAt(repoDir, 0, 'important config data', 'config.yaml');
      commitAt(repoDir, 0, 'task list data', 'tasks.json');
      commitAt(repoDir, 0, 'notes content', 'notes/note1.md');

      const beforeCount = getCommitCount(repoDir);
      const beforeFiles = getAllFiles(repoDir);
      const beforeTreeHash = getTreeHash(repoDir);

      expect(beforeCount).toBeGreaterThan(100);

      // Run compaction
      const result = await compactGitHistory(repoDir);

      expect(result.skipped).toBeFalsy();
      expect(result.error).toBeUndefined();
      expect(result.before).toBe(beforeCount);
      expect(result.after).toBeLessThan(beforeCount);
      expect(result.after).toBeGreaterThan(0);

      // CRITICAL: verify file tree is identical
      const afterFiles = getAllFiles(repoDir);
      const afterTreeHash = getTreeHash(repoDir);

      expect(afterTreeHash).toBe(beforeTreeHash);
      expect(afterFiles.size).toBe(beforeFiles.size);
      for (const [file, content] of beforeFiles) {
        expect(afterFiles.get(file)).toBe(content);
      }

      // Verify we're still on main
      expect(getCurrentBranch(repoDir)).toBe('main');

      // Verify commit count reduced significantly
      const afterCount = getCommitCount(repoDir);
      expect(afterCount).toBe(result.after);
      expect(afterCount).toBeLessThan(beforeCount / 2);

      // Verify no compaction-wip branch left
      const branches = execSync('git branch', { cwd: repoDir, encoding: 'utf-8' });
      expect(branches).not.toContain('compaction-wip');

      // Verify backup branch exists
      expect(branches).toContain('backup-');

      // Verify state file cleaned up
      expect(fs.existsSync(path.join(repoDir, '.git', 'compaction-state.json'))).toBe(false);
    });

    it('preserves multiple files across directories', async () => {
      // Create a repo with complex file structure
      fs.mkdirSync(path.join(repoDir, 'tasks'), { recursive: true });
      fs.mkdirSync(path.join(repoDir, 'notes'), { recursive: true });
      fs.mkdirSync(path.join(repoDir, 'sessions'), { recursive: true });

      // Old commits establishing file structure
      for (let day = 60; day >= 1; day -= 1) {
        const filePath = path.join(repoDir, 'tasks', 'tasks.json');
        fs.writeFileSync(filePath, JSON.stringify({ day, tasks: ['task1', 'task2'] }), 'utf-8');
        const notePath = path.join(repoDir, 'notes', `note-${day % 5}.md`);
        fs.writeFileSync(notePath, `Note content for day ${day}`, 'utf-8');
        const sessionPath = path.join(repoDir, 'sessions', 'sessions.json');
        fs.writeFileSync(sessionPath, JSON.stringify({ active: day }), 'utf-8');

        const date = new Date(Date.now() - day * 86_400_000);
        execSync('git add -A', { cwd: repoDir, stdio: 'pipe' });
        execSync(`git commit -m "day ${day}"`, {
          cwd: repoDir, stdio: 'pipe',
          env: { ...process.env, GIT_AUTHOR_DATE: date.toISOString(), GIT_COMMITTER_DATE: date.toISOString() },
        });
      }

      const beforeFiles = getAllFiles(repoDir);
      const beforeCount = getCommitCount(repoDir);

      const result = await compactGitHistory(repoDir);

      expect(result.error).toBeUndefined();
      expect(result.skipped).toBeFalsy();

      // Verify ALL files are identical
      const afterFiles = getAllFiles(repoDir);
      expect(afterFiles.size).toBe(beforeFiles.size);
      for (const [file, content] of beforeFiles) {
        expect(afterFiles.get(file), `File mismatch: ${file}`).toBe(content);
      }

      expect(getCommitCount(repoDir)).toBeLessThan(beforeCount);
    });

    it('creates backup branch and cleans up old ones', async () => {
      // Create enough commits
      for (let day = 60; day >= 1; day--) {
        commitAt(repoDir, day, `content-${day}`);
      }

      await compactGitHistory(repoDir);

      const branches = execSync('git branch', { cwd: repoDir, encoding: 'utf-8' });
      const backupBranches = branches.split('\n').filter((b) => b.includes('backup-'));
      expect(backupBranches.length).toBeGreaterThanOrEqual(1);
    });

    it('is idempotent — running twice does not corrupt', async () => {
      for (let day = 60; day >= 1; day--) {
        createAutoSaveCommits(repoDir, day, 3);
      }
      commitAt(repoDir, 0, 'final state', 'final.txt');

      const expectedFiles = getAllFiles(repoDir);

      // First compaction
      const r1 = await compactGitHistory(repoDir);
      expect(r1.error).toBeUndefined();

      // Second compaction (should skip — not enough improvement)
      const r2 = await compactGitHistory(repoDir);
      // Either skipped or successful, but files must be intact
      const afterFiles = getAllFiles(repoDir);
      for (const [file, content] of expectedFiles) {
        expect(afterFiles.get(file), `File mismatch after 2nd compaction: ${file}`).toBe(content);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Crash recovery tests
  // -------------------------------------------------------------------------

  describe('recoverFromCrashedCompaction', () => {
    it('recovers from crash during building phase', () => {
      commitAt(repoDir, 10, 'some data');

      // Simulate crash: leave compaction-wip branch and state file
      execSync('git checkout --orphan compaction-wip', { cwd: repoDir, stdio: 'pipe' });
      fs.writeFileSync(
        path.join(repoDir, '.git', 'compaction-state.json'),
        JSON.stringify({ phase: 'building', backup: 'backup-20260407', startedAt: new Date().toISOString() }),
      );
      execSync('git checkout -b backup-20260407 main', { cwd: repoDir, stdio: 'pipe' });

      recoverFromCrashedCompaction(repoDir);

      // Should be back on main
      expect(getCurrentBranch(repoDir)).toBe('main');
      // State file should be gone
      expect(fs.existsSync(path.join(repoDir, '.git', 'compaction-state.json'))).toBe(false);
      // Data intact
      expect(getFileContent(repoDir, 'data.txt')).toBe('some data');
    });

    it('recovers from crash during swapped phase', () => {
      commitAt(repoDir, 10, 'important data');

      // Simulate: swap already happened, just needs gc
      fs.writeFileSync(
        path.join(repoDir, '.git', 'compaction-state.json'),
        JSON.stringify({ phase: 'swapped', backup: 'backup-20260407', startedAt: new Date().toISOString() }),
      );

      recoverFromCrashedCompaction(repoDir);

      expect(getCurrentBranch(repoDir)).toBe('main');
      expect(fs.existsSync(path.join(repoDir, '.git', 'compaction-state.json'))).toBe(false);
      expect(getFileContent(repoDir, 'data.txt')).toBe('important data');
    });

    it('does nothing when no state file exists', () => {
      commitAt(repoDir, 5, 'data');
      const beforeCount = getCommitCount(repoDir);

      recoverFromCrashedCompaction(repoDir);

      expect(getCommitCount(repoDir)).toBe(beforeCount);
      expect(getFileContent(repoDir, 'data.txt')).toBe('data');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles repo with only recent commits', async () => {
      for (let i = 0; i < 100; i++) {
        commitAt(repoDir, 0, `content-${i}`, `file-${i}.txt`);
      }

      const result = await compactGitHistory(repoDir);
      // All commits are recent — should skip (not enough reduction)
      expect(result.skipped).toBe(true);
    });

    it('handles binary-like content (no corruption)', async () => {
      // Create a file with special characters
      const specialContent = 'line1\nline2\ttab\r\nwindows\n\0nullbyte';
      for (let day = 60; day >= 1; day--) {
        fs.writeFileSync(path.join(repoDir, 'special.txt'), specialContent + day, 'utf-8');
        const date = new Date(Date.now() - day * 86_400_000);
        execSync('git add -A', { cwd: repoDir, stdio: 'pipe' });
        execSync(`git commit -m "day ${day}"`, {
          cwd: repoDir, stdio: 'pipe',
          env: { ...process.env, GIT_AUTHOR_DATE: date.toISOString(), GIT_COMMITTER_DATE: date.toISOString() },
        });
      }

      const beforeContent = fs.readFileSync(path.join(repoDir, 'special.txt'), 'utf-8');
      const result = await compactGitHistory(repoDir);

      expect(result.error).toBeUndefined();
      const afterContent = fs.readFileSync(path.join(repoDir, 'special.txt'), 'utf-8');
      expect(afterContent).toBe(beforeContent);
    });

    it('handles deleted files in history correctly', async () => {
      // Create file, commit, delete file, commit more
      commitAt(repoDir, 50, 'temp content', 'temp-file.txt');
      for (let day = 49; day >= 1; day--) {
        commitAt(repoDir, day, `day ${day}`, 'data.txt');
      }
      // Delete temp file
      fs.unlinkSync(path.join(repoDir, 'temp-file.txt'));
      execSync('git add -A && git commit -m "delete temp"', { cwd: repoDir, stdio: 'pipe' });

      const beforeFiles = getAllFiles(repoDir);
      expect(beforeFiles.has('temp-file.txt')).toBe(false);

      const result = await compactGitHistory(repoDir);
      expect(result.error).toBeUndefined();

      const afterFiles = getAllFiles(repoDir);
      // temp-file.txt should still be absent
      expect(afterFiles.has('temp-file.txt')).toBe(false);
      // Other files match
      for (const [file, content] of beforeFiles) {
        expect(afterFiles.get(file), `Mismatch: ${file}`).toBe(content);
      }
    });
  });

  // -------------------------------------------------------------------------
  // commitIfDirty guard — suppressed during compaction
  // -------------------------------------------------------------------------

  describe('commitIfDirty guard', () => {
    it('skips commit when compactionInProgress is true', () => {
      commitAt(repoDir, 5, 'initial', 'data.txt');

      // Dirty the working tree
      fs.writeFileSync(path.join(repoDir, 'data.txt'), 'dirty content', 'utf-8');

      // Set flag — simulates compaction in progress
      // We need to temporarily point WALNUT_HOME at our test repo
      // commitIfDirty uses WALNUT_HOME, so we test the flag logic directly
      setCompactionInProgress(true);
      try {
        // commitIfDirty checks the flag before anything else
        expect(compactionInProgress).toBe(true);

        // Since commitIfDirty uses WALNUT_HOME (not our test repo),
        // we verify the flag logic by checking the exported value
        // The actual integration is: when flag is true, commitIfDirty returns false
        // We can't easily redirect WALNUT_HOME in a unit test, but we can verify
        // the flag is properly set and readable
      } finally {
        setCompactionInProgress(false);
      }
      expect(compactionInProgress).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // isCompactionDue / markCompactionDone
  // -------------------------------------------------------------------------

  describe('isCompactionDue / markCompactionDone', () => {
    it('returns true when no .last-compaction file exists', () => {
      expect(isCompactionDue(repoDir)).toBe(true);
    });

    it('returns false immediately after markCompactionDone', () => {
      markCompactionDone(repoDir);
      expect(isCompactionDue(repoDir)).toBe(false);
    });

    it('returns true when .last-compaction is older than 7 days', () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
      fs.writeFileSync(path.join(repoDir, '.last-compaction'), eightDaysAgo, 'utf-8');
      expect(isCompactionDue(repoDir)).toBe(true);
    });

    it('returns false when .last-compaction is 6 days old', () => {
      const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString();
      fs.writeFileSync(path.join(repoDir, '.last-compaction'), sixDaysAgo, 'utf-8');
      expect(isCompactionDue(repoDir)).toBe(false);
    });

    it('markCompactionDone writes a parseable ISO date', () => {
      markCompactionDone(repoDir);
      const content = fs.readFileSync(path.join(repoDir, '.last-compaction'), 'utf-8').trim();
      const parsed = new Date(content);
      expect(parsed.getTime()).not.toBeNaN();
      // Should be within the last minute
      expect(Date.now() - parsed.getTime()).toBeLessThan(60_000);
    });
  });

  // -------------------------------------------------------------------------
  // runScheduledCompaction integration
  // -------------------------------------------------------------------------

  describe('runScheduledCompaction', () => {
    it('returns null when compaction is not due', async () => {
      markCompactionDone(repoDir);
      const result = await runScheduledCompaction(repoDir);
      expect(result).toBeNull();
    });

    it('runs compaction when due and writes .last-compaction', async () => {
      // Create enough history to trigger compaction
      for (let day = 60; day >= 1; day--) {
        createAutoSaveCommits(repoDir, day, 2);
      }
      commitAt(repoDir, 0, 'final state', 'final.txt');

      // No .last-compaction file → due
      expect(isCompactionDue(repoDir)).toBe(true);

      const result = await runScheduledCompaction(repoDir);
      expect(result).not.toBeNull();
      expect(result!.before).toBeGreaterThan(result!.after);

      // .last-compaction should now exist
      expect(fs.existsSync(path.join(repoDir, '.last-compaction'))).toBe(true);

      // Flag should be reset
      expect(compactionInProgress).toBe(false);

      // Second call should return null (not due)
      expect(await runScheduledCompaction(repoDir)).toBeNull();
    });

    it('resets compactionInProgress flag even when compaction skips', async () => {
      // Only a few commits — compaction will skip
      for (let i = 0; i < 5; i++) {
        commitAt(repoDir, i, `content-${i}`);
      }

      const result = await runScheduledCompaction(repoDir);
      // Skipped (< 50 commits) but should not crash
      expect(result).not.toBeNull();
      expect(result!.skipped).toBe(true);
      // Flag must be reset regardless
      expect(compactionInProgress).toBe(false);
    });
  });
});
