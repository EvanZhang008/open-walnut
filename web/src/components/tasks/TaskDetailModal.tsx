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
 */

import { createPortal } from 'react-dom';
import type { Task } from '@open-walnut/core';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { TaskDetailPane } from './TodoPanel';

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
  useModalOverlay(onClose);

  return createPortal(
    <div className="wf-modal-overlay" onClick={onClose}>
      {/* Reuse the wf-modal shell; the pane brings its own header (category +
          external link + close), so we don't add a second header row. */}
      <div className="wf-modal task-detail-modal" onClick={(e) => e.stopPropagation()}>
        <TaskDetailPane
          task={task}
          allTasks={allTasks}
          onClose={onClose}
          onOpenSession={onOpenSession}
          onOpenTriageForTask={onOpenTriageForTask}
          onFocusChild={onFocusChild}
        />
      </div>
    </div>,
    document.body,
  );
}
