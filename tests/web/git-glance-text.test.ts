/**
 * The words and numbers of a session's git glance (web/src/utils/git-glance-text.ts).
 */
import { describe, expect, it } from 'vitest';
import type { GitRepoStatus, SessionGitGlance } from '../../web/src/api/session-git-status';
import { changedChipTitle, pillBranchText, compactCount, gitGlanceTitle, summarizeGitGlance, branchLabel } from '../../web/src/utils/git-glance-text';

function repo(over: Partial<GitRepoStatus> = {}): GitRepoStatus {
  return { repoRoot: '/w/app', branch: 'main', head: 'abcdef123', upstream: 'origin/main', ahead: 0, behind: 0, files: 0, untracked: 0, conflicted: 0, insertions: 0, deletions: 0, ...over };
}
const g = (repos: GitRepoStatus[], extra: Partial<SessionGitGlance> = {}): SessionGitGlance => ({ sessionId: 's', repos, changedFiles: null, checkedAt: '2026-11-04T00:00:00Z', ...extra });

describe('summarizeGitGlance', () => {
  it('no repo is nothing to show', () => {
    expect(summarizeGitGlance(null)).toBeNull();
    expect(summarizeGitGlance(g([]))).toBeNull();
  });

  it('a clean, pushed branch is clean', () => {
    expect(summarizeGitGlance(g([repo()]))).toMatchObject({ clean: true, files: 0, ahead: 0 });
  });

  it('sums every repo, and the main repo names the branch', () => {
    const s = summarizeGitGlance(g([
      repo({ branch: 'feature/x', files: 2, untracked: 1, insertions: 10, deletions: 3, ahead: 1 }),
      repo({ repoRoot: '/w/lib', files: 1, insertions: 1, deletions: 1, ahead: null, behind: null }),
    ]))!;
    expect(s).toMatchObject({ branch: 'feature/x', files: 3, untracked: 1, insertions: 11, deletions: 4, ahead: 1, behind: 0, extraRepos: 1, clean: false });
  });

  it('unpushed alone is not clean; unknown ahead (no remote) with no changes is', () => {
    expect(summarizeGitGlance(g([repo({ ahead: 2 })]))!.clean).toBe(false);
    expect(summarizeGitGlance(g([repo({ ahead: null, behind: null, upstream: null })]))!.clean).toBe(true);
  });

  it('a detached HEAD reads as such', () => {
    expect(branchLabel(summarizeGitGlance(g([repo({ branch: null, ahead: null })]))!)).toBe('detached at abcdef1');
  });
});

describe('titles', () => {
  it('spells out every number', () => {
    const glance = g([repo({ files: 3, untracked: 1, insertions: 12, deletions: 4, ahead: 2, behind: 1 })], { unavailable: 'host_offline' });
    const t = gitGlanceTitle(glance, summarizeGitGlance(glance)!);
    expect(t).toContain('app: branch main, tracking origin/main');
    expect(t).toContain('3 changed files not committed, 1 new');
    expect(t).toContain('12 lines added, 4 removed');
    expect(t).toContain('2 commits not pushed');
    expect(t).toContain('1 commit on origin/main not pulled');
    expect(t).toContain('last reading');
  });

  it('the Changed chip says what its number counts', () => {
    expect(changedChipTitle(null)).toMatch(/^See the files this session changed/);
    // Set against git's count, which counts something else (what is not committed yet).
    expect(changedChipTitle(g([repo()], { changedFiles: 1 }))).toMatch(/^This session changed 1 file, all committed\. Click to see them/);
    expect(changedChipTitle(g([repo({ files: 2 })], { changedFiles: 4 }))).toMatch(/^This session changed 4 files\. Its repo has 2 uncommitted files\./);
    expect(changedChipTitle(g([repo({ files: 1 }), repo({ repoRoot: '/w/b' })], { changedFiles: 3 }))).toContain('Its repos have 1 uncommitted file.');
    // More uncommitted than the session changed: never "13 files (14 still uncommitted)".
    expect(changedChipTitle(g([repo({ files: 14 })], { changedFiles: 13 }))).toMatch(/^This session changed 13 files\. Its repo has 14 uncommitted files \(some changed outside this session\)\./);
    expect(changedChipTitle(g([repo({ files: 0 })], { changedFiles: 0 }))).toMatch(/^This session has not changed any files yet\./);
  });

  it('a pill names a detached HEAD by its short sha', () => {
    expect(pillBranchText(summarizeGitGlance(g([repo({ branch: null, head: '0713ad5c1' })]))!)).toBe('0713ad5');
    expect(pillBranchText(summarizeGitGlance(g([repo()]))!)).toBe('main');
  });
});

it('compactCount', () => {
  expect([0, 999, 1000, 1234, 15_400, 999_499, 2_500_000].map(compactCount)).toEqual(['0', '999', '1k', '1.2k', '15k', '999k', '2.5m']);
});
