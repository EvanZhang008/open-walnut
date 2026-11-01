/**
 * The message hints a user row carried (src/core/hints/), as one line under the
 * person's words that says in plain words what Walnut added and why: "Walnut
 * added a request to write to you in Chinese (your Reply language setting)."
 * (2026-10-31, the user saw `Walnut (reply-language): ...` and asked what it was
 * and where it came from.) One click opens the exact text the AI received and a
 * link to the setting. The exact text marks whose words each part is (2026-11-01,
 * the user: which is built in, which is mine, "is this global in all people's
 * Walnut or just me?"): Walnut's built-in text is the same in every Walnut, the
 * part a setting of his fills in is highlighted as his (hint-origin.ts). The
 * hints are taken off the bubble by structure (the history projection); the raw
 * view (SessionRawView) shows the whole input.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CarriedHint } from '@open-walnut/hint-format';
import { hintLabel, hintSummary } from '@open-walnut/walnut-added';
import { HINT_USER_SETTINGS, hintTextParts, isBuiltInHintKind } from '@open-walnut/hint-origin';
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

/** One line saying whose words the exact text is. */
export function hintOriginLine(h: CarriedHint): string {
  if (!isBuiltInHintKind(h.kind)) return 'All of it is your own hint, from Settings. Only your Walnut sends it.';
  const parts = hintTextParts(h);
  const yours = parts.find((p) => p.from === 'user');
  if (yours) return `Highlighted: your ${yours.setting} setting, your own words. The rest is Walnut's built-in text, the same in every Walnut.`;
  return "Walnut's built-in text, the same in every Walnut.";
}

/** The exact text, the user's own words marked as theirs. */
function ExactText({ hint }: { hint: CarriedHint }) {
  const parts = hintTextParts(hint);
  const custom = !isBuiltInHintKind(hint.kind);
  return (
    <pre className="message-hint-exact" data-testid="message-hint-exact">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? ' ' : ''}
          {p.from === 'user' && !custom
            ? <mark className="message-hint-yours" data-testid="message-hint-yours" title={`Your ${p.setting} setting`}>{p.text}</mark>
            : p.text}
        </span>
      ))}
    </pre>
  );
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
                <ExactText hint={h} />
                <p className="message-hint-origin" data-testid="message-hint-origin">{hintOriginLine(h)}</p>
                {HINT_USER_SETTINGS[h.kind] && hintTextParts(h).some((p) => p.from === 'user') && (
                  <Link
                    className="message-hint-settings-link"
                    to={`/settings#${HINT_USER_SETTINGS[h.kind].anchor}`}
                    onClick={(e) => e.stopPropagation()}
                    data-testid="message-hint-own-setting-link"
                  >
                    Edit your {HINT_USER_SETTINGS[h.kind].label}
                  </Link>
                )}
                {!NOT_IN_REGISTRY.has(h.kind) && (
                  <Link
                    className="message-hint-settings-link"
                    to={`/settings${hintSettingsHash(h.kind)}`}
                    onClick={(e) => e.stopPropagation()}
                    data-testid="message-hint-settings-link"
                  >
                    Change in Settings
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
