/**
 * Output-mode pill — the session's reply STYLE: plain markdown (`MD`) or rich
 * HTML (`Rich`). Shared by the session composer's mode bar and the main-chat
 * lane composer, which is a session under the hood and takes the same PATCH.
 *
 * Optimistic-then-revert like the permission-mode pill beside it. Flipping is
 * free: the server prefixes its one-line instruction to the next outgoing
 * message only, and only when the mode actually CHANGED (the edge lives on the
 * record — src/core/sessions/output-mode.ts).
 */

import type { SessionOutputMode } from '@open-walnut/core';
import { updateSession } from '@/api/sessions';
import { log } from '@/utils/log';

interface OutputModePillProps {
  sessionId: string;
  /** Current mode from the fetched record (undefined ⇒ 'markdown'). */
  mode: SessionOutputMode | undefined;
  /** Apply a value locally — called again with the previous one if PATCH fails. */
  onOptimistic: (mode: SessionOutputMode) => void;
}

const STYLE_LABEL: Record<SessionOutputMode, string> = {
  markdown: 'plain markdown',
  rich: 'rich HTML',
};

export function OutputModePill({ sessionId, mode, onOptimistic }: OutputModePillProps) {
  const current: SessionOutputMode = mode === 'rich' ? 'rich' : 'markdown';
  const next: SessionOutputMode = current === 'rich' ? 'markdown' : 'rich';

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
      title={`Output mode: model replies in ${STYLE_LABEL[current]}. Click for ${STYLE_LABEL[next]}`}
    >
      <span className="mode-toggle-pill-label">{current === 'rich' ? 'Rich' : 'MD'}</span>
    </button>
  );
}
