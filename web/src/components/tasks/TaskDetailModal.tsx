/**
 * TaskDetailModal — full-screen reader for one task's detail.
 *
 * The home page used to render TaskDetailPane in a cramped split-pane inside the
 * narrow task panel (hard to read, squeezed the task list to half-width). This hosts
 * the SAME TaskDetailPane in a large centered overlay (≈90vw×90vh) instead — reusing
 * the app's modal infra (`.wf-modal*` CSS + useModalOverlay = Escape + ref-counted
 * scroll lock + portal-to-body), the same pattern as WorkflowTranscriptModal.
 *
 * Both entry points open this one modal: clicking a task in TodoPanel, and the
 * "Task detail" item in the Session panel kebab — they share MainPage's focusedTask
 * state, so there is exactly one full-screen task detail surface.
 *
 * Phone (spec 4.7 Task detail, C23, C58): the same modal is a phone layer
 * `task-detail:<id>` under the top bar (Back + the task's title), one column,
 * with an editable 16 px title and the phase choice (PhonePhaseSheet) on top.
 * Every UI close goes through the layer, so Back and the close button agree.
 */

import { useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@open-walnut/core';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { usePhoneOverlay } from '@/hooks/usePhoneOverlayHistory';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { TaskDetailPane } from './TaskDetailPane';
import { PhoneTaskDetailHead } from './PhoneTaskDetailHead';

export function TaskDetailModal({
  task, allTasks, onClose, onOpenSession, onOpenTriageForTask, onFocusChild,
}: {
  task: Task;
  allTasks?: Task[];
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenTriageForTask?: (taskId: string) => void;
  onFocusChild?: (task: Task) => void;
}) {
  const phone = usePhoneLayout();
  const afterCloseRef = useRef<(() => void) | null>(null);
  const layer = usePhoneOverlay({
    id: `task-detail:${task.id}`,
    kind: 'task-detail',
    open: true,
    bar: { title: task.title || 'Task' },
    onClose: () => {
      onClose();
      const next = afterCloseRef.current;
      afterCloseRef.current = null;
      if (next) setTimeout(next, 0);
    },
  });
  const close = layer.close;
  useModalOverlay(close);
  // Phone: a session opened from the detail replaces it (the session layer is
  // drawn below this one), once the detail's history entry is gone.
  const openSession = useCallback((sid: string) => {
    if (!onOpenSession) return;
    if (!phone) { onOpenSession(sid); return; }
    afterCloseRef.current = () => onOpenSession(sid);
    close();
  }, [close, onOpenSession, phone]);

  return createPortal(
    <div className={`wf-modal-overlay task-detail-modal-overlay${phone ? ' is-phone-layer' : ''}`} onClick={close}>
      {/* Reuse the wf-modal shell; the pane brings its own header (project +
          external link + close), so we don't add a second header row. */}
      <div className="wf-modal task-detail-modal" onClick={(e) => e.stopPropagation()}>
        {phone && <PhoneTaskDetailHead task={task} />}
        <TaskDetailPane
          task={task}
          allTasks={allTasks}
          onClose={close}
          onOpenSession={onOpenSession ? openSession : undefined}
          onOpenTriageForTask={onOpenTriageForTask}
          onFocusChild={onFocusChild}
        />
      </div>
    </div>,
    document.body,
  );
}
