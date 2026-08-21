import type { ReactNode } from 'react';
import type { TaskStatus, TaskPhase } from '@open-walnut/core';
import { phaseIcon } from './Icons';

interface StatusBadgeProps {
  status: TaskStatus;
  phase?: TaskPhase;
}

const phaseSymbols: Record<string, ReactNode> = {
  TODO: phaseIcon('TODO'),
  IN_PROGRESS: phaseIcon('IN_PROGRESS'),
  AGENT_COMPLETE: phaseIcon('AGENT_COMPLETE'),
  COMPLETE: phaseIcon('COMPLETE'),
};

const phaseLabels: Record<string, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  AGENT_COMPLETE: 'Agent Complete',
  COMPLETE: 'Complete',
};

const statusSymbols: Record<string, string> = {
  todo: '\u25CB',
  done: '\u25CF',
};

const statusLabels: Record<string, string> = {
  todo: 'Todo',
  done: 'Done',
};

export function StatusBadge({ status, phase }: StatusBadgeProps) {
  if (phase) {
    return (
      <span className={`badge badge-phase-${phase.toLowerCase()}`}>
        {phaseSymbols[phase] ?? '?'} {phaseLabels[phase] ?? phase}
      </span>
    );
  }
  return (
    <span className={`badge badge-${status}`}>
      {statusSymbols[status] ?? '?'} {statusLabels[status] ?? status}
    </span>
  );
}
