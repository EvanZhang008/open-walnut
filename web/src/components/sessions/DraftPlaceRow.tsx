/**
 * One place row of the v6 draft (experiment `project_first_start`): a folder or a project with its
 * machine, as the Where picker's Recent / Most used list draws it and the draft's own list under the
 * composer (DraftRecentList) draws it too, so the two read as one list.
 *
 *   [▭]  walnut  [Walnut]                              [This Mac]  1,486 starts · 2h ago   ›
 *        ~/code
 *
 * The row is a listbox option (its list owns the keys); the place in use is the family's picked
 * row (aria-selected). The chevron opens the folder's own folders, only where the list browses.
 */
import type { KeyboardEvent, ReactNode } from 'react';
import { usePageView } from '@/utils/view-memory';
import { badge } from '@/components/common/badge';
import { ICON_CHEVRON_RIGHT } from '@/components/common/Icons';
import { Title } from './DraftWhereAuto';
import { WhereIcon, type WhereKind } from './DraftWhereIcons';

export function DraftPlaceRow({ kind, name, tag, line, hostName, meta, current, active, compact, title, onPick, onOpen, openLabel, testId, data, tabIndex, onKeyDown }: {
  /** Its icon: a folder, a repo, a package. */
  kind: WhereKind;
  /** The name, whole (it wraps); may carry the search's marks. */
  name: ReactNode;
  /** A project the folder belongs to, after the name. */
  tag?: string;
  /** The second line: the parent folder, or what a project starts from. */
  line: string;
  /** The machine, read whole on every row (two folders of one name on two machines). */
  hostName: string;
  meta: string;
  current: boolean;
  active?: boolean;
  /** Five of them under the draft's composer: 4 px less above and below, the same look. */
  compact?: boolean;
  title: string;
  onPick: () => void;
  onOpen?: () => void;
  openLabel?: string;
  testId: string;
  data?: Record<string, string>;
  tabIndex?: number;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div className={`draft-v6-wm-row wn-pick-row draft-v6-wp-row${active ? ' is-active' : ''}${compact ? ' is-compact' : ''}`} role="option" aria-selected={current}
      data-testid={testId} {...Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]))}
      title={title} tabIndex={tabIndex} onKeyDown={onKeyDown} onMouseDown={(e) => e.preventDefault()} onClick={onPick}>
      <span className="draft-v6-wm-ico"><WhereIcon kind={kind} size={15} /></span>
      <span className="draft-v6-wm-text">
        <span className="draft-v6-wm-name wn-pick-name"><Title>{name}</Title>
          {tag && <span className={`${badge()} draft-v6-tag`}><span>{tag}</span></span>}</span>
        {/* The parent's tail wins when it is long: the folder's own levels stay readable. */}
        <span className="draft-v6-wm-line is-path draft-v6-wp-parent"><bdi>{line}</bdi></span>
      </span>
      <span className="draft-v6-wp-meta">
        <span className={`${badge()} draft-v6-tag`}><span>{hostName}</span></span>
        <span className="draft-v6-wm-time">{meta}</span>
      </span>
      {onOpen && (
        <button type="button" className="btn btn-sm btn-icon draft-v6-wp-go" aria-label={openLabel} title="Open its folders"
          onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); onOpen(); }}>{ICON_CHEVRON_RIGHT}</button>
      )}
    </div>
  );
}

/** A row's meta, the same words in every list: Recent says when, Most used how many starts, a
 *  search both (review: one number a row, the one its order is by). */
export function placeMeta(order: PlaceOrder | 'search', count: number, ago: string): string {
  const starts = `${count.toLocaleString()} ${count === 1 ? 'start' : 'starts'}`;
  return order === 'recent' ? ago || starts : order === 'most' ? starts : [starts, ago].filter(Boolean).join(' · ');
}

export type PlaceOrder = 'recent' | 'most';
const isPlaceOrder = (v: unknown): v is PlaceOrder => v === 'recent' || v === 'most';

/** Recent or Most used: one choice for the Where picker and the draft's list (kept per page). */
export function usePlaceOrder() {
  return usePageView<PlaceOrder>('draft-where', 'list', 'recent', isPlaceOrder);
}
