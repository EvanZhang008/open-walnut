/**
 * QuickAccessBar — horizontal row of pill-shaped shortcut buttons above the chat input.
 * Provides one-click access to frequently used commands like /session
 * and the Execution / Plan mode toggle. The right edge shows the context-window
 * usage percentage (moved here from the chat header) when stats are available.
 */

import type { ChatMode } from '@/hooks/usePlanMode';
import type { ChatStats } from '@/api/chat';

const CONTEXT_WINDOW_DEFAULT = 200_000; // fallback when backend doesn't provide contextWindow

interface QuickAccessBarProps {
  onSessionClick: () => void;
  /** Fix Walnut pill — omit to hide (e.g. npm installs / cloud, where installDir is unknown). */
  onFixWalnutClick?: () => void;
  mode?: ChatMode;
  onModeToggle?: () => void;
  /** Chat stats for the context-usage % indicator (omit to hide it). */
  stats?: ChatStats | null;
}

export function QuickAccessBar({ onSessionClick, onFixWalnutClick, mode, onModeToggle, stats }: QuickAccessBarProps) {
  const isPlan = mode === 'plan';

  const contextWindow = stats?.contextWindow ?? CONTEXT_WINDOW_DEFAULT;
  const pct = stats ? Math.round((stats.estimatedTotalTokens ?? stats.estimatedTokens) / contextWindow * 100) : null;
  // >80% red, >50% orange, else muted — mirrors the former chat-header indicator.
  const pctColor = pct != null && pct > 80 ? 'var(--error)' : pct != null && pct > 50 ? 'var(--warning)' : 'var(--fg-muted)';

  return (
    <div className="quick-access-bar-row">
      <button
        className="quick-access-pill"
        onClick={onSessionClick}
        title="Type a path and start a Claude Code session there directly (/session)"
      >
        <span className="quick-access-pill-icon">{'\u{1F4BB}'}</span>
        <span className="quick-access-pill-label">Quick session</span>
      </button>
      {onFixWalnutClick && (
        <button
          className="quick-access-pill"
          onClick={onFixWalnutClick}
          title="Something wrong with Walnut? Describe it (paste a screenshot too) and a session will fix it"
        >
          <span className="quick-access-pill-icon">{'\u{1F527}'}</span>
          <span className="quick-access-pill-label">fix-walnut</span>
        </button>
      )}
      {onModeToggle && (
        <button
          className={`mode-toggle-pill${isPlan ? ' plan-active' : ''}`}
          onClick={onModeToggle}
          title={`Switch to ${isPlan ? 'Execution' : 'Plan'} mode (Shift+Tab)`}
        >
          <span className="mode-toggle-pill-label">
            {isPlan ? 'Plan' : 'Execution'}
          </span>
          <span className="mode-toggle-pill-shortcut">
            {'⇧'}Tab
          </span>
        </button>
      )}
      {pct != null && (
        <span
          className="quick-access-pct"
          style={{ color: pctColor }}
          title={`${stats!.apiMessageCount} msgs · ~${Math.round((stats!.estimatedTotalTokens ?? stats!.estimatedTokens) / 1000)}K tokens${stats!.compacted ? ' · compacted' : ''}`}
        >
          {pct}%
        </span>
      )}
    </div>
  );
}
