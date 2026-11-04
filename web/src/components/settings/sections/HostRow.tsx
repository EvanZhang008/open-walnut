/**
 * One machine in Settings > Remote Hosts' list (RemoteHostsSection.tsx): its status dot and
 * name, one short state line, and at most ONE action for its state (Retry, Connect, Install,
 * Set up...) pinned to the name line in one column for every row; everything else is in its
 * More menu (Edit, Not now, Details, Remove last, in red). Remove asks once, naming the host.
 * Details and Edit open in place under the row (`panel`).
 *
 * Focus never falls to the page (2026-11-04 review: Enter on Not now, Connect or Show again
 * left `document.activeElement` on body): a menu item, the confirm, or a primary action that
 * went away with its state hands focus to the row's More button.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ContextMenu } from '@/components/common/ContextMenu';
import { SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { focusLanded } from '@/utils/focus-landed';

export interface RowPrimary {
  /** What the button says now (its busy words while it runs). */
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Every label it may show, so its width never moves. */
  reserve?: string[];
  ariaLabel?: string;
  title?: string;
  testId?: string;
}

export interface RowMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
}

interface Props {
  rowKey: string;
  id?: string;
  alias?: string;
  name: string;
  /** Muted words after the name (alias, hostname, system). */
  sub?: ReactNode;
  tag?: ReactNode;
  dot: ReactNode;
  state: ReactNode;
  /** Lines under the state line, one per line: the one warning, a note, an error (RowLine). */
  lines?: ReactNode[];
  primary?: RowPrimary | null;
  menu: RowMenuItem[];
  /** Remove, last in the menu: asks "Remove <name>?" first. */
  onRemove?: () => void | Promise<unknown>;
  removeNote?: string;
  /** Details or Edit, open under the row. */
  panel?: ReactNode;
  off?: boolean;
  needsLook?: boolean;
  data?: Record<`data-${string}`, string | undefined>;
}

/** One line under a row's state line. */
export function RowLine({ tone, children, testId }: { tone: 'warn' | 'bad' | 'note' | 'good'; children: ReactNode; testId?: string }) {
  return <span className="rh-row-line" data-tone={tone} data-testid={testId} role={tone === 'warn' ? undefined : 'status'}>{children}</span>;
}

function MoreGlyph() {
  return (
    <svg className="rh-more-glyph" viewBox="0 0 14 4" width="14" height="4" fill="currentColor" aria-hidden="true">
      <circle cx="2" cy="2" r="1.5" /><circle cx="7" cy="2" r="1.5" /><circle cx="12" cy="2" r="1.5" />
    </svg>
  );
}

/** The focus fell to the page (the element that held it went away). */
const fell = () => !document.activeElement || document.activeElement === document.body;

/**
 * The focus fell to the page, or still sits on a control in `within` that just turned disabled:
 * WebKit keeps a disabled button as the active element and drops it to the page later, with no
 * event, so a check for the page alone never fires there (Retry turning Retrying...).
 */
const stranded = (within: HTMLElement | null) => {
  const a = document.activeElement;
  return fell() || (!!within && !!a && within.contains(a) && (a as HTMLButtonElement).disabled === true);
};

export function HostRow({ rowKey, id, alias, name, sub, tag, dot, state, lines, primary, menu, onRemove, removeNote, panel, off, needsLook, data }: Props) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const backToMore = () => requestAnimationFrame(() => { if (fell()) focusLanded(moreRef.current); });

  // A primary action that went away or turned busy while it held the focus (Connect on a host
  // that came up, Retry becoming Retrying...): the focus moves to More, the row's one control
  // that is always there. A blur to nowhere (the button disabled or gone) still counts for a
  // moment, and so does a press (WebKit never focuses a pressed button); a blur to another
  // control does not.
  const primaryFocused = useRef(false);
  const primaryLostAt = useRef(0);
  const primaryKey = primary ? `${primary.label}|${primary.disabled ? 1 : 0}` : '';
  useEffect(() => {
    const held = primaryFocused.current || Date.now() - primaryLostAt.current < 1000;
    if (held && stranded(anchor.current)) { primaryFocused.current = false; primaryLostAt.current = 0; focusLanded(moreRef.current); }
  }, [primaryKey]);

  const cancelId = `rh-confirm-cancel-${rowKey}`;
  useEffect(() => {
    if (confirming) document.getElementById(cancelId)?.focus({ preventScroll: true });
  }, [confirming, cancelId]);

  const items = [
    ...menu.map((m) => ({ key: m.key, label: m.label, disabled: m.disabled, title: m.title, onSelect: () => { m.onSelect(); backToMore(); } })),
    ...(onRemove ? [{ key: 'remove', label: 'Remove', danger: true, onSelect: () => setConfirming(true) }] : []),
  ];

  const remove = async () => {
    setConfirming(false);
    await onRemove?.();
    backToMore();
  };

  return (
    <>
      <SettingsRow
        className="rh-host-row"
        id={id}
        data-host-alias={alias}
        data-row-key={rowKey}
        data-needs-look={needsLook ? 'true' : undefined}
        data-host-off={off ? 'true' : undefined}
        {...data}
        label={
          <span className="rh-row-name-line">
            {dot}
            <span className="rh-host-name" title={name}>{name}</span>
            {sub}
            {tag}
          </span>
        }
        help={<span className="rh-row-state" data-testid="rh-row-state">{state}</span>}
        children={lines?.length ? <span className="rh-row-lines">{lines}</span> : undefined}
        control={
          <span className="rh-row-actions" ref={anchor}>
            <span className="rh-row-primary">
              {primary && (
                <SettingsButton
                  disabled={primary.disabled}
                  reserve={primary.reserve}
                  aria-label={primary.ariaLabel}
                  title={primary.title}
                  data-testid={primary.testId ?? 'rh-row-primary'}
                  onFocus={() => { primaryFocused.current = true; }}
                  onBlur={(e) => { primaryFocused.current = false; primaryLostAt.current = e.relatedTarget ? 0 : Date.now(); }}
                  onClick={() => { primaryLostAt.current = Date.now(); primary.onClick(); }}
                >
                  {primary.label}
                </SettingsButton>
              )}
            </span>
            <button
              ref={moreRef}
              type="button"
              tabIndex={0}
              className="rh-row-more"
              aria-label={`More for ${name}`}
              aria-haspopup="menu"
              aria-expanded={!!menuAt}
              data-testid="rh-row-more"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenuAt(menuAt ? null : { x: r.left, y: r.bottom + 4 });
              }}
            >
              <MoreGlyph />
            </button>
          </span>
        }
      />
      {menuAt && (
        <ContextMenu
          point={menuAt}
          anchorRef={anchor}
          ariaLabel={`${name} actions`}
          testId="rh-row-menu"
          className="rh-add-menu rh-row-menu"
          returnFocus={moreRef.current}
          onClose={() => setMenuAt(null)}
          items={items}
        />
      )}
      {confirming && (
        <SettingsRow
          indent
          className="rh-row-confirm"
          data-testid="rh-row-confirm"
          label={`Remove ${name}?`}
          help={removeNote}
          onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setConfirming(false); backToMore(); } }}
          control={
            <>
              <SettingsButton id={cancelId} variant="text" onClick={() => { setConfirming(false); backToMore(); }} data-testid="rh-row-confirm-cancel">Cancel</SettingsButton>
              <SettingsButton variant="danger" onClick={() => void remove()} data-testid="rh-row-confirm-remove" aria-label={`Remove ${name}`}>Remove</SettingsButton>
            </>
          }
        />
      )}
      {panel}
    </>
  );
}
