import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { previewRewind, rewindSession, type RewindPreview, type RewindResult } from '@/api/sessions';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { log } from '@/utils/log';

/**
 * Confirm dialog for "rewind to this message". Same skin as every other confirm
 * in the app (.app-modal-*), so it reads as one product.
 *
 * It opens on a DRY RUN: the server asks the live CLI what a rewind would touch
 * (`rewind_files` with dry_run) and how many transcript messages would be dropped,
 * and this dialog shows that before anything happens.
 *
 * The CONVERSATION is what rewinds (that is the point of the button); by default
 * in place, this same session drops the later turns. Two opt-ins, both OFF by
 * default so nothing beyond the conversation ever moves unless asked:
 *  - restore FILES: the CLI's own checkpoints (`rewind_files`, the same thing the
 *    terminal's /rewind calls "restore code"). Only offered when the live CLI has
 *    a checkpoint for this message; otherwise the row is disabled with the reason.
 *  - into a COPY: continue the rewound conversation as a new session and leave
 *    this one untouched.
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

const MAX_FILE_ROWS = 6;

function splitPath(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
}

function describeDrop(preview: RewindPreview, intoCopy: boolean): string {
  const n = preview.droppedMessages;
  const noun = n === 1 ? 'message' : 'messages';
  if (intoCopy) {
    return n === 0
      ? 'The rewound conversation continues in a new session; this one stays as it is.'
      : `${n} later ${noun} are left out of the copy. The rewound conversation continues in a new session; this one stays as it is.`;
  }
  return n === 0
    ? 'Nothing after this point yet; the conversation continues from here.'
    : `${n} later ${noun} will be dropped from this conversation.`;
}

export function SessionRewindDialog({ sessionId, msgId, label, onClose, onRewound }: SessionRewindDialogProps) {
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [restoreFiles, setRestoreFiles] = useState(false);
  const [intoCopy, setIntoCopy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useModalOverlay(onClose);

  useEffect(() => {
    let live = true;
    previewRewind(sessionId, msgId)
      .then((p) => { if (live) setPreview(p); })
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

  const filesAvailable = !!preview?.canRewind;
  const filesReason = preview?.filesUnavailableReason === 'session_not_live'
    ? 'The CLI for this session isn’t running, so its file checkpoints can’t be read.'
    : preview?.error;
  const files = preview?.filesChanged ?? [];
  const fileStats = preview && files.length > 0
    ? `${files.length} ${files.length === 1 ? 'file' : 'files'}`
      + (preview.insertions !== undefined ? `, +${preview.insertions}` : '')
      + (preview.deletions !== undefined ? ` −${preview.deletions}` : '')
    : null;

  const confirmLabel = busy
    ? 'Rewinding…'
    : `${intoCopy ? 'Rewind into a copy' : 'Rewind'}${restoreFiles ? ' + files' : ''}`;

  return createPortal(
    <div
      className="app-modal-overlay rewind-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Rewind to this message"
      onMouseDown={onClose}
    >
      <div className="app-modal rewind-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="app-modal-title">Rewind to this message</div>
        {label && <div className="rewind-dialog-target">“{label}”</div>}

        <div className="app-modal-message">
          {!preview && !previewError && 'Checking what this would change…'}
          {previewError && <span className="rewind-dialog-error-text">Couldn’t check: {previewError}</span>}
          {preview && describeDrop(preview, intoCopy)}
        </div>

        {preview && (
          <div className="rewind-dialog-options">
            <label className={`rewind-dialog-option${filesAvailable ? '' : ' is-disabled'}`}>
              <input
                type="checkbox"
                checked={restoreFiles}
                disabled={!filesAvailable || busy}
                onChange={(e) => setRestoreFiles(e.target.checked)}
              />
              <span className="rewind-dialog-option-text">
                <span>
                  Also restore files to this point
                  {filesAvailable && fileStats && <span className="rewind-dialog-stats"> · {fileStats}</span>}
                </span>
                {!filesAvailable && filesReason && (
                  <span className="rewind-dialog-hint">{filesReason}</span>
                )}
              </span>
            </label>
            {filesAvailable && restoreFiles && files.length > 0 && (
              <div className="rewind-dialog-files">
                {files.slice(0, MAX_FILE_ROWS).map((f) => {
                  const { dir, base } = splitPath(f);
                  return (
                    <div key={f} className="rewind-dialog-file" title={f}>
                      {/* LRMs pin the slashes to LTR inside the RTL-truncating span. */}
                      <span className="rewind-dialog-file-dir">{'\u200E'}{dir}{'\u200E'}</span>
                      <span className="rewind-dialog-file-base">{base}</span>
                    </div>
                  );
                })}
                {files.length > MAX_FILE_ROWS && (
                  <div className="rewind-dialog-file rewind-dialog-file-more">
                    +{files.length - MAX_FILE_ROWS} more
                  </div>
                )}
              </div>
            )}
            <label className="rewind-dialog-option">
              <input
                type="checkbox"
                checked={intoCopy}
                disabled={busy}
                onChange={(e) => setIntoCopy(e.target.checked)}
              />
              <span className="rewind-dialog-option-text">
                <span>Rewind into a copy instead</span>
                <span className="rewind-dialog-hint">This conversation stays as it is.</span>
              </span>
            </label>
          </div>
        )}

        {error && <div className="rewind-dialog-error">{error}</div>}

        <div className="app-modal-actions">
          <button type="button" className="app-modal-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="app-modal-btn primary" onClick={confirm} disabled={busy || !preview}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
