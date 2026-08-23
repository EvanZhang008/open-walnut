/**
 * LetterReader — the letter's "inside": a large portalled overlay (PlanPopup
 * scale) with the document body, the decision buttons, the thread and a
 * composer.
 *
 * Three rules this component encodes:
 *  - Opening marks THAT letter read (and only that one). Opening the panel never
 *    marks a letter read, so the reader is the single place read state is set.
 *  - The human's answer is never lost to a delivery problem: the routes record
 *    the turn first and report a delivery STATUS, which is shown next to the
 *    thread instead of being raised as a failure.
 *  - The body is untrusted agent output: HTML renders in a no-script sandbox
 *    (see LetterBody), markdown through the console's own renderer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { lockScroll, unlockScroll } from '@/hooks/useModalOverlay';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { FileViewer } from '@/components/common/FileViewer';
import { formatRelative } from '@/contexts/notifications';
import { log } from '@/utils/log';
import {
  answerLetter, deliveryText, getLetter, humanReplyToLetter,
  LETTER_TYPE_LABEL, type LetterDetail, type LetterEnvelope,
} from '@/api/human-inbox';
import { LetterBody } from './LetterBody';
import { LetterThread } from './LetterThread';
import { senderLabelOf } from './LetterEnvelopeRow';
import '@/styles/human-inbox.css';

interface LetterReaderProps {
  letterId: string;
  /** Envelope already in the rail — renders the header before the GET lands. */
  envelope?: LetterEnvelope;
  onClose: () => void;
  /** A fresher record for the rail list (read / answered / thread length). */
  onLetterUpdated: (letter: LetterEnvelope) => void;
  /** Read state goes through the parent so the rail + bell badge follow at once. */
  onMarkRead: (id: string) => void;
  onTogglePin: (letter: LetterEnvelope) => void;
  onToggleArchive: (letter: LetterEnvelope) => void;
  /** SPA navigation out of the panel (task pills, session refs). */
  onNavigate: (to: string) => void;
}

export function LetterReader({
  letterId, envelope, onClose, onLetterUpdated, onMarkRead, onTogglePin, onToggleArchive,
  onNavigate,
}: LetterReaderProps) {
  const [letter, setLetter] = useState<LetterDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [delivery, setDelivery] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [freeText, setFreeText] = useState('');
  const [fileView, setFileView] = useState<{ path: string; line?: number } | null>(null);
  const fileViewRef = useRef(false);
  fileViewRef.current = !!fileView;

  const shown: LetterEnvelope | LetterDetail | null = letter ?? envelope ?? null;
  const host = shown?.sender?.host && shown.sender.host !== 'local' ? shown.sender.host : undefined;
  const senderSid = shown?.sender?.sessionId && shown.sender.sessionId !== 'external'
    ? shown.sender.sessionId : undefined;

  const onBodyClick = useEntityClickHandler(
    useCallback((taskId: string) => onNavigate(`/tasks/${taskId}`), [onNavigate]),
    useCallback((sid: string) => onNavigate(`/sessions?id=${sid}`), [onNavigate]),
    useCallback((path: string, line?: number) => setFileView({ path, ...(line ? { line } : {}) }), []),
    host,
    senderSid,
  );

  // Escape closes the top-most layer only: with a file preview open it belongs
  // to that preview, which owns its own listener. (The panel underneath also
  // guards on the reader being open, so one Escape never closes three layers.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || fileViewRef.current) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    lockScroll();
    return () => { document.removeEventListener('keydown', onKey); unlockScroll(); };
  }, [onClose]);

  // Load the document (+ thread bodies). A stale answer from a previously opened
  // letter must never land on this one, hence the id check.
  useEffect(() => {
    let live = true;
    setLetter(null);
    setLoadError(null);
    setDelivery(null);
    getLetter(letterId)
      .then((detail) => {
        if (!live) return;
        setLetter(detail);
        onLetterUpdated({ ...detail, read: true });
      })
      .catch((err) => {
        if (!live) return;
        setLoadError('Could not open this letter');
        log.warn('inbox', 'letter open failed', { letterId, error: String(err) });
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- letterId identifies the load
  }, [letterId]);

  // Reading THIS letter is what marks it read (never opening the panel).
  useEffect(() => { onMarkRead(letterId); }, [letterId, onMarkRead]);

  const applyResult = useCallback((next: LetterDetail | undefined, status: string) => {
    if (next) {
      // Keep the document already on screen when the write response carries no
      // body (an older primary, or a relay that stripped it): the reader would
      // otherwise blank the letter the instant the human answered it.
      setLetter(prev => (prev && !next.body
        ? { ...next, body: prev.body, bodyFormat: prev.bodyFormat }
        : next));
      onLetterUpdated({ ...next, read: true });
    }
    setDelivery(status);
  }, [onLetterUpdated]);

  const onAnswer = useCallback(async (actionId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await answerLetter(letterId, actionId, freeText.trim() || undefined);
      applyResult(result.letter, deliveryText(result.delivery, result.reason));
      setFreeText('');
      log.info('inbox', 'letter answered', { letterId, actionId, delivery: result.delivery });
    } catch (err) {
      const status = (err as { status?: number }).status;
      // 409 = answered elsewhere (another tab, the phone). Re-read rather than
      // leaving buttons armed for a decision that is already on record.
      if (status === 409) {
        setDelivery('Already answered somewhere else');
        getLetter(letterId).then(setLetter).catch(() => {});
      } else {
        setDelivery('Could not send that answer — try again');
      }
      log.warn('inbox', 'letter answer failed', { letterId, actionId, error: String(err) });
    } finally {
      setBusy(false);
    }
  }, [busy, letterId, freeText, applyResult]);

  const onReply = useCallback(async () => {
    const text = replyText.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const result = await humanReplyToLetter(letterId, text);
      applyResult(result.letter, deliveryText(result.delivery, result.reason));
      setReplyText('');
      log.info('inbox', 'letter human reply sent', { letterId, delivery: result.delivery });
    } catch (err) {
      setDelivery('Could not send that reply — try again');
      log.warn('inbox', 'letter human reply failed', { letterId, error: String(err) });
    } finally {
      setBusy(false);
    }
  }, [replyText, busy, letterId, applyResult]);

  const answered = shown?.answered;
  const actions = shown?.actions ?? [];
  const canDecide = shown?.type === 'action_required' && actions.length > 0 && !answered;

  return createPortal(
    <>
      <div
        className="hib-reader-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={shown?.subject || 'Letter'}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        {/* Portalled overlay inside the panel's own portal: stop pointer events
            at the container so a drag sensor on an ancestor row can't see them
            (web/src/AGENTS.md — portals escape clipping, not bubbling). */}
        <div
          className="hib-reader"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="hib-reader-head">
            <div className="hib-reader-title">
              <span className="hib-reader-subject">{shown?.subject || 'Letter'}</span>
              {shown && (
                <span className={`hib-type hib-type--${shown.type}`}>
                  {LETTER_TYPE_LABEL[shown.type] ?? shown.type}
                </span>
              )}
            </div>
            <div className="hib-reader-tools">
              {shown && (
                <>
                  <button className="hib-row-btn" onClick={() => onTogglePin(shown)}>
                    {shown.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button className="hib-row-btn" onClick={() => onToggleArchive(shown)}>
                    {shown.archived ? 'Unarchive' : 'Archive'}
                  </button>
                </>
              )}
              <button className="hib-reader-close" onClick={onClose} aria-label="Close letter">
                &times;
              </button>
            </div>
          </div>

          {shown && (
            <div className="hib-reader-meta">
              <span className="hib-chip">{senderLabelOf(shown)}</span>
              {shown.sender?.taskTitle && (
                <span className="hib-chip hib-chip-task">{shown.sender.taskTitle}</span>
              )}
              {shown.sender?.project && <span className="hib-chip">{shown.sender.project}</span>}
              {shown.sender?.host && <span className="hib-chip">{shown.sender.host}</span>}
              <span className="hib-time">{formatRelative(shown.createdAt)}</span>
              {senderSid && (
                <button
                  className="hib-row-btn"
                  onClick={() => onNavigate(`/sessions?id=${senderSid}`)}
                >
                  Open session ↗
                </button>
              )}
            </div>
          )}

          <div className="hib-reader-body">
            {/* The decision lives ABOVE the document: an action_required letter's
                ask must be the most visible thing in it. */}
            {canDecide && (
              <div className="hib-actions">
                <div className="hib-actions-head">This letter needs a decision</div>
                {actions.map((action) => (
                  <button
                    key={action.id}
                    className="hib-action-btn"
                    disabled={busy}
                    onClick={() => void onAnswer(action.id)}
                  >
                    <span className="hib-action-label">{action.label || action.id}</span>
                    {action.description && (
                      <span className="hib-action-desc">{action.description}</span>
                    )}
                  </button>
                ))}
                <textarea
                  className="hib-freetext"
                  placeholder="Optional note to send with your choice"
                  value={freeText}
                  onChange={(e) => setFreeText(e.target.value)}
                  rows={2}
                />
              </div>
            )}
            {answered && (
              <div className="hib-answered">
                Answered: <strong>{answered.label || answered.actionId}</strong>
                {' · '}{formatRelative(answered.at)}
                {answered.freeText && <div className="hib-answered-note">{answered.freeText}</div>}
              </div>
            )}

            {loadError && <div className="hib-note hib-note-error">{loadError}</div>}
            {!letter && !loadError && <div className="hib-note">Opening…</div>}
            {letter && (
              <>
                {/* The server already inlines its own "body file is missing"
                    note into `body`; render the plain notice instead of framing
                    that one line as a document. */}
                {letter.bodyMissing ? (
                  <div className="hib-note">
                    The body of this letter is no longer on disk. The envelope and thread are intact.
                  </div>
                ) : (
                  <LetterBody
                    body={letter.body}
                    format={letter.bodyFormat}
                    subject={letter.subject}
                    onClick={onBodyClick}
                  />
                )}
                {(letter.taskRefs?.length ?? 0) > 0 && (
                  <div className="hib-taskrefs" onClick={onBodyClick}>
                    <span className="hib-taskrefs-label">Tasks</span>
                    {letter.taskRefs?.map((taskId) => (
                      <a
                        key={taskId}
                        className="task-link"
                        data-task-id={taskId}
                        href={`/tasks/${taskId}`}
                      >
                        {taskId}
                      </a>
                    ))}
                  </div>
                )}
                <LetterThread
                  entries={letter.thread}
                  subject={letter.subject}
                  onBodyClick={onBodyClick}
                />
              </>
            )}
          </div>

          <div className="hib-composer">
            {delivery && <div className="hib-delivery">{delivery}</div>}
            <textarea
              className="hib-composer-input"
              placeholder="Reply to this letter…"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void onReply(); }
              }}
              rows={2}
            />
            <button
              className="hib-send-btn"
              disabled={busy || !replyText.trim()}
              onClick={() => void onReply()}
            >
              Send
            </button>
          </div>
        </div>
      </div>
      {fileView && (
        <FileViewer
          path={fileView.path}
          {...(fileView.line ? { line: fileView.line } : {})}
          {...(host ? { host } : {})}
          onClose={() => setFileView(null)}
        />
      )}
    </>,
    document.body,
  );
}
