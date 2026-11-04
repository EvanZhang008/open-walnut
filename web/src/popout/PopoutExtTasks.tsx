/**
 * The Tasks tab of the Walnut browser side panel (packages/browser-extension/src/sidepanel.ts
 * frames it at `/popout?view=ext-tasks`): what needs the person and their Focus tasks, as on
 * Home, with each one's status; a line back to a task's session; and the page the person is on
 * saved as a task for later. The same Walnut data and rules as everywhere (a test run's writes
 * stay a test run's).
 */
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { Task } from '@open-walnut/core';
import { buildImageRefsPayload } from '@/api/image-upload';
import { createTask } from '@/api/tasks';
import { wsClient } from '@/api/ws';
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
import { hostOf, type PanelPage } from './ext-panel-model';
import { extTaskLists, pageTaskInput, type ExtTaskRow } from './ext-tasks-model';
import './ext-panel.css';

export function PopoutExtTasks() {
  return <TasksProvider><NotificationProvider><ExtTasks /></NotificationProvider></TasksProvider>;
}

function ExtTasks() {
  const { tasks } = useTasksContext();
  const [current, setCurrent] = useState<PanelPage | null>(null);
  /** The save of the page the person is on now; a save of a page they left is never shown here. */
  const [save, setSave] = useState<{ url: string; state: 'busy' | 'done' | 'error'; id?: string; title?: string } | null>(null);
  const [open, setOpen] = useState('');
  /** Each reply's send, by task: a row moving between sections keeps it (the words are a draft). */
  const [replies, setReplies] = useState<Record<string, ReplyState>>({});
  const lists = useMemo(() => extTaskLists(tasks), [tasks]);

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

  return <div className="ext-panel ext-tasks" data-testid="ext-tasks">
    <div className="ext-tasks-save">
      <button type="button" className="btn btn-sm" data-testid="ext-tasks-save-page" disabled={!current || saving?.state === 'busy' || saving?.state === 'done'} onClick={() => void savePage()}
        title={current ? `A task for later: ${current.title ?? hostOf(current.url)}` : 'Open a web page to save it as a task'}>
        {saving?.state === 'busy' ? 'Saving…' : saving?.state === 'done' ? 'Saved as a task' : 'Save this page as a task'}
      </button>
      {saving?.state === 'done' && <span className="ext-tasks-note" data-testid="ext-tasks-saved" data-task-id={saving.id}>Saved: {saving.title}</span>}
      {saving?.state === 'error' && <span className="ext-tasks-note ext-panel-error" role="alert">Could not save the page.</span>}
    </div>
    <div className="ext-tasks-lists">
      <Section title="Needs you" testid="ext-tasks-needs" rows={lists.needs} empty="Nothing needs you." open={open} onOpen={setOpen} replies={replies} setReplies={setReplies} />
      <Section title="Focus" testid="ext-tasks-focus" rows={lists.focus} empty="No Focus tasks." open={open} onOpen={setOpen} replies={replies} setReplies={setReplies} />
    </div>
  </div>;
}

type ReplyState = { state: '' | 'sending' | 'sent' | 'error' };
type Replies = { replies: Record<string, ReplyState>; setReplies: Dispatch<SetStateAction<Record<string, ReplyState>>> };

function Section(p: { title: string; testid: string; rows: ExtTaskRow[]; empty: string; open: string; onOpen: (id: string) => void } & Replies) {
  return <section className="ext-tasks-section" data-testid={p.testid}>
    <h3 className="ext-tasks-heading">{p.title} <span className="ext-tasks-count">{p.rows.length}</span></h3>
    {p.rows.length === 0 && <p className="ext-tasks-empty">{p.empty}</p>}
    {p.rows.map((r) => <TaskRow key={r.task.id} row={r} open={p.open === r.task.id} onToggle={() => p.onOpen(p.open === r.task.id ? '' : r.task.id)} replies={p.replies} setReplies={p.setReplies} />)}
  </section>;
}

function TaskRow({ row, open, onToggle, replies, setReplies }: { row: ExtTaskRow; open: boolean; onToggle: () => void } & Replies) {
  const { task } = row;
  return <div className={`ext-task${open ? ' is-open' : ''}`} data-testid="ext-task" data-task-id={task.id} data-state={row.state}>
    <button type="button" className="ext-task-head" onClick={onToggle} aria-expanded={open}>
      <span className={`ext-task-dot state-${row.state}`} aria-hidden="true" />
      <span className="ext-task-text">
        <span className="ext-task-title">{task.title}</span>
        <span className="ext-task-line">{row.line ? `${row.label} · ${row.line}` : row.label}</span>
      </span>
    </button>
    {open && <TaskReply task={task} reply={replies[task.id] ?? { state: '' }} onChange={(r) => setReplies((all) => ({ ...all, [task.id]: { ...(all[task.id] ?? { state: '' }), ...r } }))} />}
  </div>;
}

function TaskReply({ task, reply, onChange }: { task: Task; reply: ReplyState; onChange: (r: Partial<ReplyState>) => void }) {
  const sessionId = resolveTaskSessionId(task);
  const { state } = reply;
  // The words wait in the draft store and pictures go with them, as in the chat.
  const draft = useDraft(sessionId ? draftKey('ext-task-reply', task.id) : null);
  const pictures = useImageAttachments();
  const send = async (words: string) => {
    const message = words.trim();
    const images = pictures.images;
    if ((!message && images.length === 0) || !sessionId || state === 'sending') return;
    onChange({ state: 'sending' });
    try {
      await wsClient.sendRpc('session:send', { sessionId, message, ...(await buildImageRefsPayload(images)) });
      draft.clear(draft.key, words);
      pictures.clear();
      onChange({ state: 'sent' });
    } catch (err) {
      onChange({ state: 'error' });
      log.warn('ext-tasks', 'reply not sent', { taskId: task.id, sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  };
  const openInWalnut = () => window.open(`${window.location.origin}${taskPath(task.id)}`, '_blank', 'noopener');
  return <div className="ext-task-reply">
    {sessionId
      ? <>
        {/* Walnut's answer box (common/AnswerBox.tsx): the mic inside, pictures, Enter sends (an input method's Enter does not). */}
        <AnswerBox value={draft.text} onChange={(t) => { draft.setText(t); if (state === 'sent' || state === 'error') onChange({ state: '' }); }}
          onSubmit={(t) => void send(t)} sendLabel="Send" sending={state === 'sending'} draftKey={draft.key}
          placeholder={`Reply to ${task.title.slice(0, 40)}`} minRows={2} testId="ext-task-input" sendTestId="ext-task-send"
          inputClassName="ext-task-input" pictures={pictures} />
        <div className="ext-task-actions">
          <button type="button" className="btn btn-sm" onClick={openInWalnut}>Open in Walnut</button>
          {state === 'sent' && <span className="ext-tasks-note" data-testid="ext-task-sent">Sent</span>}
          {state === 'error' && <span className="ext-tasks-note ext-panel-error" role="alert">Not sent. Try again.</span>}
        </div>
      </>
      : <div className="ext-task-actions">
        <span className="ext-tasks-note">No conversation yet.</span>
        <button type="button" className="btn btn-sm" onClick={openInWalnut}>Open in Walnut</button>
      </div>}
  </div>;
}
