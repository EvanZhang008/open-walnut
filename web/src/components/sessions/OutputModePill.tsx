/**
 * Output-mode pill — the session's reply STYLE: plain markdown (`MD`) or rich
 * HTML (`Rich`). Shared by the session composer's mode bar and the main-chat
 * lane composer, which is a session under the hood and takes the same PATCH.
 *
 * It shows the EFFECTIVE mode: the record's own `output_mode` when the human
 * picked one, otherwise the configured default (Settings → Sessions →
 * Output mode). Clicking always writes an EXPLICIT per-session value — pinning
 * this session's style is the whole point of the pill, so it must not keep
 * drifting with the config afterwards.
 *
 * Optimistic-then-revert like the permission-mode pill beside it. Flipping is
 * cheap: the server prefixes its full instruction only when the mode actually
 * CHANGED, and while rich holds it appends one short reminder line per message
 * (src/core/sessions/output-mode.ts).
 */

import { useEffect, useState } from 'react';
import type { SessionOutputMode } from '@open-walnut/core';
import { DEFAULT_SESSION_OUTPUT_MODE } from '@open-walnut/core';
import { updateSession } from '@/api/sessions';
import { fetchConfig } from '@/api/config';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';

interface OutputModePillProps {
  sessionId: string;
  /** Mode from the fetched record. Undefined ⇒ follow the configured default. */
  mode: SessionOutputMode | undefined;
  /** Apply a value locally — called again with the previous one if PATCH fails. */
  onOptimistic: (mode: SessionOutputMode) => void;
}

const STYLE_LABEL: Record<SessionOutputMode, string> = {
  markdown: 'plain markdown',
  rich: 'rich HTML',
};

// ── Configured default (config.session.output_mode) ──
//
// ONE /api/config read for the whole page, shared by every pill: the homepage
// renders a session column (hence a pill) per open session, and a fetch each
// would be N reads of the same file for one small string. Refreshed on
// config:changed, so changing the Settings control moves every pill that has no
// per-session override without a reload.

let sharedDefault: SessionOutputMode = DEFAULT_SESSION_OUTPUT_MODE;
let loaded = false;
let inflight: Promise<void> | null = null;
const subscribers = new Set<(mode: SessionOutputMode) => void>();

function loadSharedDefault(force = false): Promise<void> {
  if (inflight) return inflight;
  if (loaded && !force) return Promise.resolve();
  inflight = fetchConfig()
    .then((c) => {
      const configured = c.session?.output_mode;
      sharedDefault = configured === 'rich' || configured === 'markdown'
        ? configured
        : DEFAULT_SESSION_OUTPUT_MODE;
      loaded = true;
      for (const notify of subscribers) notify(sharedDefault);
    })
    .catch(() => { /* keep the last known default — never blank the pill */ })
    .finally(() => { inflight = null; });
  return inflight;
}

function useConfiguredOutputMode(): SessionOutputMode {
  const [mode, setMode] = useState<SessionOutputMode>(sharedDefault);
  useEffect(() => {
    subscribers.add(setMode);
    setMode(sharedDefault);   // a later pill adopts the already-loaded value
    void loadSharedDefault();
    return () => { subscribers.delete(setMode); };
  }, []);
  useEvent('config:changed', () => { void loadSharedDefault(true); });
  return mode;
}

export function OutputModePill({ sessionId, mode, onOptimistic }: OutputModePillProps) {
  const configured = useConfiguredOutputMode();
  // Effective mode. An unrecognized stored value falls back to the default rather
  // than silently reading as markdown.
  const current: SessionOutputMode = mode === 'rich' || mode === 'markdown' ? mode : configured;
  const next: SessionOutputMode = current === 'rich' ? 'markdown' : 'rich';
  const inherited = mode !== 'rich' && mode !== 'markdown';

  const toggle = () => {
    onOptimistic(next);
    updateSession(sessionId, { output_mode: next }).catch((err: Error) => {
      onOptimistic(current); // revert
      log.warn('session', 'output mode toggle failed', { sessionId, next, error: err.message });
    });
  };

  return (
    <button
      type="button"
      className="mode-toggle-pill"
      onClick={toggle}
      // Accent (not the amber .plan-active) marks the non-default state: rich
      // output is a formatting choice, not a permission warning.
      style={current === 'rich' ? { color: 'var(--accent)' } : undefined}
      title={`Output mode: model replies in ${STYLE_LABEL[current]}`
        + `${inherited ? ' (default from Settings)' : ''}. Click for ${STYLE_LABEL[next]}`}
    >
      <span className="mode-toggle-pill-label">{current === 'rich' ? 'Rich' : 'MD'}</span>
    </button>
  );
}
