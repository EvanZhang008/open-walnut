/**
 * QuickAccessBar — horizontal row of pill-shaped shortcut buttons above the chat input.
 * Provides one-click access to frequently used commands like /session.
 */

interface QuickAccessBarProps {
  onSessionClick: () => void;
}

export function QuickAccessBar({ onSessionClick }: QuickAccessBarProps) {
  return (
    <div className="quick-access-bar-row">
      <button
        className="quick-access-pill"
        onClick={onSessionClick}
        title="Quick Start a session (/session)"
      >
        <span className="quick-access-pill-icon">{'\u{1F4BB}'}</span>
        <span className="quick-access-pill-label">/session</span>
      </button>
    </div>
  );
}
