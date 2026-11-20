/**
 * The rail's magnifier (Sidebar.tsx, right above the bell: a tool, not a page): a click opens the quick bar as
 * Control-Option-Command-Space does, for a person who does not remember the key. Shown only while
 * the experiment `quick_bar` is on, as the bar itself.
 */
import { useExperimental } from '@/hooks/useExperimental';
import { openQuickBar } from './quickbar-native';

export function QuickBarRailButton() {
  const on = useExperimental('quick_bar');
  if (!on) return null;
  return (
    // `sidebar-panel-toggle`: the button reset, and the phone drawer closes on the tap.
    <button
      type="button"
      className="sidebar-link sidebar-panel-toggle sidebar-quickbar-link"
      // The click's own focus would stay on this button: the bar takes it on its next frame.
      onClick={() => openQuickBar()}
      aria-label="Quick bar"
      title="Talk to the CEO, a VP or a task (Control-Option-Command-Space)"
      data-testid="sidebar-quick-bar"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" />
        <path d="m20 20-4.2-4.2" />
      </svg>
      <span className="sidebar-label">Quick bar</span>
    </button>
  );
}
