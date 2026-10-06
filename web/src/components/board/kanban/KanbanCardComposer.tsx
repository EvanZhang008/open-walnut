/**
 * A one line message to a card's worker, from the card (spec 6.1): the same
 * `session:send` path the session composer uses, so the message queues,
 * delivers and shows in the chat exactly as if typed there. Enter sends,
 * Shift+Enter is a new line, Escape closes. While it sends the field is read
 * only with a spinner; success closes it (the card flashes `Sent`); a failure
 * keeps the text and says `Couldn't send: <reason>` with a Retry. A Send button
 * sits beside the field (N21) and turns into the spinner while it sends; the
 * placeholder names the worker by its title cut at 30 (R3-24, spec 6.1): the
 * ticket alone does not say which worker hears it.
 */
import { useEffect, useRef, useState } from 'react';
import { wsClient } from '@/api/ws';
import { log } from '@/utils/log';
import type { KanbanCardComposerProps } from './kanban-contract';
import { cutTitle } from './kanban-changes-model';

const SEND_TIMEOUT_MS = 15_000;

/** `Message <worker title, cut at 30>`. */
export function composerPlaceholder(title: string): string {
  return `Message ${cutTitle(title, 30)}`;
}

/** The send itself (the composer's own RPC), failing after 15s without an answer. */
export async function sendToCardSession(sessionId: string, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no answer in 15s')), SEND_TIMEOUT_MS); });
  try {
    await Promise.race([wsClient.sendRpc<{ messageId: string }>('session:send', { sessionId, message }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function reasonOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.trim() || 'the session did not take it';
}

export function KanbanCardComposer({ card, onSent, onClose }: KanbanCardComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    const sessionId = card.sessionId;
    if (!sessionId) { setError('No session yet. Use Start worker.'); return; }
    setSending(true);
    setError('');
    const started = Date.now();
    try {
      await sendToCardSession(sessionId, message);
      log.info('board', 'kanban card message sent', { cardTaskId: card.taskId, sessionId, ms: Date.now() - started });
      setSending(false);
      setText('');
      onSent();
    } catch (err) {
      log.warn('board', 'kanban card message failed', { cardTaskId: card.taskId, sessionId, error: String(err) });
      setSending(false);
      setError(reasonOf(err));
    }
  };

  return (
    <div className="kanban-card-composer" data-testid="kanban-card-composer" data-sending={sending || undefined}
      onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <div className="kanban-composer-row">
        <textarea
          ref={ref}
          className="kanban-composer-input"
          data-testid="kanban-card-composer-input"
          rows={1}
          placeholder={composerPlaceholder(card.title)}
          aria-label={`Message ${card.title}`}
          value={text}
          readOnly={sending}
          onChange={(e) => { setText(e.target.value); if (error) setError(''); }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
          }}
        />
        {sending ? <span className="kanban-spinner" data-testid="kanban-card-composer-sending" aria-label="Sending" /> : (
          <button
            type="button" className="kanban-text-btn kanban-composer-send" data-testid="kanban-card-composer-send"
            aria-disabled={!text.trim() || undefined} title={text.trim() ? 'Send (Enter)' : 'Type a message first'}
            onClick={() => void send()}
          >Send</button>
        )}
      </div>
      {error && (
        <div className="kanban-composer-error" data-testid="kanban-card-composer-error" role="alert">
          Couldn't send: {error}{' '}
          <button type="button" className="kanban-text-btn" data-testid="kanban-card-composer-retry" onClick={() => void send()}>Retry</button>
        </div>
      )}
    </div>
  );
}
