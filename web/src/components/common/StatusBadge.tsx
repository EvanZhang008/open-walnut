import type { ReactNode } from 'react';
import type { Task, TaskStatus, TaskPhase } from '@open-walnut/core';
import { PHASE_LABELS, taskStatusLabel } from '@/utils/session-status';
import { phaseIcon } from './Icons';

interface StatusBadgeProps {
  status: TaskStatus;
  phase?: TaskPhase;
  /** The task itself, when the caller holds it: the badge then reads its user status
   *  (taskStatusLabel), not its phase. */
  task?: Pick<Task, 'phase' | 'status' | 'user_status'> | null;
}

const phaseSymbols: Record<string, ReactNode> = {
  TODO: phaseIcon('TODO'),
  WAITING: phaseIcon('WAITING'),
  IN_PROGRESS: phaseIcon('IN_PROGRESS'),
  NEED_ACTION: phaseIcon('NEED_ACTION'),
  COMPLETE: phaseIcon('COMPLETE'),
};


const statusSymbols: Record<string, string> = {
  todo: '\u25CB',
  done: '\u25CF',
};

const statusLabels: Record<string, string> = {
  todo: 'Todo',
  done: 'Done',
};

export function StatusBadge({ status, phase, task }: StatusBadgeProps) {
  if (phase) {
    return (
      <span className={`badge badge-phase-${phase.toLowerCase()}`}>
        {phaseSymbols[phase] ?? '?'} {task ? taskStatusLabel(task) : (PHASE_LABELS[phase] ?? phase)}
      </span>
    );
  }
  return (
    <span className={`badge badge-${status}`}>
      {statusSymbols[status] ?? '?'} {statusLabels[status] ?? status}
    </span>
  );
}
