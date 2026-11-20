/**
 * "@Name" in a topic message, drawn as the member's chip: its avatar and name, so a reader sees at
 * once that it names a real member (a task, the CEO, a VP, a person by email) and not just text.
 * A click opens the member's card: what it is, its place in the topic, and for a task or an Org
 * node "Open chat" (useOpenTask, the one way a task opens).
 *
 * The words stay the message's own markdown (AgentText); the chips are put in after it is drawn:
 * every "@Name" the server's own rule names (mentionSpans, topic-mentions.ts) in the drawn text,
 * outside code and links, becomes an empty slot, and each slot gets its chip through a portal. A
 * redraw of the words (a new html) takes the slots away, so a MutationObserver puts them back.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { MemberRef, Topic } from '@/api/topics';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOpenTask } from '@/hooks/useOpenTask';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { useTaskListSelect } from '@/contexts/TasksContext';
import { MemberAvatar, memberTaskId } from './TopicAvatars';
import { useMemberCandidates } from './member-candidates';
import { mentionCardFacts, mentionSpans, refKey, shortName } from './topic-model';

type Member = Topic['members'][number];
interface Slot { el: HTMLElement; id: string }

const SKIP = 'code, pre, a, .topic-mention-slot';

/** Puts a slot in place of every "@Name" that names a member, in the drawn words under `root`. */
function placeSlots(root: HTMLElement, members: readonly Member[]): Slot[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (t.data.includes('@') && !t.parentElement?.closest(SKIP)) texts.push(t);
  }
  const slots: Slot[] = [];
  for (const t of texts) {
    const spans = mentionSpans(t.data, members);
    if (!spans.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const s of spans) {
      if (s.start > at) frag.append(t.data.slice(at, s.start));
      const el = document.createElement('span');
      el.className = 'topic-mention-slot';
      // The words a copy or a screen reader gets: the name as written.
      el.dataset.text = t.data.slice(s.start, s.end);
      frag.append(el);
      slots.push({ el, id: s.id });
      at = s.end;
    }
    if (at < t.data.length) frag.append(t.data.slice(at));
    t.replaceWith(frag);
  }
  return slots;
}

/** The chips of one message's words (`root`), kept in place across redraws of the words. */
export function useMentionSlots(root: RefObject<HTMLElement | null>, text: string, members: readonly Member[]): Slot[] {
  const [slots, setSlots] = useState<Slot[]>([]);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !text.includes('@')) { setSlots([]); return; }
    let ours = false;
    const scan = () => {
      ours = true;
      setSlots(placeSlots(el, members));
      // The observer reports our own edits after this task: let them pass first.
      queueMicrotask(() => { ours = false; });
    };
    scan();
    const watch = new MutationObserver(() => {
      if (ours) return;
      if (!el.querySelector('.topic-mention-slot')) scan();
    });
    watch.observe(el, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [root, text, members]);
  return slots;
}

export function MentionChips({ slots, topic }: { slots: readonly Slot[]; topic: Topic }) {
  return <>{slots.map((s, i) => {
    const m = topic.members.find((x) => x.id === s.id);
    return m ? createPortal(<MentionChip member={m} written={s.el.dataset.text ?? `@${m.name}`} />, s.el, `${s.id}-${i}`) : null;
  })}</>;
}

function kindOf(ref: MemberRef): string {
  return ref.kind === 'person' ? (ref.bot ? 'bot' : 'person') : ref.kind;
}

function MentionChip({ member, written }: { member: Member; written: string }) {
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={chipRef} type="button" className={`topic-mention${member.status === 'left' ? ' is-left' : ''}`} data-testid="topic-mention"
        data-kind={kindOf(member.ref)} data-member-id={member.id} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${written}: show ${member.name}`}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
        <MemberAvatar who={{ name: member.name, ref: member.ref }} size={16} />
        <span className="topic-mention-label">{shortName(member.name)}</span>
        {member.ref.kind === 'person' && <span className="topic-mention-mail" aria-hidden="true" />}
      </button>
      {open && <MentionCard member={member} anchor={chipRef} onClose={() => setOpen(false)} />}
    </>
  );
}

function MentionCard({ member, anchor, onClose }: { member: Member; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
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
    <div ref={cardRef} role="dialog" aria-label={member.name} className="task-kebab-menu topic-mention-card" data-testid="topic-mention-card"
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

