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
import { BoxMic, type BoxMicHandle } from '@/components/common/BoxMic';
import { useImageAttachments } from '@/components/common/image-attachments';
import { AttachPictureButton, PictureStrip, usePictureInput } from '@/components/common/PictureStrip';
import { buildImageRefsPayload } from '@/api/image-upload';
import type { ImageAttachment } from '@/api/chat';
import { useSendAfterDictation, dictationWaitProps } from '@/hooks/useSendAfterDictation';
import { useDraft } from '@/hooks/useDraft';
import { sessionDraftKey } from '@/utils/composer-insert';
import { draftKey } from '@/utils/drafts';
import type { KanbanCardComposerProps } from './kanban-contract';
import { cutTitle } from './kanban-changes-model';

const SEND_TIMEOUT_MS = 15_000;

/** `Message <worker title, cut at 30>`. */
export function composerPlaceholder(title: string): string {
  return `Message ${cutTitle(title, 30)}`;
}

/** The send itself (the composer's own RPC), failing after 15s without an answer. */
export async function sendToCardSession(sessionId: string, message: string, images?: ImageAttachment[]): Promise<void> {
  // Pictures go up over HTTP first, never on the socket; the RPC carries their names (api/image-upload.ts).
  const pictures = await buildImageRefsPayload(images);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no answer in 15s')), SEND_TIMEOUT_MS); });
  try {
    await Promise.race([wsClient.sendRpc<{ messageId: string }>('session:send', { sessionId, message, ...pictures }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function reasonOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.trim() || 'the session did not take it';
}

export function KanbanCardComposer({ card, onSent, onClose }: KanbanCardComposerProps) {
  // The worker's session draft (the same words its own composer shows); a card with no session yet keeps its own.
  const draft = useDraft(card.sessionId ? sessionDraftKey(card.sessionId) : draftKey('kanban-card', card.taskId));
  const { text, setText } = draft;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const mic = useRef<BoxMicHandle | null>(null);
  // Pictures go with the message, as in the chat (common/image-attachments.ts).
  const pictures = useImageAttachments();
  const pictureInput = usePictureInput(pictures, !sending);
  useEffect(() => { ref.current?.focus(); }, []);

  const sendNow = async () => {
    const message = text.trim();
    const images = pictures.images;
    if ((!message && images.length === 0) || sending) return;
    const sessionId = card.sessionId;
    if (!sessionId) { setError('No session yet. Use Start worker.'); return; }
    setSending(true);
    setError('');
    const started = Date.now();
    const sentKey = draft.key;
    try {
      await sendToCardSession(sessionId, message, images.length ? images : undefined);
      log.info('board', 'kanban card message sent', { cardTaskId: card.taskId, sessionId, images: images.length, ms: Date.now() - started });
      setSending(false);
      draft.clear(sentKey);
      mic.current?.clear();
      pictures.clear();
      onSent();
    } catch (err) {
      log.warn('board', 'kanban card message failed', { cardTaskId: card.taskId, sessionId, error: String(err) });
      setSending(false);
      setError(reasonOf(err));
    }
  };
  // Enter, Send and Retry wait for a live dictation's words, then send.
  const gate = useSendAfterDictation([mic], () => { void sendNow(); });

  return (
    <div className="kanban-card-composer" data-testid="kanban-card-composer" data-sending={sending || undefined}
      onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <PictureStrip pictures={pictures} className="kanban-composer-pictures" testId="kanban-card-composer-pictures" readOnly={sending} />
      <div className={`kanban-composer-row${pictureInput.dragOver ? ' is-drag-over' : ''}`} {...pictureInput.dropProps}>
        <textarea
          ref={ref}
          className="kanban-composer-input"
          data-testid="kanban-card-composer-input"
          data-draft-key={draft.key ?? undefined}
          rows={1}
          placeholder={composerPlaceholder(card.title)}
          aria-label={`Message ${card.title}`}
          value={text}
          readOnly={sending}
          onChange={(e) => { setText(e.target.value); if (error) setError(''); }}
          onPaste={pictureInput.onPaste}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); gate.send(); }
          }}
        />
        <AttachPictureButton pictures={pictures} testId="kanban-card-composer-attach" disabled={sending} />
        <BoxMic boxRef={ref} text={text} setText={(v) => { setText(v); if (error) setError(''); }} handleRef={mic} disabled={sending} />
        {sending ? <span className="kanban-spinner" data-testid="kanban-card-composer-sending" aria-label="Sending" /> : (
          <button
            type="button" className="kanban-text-btn kanban-composer-send" data-testid="kanban-card-composer-send"
            aria-disabled={(!text.trim() && pictures.images.length === 0 && !gate.micBusy && !gate.waiting) || undefined}
            onClick={gate.send} {...dictationWaitProps(gate, text.trim() || pictures.images.length || gate.micBusy ? 'Send (Enter)' : 'Type a message first')}
          >Send</button>
        )}
      </div>
      {error && (
        <div className="kanban-composer-error" data-testid="kanban-card-composer-error" role="alert">
          Couldn't send: {error}{' '}
          <button type="button" className="kanban-text-btn" data-testid="kanban-card-composer-retry" onClick={gate.send}>Retry</button>
        </div>
      )}
    </div>
  );
}
