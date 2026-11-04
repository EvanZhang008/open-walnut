/**
 * The words and numbers of a session's git glance (web/src/utils/git-glance-text.ts).
 */
import { describe, expect, it } from 'vitest';
import type { GitRepoStatus, SessionGitGlance } from '../../web/src/api/session-git-status';
import { changedChipTitle, compactCount, gitGlanceTitle, summarizeGitGlance, branchLabel } from '../../web/src/utils/git-glance-text';

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
    expect(changedChipTitle(g([repo()], { changedFiles: 1 }))).toMatch(/^This session changed 1 file: open them/);
  });
});

it('compactCount', () => {
  expect([0, 999, 1000, 1234, 15_400, 999_499, 2_500_000].map(compactCount)).toEqual(['0', '999', '1k', '1.2k', '15k', '999k', '2.5m']);
});
