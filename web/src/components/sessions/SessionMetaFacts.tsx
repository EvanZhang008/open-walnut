/**
 * Plugin facts about a session (walnut.ui.slot 'session.meta'), e.g. the time it took.
 *
 * Their home is the TOP of the ⋮ menu (the same menu a right-click on the header opens):
 * one labelled row each, seen without scrolling a tall menu. Each row has a "Header"
 * toggle; a fact the user turns on there also shows on every session's header row, as a
 * label-less chip the row fit measures like its own and is the first to move into "...".
 * Nothing is pinned by default: the header row's width belongs to the host's own tools
 * until the user decides to spend it (2026-10-06).
 */
import { useCallback } from 'react';
import { PluginSlotFact, PluginSlots, type SlotEntry } from '@/plugins/PluginSlots';
import { useNavigationList } from '@/hooks/useNavigationPreference';
import { SLOT_ID_PREFIX } from './useSessionHeaderFit';

/** The slot keys ("<plugin>:<slot id>") the user pinned to every session's header. */
export const SESSION_HEADER_PINS_KEY = 'open-walnut-session-header-pins';

export function useSessionHeaderPins() {
  const [pins, setPins] = useNavigationList(SESSION_HEADER_PINS_KEY);
  const toggle = useCallback(
    (key: string) => setPins(pins.includes(key) ? pins.filter((k) => k !== key) : [...pins, key]),
    [pins, setPins],
  );
  return [pins, toggle] as const;
}

interface FactsProps {
  sessionId: string;
  taskId?: string;
}

/** The ⋮ menu's rows. A plugin that navigates closes the menu; the toggle keeps it open. */
export function SessionMetaFacts({ sessionId, taskId, onAfterAction }: FactsProps & { onAfterAction?: () => void }) {
  const [pins, toggle] = useSessionHeaderPins();
  return (
    <PluginSlots
      target="session.meta"
      props={{ sessionId, ...(taskId ? { taskId } : {}), placement: 'menu' }}
      onNavigate={onAfterAction}
      wrap={(entry, node) => {
        const pinned = pins.includes(entry.key);
        return (
          <PluginSlotFact
            entry={entry}
            className="task-kebab-tier task-kebab-fact"
            labelClassName="task-kebab-tier-label task-kebab-fact-label"
            valueClassName="task-kebab-fact-value"
            trailing={
              <button
                type="button"
                className={`task-kebab-tier-btn task-kebab-fact-pin${pinned ? ' active' : ''}`}
                aria-pressed={pinned}
                data-testid="session-fact-pin"
                title={pinned
                  ? `Showing ${entry.value.title} on every session's header. Click to keep it in this menu only`
                  : `Also show ${entry.value.title} on every session's header`}
                onClick={(e) => { e.stopPropagation(); toggle(entry.key); }}
              >
                Header
              </button>
            }
          >
            {node}
          </PluginSlotFact>
        );
      }}
    />
  );
}

/**
 * The pinned facts on the header's tool row. Each is a row item (`data-header-id`
 * "slot:<key>", named by the slot's title for the "..." menu); a plugin that renders
 * nothing leaves an empty wrapper the row fit skips.
 */
export function PinnedSessionFacts({ sessionId, taskId, hid }: FactsProps & { hid: (id: string) => 'true' | 'false' }) {
  const [pins] = useSessionHeaderPins();
  const include = useCallback((entry: SlotEntry) => pins.includes(entry.key), [pins]);
  if (pins.length === 0) return null;
  return (
    <PluginSlots
      target="session.meta"
      props={{ sessionId, ...(taskId ? { taskId } : {}), placement: 'header' }}
      include={include}
      wrap={(entry, node) => (
        <span
          className="session-header-item"
          data-header-id={`${SLOT_ID_PREFIX}${entry.key}`}
          data-header-name={entry.value.title}
          data-hidden={hid(`${SLOT_ID_PREFIX}${entry.key}`)}
        >
          {node}
        </span>
      )}
    />
  );
}
