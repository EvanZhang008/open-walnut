/**
 * A session's git state at a glance (session-git-store.ts): the branch, how many
 * files are not committed, their +/- lines, and the commits not pushed.
 *
 *  - GitGlancePill: a task row's pill. Shown only when there is something to
 *    act on (uncommitted files or unpushed commits): a clean, pushed task
 *    stays quiet in a list of thirty.
 *  - GitGlanceLine: a session row's line and the Changed tab's strip. Always
 *    names the branch, and says "clean" when there is nothing else.
 * Every number is spelled out in the tooltip (gitGlanceTitle).
 */
import { memo, useEffect, useState } from 'react';
import { timeAgo } from '@/utils/time';
import { useSessionGitGlance } from '@/stores/session-git-store';
import type { SessionGitGlance } from '@/api/session-git-status';
import { branchLabel, compactCount, gitGlanceTitle, summarizeGitGlance, type GitGlanceSummary } from '@/utils/git-glance-text';
import '@/styles/git-glance.css';

export function BranchIcon() {
  return (
    <svg className="git-glance-icon" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="4.5" cy="12.5" r="1.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="11.5" cy="5" r="1.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 5.25v5.5M11.5 6.75c0 2.5-2 3.25-5.5 4.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** A page with a folded corner: "files" where a row has no room for the word. */
function FileIcon() {
  return (
    <svg className="git-glance-file-icon" viewBox="0 0 16 16" width="9" height="9" aria-hidden="true">
      <path d="M3.5 1.75h6l3 3v9.5h-9z M9.5 1.75v3h3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function Counts({ s, filesWord, pull = true }: { s: GitGlanceSummary; filesWord: boolean; pull?: boolean }) {
  return (
    <>
      {s.files > 0 && (
        <span className="git-glance-files" data-testid="git-glance-files">
          {!filesWord && <FileIcon />}
          {compactCount(s.files)}{filesWord ? ` file${s.files === 1 ? '' : 's'}` : ''}
        </span>
      )}
      {s.files > 0 && (s.insertions > 0 || s.deletions > 0) && (
        <span className="git-glance-lines">
          <span className="git-glance-add">+{compactCount(s.insertions)}</span>
          <span className="git-glance-del">{'−'}{compactCount(s.deletions)}</span>
        </span>
      )}
      {s.conflicted > 0 && <span className="git-glance-conflict">{s.conflicted} conflict{s.conflicted === 1 ? '' : 's'}</span>}
      {!!s.ahead && <span className="git-glance-ahead" data-testid="git-glance-ahead">{'↑'}{compactCount(s.ahead)}</span>}
      {pull && !!s.behind && <span className="git-glance-behind">{'↓'}{compactCount(s.behind)}</span>}
    </>
  );
}

function ariaOf(s: GitGlanceSummary): string {
  const parts = [`Branch ${branchLabel(s)}`];
  parts.push(s.files ? `${s.files} uncommitted file${s.files === 1 ? '' : 's'}, ${s.insertions} added, ${s.deletions} removed lines` : 'no uncommitted changes');
  if (s.ahead) parts.push(`${s.ahead} unpushed commit${s.ahead === 1 ? '' : 's'}`);
  if (s.behind) parts.push(`${s.behind} commit${s.behind === 1 ? '' : 's'} to pull`);
  return parts.join(', ');
}

/** A task row's pill, for the task's session. Nothing when clean or unknown. */
export const GitGlancePill = memo(function GitGlancePill({ sessionId }: { sessionId: string | null | undefined }) {
  const glance = useSessionGitGlance(sessionId);
  const s = summarizeGitGlance(glance);
  // Only what waits on the user's work: uncommitted files or unpushed commits.
  // (Commits to pull are in the tooltip and on the session's own line.)
  if (!glance || !s || (s.files === 0 && !s.ahead)) return null;
  return (
    <span
      className={`todo-item-due-pill git-glance git-glance-pill${s.stale ? ' is-stale' : ''}`}
      title={gitGlanceTitle(glance, s)}
      aria-label={ariaOf(s)}
      role="img"
      data-testid="git-glance-pill"
    >
      <BranchIcon />
      <span className="git-glance-branch">{branchLabel(s)}</span>
      <Counts s={s} filesWord={false} pull={false} />
    </span>
  );
});

/** The line form, from a glance already read (the Changed tab passes its own). */
export function GitGlanceLineView({ glance, className = '' }: { glance: SessionGitGlance | null; className?: string }) {
  const s = summarizeGitGlance(glance);
  if (!glance || !s) return null;
  return (
    <span
      className={`git-glance git-glance-line${s.stale ? ' is-stale' : ''}${className ? ` ${className}` : ''}`}
      title={gitGlanceTitle(glance, s)}
      aria-label={ariaOf(s)}
      role="img"
      data-testid="git-glance-line"
    >
      <BranchIcon />
      <span className="git-glance-branch">{branchLabel(s)}</span>
      {s.extraRepos > 0 && <span className="git-glance-more">+{s.extraRepos} repo{s.extraRepos === 1 ? '' : 's'}</span>}
      {s.clean ? <span className="git-glance-clean">clean</span> : <Counts s={s} filesWord />}
    </span>
  );
}

/** A session row's line. Nothing until the session is known to sit in a repo. */
export const GitGlanceLine = memo(function GitGlanceLine({ sessionId, className }: { sessionId: string | null | undefined; className?: string }) {
  const glance = useSessionGitGlance(sessionId);
  return <GitGlanceLineView glance={glance} className={className} />;
});

/** "checked 2m ago", kept current while it is on screen. */
export function GitCheckedAgo({ at }: { at: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="session-diff-gitstrip-when" title={new Date(at).toLocaleString()}>
      checked {timeAgo(at)}
    </span>
  );
}
