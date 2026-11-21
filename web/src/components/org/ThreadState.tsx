/**
 * A Threads card's state: its group's dot and word (thread-badge.ts threadBadge). Every kind of card
 * draws its state through this one piece: the node's own card (OrgThreads ThreadCard) and a thread
 * of a task below (PoppedThreadCard), so the two never read differently (2026-11-21, a review on his
 * data: a card of a task below sat in Working with a grey dot and no word, beside a green "Working").
 */
import type { ThreadBadge } from './thread-badge';

export function ThreadState({ badge }: { badge: ThreadBadge }) {
  const known = badge.group === 'known';
  return (
    <span className="org-thread-state" data-testid="org-thread-state" data-group={badge.group}>
      <i className={known ? 'is-known' : undefined} style={known ? undefined : { background: badge.dot }} />
      {badge.label}
    </span>
  );
}
