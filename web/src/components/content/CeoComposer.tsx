/**
 * The Talk to CEO box (utils/content-actions.ts `openCeoComposer`): the person writes what they
 * want to tell the CEO, the item rides along as attached context, and Send sends both. Nothing is
 * sent before Send (2026-11-03, the user: "I definitely have something to say ... at least give me
 * an input box"). One box for every surface (the Mail reader, an Inbox letter, a plugin's buttons or
 * menu), rendered once by ContentActionsHost. It opens below the point it was asked from, or in the
 * middle of the window when there is none. What was typed is kept while the page lives, so a box
 * closed by mistake opens again with it.
 */
import { useEffect, useRef, useState } from 'react';
import { useMenuPlacement } from '@/hooks/useMenuPlacement';
import { CEO_NOTE_MAX, sendToCeo, type CeoComposerRequest } from '@/utils/content-actions';
import '@/styles/content-actions.css';

const typed = new Map<string, string>();
// One kept note per piece of content: two mails with one subject are two items.
const keyOf = ({ item }: CeoComposerRequest) => [item.source, item.title, item.open, item.url, item.from, item.at].join('\n');

export function CeoComposer({ req, onClose }: { req: CeoComposerRequest; onClose(sent: boolean): void }) {
  const key = keyOf(req);
  const [note, setNote] = useState(() => typed.get(key) ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const noTrigger = useRef<HTMLElement>(null);
  const placement = useMenuPlacement(!!req.anchor, noTrigger, boxRef, {
    anchorPoint: req.anchor, align: 'left', edgeOverflow: 'clamp', gap: 4, minHeight: 200,
  });

  // Focus once it is placed (a box still hidden for measuring cannot take focus), and again after
  // a send that failed (the caret goes back where it was).
  const shown = !req.anchor || placement !== null;
  useEffect(() => {
    if (sending || !shown) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (!error) el.setSelectionRange(el.value.length, el.value.length);
  }, [sending, error, shown]);

  // Outside a click or Escape closes it (what was typed is kept); a send in flight finishes first.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      // The button it came from closes it itself (a press there toggles it).
      if (sending || boxRef.current?.contains(target) || req.owner?.contains(target)) return;
      onClose(false);
    };
    // Escape that ends an IME composition is the input method's, not a close.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !sending && !e.isComposing && e.keyCode !== 229) { e.stopPropagation(); onClose(false); }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, sending, req.owner]);

  const words = note.trim();
  const send = () => {
    if (!words || sending) return;
    setSending(true);
    setError(null);
    sendToCeo(req.item, words).then(
      () => { typed.delete(key); onClose(true); },
      (err: unknown) => { setSending(false); setError(err instanceof Error && err.message ? err.message : 'Not sent'); },
    );
  };

  const { item } = req;
  const from = [item.from, item.where].filter(Boolean).join(' · ');
  return (
    <div
      ref={boxRef}
      className={`ceo-composer${req.anchor ? '' : ' ceo-composer-centered'}`}
      role="dialog"
      aria-label="Talk to CEO"
      data-testid="ceo-composer"
      // A portal under the page: keep a drag or a row's own click handler from taking this press.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={req.anchor
        ? placement
          ? { top: placement.top, right: placement.right, maxHeight: placement.maxHeight }
          : { visibility: 'hidden', top: 0, left: 0 }
        : undefined}
    >
      <div className="ceo-composer-head">
        <span>Talk to CEO</span>
        <button type="button" className="ceo-composer-close" aria-label="Close" disabled={sending} onClick={() => onClose(false)}>×</button>
      </div>
      <textarea
        ref={inputRef}
        className="ceo-composer-input"
        data-testid="ceo-composer-input"
        rows={3}
        maxLength={CEO_NOTE_MAX}
        placeholder="What do you want to tell the CEO about this?"
        value={note}
        readOnly={sending}
        onChange={(e) => { setNote(e.target.value); typed.set(key, e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
        }}
      />
      <div className="ceo-composer-attached" data-testid="ceo-composer-attached" title="Sent with your message as context">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.5 4.5 5.8 9.2a1.6 1.6 0 0 0 2.3 2.3l5-5a3 3 0 0 0-4.3-4.3l-5 5a4.4 4.4 0 0 0 6.2 6.2l4-4"/></svg>
        <span className="ceo-composer-source">{item.source}</span>
        <span className="ceo-composer-title">{item.title}</span>
        {from && <span className="ceo-composer-from">{from}</span>}
      </div>
      {error && <div className="ceo-composer-error" role="alert">{error}</div>}
      <div className="ceo-composer-foot">
        <span className="ceo-composer-hint">⌘↵ to send</span>
        <button type="button" className="content-action-btn" disabled={sending} onClick={() => onClose(false)}>Cancel</button>
        <button type="button" className="content-action-btn ceo-composer-send" data-testid="ceo-composer-send" disabled={!words || sending} onClick={send}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
