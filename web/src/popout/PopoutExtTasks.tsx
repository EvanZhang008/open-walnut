/**
 * The Tasks tab of the Walnut browser side panel (packages/browser-extension/src/sidepanel.ts
 * frames it at `/popout?view=ext-tasks`): what needs the person and their Focus tasks, as on
 * Home, with each one's status; a line back to a task's session; and the page the person is on
 * saved as a task for later. The same Walnut data and rules as everywhere (a test run's writes
 * stay a test run's).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { createTask } from '@/api/tasks';
import { wsClient } from '@/api/ws';
import { TasksProvider, useTasksContext } from '@/contexts/TasksContext';
import { NotificationProvider } from '@/contexts/notifications';
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
  const [saving, setSaving] = useState<'' | 'busy' | 'done' | 'error'>('');
  const [saved, setSaved] = useState<{ id: string; title: string } | null>(null);
  const [open, setOpen] = useState('');
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
  useEffect(() => { setSaving(''); }, [current?.url]);

  const savePage = useCallback(async () => {
    if (!current) return;
    setSaving('busy');
    try {
      const task = await createTask(pageTaskInput(current));
      setSaved({ id: task.id, title: task.title });
      setSaving('done');
      log.info('ext-tasks', 'page saved as a task', { taskId: task.id, host: hostOf(current.url) });
    } catch (err) {
      setSaving('error');
      log.warn('ext-tasks', 'saving the page as a task failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }, [current]);

  return <div className="ext-panel ext-tasks" data-testid="ext-tasks">
    <div className="ext-tasks-save">
      <button type="button" className="btn btn-sm" data-testid="ext-tasks-save-page" disabled={!current || saving === 'busy'} onClick={() => void savePage()}
        title={current ? `A task for later: ${current.title ?? hostOf(current.url)}` : 'Open a web page to save it as a task'}>
        {saving === 'busy' ? 'Saving…' : 'Save this page as a task'}
      </button>
      {saving === 'done' && saved && <span className="ext-tasks-note" data-testid="ext-tasks-saved" data-task-id={saved.id}>Saved: {saved.title}</span>}
      {saving === 'error' && <span className="ext-tasks-note ext-panel-error" role="alert">Could not save the page.</span>}
    </div>
    <div className="ext-tasks-lists">
      <Section title="Needs you" testid="ext-tasks-needs" rows={lists.needs} empty="Nothing needs you." open={open} onOpen={setOpen} />
      <Section title="Focus" testid="ext-tasks-focus" rows={lists.focus} empty="No Focus tasks." open={open} onOpen={setOpen} />
    </div>
  </div>;
}

function Section(p: { title: string; testid: string; rows: ExtTaskRow[]; empty: string; open: string; onOpen: (id: string) => void }) {
  return <section className="ext-tasks-section" data-testid={p.testid}>
    <h3 className="ext-tasks-heading">{p.title} <span className="ext-tasks-count">{p.rows.length}</span></h3>
    {p.rows.length === 0 && <p className="ext-tasks-empty">{p.empty}</p>}
    {p.rows.map((r) => <TaskRow key={r.task.id} row={r} open={p.open === r.task.id} onToggle={() => p.onOpen(p.open === r.task.id ? '' : r.task.id)} />)}
  </section>;
}

function TaskRow({ row, open, onToggle }: { row: ExtTaskRow; open: boolean; onToggle: () => void }) {
  const { task } = row;
  return <div className={`ext-task${open ? ' is-open' : ''}`} data-testid="ext-task" data-task-id={task.id} data-state={row.state}>
    <button type="button" className="ext-task-head" onClick={onToggle} aria-expanded={open}>
      <span className={`ext-task-dot state-${row.state}`} aria-hidden="true" />
      <span className="ext-task-text">
        <span className="ext-task-title">{task.title}</span>
        <span className="ext-task-line">{row.line ? `${row.label} · ${row.line}` : row.label}</span>
      </span>
    </button>
    {open && <TaskReply task={task} />}
  </div>;
}

function TaskReply({ task }: { task: Task }) {
  const sessionId = resolveTaskSessionId(task);
  const [text, setText] = useState('');
  const [state, setState] = useState<'' | 'sending' | 'sent' | 'error'>('');
  const send = async () => {
    const message = text.trim();
    if (!message || !sessionId) return;
    setState('sending');
    try {
      await wsClient.sendRpc('session:send', { sessionId, message });
      setText('');
      setState('sent');
    } catch (err) {
      setState('error');
      log.warn('ext-tasks', 'reply not sent', { taskId: task.id, sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  };
  const openInWalnut = () => window.open(`${window.location.origin}${taskPath(task.id)}`, '_blank', 'noopener');
  return <div className="ext-task-reply">
    {sessionId
      ? <>
        <textarea className="ext-task-input" data-testid="ext-task-input" rows={2} value={text} placeholder={`Reply to ${task.title.slice(0, 40)}`}
          onChange={(e) => { setText(e.target.value); if (state === 'sent') setState(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <div className="ext-task-actions">
          <button type="button" className="btn btn-sm btn-primary" data-testid="ext-task-send" disabled={!text.trim() || state === 'sending'} onClick={() => void send()}>
            {state === 'sending' ? 'Sending…' : 'Send'}
          </button>
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
