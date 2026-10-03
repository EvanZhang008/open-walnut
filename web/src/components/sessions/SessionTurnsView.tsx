import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  fetchSessionTurns, fetchTurnFileDiff,
  type SessionTurns, type TurnSnapshot, type TurnFileDiff, type TurnRestoreResult,
} from '@/api/session-turns';
import type { SessionFileChange } from '@/api/session-changes';
import { FileDiffPane, type PendingComment } from './SessionDiffView';
import { TurnRestoreDialog } from './TurnRestoreDialog';
import { buildReviewMessage, buildCommentMessage } from './diffPrefill';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ICON_REFRESH, ICON_WARNING } from '@/components/common/Icons';
import { log } from '@/utils/log';

/**
 * The Changed tab's Turns view: one row per snapshot the session's daemon
 * recorded when a turn ended (providers/turn-snapshot-core.ts), the files each
 * turn changed, that turn's diff (the Files view's own diff pane), and a
 * restore that snapshots the current files first so it can be undone.
 */

interface SessionTurnsViewProps {
  sessionId: string;
  sessionCwd?: string;
  sessionHost?: string;
  onComment?: (message: string) => boolean | void | Promise<boolean | void>;
  toolbarLeadingSlot?: ReactNode;
  barRightSlot?: ReactNode;
}

/** How long after a turn end the list keeps asking for its snapshot. */
const PENDING_POLL_MS = 1000;
const PENDING_POLL_MAX = 10;

export function snapshotLabel(s: TurnSnapshot, all?: TurnSnapshot[]): string {
  if (s.kind === 'start') return 'Session start';
  if (s.kind === 'pre-restore') return 'Before restore';
  if (s.kind === 'restored') {
    const from = all?.find((x) => x.n === s.restoredFrom);
    return from ? `Restored to ${snapshotLabel(from)}` : 'Restored';
  }
  return `Turn ${s.n}`;
}

function timeOf(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

function filesLine(s: TurnSnapshot): string {
  if (s.filesTotal === 0) return s.kind === 'start' ? 'before the first turn' : 'no file changes';
  let add = 0, del = 0, known = false;
  for (const f of s.files) {
    if (f.additions !== null) { add += f.additions; known = true; }
    if (f.deletions !== null) { del += f.deletions; known = true; }
  }
  const count = `${s.filesTotal} ${s.filesTotal === 1 ? 'file' : 'files'}`;
  return known ? `${count} · +${add} −${del}` : count;
}

const SKIP_TEXT: Record<string, string> = {
  'not-a-repo': 'the folder is not in a git repository',
  'index-locked': 'git was busy in this repository (index.lock)',
  'merge-in-progress': 'a merge was in progress',
  'rebase-in-progress': 'a rebase was in progress',
  'cherry-pick-in-progress': 'a cherry-pick was in progress',
  'revert-in-progress': 'a revert was in progress',
  timeout: 'it took longer than its time budget',
  resting: 'a recent snapshot of this repository was too slow, so it is paused for a while',
};

function statusGlyph(status: 'added' | 'modified' | 'deleted'): { ch: string; cls: string } {
  if (status === 'added') return { ch: 'A', cls: 'is-added' };
  if (status === 'deleted') return { ch: 'D', cls: 'is-deleted' };
  return { ch: 'M', cls: 'is-modified' };
}

function toChange(d: TurnFileDiff): SessionFileChange {
  return { filePath: d.filePath, relPath: d.path, before: d.before, after: d.after, status: d.status, ops: 1, partial: false };
}

export function SessionTurnsView({ sessionId, sessionCwd, sessionHost, onComment, toolbarLeadingSlot, barRightSlot }: SessionTurnsViewProps) {
  const [data, setData] = useState<SessionTurns | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ n: number; path: string | null } | null>(null);
  const [diff, setDiff] = useState<{ key: string; diff: TurnFileDiff | null; error?: string } | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<TurnSnapshot | null>(null);
  const [notice, setNotice] = useState<{ text: string; undoN: number | null } | null>(null);
  const [pending, setPending] = useState<PendingComment[]>([]);
  const pendingSeq = useRef(0);
  const loadSeq = useRef(0);
  const pollCount = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const status = useSessionStatus(sessionId);
  const turnRunning = status?.process_status === 'running';

  const load = useCallback((opts: { fromPoll?: boolean } = {}) => {
    const seq = ++loadSeq.current;
    if (!opts.fromPoll) pollCount.current = 0;
    if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; }
    setLoading(true);
    fetchSessionTurns(sessionId)
      .then((res) => {
        if (seq !== loadSeq.current) return;
        setData(res);
        setError(null);
        // A turn just ended and its snapshot is not written yet: ask again shortly.
        const newest = res.snapshots?.[res.snapshots.length - 1];
        const waiting = res.supported && res.enabled && res.repoRoot && typeof res.lastTurnEndAt === 'number'
          && (!newest || newest.at < res.lastTurnEndAt)
          && !(res.skipped ?? []).some((s) => s.at >= (res.lastTurnEndAt ?? 0));
        if (waiting && pollCount.current < PENDING_POLL_MAX) {
          pollCount.current++;
          pollTimer.current = setTimeout(() => load({ fromPoll: true }), PENDING_POLL_MS);
        }
      })
      .catch((err) => {
        if (seq !== loadSeq.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (seq === loadSeq.current) setLoading(false); });
  }, [sessionId]);

  useEffect(() => {
    setData(null);
    setSelected(null);
    setDiff(null);
    setPending([]);
    setNotice(null);
    load();
    return () => {
      loadSeq.current++;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [load]);

  // A turn that ends adds a snapshot: re-read when the session goes quiet.
  const wasRunning = useRef(turnRunning);
  useEffect(() => {
    if (wasRunning.current && !turnRunning) load();
    wasRunning.current = turnRunning;
  }, [turnRunning, load]);

  const snapshots = useMemo(() => data?.snapshots ?? [], [data]);
  const newestFirst = useMemo(() => [...snapshots].reverse(), [snapshots]);

  // Default selection: the newest snapshot that changed something.
  const effective = useMemo(() => {
    const pick = selected && snapshots.find((s) => s.n === selected.n);
    const snap = pick || newestFirst.find((s) => s.filesTotal > 0) || newestFirst[0] || null;
    if (!snap) return null;
    const path = selected && pick && selected.path && snap.files.some((f) => f.path === selected.path)
      ? selected.path
      : snap.files[0]?.path ?? null;
    return { snap, path };
  }, [selected, snapshots, newestFirst]);

  const diffKey = effective && effective.path ? `${effective.snap.n}:${effective.path}` : null;
  useEffect(() => {
    if (!effective || !effective.path || !diffKey) return;
    if (diff?.key === diffKey) return;
    let live = true;
    const key = diffKey;
    fetchTurnFileDiff(sessionId, effective.snap.n, effective.path, 'previous')
      .then((d) => { if (live) setDiff({ key, diff: d }); })
      .catch((err) => { if (live) setDiff({ key, diff: null, error: err instanceof Error ? err.message : String(err) }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- diff is read to skip a refetch only
  }, [sessionId, diffKey]);

  const change = useMemo(() => (diff && diff.key === diffKey && diff.diff ? toChange(diff.diff) : null), [diff, diffKey]);
  const pendingForFile = useMemo(() => (change ? pending.filter((c) => c.filePath === change.filePath) : []), [pending, change]);

  const send = useCallback((message: string) => {
    if (!onComment) return;
    void Promise.resolve(onComment(message)).catch((err) => {
      log.warn('session', 'turn diff comment send failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    });
  }, [onComment, sessionId]);
  const addComment = useCallback((c: Omit<PendingComment, 'id'>) => {
    setPending((p) => [...p, { ...c, id: ++pendingSeq.current }]);
  }, []);
  const removeComment = useCallback((id: number) => setPending((p) => p.filter((c) => c.id !== id)), []);
  const copyComment = useCallback((c: PendingComment) => {
    void navigator.clipboard?.writeText(buildCommentMessage(c.loc, c.code, c.comment)).catch(() => {});
  }, []);
  const submitReview = useCallback(() => {
    if (!pending.length) return;
    send(buildReviewMessage(pending.map((c) => ({ loc: c.loc, code: c.code, comment: c.comment }))));
    setPending([]);
  }, [pending, send]);

  const onRestored = useCallback((result: TurnRestoreResult, target: TurnSnapshot) => {
    setRestoreTarget(null);
    const count = result.write.length + result.delete.length;
    setNotice({
      text: count === 0
        ? `The files already match ${snapshotLabel(target, snapshots)}.`
        : `Restored ${count} ${count === 1 ? 'file' : 'files'} to ${snapshotLabel(target, snapshots)}.`,
      undoN: count > 0 ? result.backupN : null,
    });
    log.info('session', 'turn snapshot restored', { sessionId, n: target.n, backupN: result.backupN, afterN: result.afterN });
    if (result.afterN !== null) setSelected({ n: result.afterN, path: null });
    load();
  }, [load, sessionId, snapshots]);

  const toolbar = (
    <div className="session-diff-toolbar turns-toolbar">
      {toolbarLeadingSlot}
      <span className="session-diff-toolbar-title">
        {data?.supported && data.repoRoot ? `${snapshots.length} ${snapshots.length === 1 ? 'snapshot' : 'snapshots'}` : 'Turns'}
        {loading && data && <span className="session-diff-refreshing" title="Refreshing">↻</span>}
      </span>
      <div className="session-diff-toolbar-actions">
        <button type="button" className="session-diff-refresh" onClick={() => load()} title="Refresh the turn list" aria-label="Refresh the turn list">
          {ICON_REFRESH}
        </button>
      </div>
      {barRightSlot}
    </div>
  );

  let body: ReactNode;
  if (!data && loading) {
    body = <div className="session-diff-loading"><LoadingSpinner /></div>;
  } else if (!data && error) {
    body = (
      <div className="session-diff-error-box">
        {ICON_WARNING} <span>Couldn't load the turns: {error}</span>
        <button type="button" className="btn btn-sm" onClick={() => load()}>Retry</button>
      </div>
    );
  } else if (data && !data.supported) {
    body = (
      <div className="session-diff-empty turns-empty">
        <p>
          {data.reason === 'no_cwd' ? 'This session has no working folder.'
            : data.reason === 'daemon_upgrade' ? 'This host’s session daemon needs an update before it can record turns.'
            : 'The host for this session is not connected.'}
        </p>
      </div>
    );
  } else if (data && !data.repoRoot) {
    body = (
      <div className="session-diff-empty turns-empty">
        <p>Turns are recorded for folders inside a git repository, and this session’s folder is not in one.</p>
      </div>
    );
  } else if (data && snapshots.length === 0) {
    body = (
      <div className="session-diff-empty turns-empty">
        {data.enabled === false
          ? <p>Turn snapshots are off. Turn them on in Settings, under Sessions.</p>
          : (
            <>
              <p>No turns recorded yet.</p>
              <p className="text-muted">When a turn ends, Walnut records this repository’s files so you can see and restore that turn.</p>
            </>
          )}
      </div>
    );
  } else {
    const lastSkip = (data?.skipped ?? []).slice(-1)[0];
    const newestAt = snapshots.length ? snapshots[snapshots.length - 1].at : 0;
    const skipNote = lastSkip && lastSkip.at > newestAt && lastSkip.reason !== 'disabled'
      ? SKIP_TEXT[lastSkip.reason] ?? lastSkip.detail ?? lastSkip.reason
      : null;
    const snap = effective?.snap ?? null;
    body = (
      <>
        {data?.enabled === false && (
          <div className="turns-strip">Turn snapshots are off, so new turns are not recorded. Turn them on in Settings, under Sessions.</div>
        )}
        {skipNote && <div className="turns-strip">{ICON_WARNING} <span>The last turn was not recorded: {skipNote}.</span></div>}
        {notice && (
          <div className="turns-strip turns-strip-ok" role="status">
            <span>{notice.text}</span>
            {notice.undoN !== null && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  const backup = snapshots.find((s) => s.n === notice.undoN);
                  if (backup) setRestoreTarget(backup);
                }}
              >Undo</button>
            )}
            <button type="button" className="turns-strip-close" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
          </div>
        )}
        <div className="session-diff-body">
          <div className="session-diff-tree turns-list" role="list" aria-label="Turn snapshots">
            {newestFirst.map((s) => {
              const isSel = snap?.n === s.n;
              return (
                <div key={s.n} className={`turns-item${isSel ? ' is-selected' : ''}`} role="listitem" data-turn-n={s.n}>
                  <button
                    type="button"
                    className="turns-row"
                    onClick={() => setSelected({ n: s.n, path: null })}
                    aria-current={isSel ? 'true' : undefined}
                    title={new Date(s.at).toLocaleString()}
                  >
                    <span className={`turns-row-title turns-kind-${s.kind}`}>{snapshotLabel(s, snapshots)}</span>
                    <span className="turns-row-time">{timeOf(s.at)}</span>
                    <span className="turns-row-files">{filesLine(s)}</span>
                    {s.capture === 'tracked-only' && (
                      <span className="turns-row-note" title="This repository had more untracked files than a snapshot takes, so only tracked files were recorded.">tracked files only</span>
                    )}
                  </button>
                  {isSel && s.files.length > 0 && (
                    <div className="turns-files">
                      {s.files.map((f) => {
                        const g = statusGlyph(f.status);
                        const fileSel = effective?.path === f.path;
                        return (
                          <button
                            type="button"
                            key={f.path}
                            className={`turns-file${fileSel ? ' is-selected' : ''}`}
                            onClick={() => setSelected({ n: s.n, path: f.path })}
                            title={f.path}
                          >
                            <span className={`turns-file-status ${g.cls}`}>{g.ch}</span>
                            <span className="turns-file-path">{f.path}</span>
                            {f.additions !== null && <span className="turns-file-add">+{f.additions}</span>}
                            {f.deletions !== null && <span className="turns-file-del">−{f.deletions}</span>}
                          </button>
                        );
                      })}
                      {s.filesTotal > s.files.length && (
                        <div className="turns-file-more">+{s.filesTotal - s.files.length} more files</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="session-diff-main turns-main">
            {snap && (
              <div className="turns-main-head">
                <span className="turns-main-title">{snapshotLabel(snap, snapshots)}</span>
                <span className="turns-main-time">{timeOf(snap.at)}</span>
                <button
                  type="button"
                  className="btn btn-sm turns-restore-btn"
                  onClick={() => setRestoreTarget(snap)}
                  disabled={turnRunning}
                  title={turnRunning ? 'Wait for the running turn to end' : 'Put the files back the way they were at this point'}
                >{snap.kind === 'pre-restore' ? 'Restore this state' : 'Restore to this turn'}</button>
              </div>
            )}
            {pending.length > 0 && (
              <div className="turns-review-bar">
                <span>{pending.length} {pending.length === 1 ? 'comment' : 'comments'}</span>
                <button type="button" className="btn btn-sm" onClick={() => setPending([])}>Discard</button>
                <button type="button" className="btn btn-sm btn-primary" onClick={submitReview} disabled={!onComment}>Send to session</button>
              </div>
            )}
            {!snap || !effective?.path ? (
              <div className="session-diff-file-empty">{snap ? 'This snapshot changed no files.' : 'Select a turn.'}</div>
            ) : diff?.key !== diffKey ? (
              <div className="session-diff-file-empty"><LoadingSpinner /></div>
            ) : diff?.error ? (
              <div className="session-diff-file-empty">{ICON_WARNING} Couldn't load this diff: {diff.error}</div>
            ) : diff?.diff?.binary || diff?.diff?.tooLarge ? (
              <div className="session-diff-file-empty">{diff.diff.binary ? 'Binary file: no text diff.' : 'This file is too large to show.'}</div>
            ) : change ? (
              <FileDiffPane
                key={`${snap.n}:${change.filePath}`}
                change={change}
                viewType="auto"
                rendered={false}
                sessionCwd={sessionCwd}
                sessionHost={sessionHost}
                sessionId={sessionId}
                aiSummaryOn={false}
                pending={pendingForFile}
                onAddComment={addComment}
                onSendNow={send}
                onCopyComment={copyComment}
                onRemoveComment={removeComment}
              />
            ) : null}
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="session-diff-view session-turns-view" data-testid="session-turns-view">
      {toolbar}
      {error && data && (
        <div className="session-diff-error-strip">
          {ICON_WARNING} <span>Refresh failed: {error}</span>
          <button type="button" className="btn btn-sm" onClick={() => load()}>Retry</button>
        </div>
      )}
      {body}
      {restoreTarget && (
        <TurnRestoreDialog
          sessionId={sessionId}
          snapshot={restoreTarget}
          label={snapshotLabel(restoreTarget, snapshots)}
          turnRunning={turnRunning}
          onClose={() => setRestoreTarget(null)}
          onRestored={(r) => onRestored(r, restoreTarget)}
        />
      )}
    </div>
  );
}
