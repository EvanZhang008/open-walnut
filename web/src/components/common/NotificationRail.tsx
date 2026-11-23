/**
 * The notification center's frame around its feed: the header (title, then one group of quiet
 * tool buttons: Clear, Quiet, Close) and the rail of sections. Split out of NotificationPanel.tsx,
 * which keeps the state.
 *
 * 2026-11-21 audit: Clear All and "Quiet 1h" were bright blue link text of the same weight (and
 * Clear All did not say what it cleared), the close × a bare glyph; the rail's selected entry was
 * a full-width blue block and its counts three colours of their own. Now the header's buttons are
 * the card family's tool buttons (`.ask-card-tools .btn`, components/actions/ask-card.css), the
 * selected entry is the shared Nav item (`.wn-nav-item` with aria-current="page",
 * styles/pick-and-nav.css), the same as the rail's current page and Settings' current section,
 * and every count is the console's one label, a `.badge-count` (styles/badge.css) toned by what
 * it counts.
 */
import type { NotificationSection } from '@/contexts/notifications';
import { QuietToggle } from './QuietToggle';
import { badge, type BadgeTone } from './badge';
import '@/components/actions/ask-card.css';
import '@/styles/header-fit.css';
import '@/styles/pick-and-nav.css';

/** Rail tabs: the notification sections plus the ambient System zone. */
export type RailSection = NotificationSection | 'system';

/** What Clear says it clears, per section (Inbox and System list nothing it could clear). An ask
 *  still waiting for its answer is never cleared (useNotificationFeedView clearableKeys). */
const CLEAR_LABEL: Partial<Record<RailSection, string>> = {
  all: 'Clear all',
  action: 'Clear answered',
  errors: 'Clear errors',
  automation: 'Clear automation',
};

export function NotificationPanelHeader({ section, category, canClear, onClear, onClose }: {
  section: RailSection;
  /** The error family the view is filtered to, if any: Clear names it. */
  category: string | null;
  /** The view lists something Clear would dismiss. */
  canClear: boolean;
  onClear: () => void;
  onClose: () => void;
}) {
  const base = CLEAR_LABEL[section];
  const label = section === 'errors' && category ? `Clear ${category} errors` : base;
  return (
    <div className="notification-panel-header" data-fit-header="">
      <span className="notification-panel-title" data-fit-title="">Notifications</span>
      <div className="ask-card-tools nfc-header-tools" role="group" aria-label="Notification tools" data-fit-actions="">
        {label && canClear && (
          <button
            type="button"
            className="btn nfc-header-clear"
            title={section === 'all'
              ? 'Dismiss every notification in the list. Letters stay in the Inbox, and asks waiting for an answer stay.'
              : `Dismiss what this list shows (${label.replace(/^Clear /, '')}). Asks waiting for an answer stay, and the other sections keep theirs.`}
            onClick={onClear}
          >
            {label}
          </button>
        )}
        <QuietToggle />
        <button type="button" className="btn notification-panel-close" onClick={onClose} aria-label="Close" title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** A section's count, inline in the rail: the one label as a count, in its section's tone. */
function RailCount({ count, tone }: { count: number; tone: BadgeTone }) {
  return <span className={`${badge(tone, { count: true })} nfc-rail-badge`}>{count > 99 ? '99+' : count}</span>;
}

/**
 * A category sub-entry under the Errors section button: the same anatomy as RailButton with the
 * indent and smaller type that read as "child of the entry above", its count quiet text.
 */
export function RailSubButton({ label, count, active, onClick }: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="nfc-rail-btn wn-nav-item nfc-rail-sub"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <span className="nfc-rail-name wn-title">{label}</span>
      {count > 0 && <span className="nfc-rail-subcount">{count > 99 ? '99+' : count}</span>}
    </button>
  );
}

export function RailButton({ label, count, active, tone = 'neutral', dot, warn, onClick }: {
  label: string;
  count: number;
  active: boolean;
  /** The count's tone: 'alert' (solid red) only for what needs the user; a plain total stays grey. */
  tone?: BadgeTone;
  /** Countless attention marker (the System zone: health, not a list length). */
  dot?: boolean;
  /** The dot is a warning (something unhealthy), not news (an update). */
  warn?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="nfc-rail-btn wn-nav-item"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <span className="nfc-rail-name wn-title">{label}</span>
      {count > 0 ? (
        <RailCount count={count} tone={tone} />
      ) : dot ? (
        <span className={`nfc-rail-dot${warn ? ' nfc-warn' : ''}`} aria-label={`${label} needs attention`} role="img" />
      ) : null}
    </button>
  );
}
