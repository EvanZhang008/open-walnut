import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { previewRewind, rewindSession, type RewindPreview, type RewindResult } from '@/api/sessions';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { log } from '@/utils/log';

/**
 * Confirm dialog for "rewind to this message".
 *
 * It opens on a DRY RUN: the server asks the live CLI what a rewind would touch
 * (`rewind_files` with dry_run) and how many transcript messages would be dropped,
 * and this dialog shows that before anything happens. Rewinding code without
 * showing the blast radius first would be the one irreversible thing in the
 * session UI.
 *
 * The two halves are independent, and the copy says so:
 *  - the CONVERSATION always rewinds (that is the point of the button). By
 *    default it rewinds IN PLACE — this same session drops the later turns;
 *    the "into a copy" toggle instead continues the rewound conversation as a
 *    new session and leaves this one untouched.
 *  - the FILES only rewind if the user asks AND the CLI has a checkpoint for that
 *    message. When it doesn't (session not live, or spawned before file
 *    checkpointing was enabled), the checkbox is disabled with the reason instead
 *    of promising a restore that would silently not happen.
 */

interface SessionRewindDialogProps {
  sessionId: string;
  msgId: string;
  /** Label of the target message, for the "back to" line. */
  label?: string;
  onClose: () => void;
  /** The rewound session replaces this one in its column. */
  onRewound: (result: RewindResult) => void;
}

export function SessionRewindDialog({ sessionId, msgId, label, onClose, onRewound }: SessionRewindDialogProps) {
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [restoreFiles, setRestoreFiles] = useState(false);
  // Default: rewind THIS conversation in place. The secondary "into a copy"
  // toggle keeps the current conversation untouched and continues the rewound
  // one as a new (forked) session.
  const [intoCopy, setIntoCopy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useModalOverlay(onClose);

  useEffect(() => {
    let live = true;
    previewRewind(sessionId, msgId)
      .then((p) => {
        if (!live) return;
        setPreview(p);
        // Default ON only when the restore is actually available — a checked box
        // that can't do anything is a lie about what the button will do.
        setRestoreFiles(p.canRewind);
      })
      .catch((err) => {
        if (!live) return;
        setPreviewError(err instanceof Error ? err.message : String(err));
      });
    return () => { live = false; };
  }, [sessionId, msgId]);

  const confirm = useCallback(() => {
    setBusy(true);
    setError(null);
    rewindSession(sessionId, msgId, { mode: intoCopy ? 'fork' : 'in-place', restoreFiles })
      .then((result) => {
        log.info('session', 'rewind committed', {
          sessionId, msgId, mode: result.mode, rewoundId: result.sessionId, restoreFiles,
        });
        onRewound(result);
      })
      .catch((err) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [sessionId, msgId, intoCopy, restoreFiles, onRewound]);

  const filesReason = preview?.filesUnavailableReason === 'session_not_live'
    ? 'The CLI for this session is not running, so its file checkpoints can\'t be read.'
    : preview?.error;

  return createPortal(
    <div className="rewind-dialog-backdrop" onClick={onClose}>
      <div
        className="rewind-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Rewind session"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rewind-dialog-title">Rewind to this message</div>
        {label && <div className="rewind-dialog-target">“{label}”</div>}

        {!preview && !previewError && <div className="rewind-dialog-line text-muted">Checking what this would change…</div>}
        {previewError && <div className="rewind-dialog-error">Couldn’t check: {previewError}</div>}

        {preview && (
          <>
            <div className="rewind-dialog-line">
              <strong>{preview.droppedMessages}</strong>{' '}
              {preview.droppedMessages === 1 ? 'message' : 'messages'} after this point will be dropped.
              {intoCopy
                ? ' The rewound conversation continues as a new session; this one stays exactly as it is.'
                : ' This conversation continues from here; the dropped messages are gone from it (recoverable only if you kept a copy).'}
            </div>
            <label className={`rewind-dialog-check${preview.canRewind ? '' : ' is-disabled'}`}>
              <input
                type="checkbox"
                checked={restoreFiles}
                disabled={!preview.canRewind || busy}
                onChange={(e) => setRestoreFiles(e.target.checked)}
              />
              <span>
                {preview.canRewind ? (
                  <>
                    Also restore the files to their state at this message
                    {preview.filesChanged?.length !== undefined && (
                      <span className="rewind-dialog-stats">
                        {' '}({preview.filesChanged.length} {preview.filesChanged.length === 1 ? 'file' : 'files'}
                        {preview.insertions !== undefined && `, +${preview.insertions}`}
                        {preview.deletions !== undefined && ` −${preview.deletions}`})
                      </span>
                    )}
                  </>
                ) : (
                  <>Files can’t be restored for this message</>
                )}
              </span>
            </label>
            {!preview.canRewind && filesReason && (
              <div className="rewind-dialog-line text-muted">{filesReason}</div>
            )}
            {preview.canRewind && !!preview.filesChanged?.length && (
              <div className="rewind-dialog-files">
                {preview.filesChanged.slice(0, 8).map((f) => (
                  <div key={f} className="rewind-dialog-file" title={f}>{f}</div>
                ))}
                {preview.filesChanged.length > 8 && (
                  <div className="rewind-dialog-file text-muted">
                    +{preview.filesChanged.length - 8} more
                  </div>
                )}
              </div>
            )}
            <label className="rewind-dialog-check">
              <input
                type="checkbox"
                checked={intoCopy}
                disabled={busy}
                onChange={(e) => setIntoCopy(e.target.checked)}
              />
              <span>Rewind into a copy instead (keep this conversation untouched)</span>
            </label>
          </>
        )}

        {error && <div className="rewind-dialog-error">{error}</div>}

        <div className="rewind-dialog-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary" onClick={confirm} disabled={busy || !preview}>
            {busy
              ? 'Rewinding…'
              : `${restoreFiles ? 'Rewind code + chat' : 'Rewind chat'}${intoCopy ? ' (copy)' : ''}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
