/**
 * Caller-defined action rows for the composer's "+" menu.
 *
 * Presentational only (no hooks, no state) so it renders under
 * `renderToStaticMarkup` in a unit test. ChatInput owns the LOOK of the row
 * (every row here is a plain `.chat-plus-menu-item[role=menuitem]`, same as
 * the built-in ones) and the caller owns the MEANING: the label, the tooltip,
 * the icon and what selecting it does. Nothing in this file knows any feature.
 *
 * Renders nothing at all for an empty list: a menu must not carry a stray
 * separator with no rows under it.
 */
import type { PlusMenuAction } from './plus-menu-actions';

interface PlusMenuActionRowsProps {
  actions: PlusMenuAction[];
  /** Called for ENABLED rows only; ChatInput closes the menu and hands the anchor on. */
  onSelect: (action: PlusMenuAction) => void;
}

/** Default row icon, same 16px stroke=currentColor box as the menu's other SVGs. */
function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-icon="gear">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

export function PlusMenuActionRows({ actions, onSelect }: PlusMenuActionRowsProps) {
  if (actions.length === 0) return null;
  return (
    <>
      <div className="chat-plus-menu-divider" role="separator" />
      {actions.map((action) => {
        const disabled = !!action.disabled;
        return (
          <button
            key={action.id}
            className={`chat-plus-menu-item${disabled ? ' is-disabled' : ''}`}
            // aria-disabled instead of `disabled`: the row stays hoverable so its
            // title (the reason it is off) can still be read; the click is a no-op.
            aria-disabled={disabled ? 'true' : undefined}
            onClick={disabled ? undefined : () => onSelect(action)}
            type="button"
            role="menuitem"
            title={action.title}
            data-action-id={action.id}
          >
            {action.icon ?? <GearIcon />}
            <span>{action.label}</span>
          </button>
        );
      })}
    </>
  );
}
