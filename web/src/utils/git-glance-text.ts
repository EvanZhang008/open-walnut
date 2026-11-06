/**
 * The words and numbers of a session's git glance (session-git-store.ts), one
 * place for every surface that shows it: task rows, session rows, the Changed
 * chip and the Changed tab's strip.
 */
import type { SessionGitGlance } from '@/api/session-git-status';

export interface GitGlanceSummary {
  /** The main repo's branch; null when detached. */
  branch: string | null;
  /** Short sha, shown for a detached HEAD. */
  head: string | null;
  upstream: string | null;
  /** Totals over every repo the session works in. */
  files: number;
  untracked: number;
  conflicted: number;
  insertions: number;
  deletions: number;
  /** Commits not pushed (sum over repos that know); null when no repo knows. */
  ahead: number | null;
  behind: number | null;
  /** Repos beyond the main one. */
  extraRepos: number;
  linesPartial: boolean;
  /** Nothing changed, nothing unpushed, nothing to pull. */
  clean: boolean;
  /** The host could not be read now (the numbers are its last reading). */
  stale: boolean;
}

export function summarizeGitGlance(glance: SessionGitGlance | null | undefined): GitGlanceSummary | null {
  if (!glance || !glance.repos.length) return null;
  const main = glance.repos[0]!;
  let files = 0, untracked = 0, conflicted = 0, insertions = 0, deletions = 0;
  let ahead: number | null = null, behind: number | null = null;
  let linesPartial = false;
  for (const r of glance.repos) {
    files += r.files;
    untracked += r.untracked;
    conflicted += r.conflicted;
    insertions += r.insertions;
    deletions += r.deletions;
    if (r.ahead !== null) ahead = (ahead ?? 0) + r.ahead;
    if (r.behind !== null) behind = (behind ?? 0) + r.behind;
    if (r.linesPartial) linesPartial = true;
  }
  return {
    branch: main.branch,
    head: main.head,
    upstream: main.upstream,
    files, untracked, conflicted, insertions, deletions, ahead, behind,
    extraRepos: glance.repos.length - 1,
    linesPartial,
    clean: files === 0 && !ahead && !behind,
    stale: !!glance.unavailable,
  };
}

/** 1234 -> "1.2k", as a narrow row has room for: one decimal under 10 of a
 *  unit, whole numbers above, and the next unit once rounding reaches 1000. */
export function compactCount(n: number): string {
  const steps: Array<[number, string]> = [[1, ''], [1e3, 'k'], [1e6, 'm'], [1e9, 'b']];
  for (let i = 0; i < steps.length; i++) {
    const [size, suffix] = steps[i]!;
    const v = n / size;
    const shown = v < 10 && size > 1 ? Math.round(v * 10) / 10 : Math.round(v);
    if (shown < 1000 || i === steps.length - 1) return `${shown}${suffix}`;
  }
  return String(n);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The branch as a row shows it: the name, or "detached at <sha>". */
export function branchLabel(s: GitGlanceSummary): string {
  if (s.branch) return s.branch;
  return s.head ? `detached at ${s.head.slice(0, 7)}` : 'no commits yet';
}

const UNAVAILABLE_TEXT: Record<NonNullable<SessionGitGlance['unavailable']>, string> = {
  host_offline: 'Its host is not connected: this is the last reading.',
  daemon_needs_upgrade: "Its host's Walnut daemon needs an update to report git state.",
  error: 'The last read failed: this is the reading before it.',
};

/** The full sentence a tooltip gives: every number, spelled out. */
export function gitGlanceTitle(glance: SessionGitGlance, s: GitGlanceSummary): string {
  const lines: string[] = [];
  const main = glance.repos[0]!;
  const repoName = main.repoRoot.split('/').filter(Boolean).pop() ?? main.repoRoot;
  lines.push(`${repoName}: ${s.branch ? `branch ${s.branch}` : branchLabel(s)}${s.upstream ? `, tracking ${s.upstream}` : ''}`);
  if (s.files === 0) lines.push('No uncommitted changes');
  else {
    const parts = [`${plural(s.files, 'changed file')} not committed`];
    if (s.untracked) parts.push(`${s.untracked} new`);
    if (s.conflicted) parts.push(`${s.conflicted} in conflict`);
    lines.push(parts.join(', '));
    lines.push(`${s.insertions} line${s.insertions === 1 ? '' : 's'} added, ${s.deletions} removed${s.linesPartial ? ' (some files too big to count)' : ''}`);
  }
  if (s.ahead === null) lines.push(s.branch ? 'No remote to push to' : 'Detached HEAD: nothing to push');
  else if (s.ahead > 0) lines.push(`${plural(s.ahead, 'commit')} not pushed`);
  else lines.push('Every commit is pushed');
  if (s.behind) lines.push(`${plural(s.behind, 'commit')} on ${s.upstream ?? 'the remote'} not pulled`);
  if (s.extraRepos) lines.push(`Also in ${plural(s.extraRepos, 'other repo')}: ${glance.repos.slice(1).map((r) => r.repoRoot.split('/').filter(Boolean).pop()).join(', ')}`);
  if (glance.unavailable) lines.push(UNAVAILABLE_TEXT[glance.unavailable]);
  return lines.join('\n');
}

/** The Changed chip's tooltip: how many files the session changed, set against git's
 *  count (they differ: the session's own edits count, committed or not). */
export function changedChipTitle(glance: SessionGitGlance | null): string {
  const base = 'See the files this session changed, in a full-screen diff alongside the chat';
  if (!glance) return base;
  const s = summarizeGitGlance(glance);
  let head = base;
  if (glance.changedFiles !== null && glance.changedFiles > 0) {
    head = `This session changed ${plural(glance.changedFiles, 'file')}`;
    // Two counts, two sentences: the repo's uncommitted files are not a part of the session's.
    if (s) {
      head += s.files === 0 ? ', all committed'
        : `. ${s.extraRepos ? 'Its repos have' : 'Its repo has'} ${plural(s.files, 'uncommitted file')}${s.files > glance.changedFiles ? ' (some changed outside this session)' : ''}`;
    }
    head += '. Click to see them in a full-screen diff alongside the chat.';
  } else if (glance.changedFiles === 0) {
    head = 'This session has not changed any files yet. Click to open its full-screen diff alongside the chat.';
  }
  return s ? `${head}\n\n${gitGlanceTitle(glance, s)}` : head;
}

/** The branch as a pill has room for: the name, or the short sha of a detached HEAD. */
export function pillBranchText(s: GitGlanceSummary): string {
  if (s.branch) return s.branch;
  return s.head ? s.head.slice(0, 7) : 'no commits';
}
