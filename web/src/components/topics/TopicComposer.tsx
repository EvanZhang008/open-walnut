/**
 * The topic's composer: the chat's own box (ChatInput, light: its mic, its kept draft, a failed
 * send keeping the words), with the topic's own "@": the members first, then open tasks not in
 * the topic. Picking a member writes "@Name "; picking a task asks "Add it to this topic?" first,
 * so a mistyped name never pulls an unrelated task in (each member wake costs a turn). Every "@Name"
 * that names a member is drawn as a pill in the box (ChatInput namedPills), and goes as one unit. The list
 * takes the arrows, Enter, Tab and Esc while it is open (caught before the box sees them; an input
 * method's keys stay its own, mentionKeyAction) and is placed by useMenuPlacement above the box.
 * A mouse pick closes it like Enter does: the click that bubbles up from the list reads nothing.
 * A topic line is text only (it goes to several members' turns and out by mail): a pasted picture
 * is refused with words and stays in the box with the text, never dropped silently.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Topic } from '@/api/topics';
import { ChatInput } from '@/components/chat/ChatInput';
import { detectMention } from '@/components/chat/mention-trigger';
import { useConfirm } from '@/hooks/useConfirm';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { draftKey } from '@/utils/drafts';
import { mentionCandidates, mentionKeyAction, mentionSpans, orgRef, refKey, taskRef, type MentionCandidate } from './topic-model';
import { useOpenTaskNames, useOrgNodeNames } from './member-candidates';
import { MemberAvatar } from './TopicAvatars';
import type { TopicActions } from './useTopics';

interface Open { atIndex: number; query: string; caret: number }

export function TopicComposer({ topic, actions }: { topic: Topic; actions: Pick<TopicActions, 'post' | 'addMembers'> }) {
  const wrap = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  const [value, setValue] = useState('');
  const [at, setAt] = useState<Open | null>(null);
  const [hi, setHi] = useState(0);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const openTasks = useOpenTaskNames();
  const orgNodes = useOrgNodeNames();
  const rows = useMemo(() => (at ? mentionCandidates(at.query, topic.members, openTasks, 8, orgNodes) : []), [at, topic.members, openTasks, orgNodes]);
  const open = !!at && rows.length > 0;
  // Every "@Name" that names a member is drawn as a pill in the box: the same rule that decides who it wakes.
  const namedPills = useLeanCallback((body: string) => mentionSpans(body, topic.members), [topic.members]);
  const placement = useMenuPlacement(open, wrap, menuRef, { preferSide: 'up', align: 'start', minHeight: 120, onAnchorLost: () => setAt(null) });

  const box = () => wrap.current?.querySelector('textarea') ?? null;
  const read = (text: string) => {
    const caret = box()?.selectionStart ?? text.length;
    const m = detectMention(text, caret, at?.atIndex ?? -1);
    setAt(m ? { ...m, caret } : null);
    if (!m || m.atIndex !== at?.atIndex) setHi(0);
  };
  const insert = (name: string) => {
    if (!at) return;
    const text = `${value.slice(0, at.atIndex)}@${name} ${value.slice(at.caret)}`;
    setPrefill({ text, nonce: Date.now() });
    setAt(null);
  };
  const pick = async (c: MentionCandidate) => {
    if (c.kind === 'member') { insert(c.member.name); return; }
    const yes = await confirm({ title: `Add ${c.name} to this topic?`, message: 'It is woken when someone names it with @, and reads what it missed then.', confirmLabel: 'Add to topic' });
    if (!yes) return;
    if (!(await actions.addMembers([c.kind === 'org' ? orgRef(c.node) : taskRef(c.taskId)]))) return;
    insert(c.name);
  };
  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (!open) return;
    // An IME's keys stay its own (mentionKeyAction): the Enter that commits a word never picks a row.
    const action = mentionKeyAction({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode });
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === 'next') setHi((i) => (i + 1) % rows.length);
    else if (action === 'prev') setHi((i) => (i - 1 + rows.length) % rows.length);
    else if (action === 'pick') { const c = rows[Math.min(hi, rows.length - 1)]; if (c) void pick(c); }
    else setAt(null);
  };

  return (
    <div ref={wrap} className="topic-composer" data-testid="topic-composer" onKeyDownCapture={onKeyDownCapture}
      onKeyUp={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') read(value); }}
      onClick={(e) => {
        // A click on a row of the (portalled) list bubbles here through React: the pick wrote the
        // name already, and reading the old "@Al" again would open the list once more.
        if (menuRef.current?.contains(e.target as Node)) return;
        read(value);
      }}>
      <ChatInput
        light
        placeholder={topic.closed ? 'This topic is closed' : 'Message the topic · @Name wakes only that member'}
        draftKey={draftKey('topic', topic.id)}
        onSend={(text, images) => {
          if (images?.length) {
            setRefused('A topic takes text only. Remove the picture to post.');
            return Promise.resolve(false);
          }
          setRefused(null);
          return actions.post(text);
        }}
        onValueChange={(text) => { setValue(text); read(text); }}
        showCommands={false}
        disabled={!!topic.closed}
        {...(prefill ? { prefillText: prefill.text, prefillNonce: prefill.nonce, prefillMode: 'replace' as const } : {})}
        namedPills={namedPills}
        inputTestId="topic-input"
        sendTestId="topic-send"
        sendTitle="Post to the topic"
      />
      {refused && <div className="topic-composer-refused" role="alert" data-testid="topic-composer-refused">{refused}</div>}
      {open && createPortal(
        <div ref={menuRef} role="listbox" aria-label="Mention a member" className="task-kebab-menu topic-mention-menu" data-testid="topic-mention-menu"
          style={menuPlacementStyle(placement)} onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.preventDefault()}>
          {rows.map((c, i) => {
            const ref = c.kind === 'member' ? c.member.ref : c.kind === 'org' ? orgRef(c.node) : taskRef(c.taskId);
            const key = c.kind === 'member' ? c.member.id : refKey(ref);
            const name = c.kind === 'member' ? c.member.name : c.name;
            return (
              <button key={key} type="button" role="option" aria-selected={i === hi}
                className={`task-kebab-item topic-mention-row${i === hi ? ' task-kebab-item-active' : ''}`}
                data-testid="topic-mention-row" data-kind={c.kind}
                onMouseEnter={() => setHi(i)} onClick={() => void pick(c)}>
                <MemberAvatar who={{ name, ref }} size={20} />
                <span className="topic-mention-name wn-title">{name}</span>
                <span className="topic-mention-hint">{c.kind === 'member' ? (c.member.role === 'host' ? 'Host' : 'In the topic') : 'Add to topic'}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
