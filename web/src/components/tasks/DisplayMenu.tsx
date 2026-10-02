/**
 * DisplayMenu: the task panel toolbar's Display button and its portalled
 * `.dm-menu` (spec 3.3, 6.5). It decides how the list is laid out (view, tab
 * bar, session columns, sort, group, collapse); which tasks show is the Filter
 * bar's job, so this button carries no filter dot.
 *
 * Open state is controlled (props.open / onOpenChange): the filter row's
 * "View: Pinned" item and the Filter search hint open it too.
 *
 * View rows: the first layer is the tabs the user keeps on the bar (same list,
 * same order, tab-bar-model.ts displayViewLayers; All + Pinned by default), the
 * rest live in the portalled More views flyout (DisplayViewsFlyout.tsx), never
 * inline. Every title comes from tab-bar-model.ts, the one source.
 *
 * Height (C29b): the rows only some views have (Sort and Group where the list
 * order applies, Tier layout, Recent order) sit LAST in a slot of fixed height
 * (.dm-context, display-menu.css), so switching views inside the open menu
 * moves no row; the box height is measured ONCE at open and the body scrolls
 * inside when the window is short.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ICON_CHECK, ICON_CHEVRON_RIGHT, ICON_SLIDERS } from '../common/Icons';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { clampToPanelLeft, panelLeftOf } from './panel-menu-clamp';
import { useOverlayLayer, type OverlayCloseReason } from '@/hooks/useOverlayLayer';
import { TAB_BAR_HIDDEN_TABS_KEY, useNavigationList } from '@/hooks/useNavigationPreference';
import '@/styles/filter-toolbar-base.css';
import '@/styles/display-menu.css';
import type { DisplayMenuProps } from './filter-bar-types';
import type { GroupBy, ViewChoiceRow } from './ViewDropdown';
import { DEFAULT_HIDDEN_TABS, displayViewLayers } from './tab-bar-model';
import { useSessionPanelsViewGroup } from './session-panels-view-group';
import { DisplayViewsFlyout, DISPLAY_VIEWS_FLYOUT_CLASS } from './DisplayViewsFlyout';
import { DisplayRow, Segmented, SortRow, SwitchRow, type SegChoice } from './DisplaySortRows';
import { VIEW_DROPDOWN_REVEAL_EVENT, VIEW_OPTION_FLASH_MS, whenSettled, type ViewDropdownRevealDetail } from './view-dropdown-reveal';

export const DISPLAY_MENU_WIDTH = 320;
/** Child portals that count as inside the menu for its outside-press closer. */
export const DISPLAY_MENU_EXEMPT = [`.${DISPLAY_VIEWS_FLYOUT_CLASS}`] as const;
export const TAB_BAR_SWITCH_TITLE = 'All, Pinned and the other views as tabs across the top';
export const MORE_VIEWS_TITLE = 'More views: every view that is not on your tab bar';

export function displayButtonTitle(viewTitleHint: string | null): string {
  return viewTitleHint ? `Display: view ${viewTitleHint}, sort, group, layout` : 'Display: view, sort, group, layout';
}

const GROUP_CHOICES: readonly SegChoice<GroupBy>[] = [
  { key: 'project', label: 'By project', title: 'Group the list by project' },
  { key: 'none', label: 'Flat', title: 'One flat list' },
];
const TIER_LAYOUT_CHOICES: readonly SegChoice<'project' | 'custom'>[] = [
  { key: 'project', label: 'Group by project', option: 'tier-project' },
  { key: 'custom', label: 'Custom order', option: 'tier-custom' },
];
const RECENT_ORDER_CHOICES: readonly SegChoice<'updated' | 'created'>[] = [
  { key: 'updated', label: 'Updated', title: 'Most recently updated first', option: 'recent-updated' },
  { key: 'created', label: 'Created', title: 'Most recently created first', option: 'recent-created' },
];

/** The sliders button (6.5) plus, while open, the menu. */
/** The menu was opened with the pointer: no focus ring on its first focused row (F29). */
let openedByPointer = false;

export function DisplayButton(props: DisplayMenuProps) {
  const { open, onOpenChange, buttonRef, viewTitleHint } = props;
  // "Show me that control" (view-dropdown-reveal.ts): the strip's lock-grant hint
  // opens this menu on its Session columns row and pulses it. The open waits for
  // the button to hold still: the task panel may be sliding open at that moment.
  const [flashOption, setFlashOption] = useState<string | null>(null);
  const openRef = useRef(onOpenChange);
  openRef.current = onOpenChange;
  useEffect(() => {
    let cancel: (() => void) | null = null;
    const handler = (e: Event) => {
      const option = (e as CustomEvent<ViewDropdownRevealDetail>).detail?.option;
      const el = buttonRef.current;
      if (!option || !el) return;
      cancel?.();
      cancel = whenSettled(el, () => {
        cancel = null;
        setFlashOption(option);
        openRef.current(true);
      });
    };
    window.addEventListener(VIEW_DROPDOWN_REVEAL_EVENT, handler);
    return () => { cancel?.(); window.removeEventListener(VIEW_DROPDOWN_REVEAL_EVENT, handler); };
  }, [buttonRef]);
  useEffect(() => {
    if (!open) { setFlashOption(null); return; }
    if (!flashOption) return;
    const t = setTimeout(() => setFlashOption(null), VIEW_OPTION_FLASH_MS);
    return () => clearTimeout(t);
  }, [open, flashOption]);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="tp-btn dm-display-btn"
        // Explicit tab stop: WebKit skips plain buttons on Tab (F09).
        tabIndex={0}
        aria-label="Display"
        title={displayButtonTitle(viewTitleHint)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => { openedByPointer = e.detail > 0; onOpenChange(!open); }}
      >
        {ICON_SLIDERS}
        <span className="tp-btn-label">Display</span>
      </button>
      {open && <DisplayMenu {...props} flashOption={flashOption} />}
    </>
  );
}

/** The menu itself; mounted only while open, so its height is "measured at open". */
export function DisplayMenu(p: DisplayMenuProps & { flashOption?: string | null }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [flyout, setFlyout] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  // WebKit draws :focus-visible on a programmatic focus after a click; the ring
  // waits for the first key instead (F29).
  const [quietFocus, setQuietFocus] = useState(openedByPointer);
  // Once a key was pressed here, the focused control always shows the ring: WebKit's
  // :focus-visible skips a focus moved by script after the opening click.
  const [keyed, setKeyed] = useState(false);
  const [hidden] = useNavigationList(TAB_BAR_HIDDEN_TABS_KEY, DEFAULT_HIDDEN_TABS);
  const { first, more } = displayViewLayers(p.customTiers, hidden);
  const currentInMore = more.find((v) => v.id === p.section) ?? null;
  // Rendered only while open, so the session setting's config read runs only then.
  const sessionRow = useSessionPanelsViewGroup().options[0] as ViewChoiceRow;

  // Measure once, BEFORE the placement hook's first measure (declaration order),
  // and write the height onto the node so that measure already sees it. The
  // view-specific slot has a fixed height, so this IS the tallest form.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const h = el.offsetHeight;
    el.style.height = `${h}px`;
    setHeight(h);
  }, []);

  const close = (reason: OverlayCloseReason | 'lost') => {
    p.onOpenChange(false);
    if (reason === 'escape') p.buttonRef.current?.focus({ preventScroll: true });
  };
  const placement = useMenuPlacement(true, p.buttonRef, menuRef, { align: 'right', onAnchorLost: () => close('lost') });
  useOverlayLayer({ open: true, refs: [menuRef, p.buttonRef], exemptSelectors: DISPLAY_MENU_EXEMPT, onClose: close });

  // Focus starts on the selected View row (the More views row when the view lives there).
  useLayoutEffect(() => {
    const el = menuRef.current;
    const row = el?.querySelector<HTMLElement>('.dm-view[aria-pressed="true"]') ?? (currentInMore ? moreRef.current : null);
    (row ?? el?.querySelector<HTMLElement>('.dm-view'))?.focus({ preventScroll: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Up/Down move between the View rows; Enter/Space is the button's own click.
  const onViewKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...(menuRef.current?.querySelectorAll<HTMLElement>('.dm-view') ?? [])];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    if (i < 0 || rows.length === 0) return;
    e.preventDefault();
    rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length].focus();
  };
  const viewTab = (selected: boolean) => (selected ? 0 : -1);
  const anySelectedFirst = first.some((v) => v.id === p.section);
  const sessionValue = sessionRow.choices.find((c) => c.active)?.key ?? null;
  const width = Math.min(DISPLAY_MENU_WIDTH, window.innerWidth - 16);
  const clamped = clampToPanelLeft({ placement, menuWidth: width, panelLeft: panelLeftOf(p.buttonRef.current), viewportWidth: window.innerWidth });
  const style = { ...menuPlacementStyle(clamped), width, ...(height !== null ? { height } : null) };

  return createPortal(
    // Portals escape clipping, NOT event bubbling: stop pointerdown so dnd-kit
    // never drags the task row behind the menu.
    <div
      ref={menuRef}
      className="dm-menu tp-pop"
      role="dialog"
      aria-label="Display options"
      style={style}
      data-pointer-open={quietFocus || undefined}
      data-keyed={keyed || undefined}
      onKeyDownCapture={() => { if (quietFocus) setQuietFocus(false); if (!keyed) setKeyed(true); }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="dm-section dm-views" data-view-group="Show" onKeyDown={onViewKeyDown}>
        <div className="dm-heading">View</div>
        {first.map((v) => (
          <button
            key={v.id}
            type="button"
            className="dm-view"
            data-view-option={v.id}
            aria-pressed={v.id === p.section}
            tabIndex={viewTab(v.id === p.section || (!anySelectedFirst && !currentInMore && v === first[0]))}
            title={v.title}
            onClick={() => p.onSectionChange(v.id)}
          >
            <span className="dm-check" aria-hidden="true">{v.id === p.section ? ICON_CHECK : null}</span>
            <span className="dm-view-label">{v.label}</span>
          </button>
        ))}
        {more.length > 0 && (
          <button
            ref={moreRef}
            type="button"
            className="dm-view dm-more-views"
            aria-haspopup="menu"
            aria-expanded={flyout}
            tabIndex={viewTab(!!currentInMore)}
            title={MORE_VIEWS_TITLE}
            onClick={() => setFlyout(!flyout)}
          >
            <span className="dm-check" aria-hidden="true">{currentInMore ? ICON_CHECK : null}</span>
            <span className="dm-view-label">{currentInMore ? `More views (${currentInMore.label})` : 'More views'}</span>
            <span className="dm-more-chevron" aria-hidden="true">{ICON_CHEVRON_RIGHT}</span>
          </button>
        )}
      </div>
      {flyout && (
        <DisplayViewsFlyout
          anchorRef={moreRef}
          views={more}
          active={p.section}
          onPick={p.onSectionChange}
          onClose={(reason) => {
            setFlyout(false);
            if (reason !== 'outside') moreRef.current?.focus({ preventScroll: true });
          }}
        />
      )}

      <div className="dm-section dm-settings">
        <SwitchRow option="quick-views" label="Show tab bar" title={TAB_BAR_SWITCH_TITLE}
          checked={p.quickViews} onChange={p.onQuickViewsChange} />
        <DisplayRow option={sessionRow.key} label="Session columns" title={sessionRow.title} flash={p.flashOption === sessionRow.key}>
          <Segmented label="Session columns" value={sessionValue}
            choices={sessionRow.choices.map((c) => ({ key: c.key, label: c.label, title: c.title }))}
            onPick={(k) => sessionRow.choices.find((c) => c.key === k)?.onSelect()} />
        </DisplayRow>
      </div>

      {/* Sort and Group sit at the same y in every view (C29b, spec 3.3). A view that
          keeps its own order says so in the row instead of offering a dead control. */}
      <div className="dm-section dm-order">
        {p.showSort ? <SortRow sortBy={p.sortBy} projectSortCount={p.projectSortCount} onSortForAll={p.onSortForAll} /> : (
          <DisplayRow option="sort" label="Sort" title="This view keeps its own order">
            <span className="dm-row-note">{p.orderNote}</span>
          </DisplayRow>
        )}
        {p.showGroup ? (
          <DisplayRow option="group" label="Group">
            <Segmented label="Group" choices={GROUP_CHOICES} value={p.groupBy}
              onPick={(k) => { if (k !== p.groupBy) p.onGroupByChange(k); }} />
          </DisplayRow>
        ) : (
          <DisplayRow option="group" label="Group" title="This view keeps its own grouping">
            <span className="dm-row-note">{p.orderNote}</span>
          </DisplayRow>
        )}
      </div>

      {/* The rows only some views have, always LAST in a slot of fixed height, so a view
          switch moves nothing above it and never resizes the box: Collapse all (views
          that draw project groups), Tier layout, Recent order. */}
      <div className="dm-section dm-context">
        {p.showCollapse && (
          <button type="button" className="dm-row dm-action" data-view-option="collapse" onClick={p.onCollapseExpandAll}>
            {p.allCollapsed ? 'Expand all projects' : 'Collapse all projects'}
          </button>
        )}
        {p.tierLayout && (
          <DisplayRow label="Tier layout">
            <Segmented label="Tier layout" choices={TIER_LAYOUT_CHOICES} value={p.tierLayout.mode}
              onPick={(k) => { if (k !== p.tierLayout?.mode) p.tierLayout?.onChange(k); }} />
          </DisplayRow>
        )}
        {p.recentOrder && (
          <DisplayRow label="Recent order">
            <Segmented label="Recent order" choices={RECENT_ORDER_CHOICES} value={p.recentOrder.mode}
              onPick={(k) => { if (k !== p.recentOrder?.mode) p.recentOrder?.onChange(k); }} />
          </DisplayRow>
        )}
      </div>
    </div>,
    document.body,
  );
}
