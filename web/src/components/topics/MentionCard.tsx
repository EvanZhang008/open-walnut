/**
 * The card an "@Name" chip in a topic message opens (TopicMention.tsx): what the member is, its
 * place in the topic, and for a task or an Org node "Open chat" (useOpenTask, the one way a task
 * opens). A popover on the overlay family, closed through its layer.
 */
import { useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Topic } from '@/api/topics';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOpenTask } from '@/hooks/useOpenTask';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { useTaskListSelect } from '@/contexts/TasksContext';
import { MemberAvatar, memberTaskId } from './TopicAvatars';
import { useMemberCandidates } from './member-candidates';
import { mentionCardFacts, refKey } from './topic-model';

type Member = Topic['members'][number];

export function MentionCard({ member, anchor, onClose }: { member: Member; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(true, anchor, cardRef, { preferSide: 'down', align: 'start', minHeight: 120, onAnchorLost: onClose });
  useOverlayLayer({ open: true, onClose, refs: [cardRef, anchor] });
  const candidates = useMemberCandidates();
  const leads = member.ref.kind === 'org' ? candidates.find((c) => refKey(c.ref) === refKey(member.ref))?.hint : undefined;
  const taskId = useTaskListSelect(({ tasks }) => memberTaskId(member.ref, tasks));
  const phase = useTaskListSelect(({ tasks }) => (member.ref.kind === 'task' ? tasks.find((t) => t.id === taskId)?.phase : undefined));
  const facts = mentionCardFacts(member, { ...(leads ? { leads } : {}), ...(phase ? { phase } : {}) });
  const openTask = useOpenTask();
  return createPortal(
    <div ref={cardRef} role="dialog" aria-label={member.name} className="task-kebab-menu topic-mention-card wn-overlay" data-testid="topic-mention-card"
      style={menuPlacementStyle(placement)} onPointerDown={(e) => e.stopPropagation()}>
      <div className="topic-mention-card-head">
        <MemberAvatar who={{ name: member.name, ref: member.ref }} size={40} />
        <span className="topic-mention-card-names">
          <span className="topic-mention-card-name">{member.name}</span>
          <span className="topic-mention-card-kind" data-testid="topic-mention-card-kind">{facts.kind}</span>
        </span>
      </div>
      {facts.line && <p className="topic-mention-card-line">{facts.line}</p>}
      {facts.opens && taskId && (
        <button type="button" className="btn btn-sm topic-mention-card-open" data-testid="topic-mention-card-open"
          onClick={() => { onClose(); openTask(taskId); }}>Open chat</button>
      )}
    </div>,
    document.body,
  );
}

