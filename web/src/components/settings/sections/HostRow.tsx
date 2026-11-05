/**
 * One machine in Settings > Remote Hosts' list (RemoteHostsSection.tsx): its status dot and
 * name, one short state line, and at most ONE action for its state (Retry, Connect, Install,
 * Set up...) pinned to the name line in one column for every row; everything else is in its
 * More menu (Edit, Not now, Details, Remove last, in red). Remove asks once, naming the host.
 * Details and Edit open in place under the row (`panel`).
 *
 * Focus never falls to the page (2026-11-04 review: Enter on Not now, Connect or Show again
 * left `document.activeElement` on body): a busy primary action keeps it (Retrying...), and a menu
 * item, the confirm, or a primary action that went away with its state hands it to the row's
 * More button. A row the "need a look" count counts carries a "Needs a look" tag; the row whose
 * menu is open is the one marked (2026-11-04 review: a row the network map landed on kept its
 * ring while another row's menu was open, as if the menu were its).
 *
 * Each row says what it shows to the list's store (`report`, host-list-store.ts): the summary
 * line, the count and the network map read it from there.
 */
import { isValidElement, useEffect, useRef, useState, type ReactNode } from 'react';
import { ContextMenu } from '@/components/common/ContextMenu';
import { SettingsRow, SettingsTag } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { focusLanded } from '@/utils/focus-landed';
import { RemoveConfirmRow } from './RemoveConfirmRow';
import { useMenuButton } from './useMenuButton';
import { useRowReport } from './host-list-store';
import { useHostSettingsLook } from './host-settings-data';
import type { RowReport } from './host-row-model';

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
  /** What the row tells the summary, the count and the map (none: a row that is no machine yet). */
  report?: Omit<RowReport, 'key' | 'name' | 'needsLook'>;
  /** "Not saved": a new host whose fields stay open until it saves. */
  unsaved?: boolean;
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

/** The focus fell to the page (the element that held it went away; WebKit may still name it for a while). */
const fell = () => !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;

/**
 * The focus fell to the page, or still sits on a control in `within` that just turned disabled:
 * WebKit keeps a disabled button as the active element and drops it to the page later, with no
 * event, so a check for the page alone never fires there (Retry turning Retrying...).
 */
const stranded = (within: HTMLElement | null) => {
  const a = document.activeElement;
  return fell() || (!!within && !!a && within.contains(a) && (a as HTMLButtonElement).disabled === true);
};

export function HostRow({ rowKey, id, alias, name, sub, tag, dot, state, lines, primary, menu, onRemove, removeNote, panel, off, needsLook, report, unsaved, data }: Props) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  // The More menu's one owner (useMenuButton.ts): a second press closes it, a close gives the
  // focus back to More with its ring, and no late focus move closes a menu opened since.
  const moreMenu = useMenuButton(() => moreRef.current, (el) => focusLanded(el));
  const menuAt = moreMenu.menu;
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const backToMore = () => requestAnimationFrame(() => { if (fell()) focusLanded(moreRef.current); });
  // Its own settings (Walnut on it, a secret's copy) count with the rest: one count on the page.
  // A host turned off needs no look: it was turned off on purpose (2026-11-05 review).
  const settingsLook = useHostSettingsLook(report?.counted && !off ? (report.local ? '__local__' : alias) : undefined);
  const look = (!!needsLook || !!settingsLook) && !!report?.counted && !off;
  useRowReport(report ? { ...report, key: rowKey, name, needsLook: look } : null);
  // Every row the count counts says what to look at, in one line: its own warning, else what its
  // settings need (2026-11-05 review: four status lines stacked on one row).
  const warned = (lines ?? []).some((l) => isValidElement<{ tone?: string }>(l) && (l.props.tone === 'warn' || l.props.tone === 'bad'));
  const shownLines = settingsLook && !warned ? [...(lines ?? []), <RowLine key="settings-look" tone="warn" testId="rh-row-settings-look">{settingsLook}</RowLine>] : lines;

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

  const items = [
    ...menu.map((m) => ({ key: m.key, label: m.label, disabled: m.disabled, title: m.title, onSelect: () => { m.onSelect(); backToMore(); } })),
    ...(onRemove ? [{ key: 'remove', label: 'Remove', danger: true, onSelect: () => setConfirming(true) }] : []),
  ];

  // A removal that takes a while (a joined machine's) keeps the question open as Removing...,
  // with the focus on it, and closes it only once it is done; one that fails (its error shows on
  // the row) leaves it open to try again or cancel. A second press while it runs does nothing.
  const remove = async () => {
    if (removing) return;
    setRemoving(true);
    let done: unknown;
    try { done = await onRemove?.(); } catch { done = false; }
    setRemoving(false);
    if (done === false) return;
    setConfirming(false);
    backToMore();
  };

  return (
    <>
      <SettingsRow
        className="rh-host-row"
        id={id}
        data-host-alias={alias}
        data-row-key={rowKey}
        data-needs-look={look ? 'true' : undefined}
        data-host-off={off ? 'true' : undefined}
        data-menu-open={menuAt ? 'true' : undefined}
        data-unsaved={unsaved ? 'true' : undefined}
        {...data}
        label={
          <span className="rh-row-name-line">
            {dot}
            <span className="rh-host-name" title={name}>{name}</span>
            {sub}
            {tag}
            {unsaved && <SettingsTag tone="warning" title="Walnut keeps it on this page until it saves">Not saved</SettingsTag>}
            {look && <span className="rh-look-tag" data-testid="rh-look-tag" title={settingsLook && warned ? `Also: ${settingsLook}` : undefined}>Needs a look</span>}
          </span>
        }
        help={<span className="rh-row-state" data-testid="rh-row-state">{state}</span>}
        children={shownLines?.length ? <span className="rh-row-lines">{shownLines}</span> : undefined}
        control={
          <span className="rh-row-actions" ref={anchor}>
            <span className="rh-row-primary">
              {primary && (
                <SettingsButton
                  disabled={primary.disabled}
                  // Busy (Retrying..., Installing...) it stays where it is and keeps the focus.
                  holdFocus
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
            {items.length > 0 ? (
              <button
                ref={moreRef}
                type="button"
                tabIndex={0}
                className="rh-row-more"
                aria-label={`More for ${name}`}
                aria-haspopup="menu"
                aria-expanded={!!menuAt}
                data-testid="rh-row-more"
                // WebKit focuses no button on a press: the focus (and its ring) would stay on the row
                // the map landed on while this row's menu opens.
                // The press also keeps the button if the row moves before the release (useMenuButton).
                onPointerDown={(e) => { e.currentTarget.focus({ preventScroll: true }); moreMenu.buttonProps.onPointerDown(e); }}
                onKeyDown={moreMenu.buttonProps.onKeyDown}
                onClick={moreMenu.buttonProps.onClick}
              >
                <MoreGlyph />
              </button>
            ) : (
              // A new host has no menu (its Cancel is its one action); the column keeps its width.
              <span className="rh-row-more rh-row-more-space" aria-hidden="true" />
            )}
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
          highlightFirst={menuAt.keys}
          onClose={moreMenu.close}
          items={items}
        />
      )}
      {confirming && (
        <RemoveConfirmRow
          question={`Remove ${name}?`}
          note={removeNote}
          busy={removing}
          onCancel={() => { if (removing) return; setConfirming(false); requestAnimationFrame(() => focusLanded(moreRef.current)); }}
          onConfirm={() => void remove()}
        />
      )}
      {panel}
    </>
  );
}
