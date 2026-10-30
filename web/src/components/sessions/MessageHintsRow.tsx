/**
 * The message hints a user row carried (src/core/hints/), as one folded row under
 * the person's words: "Walnut hints: Rich output · Reply language". The text of each
 * opens on click. The hints are taken off the bubble by structure (the history
 * projection), so this row is the one place the normal view says they were there;
 * the raw view (SessionRawView) shows the whole input as the model received it.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CarriedHint } from '@open-walnut/hint-format';
import { hintLabel } from '@open-walnut/walnut-added';
import '@/styles/injected-banner.css';

export { hintLabel };

/** Kinds Walnut adds outside the hint registry, so Settings has no switch for them. */
const NOT_IN_REGISTRY = new Set(['session-context', 'engine-switch']);

/** The Settings row of one hint's on/off switch (settings-routing.ts resolves the prefix). */
export function hintSettingsHash(kind: string): string {
  return `#message-hint-${encodeURIComponent(kind)}`;
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
                {!NOT_IN_REGISTRY.has(h.kind) && (
                  <>
                    {' '}
                    <Link
                      className="message-hint-settings-link"
                      to={`/settings${hintSettingsHash(h.kind)}`}
                      onClick={(e) => e.stopPropagation()}
                      data-testid="message-hint-settings-link"
                    >
                      Turn off in Settings
                    </Link>
                  </>
                )}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
