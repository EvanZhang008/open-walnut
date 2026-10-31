/**
 * The message hints a user row carried (src/core/hints/), as one line under the
 * person's words that says in plain words what Walnut added and why: "Walnut
 * added a request to write to you in Chinese (your Reply language setting)."
 * (2026-10-31, the user saw `Walnut (reply-language): ...` and asked what it was
 * and where it came from.) One click opens the exact text the AI received and a
 * link to the setting. The hints are taken off the bubble by structure (the
 * history projection); the raw view (SessionRawView) shows the whole input.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CarriedHint } from '@open-walnut/hint-format';
import { hintLabel, hintSummary } from '@open-walnut/walnut-added';
import '@/styles/injected-banner.css';

export { hintLabel, hintSummary };

/** "Walnut added a request to ..." for every hint, one sentence. */
export function hintsSentence(hints: readonly CarriedHint[]): string {
  return `Walnut added ${hints.map(hintSummary).join('; ')}.`;
}

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
        title={open ? 'Hide the exact text' : 'Show the exact text the AI received'}
      >
        <span className="tool-run-label message-hints-sentence">{hintsSentence(hints)}</span>
        <span className={`tool-run-chevron${open ? ' tool-run-chevron--open' : ''}`}>{'›'}</span>
      </button>
      {open && (
        <div className="tool-run-body" data-testid="message-hints-body">
          <div className="chat-tool-block-result">
            {hints.map((h, i) => (
              <div key={`${h.kind}-${i}`} className="message-hint-item" data-hint-kind={h.kind}>
                <p className="message-hint-summary"><strong>{capitalized(hintSummary(h))}.</strong></p>
                <p className="message-hint-exact-label">Exact text the AI received:</p>
                <pre className="message-hint-exact" data-testid="message-hint-exact">{h.text}</pre>
                {!NOT_IN_REGISTRY.has(h.kind) && (
                  <>
                    {' '}
                    <Link
                      className="message-hint-settings-link"
                      to={`/settings${hintSettingsHash(h.kind)}`}
                      onClick={(e) => e.stopPropagation()}
                      data-testid="message-hint-settings-link"
                    >
                      Change in Settings
                    </Link>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
