/**
 * LetterView — a letter's "inside", embeddable: head, decision buttons, the
 * document body, the thread and the reply composer.
 *
 * This is the ONE implementation of reading and answering a letter. Two surfaces
 * render it: the notification-center overlay (`LetterReader`, which adds the
 * portal, the scroll lock and the layered Escape) and the session panel's Inbox
 * tab (`SessionInboxPane`, which renders it in the split column next to chat).
 * They are two lenses on the same store, never two copies of the behavior.
 *
 * Four rules this component encodes:
 *  - Opening marks THAT letter read (and only that one). Opening a panel never
 *    marks a letter read, so this is the single place read state is set.
 *  - The human's answer is never lost to a delivery problem: the routes record
 *    the turn first and report a delivery STATUS, shown next to the composer
 *    instead of raised as a failure.
 *  - The body is untrusted agent output: HTML renders in a no-script sandbox
 *    (see LetterBody), markdown through the console's own renderer.
 *  - Overlays belong to the HOST, not here: a file path click is handed up
 *    (`onOpenFile`), so the overlay can pop a FileViewer while the session tab
 *    routes the path into its own Files split (a path click inside a session
 *    must never open a modal).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { useTaskLabel } from '@/hooks/useEntityLabels';
import { formatRelative } from '@/contexts/notifications';
import { log } from '@/utils/log';
import {
  answerLetter, deliveryText, getLetter, humanReplyToLetter,
  LETTER_TYPE_LABEL, type LetterDetail, type LetterEnvelope,
} from '@/api/human-inbox';
import { LetterBody } from './LetterBody';
import { LetterThread } from './LetterThread';
import { senderLabelOf } from './LetterEnvelopeRow';
import { useLetterEvents } from '@/hooks/useHumanInbox';
import { sessionInboxLetterHref } from './session-inbox-link';
import '@/styles/human-inbox.css';

/** Where a file reference in a letter body should open. */
export interface LetterFileTarget {
  path: string;
  line?: number;
  /** The sender's host — a letter from a remote session cites remote paths. */
  host?: string;
}

export interface LetterViewProps {
  letterId: string;
  /** Envelope already in a list — renders the header before the GET lands. */
  envelope?: LetterEnvelope;
  /** A fresher record for the caller's list (read / answered / thread length). */
  onLetterUpdated: (letter: LetterEnvelope) => void;
  /** Read state goes through the host so its list + the bell badge follow at once. */
  onMarkRead: (id: string) => void;
  onTogglePin: (letter: LetterEnvelope) => void;
  onToggleArchive: (letter: LetterEnvelope) => void;
  /** SPA navigation (task pills, session refs). */
  onNavigate: (to: string) => void;
  /** A file path in the body — the host decides where it opens. */
  onOpenFile: (target: LetterFileTarget) => void;
  /** Overlay only: renders the × in the head. */
  onClose?: () => void;
  /** Rendered at the head's left (the tab's "back to the list" control). */
  headLeading?: ReactNode;
  /** Fill the host column instead of sizing like the modal box. */
  embedded?: boolean;
  /** Hidden inside the session's own Inbox tab — you are already there. */
  showOpenSession?: boolean;
}

/** Coalesce a burst of letter events into one detail re-read. */
const LIVE_REFRESH_MS = 350;

/** Task chip in the letter footer: current title from the entity-label store,
 *  the raw id only when the task can't be resolved. Own component so the
 *  per-id store subscription isn't a hook-in-a-loop in LetterView. */
function TaskRefChip({ taskId }: { taskId: string }) {
  const label = useTaskLabel(taskId);
  return (
    <a
      className="task-link"
      data-task-id={taskId}
      href={`/tasks/${taskId}`}
      title={label?.project ? `${label.project} / ${label.title}` : taskId}
    >
      {label?.title ?? taskId}
    </a>
  );
}

export function LetterView({
  letterId, envelope, onLetterUpdated, onMarkRead, onTogglePin, onToggleArchive,
  onNavigate, onOpenFile, onClose, headLeading, embedded, showOpenSession = true,
}: LetterViewProps) {
  const [letter, setLetter] = useState<LetterDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [delivery, setDelivery] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [freeText, setFreeText] = useState('');

  const shown: LetterEnvelope | LetterDetail | null = letter ?? envelope ?? null;
  const host = shown?.sender?.host && shown.sender.host !== 'local' ? shown.sender.host : undefined;
  const senderSid = shown?.sender?.sessionId && shown.sender.sessionId !== 'external'
    ? shown.sender.sessionId : undefined;

  const onBodyClick = useEntityClickHandler(
    useCallback((taskId: string) => onNavigate(`/tasks/${taskId}`), [onNavigate]),
    useCallback((sid: string) => onNavigate(`/sessions?id=${sid}`), [onNavigate]),
    useCallback(
      (path: string, line?: number) => onOpenFile({ path, ...(line ? { line } : {}), ...(host ? { host } : {}) }),
      [onOpenFile, host],
    ),
    host,
    senderSid,
  );

  // Load the document (+ thread bodies). A response for a letter the user has
  // already navigated away from must never land on the one on screen — hence
  // BOTH the per-call `live` flag and the id check (a quiet live refresh has no
  // cleanup to flip `live`, so the id ref is what protects it).
  const currentId = useRef(letterId);
  currentId.current = letterId;
  const reload = useCallback((quiet: boolean) => {
    let live = true;
    if (!quiet) { setLetter(null); setLoadError(null); setDelivery(null); }
    getLetter(letterId)
      .then((detail) => {
        if (!live || currentId.current !== letterId) return;
        setLetter(detail);
        setLoadError(null);
        // `read: true` belongs to the OPEN only: the open is what marks the letter
        // read, and the GET can race its own read POST. A QUIET refresh must carry
        // the server's flag through untouched — an agent reply deliberately flips
        // the letter unread, and forcing true here fought the list's own refresh,
        // so the row and the bell badge landed on whichever answer arrived last.
        onLetterUpdated(quiet ? detail : { ...detail, read: true });
      })
      .catch((err) => {
        if (!live || quiet || currentId.current !== letterId) return;
        setLoadError('Could not open this letter');
        log.warn('inbox', 'letter open failed', { letterId, error: String(err) });
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- letterId identifies the load
  }, [letterId]);

  useEffect(() => reload(false), [reload]);

  // Live: an agent reply / another surface's answer must grow the thread of the
  // letter ON SCREEN without a reload. Same lanes the list listens on; a quiet
  // re-read so the body never blanks while the GET is in flight.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLetterEvents(useCallback((changed: string | null) => {
    if (changed && changed !== letterId) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; reload(true); }, LIVE_REFRESH_MS);
  }, [letterId, reload]));
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, [letterId]);

  // Reading THIS letter is what marks it read (never opening a panel).
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
  // Deep-link back to the sender's own Inbox tab with this letter open, so the
  // cross-session rail and the per-session tab are one navigation apart.
  const openSessionHref = useMemo(
    () => (senderSid ? sessionInboxLetterHref(senderSid, letterId) : null),
    [senderSid, letterId],
  );

  return (
    <div className={`hib-view${embedded ? ' hib-view-embedded' : ''}`}>
      <div className="hib-reader-head">
        {headLeading}
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
          {onClose && (
            <button className="hib-reader-close" onClick={onClose} aria-label="Close letter">
              &times;
            </button>
          )}
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
          {showOpenSession && openSessionHref && (
            <button className="hib-row-btn" onClick={() => onNavigate(openSessionHref)}>
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
            {/* The server already inlines its own "body file is missing" note
                into `body`; render the plain notice instead of framing that one
                line as a document. */}
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
                  <TaskRefChip key={taskId} taskId={taskId} />
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
  );
}
