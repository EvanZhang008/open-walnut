/**
 * A Threads card folded by its × (NoticeClose) to one line in its list: its group's dot and word,
 * its title and Show (actions/AskFold.tsx). It never acknowledges, snoozes or closes the thread; a
 * card that moves to another group or holds a new ask opens again by itself. Both kinds of card
 * fold this way: the node's own (OrgThreads ThreadCard) and a thread of a task below
 * (PoppedThreadCard). The top of a chat folds as a whole instead (TopThread's ×).
 */
import { useEffect } from 'react';
import type { OrgThread } from '@/api/org-threads';
import { AskFoldLine, FOLD_WORDS, useAskFold } from '@/components/actions/AskFold';
import { ThreadState } from './ThreadState';
import type { ThreadBadge } from './thread-badge';

/**
 * The card's fold, kept per thread until its group, its held ask or the decision it asks changes
 * (useAskFold drops it then, so a thread back in Needs you with a new question opens). A card the
 * user opened from a chat's thread link (`focused`) opens too, so its focus mark shows on the card.
 */
export function useThreadFold(t: OrgThread, group: string, on: boolean, focused = false) {
  const fold = useAskFold('org-thread', on ? t.id : '', `${group}|${t.heldAsk?.id ?? ''}|${t.ask_id ?? ''}`);
  const { folded, show } = fold;
  useEffect(() => { if (focused && folded) show(); }, [focused, folded, show]);
  return fold;
}

export const THREAD_CLOSE_LABEL = 'Fold it to one line in this list: the thread stays as it is';

export function ThreadFoldedItem({ t, badge, onShow }: { t: OrgThread; badge: ThreadBadge; onShow: () => void }) {
  return (
    <li className="org-thread-folded" data-testid="org-thread" data-thread-id={t.id} data-state={t.closed ? 'closed' : t.state} data-group={badge.group} data-user-folded="true">
      <AskFoldLine testId="org-thread-folded" showTestId="org-thread-show" onShow={onShow} title="Show this thread's card"
        mark={<ThreadState badge={badge} />} words={<span className={FOLD_WORDS} data-testid="org-thread-title">{t.title}</span>} />
    </li>
  );
}
