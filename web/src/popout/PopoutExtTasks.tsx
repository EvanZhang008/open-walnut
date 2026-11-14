/**
 * The Tasks tab of the Walnut browser side panel (packages/browser-extension/src/sidepanel.ts
 * frames it at `/popout?view=ext-tasks`): the person's Focus tasks and what needs them, as on
 * Home, with each one's status; a line back to a task's session, under what the task last said;
 * and the page the person is on saved as a task for later. The same Walnut data and rules as
 * everywhere (a test run's writes stay a test run's).
 *
 * Opened again, the tab shows the lists it showed last time while the tasks load (kept in this
 * browser, ext-tasks-model.ts), and never an empty list it does not know to be empty.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { Task } from '@open-walnut/core';
import type { Approval } from '@/api/approvals';
import { apiPatch } from '@/api/client';
import { buildImageRefsPayload } from '@/api/image-upload';
import { createTask } from '@/api/tasks';
import { sendSessionMessage } from '@/api/session-send';
import { ApprovalButtons, requesterText } from '@/components/approvals/ApprovalPrompts';
import { useApprovals } from '@/components/approvals/approvals-store';
import { AgentText } from '@/components/common/AgentText';
import { useHostDisplayLabel } from '@/hooks/useHostDisplayLabel';
import { AnswerBox } from '@/components/common/AnswerBox';
import { useImageAttachments } from '@/components/common/image-attachments';
import { TasksProvider, useTasksContext } from '@/contexts/TasksContext';
import { NotificationProvider } from '@/contexts/notifications';
import { useDraft } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { log } from '@/utils/log';
import { resolveTaskSessionId } from '@/utils/session-status';
import { taskPath } from '@/utils/task-path';
import { fromParent, toParent } from './ext-frame';
import { AlikeLine, ApprovalLines, alikeLines, useExtApprovals } from './ExtApprovals';
import { useVaultChangedRelay } from './vault-changed-relay';
import { useFrameTheme } from './ext-theme';
import { hostOf, panelAskTitle, type PanelPage } from './ext-panel-model';
import { EXT_TASKS_MAX, askedSourcedOf, extTaskLists, lastWordsKnown, inFocus, keepTaskLists, keptTaskLists, pageTaskInput, rowLine, type ExtTaskRow } from './ext-tasks-model';
import { SHOWN_AFTER_PAINT_MAX_MS, SNAP_ROWS, type TasksSnap } from './ext-snapshot';
import { latestReplies } from './ask-words-read';
import { useAskWords } from './useExtAsks';
import type { AgentTextSource } from '@/utils/agent-text-source';
import { TaskOpenerContext } from '@/hooks/useOpenTask';
import './ext-panel.css';

export function PopoutExtTasks() {
  return <TasksProvider><NotificationProvider><ExtTasks /></NotificationProvider></TasksProvider>;
}

const openTask = (id: string) => window.open(`${window.location.origin}${taskPath(id)}`, '_blank', 'noopener');

/** Put a task in the person's Focus (the board's Focus tier; one store write for pin and tier). */
const addToFocus = (id: string) => apiPatch(`/api/tasks/${id}`, { pinned: true, focus_tier: 'focus' });

function ExtTasks() {
  const { tasks, loading } = useTasksContext();
  useFrameTheme();
  const [current, setCurrent] = useState<PanelPage | null>(null);
  /** The save of the page the person is on now; a save of a page they left is never shown here. */
  const [save, setSave] = useState<{ url: string; state: 'busy' | 'done' | 'error'; id?: string; title?: string } | null>(null);
  const [open, setOpen] = useState('');
  /** Each reply's send, by task: a row moving between sections keeps it (the words are a draft). */
  const [replies, setReplies] = useState<Record<string, ReplyState>>({});
  const approvals = useExtApprovals();
  const alike = useMemo(() => alikeLines(approvals), [approvals]);
  useVaultChangedRelay();
  /** Tasks answered from this panel: their rows stay put, with their new state (ext-tasks-model.ts). */
  const answered = useMemo(() => new Set(Object.entries(replies).filter(([, r]) => r.state === 'sent').map(([id]) => id)), [replies]);
  /** Moves when a row's latest words were read (useAskWords), so its line says them. */
  const [wordsRev, setWordsRev] = useState(0);
  const fresh = useMemo(() => (loading ? null : extTaskLists(tasks, answered)), [tasks, loading, answered, wordsRev]); // eslint-disable-line react-hooks/exhaustive-deps
  // Each row says what its task last said, read as the drawer reads its asks' (review round 4, #2).
  // In the order the view draws them (Focus on top), every row of both lists: a full Needs you list
  // left Focus's rows unread (review round 4, L1).
  const wordRows = useMemo(() => (fresh ? [...fresh.focus, ...fresh.needs].map((r) => ({ id: r.task.id, task: r.task })) : []), [fresh]);
  useAskWords(wordRows, !!fresh, () => setWordsRev((n) => n + 1), 2 * EXT_TASKS_MAX);
  // The lists of the last open, read once: shown only until the real ones land.
  const [kept] = useState(() => keptTaskLists());
  useEffect(() => { if (fresh) keepTaskLists(fresh); }, [fresh]);
  const lists = fresh ?? kept;
  // The panel page draws the lists of last time while this view starts (ext-snapshot.ts); once
  // this view shows its own, that drawing goes.
  const shown = !!lists;
  // Said once the lists have painted, not on the commit: the extension page takes its drawing away
  // on this word, and before the paint the frame still shows its last painted frame.
  useEffect(() => {
    if (!shown) return;
    let sent = false;
    const send = () => { if (!sent) { sent = true; toParent({ type: 'shown' }); } };
    requestAnimationFrame(() => requestAnimationFrame(send));
    // A frame the browser does not draw runs no animation frames.
    setTimeout(send, SHOWN_AFTER_PAINT_MAX_MS);
  }, [shown]);
  useEffect(() => {
    if (!fresh) return;
    const rowsOf = (rs: ExtTaskRow[], section: 'focus' | 'needs') => rs.slice(0, SNAP_ROWS).map((r) => ({ title: taskTitleOf(r.task), line: rowLine(r, section), state: r.state }));
    const snap: TasksSnap = { sections: [{ title: 'Focus', rows: rowsOf(fresh.focus, 'focus') }, { title: 'Needs you', rows: rowsOf(fresh.needs, 'needs') }] };
    toParent({ type: 'snapshot', view: 'tasks', snap, counts: [fresh.focus.length, fresh.needs.length] });
  }, [fresh]);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = fromParent(e);
      if (m?.type === 'context') setCurrent(m.page);
    };
    window.addEventListener('message', on);
    toParent({ type: 'ready' });
    return () => window.removeEventListener('message', on);
  }, []);
  const saving = save && save.url === current?.url ? save : null;

  const savePage = useCallback(async () => {
    if (!current) return;
    const url = current.url;
    setSave({ url, state: 'busy' });
    try {
      const task = await createTask(pageTaskInput(current));
      log.info('ext-tasks', 'page saved as a task', { taskId: task.id, host: hostOf(url) });
      setSave((s) => (s?.url === url ? { url, state: 'done', id: task.id, title: task.title } : s));
    } catch (err) {
      log.warn('ext-tasks', 'saving the page as a task failed', { error: err instanceof Error ? err.message : String(err) });
      setSave((s) => (s?.url === url ? { url, state: 'error' } : s));
    }
  }, [current]);

  return <div className="ext-panel ext-tasks" data-testid="ext-tasks" data-lists={fresh ? 'fresh' : kept ? 'kept' : 'loading'}>
    <div className="ext-tasks-save">
      <button type="button" className="btn btn-sm" data-testid="ext-tasks-save-page" disabled={!current || saving?.state === 'busy' || saving?.state === 'done'} onClick={() => void savePage()}
        title={current ? `A task for later: ${current.title ?? hostOf(current.url)}` : 'Open a web page to save it as a task'}>
        {saving?.state === 'busy' ? 'Saving…' : saving?.state === 'done' ? 'Saved as a task' : 'Save this page as a task'}
      </button>
      {!current && <span className="ext-tasks-note ext-tasks-save-why" data-testid="ext-tasks-save-why">Open a web page to save it as a task.</span>}
      {saving?.state === 'done' && saving.id && (
        <span className="ext-tasks-note" data-testid="ext-tasks-saved" data-task-id={saving.id}>
          Saved:{' '}
          <a className="ext-panel-link" data-testid="ext-tasks-saved-link" href={`${window.location.origin}${taskPath(saving.id)}`} target="_blank" rel="noopener noreferrer"
            title="Open the new task in Walnut">{saving.title}</a>
        </span>
      )}
      {saving?.state === 'error' && <span className="ext-tasks-note ext-panel-error" role="alert">Could not save the page.</span>}
    </div>
    {!lists ? (
      <p className="ext-tasks-loading muted" data-testid="ext-tasks-loading" role="status"><span className="spinner" /> Loading your tasks…</p>
    ) : (
      <div className="ext-tasks-lists">
        {!fresh && <p className="ext-tasks-updating" data-testid="ext-tasks-updating" role="status">Updating…</p>}
        {/* Focus first: it is a few tasks, and below a long Needs you list it was out of reach. */}
        <Section section="focus" title="Focus" testid="ext-tasks-focus" rows={lists.focus} empty={fresh ? 'No Focus tasks. Open a task below and add it to Focus.' : ''} open={open} onOpen={setOpen} replies={replies} setReplies={setReplies} />
        {/* Approvals first: a script or an agent's step in this browser is blocked on each. */}
        <Section section="needs" title="Needs you" testid="ext-tasks-needs" rows={lists.needs} extra={approvals.length} empty={fresh && approvals.length === 0 ? 'Nothing needs you.' : ''} open={open} onOpen={setOpen} replies={replies} setReplies={setReplies}>
          {approvals.map((a) => <PanelApproval key={a.id} a={a} alike={alike.get(a.id)} />)}
        </Section>
      </div>
    )}
  </div>;
}

/**
 * A row's title: an ask Walnut has not titled yet wears its agent's placeholder ("Ask Walnut"), so
 * it reads the question this browser asked it with, as the Ask view's rows do (review R2-7).
 */
function taskTitleOf(task: Task): string {
  return task.walnut_agent && task.project ? panelAskTitle(task, { project: task.project }).title : task.title;
}

type ReplyState = { state: '' | 'sending' | 'sent' | 'error'; words?: string };
type Replies = { replies: Record<string, ReplyState>; setReplies: Dispatch<SetStateAction<Record<string, ReplyState>>> };

/**
 * One approval, answered here. Home lists approvals as one line and answers them on its corner
 * card; the panel has no corner, so each request shows what it is, who asks, and its buttons.
 */
function PanelApproval({ a, alike }: { a: Approval; alike?: string }) {
  const s = useApprovals();
  const host = useHostDisplayLabel(a.requester.host);
  return <div className="ext-approval" data-testid="approval-row" data-approval-id={a.id}>
    <span className="ext-approval-what">{a.what}</span>
    <span className="ext-approval-who">{requesterText(a, host)}<AlikeLine line={alike} /></span>
    <ApprovalButtons a={a} s={s} />
    <ApprovalLines a={a} s={s} />
  </div>;
}

function Section(p: { section: 'focus' | 'needs'; title: string; testid: string; rows: ExtTaskRow[]; extra?: number; empty: string; open: string; onOpen: (id: string) => void; children?: ReactNode } & Replies) {
  return <section className="ext-tasks-section" data-testid={p.testid}>
    <h3 className="ext-tasks-heading">{p.title} <span className="ext-tasks-count">{p.rows.length + (p.extra ?? 0)}</span></h3>
    {p.children}
    {p.rows.length === 0 && p.empty && <p className="ext-tasks-empty">{p.empty}</p>}
    {p.rows.map((r) => <TaskRow key={r.task.id} section={p.section} row={r} open={p.open === r.task.id} onToggle={() => p.onOpen(p.open === r.task.id ? '' : r.task.id)} replies={p.replies} setReplies={p.setReplies} />)}
  </section>;
}

/** Add to Focus: in a row (on hover or focus) and in the opened task; a task in Focus says so. */
function FocusButton({ task, inRow }: { task: Task; inRow?: boolean }) {
  const [state, setState] = useState<'' | 'busy' | 'error'>('');
  if (inFocus(task)) return inRow ? <span className="ext-task-infocus" data-testid="ext-task-infocus">Focus</span> : null;
  const add = async () => {
    setState('busy');
    try { await addToFocus(task.id); setState(''); } catch (err) {
      setState('error');
      log.warn('ext-tasks', 'adding to Focus failed', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
    }
  };
  return <button type="button" className={`btn btn-sm ext-task-focus${inRow ? ' is-row' : ''}`} data-testid={inRow ? 'ext-task-focus-row' : 'ext-task-focus'}
    disabled={state === 'busy'} title="Add this task to your Focus" onClick={(e) => { e.stopPropagation(); void add(); }}>
    {state === 'busy' ? 'Adding…' : state === 'error' ? 'Try again' : 'Add to Focus'}
  </button>;
}

function TaskRow({ section, row, open, onToggle, replies, setReplies }: { section: 'focus' | 'needs'; row: ExtTaskRow; open: boolean; onToggle: () => void } & Replies) {
  const { task } = row;
  const reply = replies[task.id];
  const line = rowLine(row, section);
  return <div className={`ext-task${open ? ' is-open' : ''}`} data-testid="ext-task" data-task-id={task.id} data-state={row.state}>
    <div className="ext-task-headrow">
      <button type="button" className="ext-task-head" onClick={onToggle} aria-expanded={open}>
        <span className={`ext-task-dot state-${row.state}`} aria-hidden="true" />
        <span className="ext-task-text">
          <span className="ext-task-title">{taskTitleOf(task)}</span>
          {line && <span className="ext-task-line" data-testid="ext-task-line">{line}</span>}
          {reply?.state === 'sent' && reply.words && <span className="ext-task-replied" data-testid="ext-task-replied">You replied: {reply.words}</span>}
        </span>
      </button>
      {/* Under Focus the section says it; elsewhere the row offers Add to Focus. */}
      {section !== 'focus' && <FocusButton task={task} inRow />}
    </div>
    {open && <TaskReply task={task} line={row.line} rowState={row.state} reply={reply ?? { state: '' }} onChange={(r) => setReplies((all) => ({ ...all, [task.id]: { ...(all[task.id] ?? { state: '' }), ...r } }))} />}
  </div>;
}

/** The task's own last message, read when its row opens and its status carries none, with the
 *  session it was read from (its writer), so a later session change never relabels it. */
export function useLastMessage(sessionId: string | null, known: boolean): { text: string; sessionId: string } {
  const [said, setSaid] = useState({ text: '', sessionId: '' });
  useEffect(() => {
    if (!sessionId || known) return;
    const controller = new AbortController();
    let cancelled = false;
    latestReplies(sessionId, { tail: 8, signal: controller.signal })
      .then((r) => {
        if (cancelled) return;
        const last = [...(r ?? [])].reverse().find((m) => m.role === 'assistant' && (m.text ?? '').trim());
        // The whole message as written (a cut there split paths and links in half); the box
        // scrolls, and opens on its end, where a turn puts its question.
        setSaid({ text: (last?.text ?? '').trim(), sessionId });
      })
      .catch(() => { /* the status line is still there */ });
    return () => { cancelled = true; controller.abort(); };
  }, [sessionId, known]);
  return !known && said.sessionId === sessionId ? said : { text: '', sessionId: '' };
}

function TaskReply({ task, line, rowState, reply, onChange }: { task: Task; line: string; rowState: ExtTaskRow['state']; reply: ReplyState; onChange: (r: Partial<ReplyState>) => void }) {
  const sessionId = resolveTaskSessionId(task);
  const { state } = reply;
  const askedLines = askedSourcedOf(task, line, rowState);
  const asked = askedLines.map((l) => l.text);
  // Its last words are known already when the status line or the list carries them.
  const last = useLastMessage(sessionId, asked.length > 1 || lastWordsKnown(task));
  const lastMessage = last.text;
  const flat = (t: string) => t.replace(/\s+/g, ' ').trim();
  const withLast = !!lastMessage && !asked.some((a) => flat(a).includes(flat(lastMessage).slice(0, 60)));
  const said = withLast ? [...asked, lastMessage] : asked;
  // Each line's recorded writer; the fetched message's is the session it was read from.
  const saidSources: AgentTextSource[] = withLast ? [...askedLines.map((l) => l.source), { sessionId: last.sessionId }] : askedLines.map((l) => l.source);
  const saidRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (saidRef.current) saidRef.current.scrollTop = saidRef.current.scrollHeight; }, [lastMessage]);
  // The words wait in the draft store and pictures go with them, as in the chat.
  const draft = useDraft(sessionId ? draftKey('ext-task-reply', task.id) : null);
  const pictures = useImageAttachments();
  const send = async (words: string) => {
    const message = words.trim();
    const images = pictures.images;
    if ((!message && images.length === 0) || !sessionId || state === 'sending') return;
    onChange({ state: 'sending' });
    try {
      await sendSessionMessage({ sessionId, message, ...(await buildImageRefsPayload(images)) });
      draft.clear(draft.key, words);
      pictures.clear();
      onChange({ state: 'sent', words: message.length > 120 ? `${message.slice(0, 119)}…` : message });
    } catch (err) {
      onChange({ state: 'error' });
      log.warn('ext-tasks', 'reply not sent', { taskId: task.id, sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  };
  return <div className="ext-task-reply">
    {said.length > 0 && (
      <div className="ext-task-asked" data-testid="ext-task-asked" ref={saidRef}>
        {/* The task's ask and last message, agent text: a path, link, task or letter in it opens
            (a task in a new tab, as Open in Walnut does). */}
        <TaskOpenerContext.Provider value={openTask}>
          {said.map((s, i) => <AgentText key={i} compact className={i === said.length - 1 && s === lastMessage ? 'ext-task-said ext-task-last' : 'ext-task-said'} {...(saidSources[i] ?? { unknownSource: true })} text={s} />)}
        </TaskOpenerContext.Provider>
      </div>
    )}
    {sessionId
      ? <>
        {/* Walnut's answer box (common/AnswerBox.tsx): the mic inside, pictures, Enter sends (an input method's Enter does not). */}
        <AnswerBox value={draft.text} onChange={(t) => { draft.setText(t); if (state === 'sent' || state === 'error') onChange({ state: '' }); }}
          onSubmit={(t) => void send(t)} sendLabel="Send" sending={state === 'sending'} draftKey={draft.key}
          placeholder={`Reply to ${taskTitleOf(task).slice(0, 40)}`} minRows={2} testId="ext-task-input" sendTestId="ext-task-send"
          inputClassName="ext-task-input" pictures={pictures} />
        <div className="ext-task-actions">
          <button type="button" className="btn btn-sm" onClick={() => openTask(task.id)}>Open in Walnut</button>
          <FocusButton task={task} />
          {state === 'sent' && <span className="ext-tasks-note" data-testid="ext-task-sent">Sent</span>}
          {state === 'error' && <span className="ext-tasks-note ext-panel-error" role="alert">Not sent. Try again.</span>}
        </div>
      </>
      : <div className="ext-task-actions">
        <span className="ext-tasks-note">No conversation yet.</span>
        <button type="button" className="btn btn-sm" onClick={() => openTask(task.id)}>Open in Walnut</button>
        <FocusButton task={task} />
      </div>}
  </div>;
}
