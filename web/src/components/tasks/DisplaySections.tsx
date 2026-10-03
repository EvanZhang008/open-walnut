/**
 * DisplaySections: the display half of the panel menu's first page (Sort,
 * Group, then View, Show tab bar, Session columns, the view-specific slot) and
 * the View page (every view, a hairline between the bar's tabs and the rest).
 * Presentational; PanelMenu (FilterMenu.tsx) wires them to DisplayMenuProps.
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ICON_CHECK, ICON_CHEVRON_RIGHT } from '../common/Icons';
import { TAB_BAR_HIDDEN_TABS_KEY, useNavigationList } from '@/hooks/useNavigationPreference';
import type { DisplayMenuProps } from './filter-bar-types';
import type { GroupBy, ViewChoiceRow } from './ViewDropdown';
import { DEFAULT_HIDDEN_TABS, displayViewLayers, type TabBarTab } from './tab-bar-model';
import { useSessionPanelsViewGroup } from './session-panels-view-group';
import { DisplayRow, Segmented, SortRow, SwitchRow, type SegChoice } from './DisplaySortRows';
import { ICON_VIEW } from './filter-dim-icons';
import { arrowFocus } from './FilterValueList';

export const TAB_BAR_SWITCH_TITLE = 'All, Pinned and the other views as tabs across the top';
export const VIEW_ROW_TITLE = 'View: All, Pinned and the other views';

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

/** Every view in menu order: the tabs kept on the bar first, then the rest, Projects last. */
export function useMenuViews(customTiers: DisplayMenuProps['customTiers']): { first: TabBarTab[]; more: TabBarTab[] } {
  const [hidden] = useNavigationList(TAB_BAR_HIDDEN_TABS_KEY, DEFAULT_HIDDEN_TABS);
  return displayViewLayers(customTiers, hidden);
}

export interface DisplaySectionsProps {
  display: DisplayMenuProps;
  flashOption: string | null;
  /** The current view's label, for the View row. */
  viewLabel: string;
  onOpenViews(anchor: HTMLElement): void;
}

/** Page one, below the filter rows: Sort, Group, then View, Show tab bar, Session columns, the view slot. */
export function DisplaySections({ display: p, flashOption, viewLabel, onOpenViews }: DisplaySectionsProps) {
  // Rendered only while open, so the session setting's config read runs only then.
  const sessionRow = useSessionPanelsViewGroup().options[0] as ViewChoiceRow;
  const sessionValue = sessionRow.choices.find((c) => c.active)?.key ?? null;
  return (
    <>
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

      <div className="dm-section dm-settings" data-view-group="Show">
        <button
          type="button"
          className="fb-item fb-prop dm-view-row"
          data-view-option="view"
          aria-haspopup="true"
          title={VIEW_ROW_TITLE}
          onClick={(e) => onOpenViews(e.currentTarget)}
        >
          <span className="fb-item-icon" aria-hidden="true">{ICON_VIEW}</span>
          <span className="fb-item-text">View</span>
          <span className="fb-prop-summary">{viewLabel}</span>
          <span className="fb-item-chevron" aria-hidden="true">{ICON_CHEVRON_RIGHT}</span>
        </button>
        <SwitchRow option="quick-views" label="Show tab bar" title={TAB_BAR_SWITCH_TITLE}
          checked={p.quickViews} onChange={p.onQuickViewsChange} />
        <DisplayRow option={sessionRow.key} label="Session columns" title={sessionRow.title} flash={flashOption === sessionRow.key}>
          <Segmented label="Session columns" value={sessionValue}
            choices={sessionRow.choices.map((c) => ({ key: c.key, label: c.label, title: c.title }))}
            onPick={(k) => sessionRow.choices.find((c) => c.key === k)?.onSelect()} />
        </DisplayRow>
      </div>

      {/* The rows only some views have, always LAST: Collapse all (views that draw
          project groups), Tier layout, Recent order. Absent views leave no empty slot. */}
      {(p.showCollapse || p.tierLayout || p.recentOrder) && (
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
      )}
    </>
  );
}

export interface DisplayViewsPageProps {
  views: { first: TabBarTab[]; more: TabBarTab[] };
  active: string;
  query: string;
  onPick(id: string): void;
  onBack(): void;
  onExitTop?(): void;
  /** The page head (Back button and title), drawn by the caller for every page alike. */
  head: ReactNode;
}

/** Page two for View: every view as a radio-style row, a hairline between the bar's tabs and the rest. */
export function DisplayViewsPage({ views, active, query, onPick, onBack, onExitTop, head }: DisplayViewsPageProps) {
  const q = query.trim().toLowerCase();
  const match = (v: TabBarTab) => !q || v.label.toLowerCase().includes(q);
  const first = views.first.filter(match);
  const more = views.more.filter(match);
  const listRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); onBack(); return; }
    if (e.key === 'ArrowUp' && onExitTop) {
      const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('.dm-view') ?? []);
      if (rows.indexOf(document.activeElement as HTMLElement) === 0) { e.preventDefault(); onExitTop(); return; }
    }
    arrowFocus(e, '.dm-view');
  };
  const row = (v: TabBarTab) => (
    <button
      key={v.id}
      type="button"
      className="dm-view"
      data-view-option={v.id}
      aria-pressed={v.id === active}
      title={v.title}
      onClick={() => onPick(v.id)}
    >
      <span className="fb-check" aria-hidden="true">{v.id === active ? ICON_CHECK : null}</span>
      <span className="dm-view-label">{v.label}</span>
    </button>
  );
  return (
    <div className="fb-page" data-filter-dim="view" data-view-group="Show">
      {head}
      <div ref={listRef} className="fb-list-rows dm-views" role="group" aria-label="Views" onKeyDown={onKeyDown}>
        {first.length === 0 && more.length === 0 && <div className="fb-empty">{`No view matches "${query.trim()}"`}</div>}
        {first.map(row)}
        {first.length > 0 && more.length > 0 && <div className="dm-flyout-sep" aria-hidden="true" />}
        {more.map(row)}
      </div>
    </div>
  );
}
