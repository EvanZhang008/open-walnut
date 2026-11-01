/**
 * Threads: the user's own requests to an Org node (Main, a VP, a lead), one thread per subject,
 * beside the Task and Brief views (2026-11-01, the user: "every user request becomes a thread ...
 * I can acknowledge, or do follow up actions"; "if my multiple ask is about the same thread, add
 * it below that thread"). Walnut files every message he sends the node; the node keeps each
 * thread's title, state and one-line reply (src/core/org/threads-model.ts).
 *
 *   Open      one card per open subject: state, title, what he wants, where it stands, its tasks;
 *             Acknowledge closes it, Follow up sends a message filed under it
 *   a card    opened: every message of his (pictures too), Split out on each when it holds more
 *             than one (a merge the node got wrong)
 *   Closed    the acknowledged and dropped ones, Reopen on each
 */
import { useMemo, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { userStateOf } from '@open-walnut/org-tree';
import { USER_STATE_LABELS } from '@open-walnut/user-status';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { AnswerBox } from '@/components/common/AnswerBox';
import { timeAgo } from '@/utils/time';
import type { OrgThread, OrgThreadMessage, OrgThreadState } from '@/api/org-threads';
import type { OrgThreadsState } from './useOrgThreads';
import '@/styles/org-threads.css';

/** A task's live status dot, the colours of the Task view's tabs (OrgTaskRail TAB_DOT). */
const TASK_DOT: Record<string, string> = {
  needs: 'var(--error, #FF3B30)', working: 'var(--success, #34C759)', waiting: 'var(--fg-muted, #86868B)', done: 'var(--accent, #0A84FF)',
};
/** A thread's state in words: the task-state names where they mean the same (USER_STATE_LABELS). */
const STATE_LABEL: Record<OrgThreadState, string> = {
  new: 'New', working: USER_STATE_LABELS.working, needs: USER_STATE_LABELS.needs, answered: 'Answered',
};
const STATE_DOT: Record<OrgThreadState, string> = {
  new: 'var(--accent, #0A84FF)', working: 'var(--success, #34C759)', needs: 'var(--error, #FF3B30)', answered: 'var(--fg-muted, #86868B)',
};

interface Props {
  name: string;
  state: OrgThreadsState;
  tasks: readonly Task[];
  onOpenTask: (id: string) => void;
  /** Send a message filed under this thread; null when the node has no chat yet. */
  onFollowUp: ((threadId: string, text: string) => Promise<boolean>) | null;
  now: number;
}

function Markdown({ text, className, testId }: { text: string; className?: string; testId?: string }) {
  const html = useMemo(() => ({ __html: renderMarkdownWithRefs(text) }), [text]);
  return <div className={`markdown-body ${className ?? ''}`} data-testid={testId} dangerouslySetInnerHTML={html} />;
}

function closedWords(t: OrgThread, now: number): string {
  const c = t.closed!;
  const who = c.by === 'human' ? '' : ' by the agent';
  return `${c.how === 'acked' ? 'Acknowledged' : 'Dropped'}${who} ${timeAgo(c.at, { now })}`;
}

function messageText(m: OrgThreadMessage): string {
  // Pictures render as the chat renders them: a path on its own line becomes the image.
  return [m.text, ...(m.images ?? [])].filter(Boolean).join('\n\n');
}

function TaskChips({ ids, tasks, onOpenTask }: { ids: readonly string[]; tasks: readonly Task[]; onOpenTask: (id: string) => void }) {
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t] as const)), [tasks]);
  return (
    <div className="org-thread-tasks" data-testid="org-thread-tasks">
      {ids.map((id) => {
        const t = byId.get(id);
        const state = t ? userStateOf(t) : null;
        return (
          <button key={id} type="button" className="org-thread-task" data-testid="org-thread-task" data-task-id={id} onClick={() => onOpenTask(id)} title={t?.title ?? id}>
            {state && <i style={{ background: TASK_DOT[state] }} />}
            <span>{t?.title ?? id}</span>
          </button>
        );
      })}
    </div>
  );
}

function FollowUp({ onSend, onDone }: { onSend: (text: string) => Promise<boolean>; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const go = async () => {
    const words = text.trim();
    if (!words || busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await onSend(words);
    setBusy(false);
    if (ok) { setText(''); onDone(); } else setFailed(true);
  };
  return (
    <div className="org-thread-follow" data-testid="org-thread-follow">
      {/* Walnut's answer box (common/AnswerBox.tsx): grows with the words, no grip, the mic inside. */}
      <AnswerBox
        autoFocus
        value={text}
        minRows={2}
        placeholder="Follow up on this request"
        testId="org-thread-follow-input"
        onChange={setText}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void go(); }
          if (e.key === 'Escape') onDone();
        }}
      />
      <div className="org-thread-follow-row">
        {failed && <span className="org-thread-error" data-testid="org-thread-follow-failed">Not sent. Your words are still here.</span>}
        <button type="button" className="btn btn-sm" onClick={onDone}>Cancel</button>
        <button type="button" className="btn btn-sm btn-primary" data-testid="org-thread-follow-send" disabled={!text.trim() || busy} onClick={() => void go()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function ThreadCard({ t, all, tasks, onOpenTask, state, onFollowUp, now }: {
  t: OrgThread; all: readonly OrgThread[]; tasks: readonly Task[]; onOpenTask: (id: string) => void;
  state: OrgThreadsState; onFollowUp: Props['onFollowUp']; now: number;
}) {
  const [open, setOpen] = useState(false);
  const [following, setFollowing] = useState(false);
  const closed = !!t.closed;
  const pictures = t.messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
  const follows = t.follows ? all.find((x) => x.id === t.follows) : undefined;
  const last = t.messages[t.messages.length - 1];
  return (
    <li className={`org-thread${closed ? ' is-closed' : ''}${open ? ' is-open' : ''}`} data-testid="org-thread" data-thread-id={t.id} data-state={closed ? 'closed' : t.state}>
      <button type="button" className="org-thread-head" aria-expanded={open} data-testid="org-thread-head" onClick={() => setOpen(!open)}>
        <span className="org-thread-state" data-testid="org-thread-state">
          <i style={{ background: closed ? 'var(--fg-muted, #86868B)' : STATE_DOT[t.state] }} />
          {closed ? (t.closed!.how === 'acked' ? 'Done' : 'Dropped') : STATE_LABEL[t.state]}
        </span>
        <span className="org-thread-title" data-testid="org-thread-title">{t.title}</span>
        <span className="org-thread-meta org-muted">
          {t.messages.length > 1 && <span data-testid="org-thread-count">{t.messages.length} messages · </span>}
          {pictures > 0 && <span>{pictures} {pictures === 1 ? 'picture' : 'pictures'} · </span>}
          {timeAgo(last?.at ?? t.updatedAt, { now })}
          <span className="org-thread-chevron" aria-hidden="true">{open ? ' ▾' : ' ▸'}</span>
        </span>
      </button>
      {follows && <p className="org-thread-follows org-muted">Asks again about “{follows.title}”</p>}
      {t.ask && <p className="org-thread-ask" data-testid="org-thread-ask">{t.ask}</p>}
      {t.reply && <Markdown text={t.reply} className="org-thread-reply" testId="org-thread-reply" />}
      {!!t.tasks?.length && <TaskChips ids={t.tasks} tasks={tasks} onOpenTask={onOpenTask} />}
      {open && (
        <ol className="org-thread-messages" data-testid="org-thread-messages">
          {t.messages.map((m) => (
            <li key={m.id} className="org-thread-message" data-testid="org-thread-message" data-message-id={m.id}>
              <div className="org-thread-message-head org-muted">
                <span>{timeAgo(m.at, { now })}{m.via === 'follow-up' ? ' · follow-up' : m.via === 'letter' ? ` · answering “${m.about ?? 'a letter'}”` : ''}</span>
                {t.messages.length > 1 && !closed && (
                  <button type="button" className="org-thread-link" data-testid="org-thread-split" title="This message is about something else: make it its own thread" onClick={() => void state.split(t.id, m.id)}>
                    Split out
                  </button>
                )}
              </div>
              <Markdown text={messageText(m)} className="org-thread-words" />
            </li>
          ))}
        </ol>
      )}
      {following && onFollowUp ? (
        <FollowUp onSend={(text) => onFollowUp(t.id, text)} onDone={() => setFollowing(false)} />
      ) : (
        <div className="org-thread-actions">
          {closed ? (<>
            <span className="org-muted org-thread-closed" data-testid="org-thread-closed">{closedWords(t, now)}</span>
            <button type="button" className="btn btn-sm" data-testid="org-thread-reopen" onClick={() => void state.update(t.id, { reopen: true })}>Reopen</button>
          </>) : (<>
            <button type="button" className="btn btn-sm btn-primary" data-testid="org-thread-ack" onClick={() => void state.update(t.id, { close: 'acked' })}>Acknowledge</button>
            {onFollowUp && <button type="button" className="btn btn-sm" data-testid="org-thread-follow-open" onClick={() => setFollowing(true)}>Follow up</button>}
          </>)}
        </div>
      )}
    </li>
  );
}

export function OrgThreads({ name, state, tasks, onOpenTask, onFollowUp, now }: Props) {
  const [show, setShow] = useState<'open' | 'closed'>('open');
  const all = state.threads;
  const open = useMemo(() => (all ?? []).filter((t) => !t.closed), [all]);
  const closed = useMemo(() => (all ?? []).filter((t) => !!t.closed), [all]);
  const list = show === 'open' ? open : closed;
  return (
    <div className="org-threads" data-testid="org-threads">
      <div className="org-threads-head">
        <div className="org-threads-pick" role="tablist" aria-label="Open or closed threads">
          <button type="button" role="tab" aria-selected={show === 'open'} className={show === 'open' ? 'is-on' : ''} data-testid="org-threads-open" onClick={() => setShow('open')}>
            Open <span className="org-task-tab-count">{open.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={show === 'closed'} className={show === 'closed' ? 'is-on' : ''} data-testid="org-threads-closed" onClick={() => setShow('closed')}>
            Closed <span className="org-task-tab-count">{closed.length}</span>
          </button>
        </div>
      </div>
      {state.error && <p className="org-thread-error" data-testid="org-threads-error">{state.error}</p>}
      {all === null && !state.error && <p className="org-muted org-threads-empty" aria-busy="true">Loading…</p>}
      {all !== null && !list.length && (
        <p className="org-muted org-threads-empty" data-testid="org-threads-empty">
          {show === 'open' ? `Nothing open. Each request you send ${name} becomes a thread here; asks about the same thing stay in one thread.` : 'Nothing closed yet.'}
        </p>
      )}
      {!!list.length && (
        <ul className="org-thread-list" data-testid="org-thread-list" data-show={show}>
          {list.map((t) => (
            <ThreadCard key={t.id} t={t} all={all ?? []} tasks={tasks} onOpenTask={onOpenTask} state={state} onFollowUp={onFollowUp} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}
