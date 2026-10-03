/**
 * Commit / push / open a PR for ONE session's changes, from the Changed tab.
 *
 * The session host's daemon reads every repo the session touched, splits each
 * changed file into hunks and attributes each hunk (src/providers/
 * git-attribution-core.ts). Only this session's hunks start checked; a file two
 * writers changed opens on its hunks, the other writer's unchecked and marked.
 * A commit, a push and a PR are jobs: the request answers at once, progress
 * arrives as `git-commit:job` events (with a slow GET poll as the fallback), so
 * a pre-commit hook that runs for minutes never pins a browser connection.
 * Push and PR sit behind an inline confirm naming the remote and the branch.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import {
  fetchCommitJobs, fetchCommitPlan, startCommitJob, suggestCommitMessage,
  type CommitJob, type CommitPlan,
} from '@/api/session-commit';
import { SessionCommitRepo } from '@/components/sessions/SessionCommitRepo';
import { errorText } from '@/components/sessions/sessionCommitModel';
import { log } from '@/utils/log';
import '@/styles/session-commit.css';

/** Unsent commit messages survive closing the dialog (per session + repo). */
const drafts = new Map<string, string>();

export interface CommitConfirm { repoRoot: string; kind: 'push' | 'pr' }

export function SessionCommitDialog({ sessionId, onClose, onCommitted }: {
  sessionId: string;
  onClose: () => void;
  onCommitted?: () => void;
}) {
  const [plan, setPlan] = useState<CommitPlan | null>(null);
  const [jobs, setJobs] = useState<CommitJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<CommitConfirm | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [p, js] = await Promise.all([
        fetchCommitPlan(sessionId),
        fetchCommitJobs(sessionId).catch(() => [] as CommitJob[]),
      ]);
      if (seq !== loadSeq.current) return;
      setPlan(p);
      setJobs(js);
      log.info('session-commit', 'plan loaded', {
        sessionId, repos: p.repos.length, attributed: p.attributed,
        files: p.repos.reduce((n, r) => n + r.files.length, 0),
      });
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setLoadError(errorText(err));
      log.warn('session-commit', 'plan failed', { sessionId, error: errorText(err) });
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  // Escape closes an open push/PR confirm first, then the dialog.
  const closeOrBack = useCallback(() => {
    if (confirm) setConfirm(null); else onClose();
  }, [confirm, onClose]);
  useModalOverlay(closeOrBack);

  const runningFor = (repoRoot: string) => {
    const mine = jobs.filter((j) => j.repoRoot === repoRoot && j.state === 'running');
    return mine.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  };

  const body = (() => {
    if (loading && !plan) {
      return <div className="scd-status">Reading the repositories this session changed…</div>;
    }
    if (loadError && !plan) {
      return (
        <div className="scd-status scd-status-error" data-testid="scd-load-error">
          <div>{loadError}</div>
          <button type="button" className="app-modal-btn" onClick={() => void load()}>Try again</button>
        </div>
      );
    }
    if (!plan || plan.repos.length === 0) {
      return <div className="scd-status">This session has no uncommitted changes in a git repository.</div>;
    }
    return (
      <>
        {!plan.attributed && (
          <div className="scd-banner">Walnut could not read this session's edits on its host, so nothing is preselected. Check what to commit.</div>
        )}
        {plan.repos.map((repo) => (
          <SessionCommitRepo
            key={repo.repoRoot}
            sessionId={sessionId}
            repo={repo}
            initialJob={runningFor(repo.repoRoot)}
            draft={drafts.get(sessionId + '\u0000' + repo.repoRoot) ?? ''}
            onDraft={(text) => { drafts.set(sessionId + '\u0000' + repo.repoRoot, text); }}
            confirm={confirm?.repoRoot === repo.repoRoot ? confirm.kind : null}
            onConfirm={(kind) => setConfirm(kind ? { repoRoot: repo.repoRoot, kind } : null)}
            onReload={() => void load()}
            onCommitted={() => { drafts.delete(sessionId + '\u0000' + repo.repoRoot); onCommitted?.(); }}
            startJob={(b) => startCommitJob(sessionId, b)}
            suggest={(diff, files) => suggestCommitMessage(sessionId, diff, files)}
          />
        ))}
      </>
    );
  })();

  return createPortal(
    <div
      className="app-modal-overlay"
      onMouseDown={onClose}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      // Typing here must not reach the panel's shortcuts; Escape still has to
      // reach useModalOverlay's document listener.
      onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation(); }}
    >
      <div
        className="app-modal scd-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Commit this session's changes"
        data-testid="session-commit-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="scd-head">
          <div className="app-modal-title">Commit this session's changes</div>
          <div className="scd-head-actions">
            <button type="button" className="app-modal-btn scd-reload" onClick={() => void load()} disabled={loading} title="Read the repositories again">
              {loading ? 'Reading…' : 'Reload'}
            </button>
            <button type="button" className="scd-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>
        <div className="scd-body">{body}</div>
      </div>
    </div>,
    document.body,
  );
}

/** The Changed tab's toolbar button that opens the commit view. */
export function SessionCommitButton({ sessionId, disabled, onCommitted }: {
  sessionId: string;
  disabled?: boolean;
  onCommitted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="session-diff-commit-btn"
        data-testid="session-commit-btn"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title={disabled ? 'No changes to commit' : "Commit this session's changes"}
      >Commit</button>
      {open && <SessionCommitDialog sessionId={sessionId} onClose={() => setOpen(false)} onCommitted={onCommitted} />}
    </>
  );
}
