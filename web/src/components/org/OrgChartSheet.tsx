/**
 * The org chart: who works on what, one screen.
 *
 *   Main (the main agent)
 *   ├ one column per project: who Main talks to there (its lead, or its one task)
 *   │   └ the project's tasks, their workers indented below
 *
 * Built from the task store with the server's own function (@open-walnut/org-tree),
 * so it always agrees with what the main agent reads. Click a card to talk to that
 * task; drag a card onto another to make it that task's worker, or onto a column
 * to make it one of that project's tasks. A drop writes the ordinary board fields.
 */

import { useCallback, useMemo, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import type { TaskPhase } from '@open-walnut/core';
import { buildOrgTree, type OrgProjectNode, type OrgTaskNode } from '@open-walnut/org-tree';
import { useTasksContext } from '@/contexts/TasksContext';
import { resolveOrgContact } from '@/api/org';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { log } from '@/utils/log';
import { contactLine, countsLine, dropAction, indexOrg, type OrgDropTarget } from './org-chart-model';
import '@/styles/org-chart.css';

interface Props {
  onClose: () => void;
  /** Talk to a task: its session, or a composer bound to it. 'main' = the main agent. */
  onChat: (taskId: string | 'main') => void;
}

const DRAG_TYPE = 'application/x-walnut-org-task';
const PHASE_LABEL: Record<TaskPhase, string> = {
  NEED_ACTION: 'Waiting on you', IN_PROGRESS: 'Running', WAITING: 'Parked', TODO: 'To do', COMPLETE: 'Done',
};

export function OrgChartSheet({ onClose, onChat }: Props) {
  const { tasks, reparentTask, moveTask, showOperationError } = useTasksContext();
  const tree = useMemo(() => buildOrgTree(tasks), [tasks]);
  const index = useMemo(() => indexOrg(tree), [tree]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [busyProject, setBusyProject] = useState<string | null>(null);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  useModalOverlay(onClose);
  useDialogFocus(panel, 'Org chart');

  const open = useCallback((taskId: string | 'main') => { onClose(); onChat(taskId); }, [onChat, onClose]);

  const chatProject = useCallback(async (p: OrgProjectNode) => {
    if (p.contactId) { open(p.contactId); return; }
    setBusyProject(p.project);
    try {
      const answer = await resolveOrgContact(p.project || 'Inbox');
      log.info('org-chart', 'project contact resolved', { project: p.project, taskId: answer.task.id, kind: answer.kind });
      open(answer.task.id);
    } catch (err) {
      showOperationError(`Could not reach ${p.project || 'the Inbox'}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyProject(null);
    }
  }, [open, showOperationError]);

  const drop = useCallback((target: OrgDropTarget, id: string | null) => {
    setOverKey(null);
    setDragId(null);
    if (!id) return;
    const action = dropAction(index, id, target);
    if (!action) return;
    log.info('org-chart', 'drop', { taskId: id, action: action.kind, ...(action.kind === 'reparent' ? { parentId: action.parentId } : { project: action.project }) });
    if (action.kind === 'reparent') { reparentTask(action.taskId, action.parentId); return; }
    if (action.moveProject) moveTask(action.taskId, action.project);
    if (action.clearParent) reparentTask(action.taskId, null);
  }, [index, moveTask, reparentTask]);

  const dropProps = (target: OrgDropTarget, key: string) => ({
    onDragOver: (e: DragEvent) => {
      // Over a card, the card decides: a refused card (itself, its own worker, its
      // parent) must not let the column under it light up for a drop that won't happen.
      if (target.kind === 'task') e.stopPropagation();
      if (!dragId || !dropAction(index, dragId, target)) {
        if (target.kind === 'task' && overKey) setOverKey(null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (overKey !== key) setOverKey(key);
    },
    onDragLeave: (e: DragEvent) => {
      if (overKey === key && !(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) setOverKey(null);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      drop(target, e.dataTransfer.getData(DRAG_TYPE) || dragId);
    },
  });

  const card = (n: OrgTaskNode, depth: number) => {
    const key = `task:${n.id}`;
    return (
      <li key={n.id} className="org-card-item">
        <div
          className={`org-card${overKey === key ? ' is-drop' : ''}${dragId === n.id ? ' is-dragging' : ''}`}
          data-testid="org-card"
          data-task-id={n.id}
          data-phase={n.phase}
          draggable
          role="button"
          tabIndex={0}
          title={`${n.title}\n${PHASE_LABEL[n.phase]}. Click to talk to it; drag onto another task to make it that task's worker.`}
          onClick={() => open(n.id)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(n.id); } }}
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData(DRAG_TYPE, n.id);
            e.dataTransfer.setData('text/plain', n.title);
            e.dataTransfer.effectAllowed = 'move';
            setDragId(n.id);
          }}
          onDragEnd={() => { setDragId(null); setOverKey(null); }}
          {...dropProps({ kind: 'task', id: n.id }, key)}
        >
          <span className={`org-dot org-dot-${n.phase.toLowerCase()}`} aria-label={PHASE_LABEL[n.phase]} />
          <span className="org-card-title">{n.title}</span>
          {n.workers.length > 0 && <span className="org-card-meta">{n.workers.length}</span>}
        </div>
        {n.workers.length > 0 && depth < 3 && (
          <ul className="org-workers" data-testid="org-workers">{n.workers.map((w) => card(w, depth + 1))}</ul>
        )}
      </li>
    );
  };

  const sheet = (
    <div
      className="org-sheet-layer"
      data-testid="org-chart"
      // Not part of the board: a pointer here must never start the home page's drag sensors.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div ref={setPanel} className="org-sheet" role="dialog" aria-modal="true" aria-label="Org chart" tabIndex={-1}>
        <header className="org-sheet-head">
          <div>
            <h2 className="org-sheet-title">Org chart</h2>
            <p className="org-sheet-hint">Click a task to talk to it. Drag a task onto another to make it its worker, or onto a project to move it there.</p>
          </div>
          <button type="button" className="task-action-btn org-sheet-close" onClick={onClose} aria-label="Close the org chart" title="Close">&times;</button>
        </header>

        <div className="org-main" data-testid="org-main">
          <div className="org-main-card">
            <span className="org-main-name">Main</span>
            <span className="org-main-sub">Your main agent · {countsLine(tree.counts)}</span>
          </div>
          <button type="button" className="btn btn-sm btn-primary" data-testid="org-main-chat" onClick={() => open('main')}>Chat</button>
        </div>

        {tree.projects.length === 0 ? (
          <p className="org-empty" data-testid="org-empty">No open work yet. Ask Main to start something.</p>
        ) : (
          <div className="org-columns" data-testid="org-columns">
            {tree.projects.map((p) => {
              const key = `project:${p.project}`;
              const canChat = !!p.contactId || p.needsLead;
              return (
                <section
                  key={key}
                  className={`org-column${overKey === key ? ' is-drop' : ''}`}
                  data-testid="org-column"
                  data-project={p.project}
                  {...dropProps({ kind: 'project', project: p.project }, key)}
                >
                  <div className="org-column-head">
                    <div className="org-column-name">{p.project || 'Inbox'}</div>
                    <div className="org-column-counts">{countsLine(p.counts)}</div>
                    <div className="org-column-contact" data-testid="org-contact">
                      <span>{contactLine(p)}</span>
                      {canChat && (
                        <button
                          type="button"
                          className="btn btn-sm org-column-chat"
                          data-testid="org-project-chat"
                          disabled={busyProject === p.project}
                          onClick={() => { void chatProject(p); }}
                          title={p.lead || p.needsLead ? `Talk to the lead of ${p.project}` : 'Talk to this task'}
                        >
                          {busyProject === p.project ? '…' : 'Chat'}
                        </button>
                      )}
                    </div>
                  </div>
                  <ul className="org-teams">{p.teams.map((t) => card(t, 0))}</ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
  return createPortal(sheet, document.body);
}
