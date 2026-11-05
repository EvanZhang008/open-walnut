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
import { useSessionServers } from '@/hooks/useSessionServers';
import { SLOT_ID_PREFIX } from './useSessionHeaderFit';
import { openable } from './session-server-label';

/** The host's own fact among them: the web pages the session's servers serve (pin key). */
export const WEB_SERVERS_FACT = 'host:web-servers';

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

function useWebPageCount(sessionId: string, enabled = true): { n: number; known: boolean } {
  const { servers, state } = useSessionServers(sessionId, { enabled, fast: false });
  return { n: servers.filter(openable).length, known: state === 'ok' };
}

function PinButton({ pinned, title, onToggle }: { pinned: boolean; title: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`task-kebab-tier-btn task-kebab-fact-pin${pinned ? ' active' : ''}`}
      aria-pressed={pinned}
      data-testid="session-fact-pin"
      title={pinned
        ? `Showing ${title} on every session's header. Click to keep it in this menu only`
        : `Also show ${title} on every session's header`}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
    >
      Header
    </button>
  );
}

/** The ⋮ menu's rows. A plugin that navigates closes the menu; the toggle keeps it open. */
export function SessionMetaFacts({ sessionId, taskId, onAfterAction }: FactsProps & { onAfterAction?: () => void }) {
  const [pins, toggle] = useSessionHeaderPins();
  const web = useWebPageCount(sessionId);
  return (
    <>
    {/* The host's own fact: how many web pages this session serves, pinnable like the rest
        (pinned, the header gets a "Web" chip while any runs, opening the Web view). */}
    <span className="task-kebab-tier task-kebab-fact" data-slot={WEB_SERVERS_FACT} data-testid="session-fact-web-servers">
      <span className="task-kebab-tier-label task-kebab-fact-label">Web servers</span>{' '}
      <span className="task-kebab-fact-value">{web.known ? (web.n > 0 ? `${web.n} running` : 'none running') : '…'}</span>
      <PinButton pinned={pins.includes(WEB_SERVERS_FACT)} title="Web servers" onToggle={() => toggle(WEB_SERVERS_FACT)} />
    </span>
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
            trailing={<PinButton pinned={pinned} title={entry.value.title} onToggle={() => toggle(entry.key)} />}
          >
            {node}
          </PluginSlotFact>
        );
      }}
    />
    </>
  );
}

/** The pinned "Web" chip: there while a web page runs, opening the Web view (as Files opens Files). */
function PinnedWebServers({ sessionId, hid, webOpen, onOpenWeb }: { sessionId: string; hid: (id: string) => 'true' | 'false'; webOpen?: boolean; onOpenWeb?: () => void }) {
  // No Web view to open here: the chip never shows, so do not poll for it.
  const { n } = useWebPageCount(sessionId, !!onOpenWeb);
  const id = `${SLOT_ID_PREFIX}${WEB_SERVERS_FACT}`;
  if (n === 0 || !onOpenWeb) return null;
  return (
    <span className="session-header-item" data-header-id={id} data-header-name="Web servers" data-hidden={hid(id)}>
      <button
        type="button"
        className={`session-action-chip${webOpen ? ' session-action-chip-active' : ''}`}
        onClick={onOpenWeb}
        data-header-value={`${n} running`}
        data-testid="session-web-servers-chip"
        title={`${n} web page${n === 1 ? '' : 's'} this session started: open the Web view`}
      >
        Web <span className="session-action-chip-count">{n}</span>
      </button>
    </span>
  );
}

/**
 * The pinned facts on the header's tool row. Each is a row item (`data-header-id`
 * "slot:<key>", named by the slot's title for the "..." menu); a plugin that renders
 * nothing leaves an empty wrapper the row fit skips.
 */
export function PinnedSessionFacts({ sessionId, taskId, hid, webOpen, onOpenWeb }: FactsProps & {
  hid: (id: string) => 'true' | 'false';
  /** The Web view is open (its pinned chip shows active). */
  webOpen?: boolean;
  onOpenWeb?: () => void;
}) {
  const [pins] = useSessionHeaderPins();
  const include = useCallback((entry: SlotEntry) => pins.includes(entry.key), [pins]);
  if (pins.length === 0) return null;
  return (
    <>
    {pins.includes(WEB_SERVERS_FACT) && <PinnedWebServers sessionId={sessionId} hid={hid} webOpen={webOpen} onOpenWeb={onOpenWeb} />}
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
    </>
  );
}
