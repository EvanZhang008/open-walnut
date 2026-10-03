import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { restoreTurn, type TurnRestoreResult, type TurnSnapshot } from '@/api/session-turns';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { ApiError } from '@/api/client';
import { log } from '@/utils/log';

/**
 * Confirm for "Restore to this turn" (the Turns view). Opens on a dry run, so
 * it names every file the restore would write back or remove before anything
 * happens, and says the current files are snapshotted first (the undo).
 * Same skin as the rewind dialog (.app-modal-*).
 */

interface TurnRestoreDialogProps {
  sessionId: string;
  snapshot: TurnSnapshot;
  label: string;
  turnRunning: boolean;
  onClose: () => void;
  onRestored: (result: TurnRestoreResult) => void;
}

const MAX_ROWS = 8;

function messageOf(err: unknown): string {
  if (err instanceof ApiError && err.status === 409 && /turn/i.test(err.message)) {
    return 'A turn of this session is running. Restore after it ends.';
  }
  return err instanceof Error ? err.message : String(err);
}

function FileRows({ paths, verb }: { paths: string[]; verb: string }) {
  if (!paths.length) return null;
  return (
    <div className="turn-restore-group">
      <div className="turn-restore-group-head">{verb} · {paths.length}</div>
      <div className="rewind-dialog-files turn-restore-files">
        {paths.slice(0, MAX_ROWS).map((p) => (
          <div key={p} className="rewind-dialog-file" title={p}>
            <span className="rewind-dialog-file-base">{p}</span>
          </div>
        ))}
        {paths.length > MAX_ROWS && (
          <div className="rewind-dialog-file rewind-dialog-file-more">+{paths.length - MAX_ROWS} more</div>
        )}
      </div>
    </div>
  );
}

export function TurnRestoreDialog({ sessionId, snapshot, label, turnRunning, onClose, onRestored }: TurnRestoreDialogProps) {
  const [plan, setPlan] = useState<TurnRestoreResult | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useModalOverlay(onClose);

  useEffect(() => {
    let live = true;
    restoreTurn(sessionId, snapshot.n, { dryRun: true })
      .then((p) => { if (live) setPlan(p); })
      .catch((err) => { if (live) setPlanError(messageOf(err)); });
    return () => { live = false; };
  }, [sessionId, snapshot.n]);

  const count = plan ? plan.write.length + plan.delete.length : 0;

  const confirm = useCallback(() => {
    setBusy(true);
    setError(null);
    restoreTurn(sessionId, snapshot.n)
      .then((r) => onRestored(r))
      .catch((err) => {
        log.warn('session', 'turn restore failed', { sessionId, n: snapshot.n, error: err instanceof Error ? err.message : String(err) });
        setBusy(false);
        setError(messageOf(err));
      });
  }, [sessionId, snapshot.n, onRestored]);

  return createPortal(
    <div className="app-modal-overlay rewind-dialog-overlay" role="dialog" aria-modal="true" aria-label="Restore files" onMouseDown={onClose}>
      <div className="app-modal rewind-dialog turn-restore-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="app-modal-title">Restore files to {label}</div>
        <div className="app-modal-message">
          {!plan && !planError && 'Checking which files would change…'}
          {planError && <span className="rewind-dialog-error-text">Can’t restore: {planError}</span>}
          {plan && count === 0 && 'The files already match this point. Nothing to restore.'}
          {plan && count > 0 && (
            <>
              {count} {count === 1 ? 'file goes' : 'files go'} back to how {count === 1 ? 'it was' : 'they were'} at this point.
              {' '}Walnut snapshots the current files first, so you can undo this from the Turns list.
            </>
          )}
        </div>
        {plan && count > 0 && (
          <div className="turn-restore-plan">
            <FileRows paths={plan.write} verb="Written back" />
            <FileRows paths={plan.delete} verb="Removed" />
            {plan.keep.length > 0 && (
              <div className="rewind-dialog-hint">
                {plan.keep.length} untracked {plan.keep.length === 1 ? 'file stays' : 'files stay'}: this snapshot did not record untracked files.
              </div>
            )}
          </div>
        )}
        {turnRunning && plan && count > 0 && (
          <div className="rewind-dialog-hint turn-restore-running">A turn is running. Restore after it ends.</div>
        )}
        {error && <div className="rewind-dialog-error">{error}</div>}
        <div className="app-modal-actions">
          <button type="button" className="app-modal-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="app-modal-btn primary"
            onClick={confirm}
            disabled={busy || !plan || count === 0 || turnRunning}
          >
            {busy ? 'Restoring…' : `Restore ${count} ${count === 1 ? 'file' : 'files'}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
