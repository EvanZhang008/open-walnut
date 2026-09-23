/**
 * The filter menu's "Session panels" row: how many session panels sit side by side on the
 * home page, 1 to 5 or Auto. It is the same app-wide setting as Settings → General and the
 * session kebab (useSessionPanelMode), shown here because the task panel is where the user
 * is when the strip feels too crowded or too sparse (2026-09-23: "this should show the
 * number of session panels we can adjust"). Under Auto the row also says how many panels
 * Auto means in this window right now.
 */
import {
  MAX_PANELS, MIN_PANELS, useLiveSessionPanelCount, useSessionPanelMode, type SessionPanelMode,
} from '@/hooks/useSessionPanelMode';
import type { ViewOptionGroup } from './ViewDropdown';

const CHOICES: SessionPanelMode[] = [
  ...Array.from({ length: MAX_PANELS - MIN_PANELS + 1 }, (_, i) => String(MIN_PANELS + i) as SessionPanelMode),
  'auto',
];

export function sessionPanelsViewGroup(
  mode: SessionPanelMode,
  liveCount: number | null,
  setMode: (mode: SessionPanelMode) => void,
): ViewOptionGroup {
  return {
    label: 'Session panels',
    options: [{
      key: 'session-panels',
      label: 'Side by side',
      title: 'How many session panels sit side by side on the home page (the same setting as Settings, General)',
      choices: CHOICES.map((value) => ({
        key: value,
        label: value === 'auto' ? (mode === 'auto' && liveCount !== null ? `Auto (${liveCount})` : 'Auto') : value,
        active: mode === value,
        title: value === 'auto'
          ? `Fit the window width${liveCount !== null && mode === 'auto' ? `: ${liveCount} now` : ''}`
          : `Show ${value} side by side`,
        // Re-picking the current value writes nothing (and evicts no column).
        onSelect: () => { if (value !== mode) setMode(value); },
      })),
    }],
  };
}

export function useSessionPanelsViewGroup(): ViewOptionGroup {
  const { mode, setMode } = useSessionPanelMode();
  const liveCount = useLiveSessionPanelCount();
  return sessionPanelsViewGroup(mode, liveCount, setMode);
}
