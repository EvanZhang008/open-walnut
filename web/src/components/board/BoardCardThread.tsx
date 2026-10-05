/**
 * The conversation parts of a project card (BoardProjectCard.tsx): a thread
 * (the card's Questions, or a choice's discussion), the inline composer the
 * user writes in, and the leader's light-markdown text.
 *
 * A thread starts closed: its count, a red "N new", and the newest message on
 * one line. Opening it shows the messages and the composer, and marks it read
 * up to the newest message (the same per-browser seen record the page uses, so
 * the Custom view agrees). A send shows at once as pending; the route stores it
 * and delivers it to the board's session like a message from the page. A failed
 * send gives the text back to the composer with the reason.
 *
 * Drafts outlive the card (switching to Custom and back unmounts it): kept per
 * board and thread in this module until sent.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { log } from '@/utils/log';
import { timeAgo } from '@/utils/time';
import { authorLabel, peekText, type CardThread } from './board-cards-model';

/** Unsent words per `${board}|${target}`. */
const drafts = new Map<string, string>();
/** Messages a closed thread keeps below its head, the rest behind "Show earlier". */
const SHOWN_MESSAGES = 6;

export interface CardContext {
  ownerId: string;
  titleOf: (taskId: string) => string;
  onOpenTask: (taskId: string) => void;
}

/** "Oct 4, 17:57" in the reader's zone; '' for an unreadable time. */
export function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The leader's text as light markdown; a task link inside opens the task beside the board. */
export function MdText({ text, className, onOpenTask }: { text: string; className?: string; onOpenTask: (taskId: string) => void }) {
  const labels = useEntityLabelsVersion();
  const html = useMemo(() => renderMarkdownWithRefs(text, undefined, undefined, { taskIds: 'links' }), [text, labels]); // eslint-disable-line react-hooks/exhaustive-deps
  const onClick = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as Element | null)?.closest?.('a.task-link[data-task-id]') as HTMLAnchorElement | null;
    const id = a?.dataset.taskId;
    if (!id || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onOpenTask(id);
  }, [onOpenTask]);
  return <div className={`markdown-body bpc-md${className ? ` ${className}` : ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * A textarea that sends on Enter (Shift+Enter is a new line, and Enter while an
 * input method composes is the IME's), closes on Escape. Resolves the send to
 * null when stored, else the reason, which it shows; the text stays until stored.
 */
export function CardComposer({ draftKey, placeholder, sendLabel, initial = '', autoFocus, onSend, onClose }: {
  draftKey: string;
  placeholder: string;
  sendLabel: string;
  initial?: string;
  autoFocus?: boolean;
  onSend: (text: string) => Promise<string | null>;
  onClose?: () => void;
}) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  // Grow with the text up to a few lines (the CSS caps the height).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // border-box: the borders on top of the content, or one line already scrolls.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [text]);
  const change = (v: string) => {
    setText(v);
    if (v) drafts.set(draftKey, v); else drafts.delete(draftKey);
  };
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError('');
    const failed = await onSend(body);
    setBusy(false);
    if (failed) { setError(failed); return; }
    drafts.delete(draftKey);
    setText('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void send();
    } else if (e.key === 'Escape' && onClose) {
      e.preventDefault();
      onClose();
    }
  };
  return (
    <div className="bpc-composer" data-testid="board-card-composer">
      <textarea
        ref={ref}
        className="bpc-composer-input"
        rows={1}
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={busy}
        onChange={(e) => change(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="bpc-composer-row">
        {error && <span className="bpc-error" role="alert" data-testid="board-card-composer-error">Not sent: {error}</span>}
        <span className="bpc-composer-hint">Enter to send, Shift+Enter for a new line</span>
        {onClose && (
          <button type="button" className="bpc-btn" onClick={onClose} disabled={busy}>Cancel</button>
        )}
        <button
          type="button"
          className="bpc-btn bpc-btn-primary"
          data-testid="board-card-send"
          disabled={busy || !text.trim()}
          onClick={() => void send()}
        >{busy ? 'Sending…' : sendLabel}</button>
      </div>
    </div>
  );
}

interface Pending { key: string; text: string }

/** One thread on a card: closed to its head and newest line, open to the messages and the composer. */
export function CardThreadBlock({ thread, label, ctx, onPost, onSeen, startOpen = false }: {
  thread: CardThread;
  label: string;
  ctx: CardContext;
  onPost?: (threadId: string, text: string) => Promise<string | null>;
  onSeen?: (threadId: string, ts: string) => void;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [composing, setComposing] = useState(false);
  const [all, setAll] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const n = thread.messages.length;

  // Open is read: up to the newest message that is not the user's.
  useEffect(() => {
    if (open && thread.unread > 0 && thread.newestOther) onSeen?.(thread.id, thread.newestOther);
  }, [open, thread.id, thread.unread, thread.newestOther, onSeen]);

  const post = useCallback(async (text: string): Promise<string | null> => {
    if (!onPost) return 'This board cannot be written here';
    const key = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    log.info('board', 'overview question sending', { taskId: ctx.ownerId, thread: thread.id, chars: text.length });
    setPending((cur) => [...cur, { key, text }]);
    const failed = await onPost(thread.id, text);
    setPending((cur) => cur.filter((p) => p.key !== key));
    return failed;
  }, [onPost, ctx.ownerId, thread.id]);

  const shown = all || n <= SHOWN_MESSAGES ? thread.messages : thread.messages.slice(n - SHOWN_MESSAGES);
  const newest = n > 0 ? thread.messages[n - 1] : null;
  const count = n === 0 ? 'No messages yet' : n === 1 ? '1 message' : `${n} messages`;
  return (
    <div className="bpc-thread" data-thread-id={thread.id} data-open={open ? 'true' : 'false'} data-testid="board-card-thread">
      <div className="bpc-thread-head">
        <button
          type="button"
          className="bpc-thread-toggle"
          aria-expanded={open}
          data-testid="board-card-thread-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`bo-chevron${open ? ' is-open' : ''}`} aria-hidden="true" />
          <span className="bpc-thread-label">{label}</span>
          <span className="bpc-thread-count">{count}</span>
          {thread.unread > 0 && <span className="bpc-new" data-testid="board-card-thread-unread">{thread.unread} new</span>}
        </button>
        {onPost && !composing && (
          <button
            type="button"
            className="bpc-btn bpc-ask"
            data-testid="board-card-ask"
            onClick={() => { setOpen(true); setComposing(true); }}
          >Ask a question</button>
        )}
      </div>
      {!open && newest && (
        <button type="button" className="bpc-thread-peek" onClick={() => setOpen(true)} title="Open the thread">
          <span className="bpc-who">{authorLabel(newest.author, ctx.ownerId, ctx.titleOf)}</span>
          <span className="bpc-peek-text">{peekText(newest.text)}</span>
        </button>
      )}
      {open && (
        <div className="bpc-thread-body">
          {!all && n > SHOWN_MESSAGES && (
            <button type="button" className="bo-link bpc-earlier" onClick={() => setAll(true)}>
              Show {n - SHOWN_MESSAGES} earlier
            </button>
          )}
          {shown.map((m) => (
            <div key={m.id} className="bpc-msg" data-author={m.author === 'user' ? 'user' : 'agent'} data-testid="board-card-message">
              <div className="bpc-msg-meta">
                <span className="bpc-who">{authorLabel(m.author, ctx.ownerId, ctx.titleOf)}</span>
                <span className="bpc-when" title={new Date(m.ts).toLocaleString()}>{timeAgo(m.ts)}</span>
              </div>
              <MdText text={m.text} onOpenTask={ctx.onOpenTask} />
            </div>
          ))}
          {pending.map((p) => (
            <div key={p.key} className="bpc-msg is-pending" data-author="user" data-testid="board-card-message-pending">
              <div className="bpc-msg-meta"><span className="bpc-who">You</span><span className="bpc-when">Sending…</span></div>
              <div className="bpc-md bpc-plain">{p.text}</div>
            </div>
          ))}
          {onPost && (composing || n > 0) && (
            <CardComposer
              draftKey={`${ctx.ownerId}|${thread.id}`}
              placeholder={n > 0 ? 'Reply…' : 'Ask the leader a question…'}
              sendLabel="Send"
              autoFocus={composing}
              onSend={post}
              onClose={composing && n === 0 ? () => setComposing(false) : undefined}
            />
          )}
        </div>
      )}
    </div>
  );
}
