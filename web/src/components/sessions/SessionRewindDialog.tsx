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
 *    this one untouched (so it sends `keepSource` — the fork path archives the
 *    source by default, which is the opposite of what this option promises).
 */

interface SessionRewindDialogProps {
  sessionId: string;
  msgId: string;
  /** Label of the target message, for the "back to" line. */
  label?: string;
  /**
   * How many of the dropped messages belong to OTHER conversation threads than the
   * target's. Passed only by the node view, where the screen shows one thread and
   * "the 12 messages after it" would otherwise read as twelve messages of the
   * thread you are looking at. Counted over the rows the browser has loaded, so it
   * is capped by the server's own count below.
   */
  otherThreadsDropped?: number;
  onClose: () => void;
  /** The rewound session replaces this one in its column. */
  onRewound: (result: RewindResult) => void;
}

const MAX_FILE_ROWS = 6;

function splitPath(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
}

/**
 * A rewind goes back to just BEFORE the message was sent: the message itself and
 * everything after it leave the conversation, and its text returns to the input
 * box to edit and resend. `droppedMessages` already counts the target.
 */
function describeDrop(preview: RewindPreview, intoCopy: boolean, otherThreads = 0): string {
  // `droppedMessages` counts the target itself plus everything after it.
  const after = Math.max(0, preview.droppedMessages - 1);
  // A rewind is a TIME operation: it takes every later message, whatever thread it
  // ended up in. The node view shows one thread, so this is the only place that can
  // say the rest are going too.
  const inOthers = Math.min(otherThreads, after);
  const alsoAfter = after === 0
    ? ''
    : `, dropping it and the ${after} ${after === 1 ? 'message' : 'messages'} after it`
      + (inOthers > 0 ? ` (including ${inOthers} in other threads)` : '');
  const back = preview.restoredPrompt
    ? ' Its text goes back to the input box, so you can edit it and send again.'
    : '';
  // No "and this one stays as it is" here — the checkbox's own hint says that,
  // permanently, and repeating it verbatim two lines apart just reads as noise.
  if (intoCopy) {
    return `A copy of this conversation picks up just before this message${alsoAfter}.` + back;
  }
  return `This conversation goes back to just before this message${alsoAfter}.` + back;
}

export function SessionRewindDialog({
  sessionId, msgId, label, otherThreadsDropped, onClose, onRewound,
}: SessionRewindDialogProps) {
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
    rewindSession(sessionId, msgId, {
      mode: intoCopy ? 'fork' : 'in-place',
      restoreFiles,
      // "Into a copy" is the escape hatch for keeping THIS conversation, so it
      // must not archive it. (The fork path archives by default because it used
      // to BE the rewind: back then the source really was the abandoned branch.)
      ...(intoCopy ? { keepSource: true } : {}),
    })
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
          {/* Most dry-run failures are a REFUSAL with a reason (nothing before this
              message to resume at, the message is behind a compaction), not a
              hiccup — so it reads as the answer, not as a failed attempt. The
              confirm button is disabled while there is no preview either way. */}
          {previewError && <span className="rewind-dialog-error-text">Can’t rewind here: {previewError}</span>}
          {preview && describeDrop(preview, intoCopy, otherThreadsDropped)}
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
