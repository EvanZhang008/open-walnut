/**
 * The topic's composer: the chat's own box (ChatInput, light: its mic, its kept draft, a failed
 * send keeping the words), with the topic's own "@": the members first, then open tasks not in
 * the topic. Picking a member writes "@Name "; picking a task asks "Add it to this topic?" first,
 * so a mistyped name never pulls an unrelated task in (each member wake costs a turn). The list
 * takes the arrows, Enter, Tab and Esc while it is open (caught before the box sees them) and is
 * placed by useMenuPlacement above the box.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { orgDisplayTitle } from '@open-walnut/org-tree';
import type { Topic } from '@/api/topics';
import { ChatInput } from '@/components/chat/ChatInput';
import { detectMention } from '@/components/chat/mention-trigger';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { useConfirm } from '@/hooks/useConfirm';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { draftKey } from '@/utils/drafts';
import { mentionCandidates, refKey, taskRef, type MentionCandidate } from './topic-model';
import { MemberAvatar } from './TopicAvatars';
import type { TopicActions } from './useTopics';

interface Open { atIndex: number; query: string; caret: number }

export function TopicComposer({ topic, actions }: { topic: Topic; actions: Pick<TopicActions, 'post' | 'addMembers'> }) {
  const wrap = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  const tasks = useTasksContextSafe()?.tasks;
  const [value, setValue] = useState('');
  const [at, setAt] = useState<Open | null>(null);
  const [hi, setHi] = useState(0);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const openTasks = useMemo(
    () => (tasks ?? []).filter((t) => t.phase !== 'COMPLETE' && t.status !== 'done').map((t) => ({ id: t.id, name: orgDisplayTitle(t) })),
    [tasks],
  );
  const rows = useMemo(() => (at ? mentionCandidates(at.query, topic.members, openTasks) : []), [at, topic.members, openTasks]);
  const open = !!at && rows.length > 0;
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
    if (!(await actions.addMembers([taskRef(c.taskId)]))) return;
    insert(c.name);
  };
  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (!open) return;
    const take = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'ArrowDown') { take(); setHi((i) => (i + 1) % rows.length); }
    else if (e.key === 'ArrowUp') { take(); setHi((i) => (i - 1 + rows.length) % rows.length); }
    else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { take(); const c = rows[Math.min(hi, rows.length - 1)]; if (c) void pick(c); }
    else if (e.key === 'Escape') { take(); setAt(null); }
  };

  return (
    <div ref={wrap} className="topic-composer" data-testid="topic-composer" onKeyDownCapture={onKeyDownCapture}
      onKeyUp={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') read(value); }}
      onClick={() => read(value)}>
      <ChatInput
        light
        placeholder={topic.closed ? 'This topic is closed' : 'Say something in the topic… @Name wakes only that member'}
        draftKey={draftKey('topic', topic.id)}
        onSend={(text) => actions.post(text)}
        onValueChange={(text) => { setValue(text); read(text); }}
        showCommands={false}
        disabled={!!topic.closed}
        {...(prefill ? { prefillText: prefill.text, prefillNonce: prefill.nonce, prefillMode: 'replace' as const } : {})}
        inputTestId="topic-input"
        sendTestId="topic-send"
        sendTitle="Post to the topic"
      />
      {open && createPortal(
        <div ref={menuRef} role="listbox" aria-label="Mention a member" className="task-kebab-menu topic-mention-menu" data-testid="topic-mention-menu"
          style={menuPlacementStyle(placement)} onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.preventDefault()}>
          {rows.map((c, i) => {
            const key = c.kind === 'member' ? c.member.id : refKey(taskRef(c.taskId));
            const name = c.kind === 'member' ? c.member.name : c.name;
            return (
              <button key={key} type="button" role="option" aria-selected={i === hi}
                className={`task-kebab-item topic-mention-row${i === hi ? ' task-kebab-item-active' : ''}`}
                data-testid="topic-mention-row" data-kind={c.kind}
                onMouseEnter={() => setHi(i)} onClick={() => void pick(c)}>
                <MemberAvatar who={{ name, ...(c.kind === 'member' ? { ref: c.member.ref } : {}) }} size={18} />
                <span className="topic-mention-name">{name}</span>
                <span className="topic-mention-hint">{c.kind === 'member' ? (c.member.role === 'host' ? 'Host' : 'In the topic') : 'Not in the topic: add it?'}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
