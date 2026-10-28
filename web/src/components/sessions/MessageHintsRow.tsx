/**
 * The message hints a user row carried (src/core/hints/), as one folded row under
 * the person's words: "Walnut hints: Rich output · Reply language". The text of each
 * opens on click. The hints are taken off the bubble by structure (the history
 * projection), so this row is the one place the normal view says they were there;
 * the raw view (SessionRawView) shows the whole input as the model received it.
 */
import { useState } from 'react';
import type { CarriedHint } from '@open-walnut/hint-format';
import '@/styles/injected-banner.css';

const LABELS: Record<string, string> = {
  question: 'Question',
  'rich-output': 'Rich output',
  'reply-language': 'Reply language',
  'voice-reply': 'Voice reply',
  // An ACP engine with no system prompt reads its session instructions here (acp-session.ts).
  'session-context': 'Session instructions',
};

export function hintLabel(h: Pick<CarriedHint, 'kind' | 'arg'>): string {
  const base = LABELS[h.kind] ?? h.kind;
  return h.arg ? `${base} ${h.kind === 'question' ? `Q${h.arg}` : h.arg}` : base;
}

export function MessageHintsRow({ hints }: { hints: readonly CarriedHint[] }) {
  const [open, setOpen] = useState(false);
  if (!hints.length) return null;
  return (
    <div className="tool-run-row injected-banner-row message-hints-row" data-testid="message-hints">
      <button
        type="button"
        className="tool-run-toggle"
        onClick={(e) => { e.stopPropagation(); setOpen((p) => !p); }}
        aria-expanded={open}
        title="Text Walnut sent to the model with this message"
      >
        <span className="tool-run-label">Walnut hints: {hints.map(hintLabel).join(' · ')}</span>
        <span className={`tool-run-chevron${open ? ' tool-run-chevron--open' : ''}`}>{'›'}</span>
      </button>
      {open && (
        <div className="tool-run-body" data-testid="message-hints-body">
          <div className="chat-tool-block-result">
            {hints.map((h, i) => (
              <p key={`${h.kind}-${i}`} className="message-hint-item" data-hint-kind={h.kind}>
                <strong>{hintLabel(h)}:</strong> {h.text}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
