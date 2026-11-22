/**
 * The notification center's Errors view: one block per ROOT CAUSE, then one per CATEGORY. The
 * header is the whole point of the grouping: it names the cause or the family and how many cards
 * are in it, so a rail of twenty reds becomes four readable problems. Split out of
 * NotificationPanel.tsx; the lists come from useNotificationFeedView.
 */
import type { ReactNode } from 'react';
import type { ErrorCauseGroup } from '@/contexts/notifications';
import { ErrorCategoryTitle } from './ErrorCategoryTitle';
import { FeedGroups, type FeedGroupsProps } from './NotificationFeedCards';
import type { ErrorBlock } from './useNotificationFeedView';

/** What every block's cards share: the panel's group state and actions. */
type CardProps = Omit<FeedGroupsProps, 'groups' | 'showCategoryChip' | 'onOpenLetter'>;

export function NotificationErrorBlocks({ causes, blocks, activeCategory, drillable, onPickCategory, onShowAll, cardProps }: {
  causes: ErrorCauseGroup[] | undefined;
  blocks: ErrorBlock[];
  /** The family the view is filtered to, if any. */
  activeCategory: string | null;
  /** Two or more families: a family's header drills into it. */
  drillable: boolean;
  onPickCategory: (category: string) => void;
  onShowAll: () => void;
  cardProps: CardProps;
}): ReactNode {
  return (
    <>
      {/* Root-cause blocks first: they name the ONE thing that broke
          ("Can't reach devbox"), and the cards under them are the
          conditions it produced. A single group so the existing
          collapse shows the newest card + "Show N more": the whole
          point is that an outage takes up one block, not four. */}
      {causes?.map(cause => (
        <div key={cause.causeKey} className="nfc-cat-block">
          <div className="nfc-cat-header nfc-cause-header">
            <ErrorCategoryTitle causeKey={cause.causeKey} label={cause.label} />
            <span className="nfc-cat-count">{cause.items.length}</span>
          </div>
          {/* A cause block mixes families by construction (Sessions + API under one outage), so
              unlike a family block its header can't name the family: each card wears the chip. */}
          <FeedGroups groups={[{ key: `cause:${cause.causeKey}`, items: cause.items }]} showCategoryChip {...cardProps} />
        </div>
      ))}
      {blocks.map(block => (
        <div key={block.category} className="nfc-cat-block">
          {/* The header doubles as the drill-down: clicking a family in
              the all-errors view filters to it (same move as its rail
              sub-entry). Filtered, the header stops being a button and
              gains "Show all": the way back mirrors the way in. Same
              two-family gate as the rail sub-entries: with one family
              the all view IS the category view, so there is nothing to
              drill into. */}
          <div className="nfc-cat-header">
            {activeCategory || !drillable ? (
              <span className="nfc-cat-name">{block.category}</span>
            ) : (
              <button
                className="nfc-cat-name nfc-cat-drill"
                title={`Show only ${block.category} errors`}
                onClick={() => onPickCategory(block.category)}
              >
                {block.category}
              </button>
            )}
            <span className="nfc-cat-count">{block.count}</span>
            {activeCategory && (
              <button className="nfc-cat-showall" onClick={onShowAll}>
                Show all
              </button>
            )}
          </div>
          <FeedGroups groups={block.groups} {...cardProps} />
        </div>
      ))}
    </>
  );
}
