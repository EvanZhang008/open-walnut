/**
 * The Org page's composer under the Board and Team tabs: one line to the node's
 * session, the same `session:send` the chat's own composer uses (the detail's useSessionSend).
 * After a send the page shows the Chat tab, where the message lands.
 */
import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { log } from '@/utils/log';
import { BoxMic, type BoxMicHandle } from '@/components/common/BoxMic';

interface Props {
  sessionId: string;
  to: string;
  /** The detail's useSessionSend `send`, bound to this session. */
  send: (text: string) => Promise<boolean>;
  onSent: () => void;
}

export function OrgComposerBar({ sessionId, to, send, onSent }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const mic = useRef<BoxMicHandle | null>(null);
  // Grow with the text (WebKit before field-sizing): up to the CSS max-height, then scroll.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);

  const submit = async () => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    const ok = await send(message).catch(() => false);
    setBusy(false);
    log.info('org-page', 'composer send', { sessionId, ok });
    if (!ok) { setError('Not sent. Try again.'); return; }
    setText('');
    mic.current?.clear();
    onSent();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
  };

  return (
    <form className="org-composer" data-testid="org-composer" onSubmit={(e: FormEvent) => { e.preventDefault(); void submit(); }}>
      <textarea
        ref={box}
        className="org-composer-input"
        rows={1}
        value={text}
        placeholder={`Message ${to}…`}
        aria-label={`Message ${to}`}
        onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
        onKeyDown={onKeyDown}
      />
      {error && <span className="org-composer-error" role="alert">{error}</span>}
      <BoxMic boxRef={box} text={text} setText={(v) => { setText(v); if (error) setError(null); }} handleRef={mic} disabled={busy} />
      <button type="submit" className="btn btn-sm btn-primary org-composer-send" disabled={busy || !text.trim()} data-testid="org-composer-send">
        {busy ? 'Sending…' : 'Send'}
      </button>
    </form>
  );
}
